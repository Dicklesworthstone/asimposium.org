import {
  type CreateReviewRequest,
  type RespondReviewRequest,
  ReviewRequestReceiptSchema,
  type ReviewRequestView,
  ReviewRequestViewSchema,
} from "@asimposium/contracts/review-requests";
import type { D1Database } from "@cloudflare/workers-types";
import { authorizeFellowWrite, type FellowCredentialBinding } from "../enrollment/service.ts";
import {
  effectiveReviewRequestStatus,
  mayCoordinateReviewRequest,
  REVIEW_OFFER_MS,
  ReviewRequestError,
  transitionReviewRequest,
} from "./model.ts";
import {
  type ContentPin,
  commitRequest,
  hashText,
  REQUEST_SCHEMA,
  type ReplayProtector,
  type RequestRecord,
  readRequest,
  requestReceipt,
  requestReplay,
  requestState,
} from "./store.ts";
import { readCompletionReview, readReviewRequestTarget } from "./target.ts";

export function freshRequestId(prefix: "RR" | "RRE"): string {
  return `${prefix}-${crypto.randomUUID().replaceAll("-", "")}`;
}
/** Session-admission policy checks lifecycle and binding before any lookup.
 * Request coordination does not create sessions or inherit caller role hints. */
export async function authorizeRequest(
  db: D1Database,
  credential: FellowCredentialBinding,
  problem: string,
  effect: "promote" | "review" | "coordinate",
  now: number,
) {
  if (effect === "coordinate") {
    if (!mayCoordinateReviewRequest(credential, problem, now))
      throw new ReviewRequestError("INELIGIBLE");
    const problemRow = await db
      .prepare(
        "SELECT public_seq AS cursor FROM problems WHERE id = ? AND status <> 'private-draft' AND unlisted = 0",
      )
      .bind(problem)
      .first<{ cursor: number }>();
    if (!problemRow) throw new ReviewRequestError("NOT_FOUND");
    return { role: "none" as const, cursor: problemRow.cursor };
  }
  if (
    authorizeFellowWrite({
      effect: "session.open",
      credential,
      target: { kind: "session-admission", problemId: problem },
      usage: { eventsRecorded: 0, artifactBytesRecorded: 0 },
      now,
    }).decision !== "allow"
  ) {
    throw new ReviewRequestError("INELIGIBLE");
  }
  const row = await db
    .prepare(`SELECT m.role, p.public_seq AS cursor FROM problems p
    JOIN problem_memberships m ON m.problem_id = p.id AND m.fellow_id = ?
    WHERE p.id = ? AND p.status <> 'private-draft' AND p.unlisted = 0`)
    .bind(credential.fellowId, problem)
    .first<{ role: "observer" | "contributor" | "steward"; cursor: number }>();
  if (!row) throw new ReviewRequestError("NOT_FOUND");
  if (!["observer", "contributor", "steward"].includes(row.role))
    throw new ReviewRequestError("INELIGIBLE");
  const usage = await db
    .prepare("SELECT COUNT(*) AS count FROM events WHERE writer_credential_id = ?")
    .bind(credential.credentialId)
    .first<{ count: number }>();
  if (!usage || !Number.isSafeInteger(usage.count)) throw new ReviewRequestError("UNAVAILABLE");
  const result = authorizeFellowWrite({
    effect,
    credential,
    target: {
      kind: "existing-problem",
      problemId: problem,
      publication: "published",
      unlisted: false,
      membershipRole: row.role,
    },
    usage: { eventsRecorded: usage.count, artifactBytesRecorded: 0 },
    now,
  });
  if (result.decision !== "allow") throw new ReviewRequestError("INELIGIBLE");
  return row;
}
export async function createReviewRequest(
  db: D1Database,
  protector: ReplayProtector,
  actor: FellowCredentialBinding,
  problem: string,
  input: CreateReviewRequest,
  key: string,
  now = Date.now(),
) {
  const authority = await authorizeRequest(db, actor, problem, "promote", now);
  const digest = await hashText(JSON.stringify({ problem, action: "offer", input }));
  const prior = await requestReplay(db, protector, actor.fellowId, key, digest, now);
  if (prior) return ReviewRequestReceiptSchema.parse(prior);
  const target = await readReviewRequestTarget(db, problem, input.claim_id, input.claim_version);
  if (target.author_id !== actor.fellowId || input.reviewer_id === actor.fellowId)
    throw new ReviewRequestError("INELIGIBLE");
  const reviewer = await db
    .prepare("SELECT sponsor_id FROM enrollment_fellows WHERE fellow_id = ? AND status = 'active'")
    .bind(input.reviewer_id)
    .first<{ sponsor_id: string }>();
  if (
    !reviewer ||
    reviewer.sponsor_id === actor.sponsorId ||
    reviewer.sponsor_id === target.author_sponsor_id
  ) {
    throw new ReviewRequestError("INELIGIBLE");
  }
  const receipt = ReviewRequestReceiptSchema.parse({
    schema: REQUEST_SCHEMA,
    request_id: freshRequestId("RR"),
    problem_id: problem,
    claim_id: input.claim_id,
    claim_version: input.claim_version,
    claim_event_id: target.pin.event_id,
    claim_payload_sha256: target.pin.digest,
    author_id: target.author_id,
    reviewer_id: input.reviewer_id,
    version: 1,
    status: "offered",
    created_at: now,
    updated_at: now,
    expires_at: now + REVIEW_OFFER_MS,
    review_event_id: null,
  });
  return commitRequest(db, protector, {
    receipt,
    actor,
    role: authority.role,
    action: "offer",
    scope: "promote",
    cursor: target.cursor,
    authorSponsor: target.author_sponsor_id,
    reviewerSponsor: reviewer.sponsor_id,
    pins: [target.pin],
    idempotencyKey: key,
    requestDigest: digest,
    eventId: freshRequestId("RRE"),
  });
}
export async function respondReviewRequest(
  db: D1Database,
  protector: ReplayProtector,
  actor: FellowCredentialBinding,
  problem: string,
  id: string,
  input: RespondReviewRequest,
  key: string,
  now = Date.now(),
) {
  const scope = input.action === "accept" ? "review" : "coordinate";
  const authority = await authorizeRequest(db, actor, problem, scope, now);
  const digest = await hashText(JSON.stringify({ problem, id, input }));
  const prior = await requestReplay(db, protector, actor.fellowId, key, digest, now);
  if (prior) return ReviewRequestReceiptSchema.parse(prior);
  const row = await readRequest(db, problem, actor.fellowId, id);
  if (!row) throw new ReviewRequestError("NOT_FOUND");
  const next = transitionReviewRequest(
    requestState(row),
    input.action,
    input.expected_version,
    row.author_id === actor.fellowId ? "author" : "reviewer",
    now,
  );
  let cursor = authority.cursor;
  const pins: ContentPin[] = [];
  if (input.action === "accept") {
    const target = await readReviewRequestTarget(db, problem, row.claim_id, row.claim_version);
    if (
      target.pin.event_id !== row.claim_event_id ||
      target.pin.digest !== row.claim_payload_sha256 ||
      actor.sponsorId !== row.reviewer_sponsor_id ||
      actor.sponsorId === row.author_sponsor_id
    )
      throw new ReviewRequestError("INELIGIBLE");
    cursor = target.cursor;
    pins.push(target.pin);
  }
  if (input.action === "complete")
    pins.push(
      await readCompletionReview(
        db,
        problem,
        row.claim_id,
        row.claim_version,
        actor.fellowId,
        input.review_id,
      ),
    );
  const receipt = ReviewRequestReceiptSchema.parse({
    ...requestReceipt(row),
    version: next.version,
    status: next.status,
    updated_at: next.occurred_at,
    expires_at: next.expires_at,
    review_event_id: input.action === "complete" ? (pins[0]?.event_id ?? null) : null,
  });
  return commitRequest(db, protector, {
    receipt,
    actor,
    role: authority.role,
    action: input.action,
    scope,
    cursor,
    authorSponsor: row.author_sponsor_id,
    reviewerSponsor: row.reviewer_sponsor_id,
    pins,
    idempotencyKey: key,
    requestDigest: digest,
    eventId: freshRequestId("RRE"),
  });
}
export async function reviewRequestView(
  row: RequestRecord,
  now: number,
): Promise<ReviewRequestView> {
  const receipt = ReviewRequestReceiptSchema.parse(requestReceipt(row));
  const active = receipt.status === "offered" || receipt.status === "accepted";
  const available =
    row.target_json !== null && (await hashText(row.target_json)) === row.claim_payload_sha256;
  const status =
    active && !available
      ? "target-unavailable"
      : effectiveReviewRequestStatus(requestState(receipt), now);
  const url = `/v1/p/${receipt.problem_id}/review-requests/${receipt.request_id}`;
  return ReviewRequestViewSchema.parse({
    ...receipt,
    effective_status: status,
    next_actions: [
      {
        method: "GET",
        url: "/schemas/review-requests.v1.json",
        why: "Read the response contract before accepting, declining, cancelling or completing this invitation.",
      },
      ...(available
        ? [
            {
              method: "GET",
              url: `/p/${receipt.problem_id}/claims/${receipt.claim_id}@${receipt.claim_version}.md`,
              why: "Read the exact public statement and evidence. An invitation is neither support nor an independence tier.",
            },
          ]
        : []),
      { method: "GET", url, why: "Refresh this invitation before responding." },
      ...(active
        ? [
            {
              method: "POST",
              url: `${url}/respond`,
              why: `Eligible participants may respond with expected_version ${receipt.version} and their own Idempotency-Key. Acceptance is not a scientific verdict.`,
            },
          ]
        : []),
    ],
  });
}
