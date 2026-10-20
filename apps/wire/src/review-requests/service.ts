import {
  type CreateReviewRequest,
  type RespondReviewRequest,
  ReviewRequestReceiptSchema,
  type ReviewRequestView,
  ReviewRequestViewSchema,
} from "@asimposium/contracts/review-requests";
import type { D1Database } from "@cloudflare/workers-types";
import { authorizeFellowWrite, type FellowCredentialBinding } from "../enrollment/service.ts";
import { hiddenByContentControlSql } from "../krater/public-content.ts";
import { reviewRequestReadAccessSql } from "./access.ts";
import { type ReviewMatch, ReviewMatchNotFoundError } from "./matching.ts";
import { matchReviewRecipient } from "./matching-service.ts";
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

/** Authenticate outside this helper. Private invitation reads still require
 * current scoped access after a problem becomes unlisted. Scientific scopes
 * and event budgets do not remove read-only access or turn a read into a write. */
export async function mayReadReviewRequests(
  db: D1Database,
  credential: FellowCredentialBinding,
  problem: string,
  now: number,
): Promise<boolean> {
  const row = await db
    .prepare(`WITH input AS (SELECT ? AS j)
    SELECT p.unlisted FROM input JOIN problems p ON p.id = json_extract(j,'$.problem')
    WHERE ${reviewRequestReadAccessSql("p", "json_extract(j,'$.fellow')", "json_extract(j,'$.now')")}`)
    .bind(JSON.stringify({ problem, fellow: credential.fellowId, now }))
    .first<{ unlisted: number }>();
  return (
    row !== null &&
    (row.unlisted === 0 ||
      ((credential.grantedResources.problemBinding === undefined ||
        credential.grantedResources.problemBinding === problem) &&
        (credential.grantedResources.fellowGrantExpiresAt === undefined ||
          credential.grantedResources.fellowGrantExpiresAt > now)))
  );
}
/** Session-admission policy checks lifecycle and binding before any lookup.
 * Request coordination does not create sessions or inherit caller role hints. */
export async function authorizeRequest(
  db: D1Database,
  credential: FellowCredentialBinding,
  problem: string,
  effect: "promote" | "review" | "coordinate" | "complete",
  now: number,
) {
  if (effect === "coordinate" || effect === "complete") {
    if (!mayCoordinateReviewRequest(credential, problem, now))
      throw new ReviewRequestError("INELIGIBLE");
    const problemRow = await db
      .prepare(
        "SELECT public_seq AS cursor, unlisted FROM problems WHERE id = ? AND status <> 'private-draft'",
      )
      .bind(problem)
      .first<{ cursor: number; unlisted: number }>();
    if (!problemRow) throw new ReviewRequestError("NOT_FOUND");
    if (effect === "complete" && !(await mayReadReviewRequests(db, credential, problem, now)))
      throw new ReviewRequestError("NOT_FOUND");
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
    .prepare(`SELECT m.role, p.public_seq AS cursor, p.unlisted,
      g.granted_scopes_json, g.granted_resources_json FROM problems p
    JOIN problem_memberships m ON m.problem_id = p.id AND m.fellow_id = ?
    JOIN enrollment_grants g ON g.fellow_id = m.fellow_id AND g.sponsor_id = ?
    WHERE p.id = ? AND p.status <> 'private-draft'
      AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
      AND json_valid(g.granted_scopes_json) AND json_valid(g.granted_resources_json)`)
    .bind(credential.fellowId, credential.sponsorId, problem)
    .first<{
      role: "observer" | "contributor" | "steward";
      cursor: number;
      unlisted: number;
      granted_scopes_json: string;
      granted_resources_json: string;
    }>();
  if (!row) throw new ReviewRequestError("NOT_FOUND");
  if (!["observer", "contributor", "steward"].includes(row.role))
    throw new ReviewRequestError("INELIGIBLE");
  const usage = await db
    .prepare("SELECT COUNT(*) AS count FROM events WHERE writer_credential_id = ?")
    .bind(credential.credentialId)
    .first<{ count: number }>();
  if (!usage || !Number.isSafeInteger(usage.count)) throw new ReviewRequestError("UNAVAILABLE");
  const target = {
    kind: "existing-problem",
    problemId: problem,
    publication: "published",
    unlisted: row.unlisted === 1,
    membershipRole: row.role,
  } as const;
  const grantScopes = JSON.parse(row.granted_scopes_json);
  const grantResources = JSON.parse(row.granted_resources_json);
  if (
    !Array.isArray(grantScopes) ||
    !grantResources ||
    typeof grantResources !== "object" ||
    Array.isArray(grantResources)
  )
    throw new ReviewRequestError("INELIGIBLE");
  for (const binding of [
    credential,
    { ...credential, grantedScopes: grantScopes, grantedResources: grantResources },
  ]) {
    const result = authorizeFellowWrite({
      effect,
      credential: binding,
      target,
      usage: { eventsRecorded: usage.count, artifactBytesRecorded: 0 },
      now,
    });
    if (result.decision !== "allow") throw new ReviewRequestError("INELIGIBLE");
  }
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
  if (!mayCoordinateReviewRequest(actor, problem, now)) throw new ReviewRequestError("INELIGIBLE");
  const digest = await hashText(JSON.stringify({ problem, action: "offer", input }));
  const prior = await requestReplay(db, protector, actor.fellowId, key, digest, now);
  if (prior) return ReviewRequestReceiptSchema.parse(prior);
  try {
    const authority = await authorizeRequest(db, actor, problem, "promote", now);
    const target = await readReviewRequestTarget(db, problem, input.claim_id, input.claim_version);
    // Never inspect another Fellow's eligible recipients before proving the
    // requester authored this exact target. Matching does not delegate authorship.
    if (target.author_id !== actor.fellowId) throw new ReviewRequestError("INELIGIBLE");
    let match: ReviewMatch | null = null;
    let reviewerId: string;
    let reviewerSponsor: string;
    if ("match" in input) {
      match = await matchReviewRecipient(db, problem, target, actor.sponsorId, now);
      if (match === null) throw new ReviewMatchNotFoundError();
      reviewerId = match.reviewerId;
      reviewerSponsor = match.reviewerSponsor;
    } else {
      if (input.reviewer_id === actor.fellowId) throw new ReviewRequestError("INELIGIBLE");
      const reviewer = await db
        .prepare(
          "SELECT sponsor_id FROM enrollment_fellows WHERE fellow_id = ? AND status = 'active'",
        )
        .bind(input.reviewer_id)
        .first<{ sponsor_id: string }>();
      if (
        !reviewer ||
        reviewer.sponsor_id === actor.sponsorId ||
        reviewer.sponsor_id === target.author_sponsor_id
      ) {
        throw new ReviewRequestError("INELIGIBLE");
      }
      reviewerId = input.reviewer_id;
      reviewerSponsor = reviewer.sponsor_id;
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
      reviewer_id: reviewerId,
      version: 1,
      status: "offered",
      created_at: now,
      updated_at: now,
      expires_at: now + REVIEW_OFFER_MS,
      review_event_id: null,
    });
    return await commitRequest(db, protector, {
      receipt,
      actor,
      role: authority.role,
      action: "offer",
      scope: "promote",
      cursor: target.cursor,
      authorSponsor: target.author_sponsor_id,
      reviewerSponsor,
      pins: match === null ? [target.pin] : [target.pin, match.provenancePin],
      ...(match === null ? {} : { match: match.eligibility }),
      idempotencyKey: key,
      requestDigest: digest,
      eventId: freshRequestId("RRE"),
    });
  } catch (error) {
    // A same-key winner can settle between the replay read and selection (or
    // change the target's active-request check). Return that exact winner;
    // never rematch a retry or cascade through alternate recipients here.
    const raced = await requestReplay(db, protector, actor.fellowId, key, digest, now);
    if (raced) return ReviewRequestReceiptSchema.parse(raced);
    throw error;
  }
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
  if (!mayCoordinateReviewRequest(actor, problem, now)) throw new ReviewRequestError("INELIGIBLE");
  const scope = input.action === "accept" ? "review" : "coordinate";
  const digest = await hashText(JSON.stringify({ problem, id, input }));
  const prior = await requestReplay(db, protector, actor.fellowId, key, digest, now);
  if (prior) return ReviewRequestReceiptSchema.parse(prior);
  try {
    const authority = await authorizeRequest(
      db,
      actor,
      problem,
      input.action === "complete" ? "complete" : scope,
      now,
    );
    const row = await readRequest(db, problem, actor.fellowId, id, {
      now,
      history: input.action === "decline" || input.action === "cancel",
    });
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
    if (input.action === "complete") {
      // Completion links an existing screened review. It does not spend another
      // scientific event budget, but both that review and its exact current target
      // must still be readable. Historical receipts remain replayable separately.
      if (
        row.target_json === null ||
        (await hashText(row.target_json)) !== row.claim_payload_sha256
      )
        throw new ReviewRequestError("INELIGIBLE");
      pins.push(
        await readCompletionReview(
          db,
          problem,
          row.claim_id,
          row.claim_version,
          actor.fellowId,
          input.review_id,
        ),
        {
          event_id: row.claim_event_id,
          digest: row.claim_payload_sha256,
          payload_json: row.target_json,
        },
      );
    }
    const receipt = ReviewRequestReceiptSchema.parse({
      ...requestReceipt(row),
      version: next.version,
      status: next.status,
      updated_at: next.occurred_at,
      expires_at: next.expires_at,
      review_event_id: input.action === "complete" ? (pins[0]?.event_id ?? null) : null,
    });
    return await commitRequest(db, protector, {
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
  } catch (error) {
    // A concurrent identical response may settle before the mutable state,
    // scope or source read. The winner's private receipt remains authoritative.
    const raced = await requestReplay(db, protector, actor.fellowId, key, digest, now);
    if (raced) return ReviewRequestReceiptSchema.parse(raced);
    throw error;
  }
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
