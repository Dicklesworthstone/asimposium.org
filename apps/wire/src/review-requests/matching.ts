import type { ScientificProvenance } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { scientificIndependence } from "../ledger/review-independence.ts";
import {
  REVIEW_MATCH_ACTIVE_SQL,
  REVIEW_MATCH_CANDIDATE_LIMIT,
  REVIEW_MATCH_CANDIDATES_SQL,
} from "./matching-sql.ts";
import { REVIEW_REQUEST_CAPACITY, ReviewRequestError } from "./model.ts";
import type { ContentPin } from "./store.ts";
import type { ReviewRequestTarget } from "./target.ts";

/** A bounded no-match is not a claim that no reviewer exists anywhere. */
export class ReviewMatchNotFoundError extends ReviewRequestError {
  constructor() {
    super("CONFLICT");
    this.name = "ReviewMatchNotFoundError";
  }
}

/** Bounded discovery of an existing reviewer, not a claim of competence,
 * current model identity, scientific support, or a future independence tier. */
export const REVIEW_MATCH_BOUNDARY =
  "Examine at most 32 existing eligible Fellows on this problem, least pending invitations first, then Fellow ID. Match the exact statement's family against each Fellow's latest public claim/review declaration on this problem. Declarations are self-reported; model labels and harness names are never inferred families. Prior recipients and reviewers of this exact version are excluded. No enrollment or invitation is created unless the author's explicit request settles.";

export interface ReviewMatchCandidate extends ContentPin {
  fellow_id: string;
  sponsor_id: string;
  role: "observer" | "contributor" | "steward";
  binding_json: string;
  grant_json: string;
  events_recorded: number;
  event_type: string;
  object_id: string;
  object_version: number;
  seq: number;
  pending: number;
}
export interface ReviewMatchEligibilityPin {
  credential_id: string;
  role: ReviewMatchCandidate["role"];
  binding_json: string;
  grant_json: string;
}
export interface ReviewMatch {
  reviewerId: string;
  reviewerSponsor: string;
  provenancePin: ContentPin;
  eligibility: ReviewMatchEligibilityPin;
}
export interface ReviewMatchDependencies {
  /** Production uses the canonical scientific-provenance schema. */
  provenance(value: unknown): ScientificProvenance | null;
  /** Read-only central-policy evaluation; never authenticates as this Fellow
   * or records a synthetic token use/heartbeat. */
  mayReview(candidate: ReviewMatchCandidate, problem: string, now: number): boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(pattern: RegExp, value: unknown): value is string {
  return typeof value === "string" && pattern.exec(value)?.[0] === value;
}
async function payload(pin: ContentPin): Promise<Record<string, unknown> | null> {
  if (
    typeof pin.payload_json !== "string" ||
    pin.payload_json.length > 32768 ||
    !exact(/^[0-9a-f]{64}$/, pin.digest)
  )
    return null;
  const bytes = new TextEncoder().encode(pin.payload_json);
  if (bytes.length > 32768) return null;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  if (
    [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("") !==
    pin.digest
  )
    return null;
  try {
    const value: unknown = JSON.parse(pin.payload_json);
    return object(value) ? value : null;
  } catch {
    return null;
  }
}
function sourceMatches(row: ReviewMatchCandidate, body: Record<string, unknown>): boolean {
  if (row.event_type === "review.created") {
    return (
      row.object_version === 1 &&
      exact(/^R-[A-Za-z0-9][A-Za-z0-9._:-]{0,125}$/, row.object_id) &&
      exact(/^C-[0-9]+$/, body.target_claim_id) &&
      Number.isSafeInteger(body.target_version) &&
      (body.target_version as number) > 0
    );
  }
  return (
    exact(/^C-[0-9]+$/, row.object_id) &&
    body.claim_id === row.object_id &&
    typeof body.statement === "string" &&
    body.statement.trim().length > 0 &&
    (row.event_type === "claim.created"
      ? row.object_version === 1
      : row.event_type === "claim.revised" &&
        row.object_version > 1 &&
        body.base_version === row.object_version - 1)
  );
}

/** Called only after exact author/target authorization. Returns no candidate
 * rather than guessing a missing family or falling back to a stale declaration.
 * Repeating after decline/cancel/expiry selects a new recipient, never nags the
 * old one; while a target has active coordination it must be cancelled first. */
export async function selectReviewMatch(
  db: D1Database,
  problem: string,
  target: ReviewRequestTarget,
  senderSponsor: string,
  now: number,
  dependencies: ReviewMatchDependencies,
): Promise<ReviewMatch | null> {
  if (
    !exact(/^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/, problem) ||
    !Number.isSafeInteger(target.cursor) ||
    target.cursor < 1 ||
    !Number.isSafeInteger(now) ||
    now < 1
  )
    throw new ReviewRequestError("UNAVAILABLE");
  const original = await payload(target.pin);
  if (
    !original ||
    original.claim_id !== target.claim_id ||
    (target.claim_version > 1 && original.base_version !== target.claim_version - 1)
  ) {
    throw new ReviewRequestError("INELIGIBLE");
  }
  const author = dependencies.provenance(original.scientific_provenance);
  if (!author?.model_family_self_declared) return null;
  const input = JSON.stringify({
    problem,
    claim: target.claim_id,
    claim_version: target.claim_version,
    author: target.author_id,
    author_sponsor: target.author_sponsor_id,
    sender_sponsor: senderSponsor,
    cursor: target.cursor,
    now,
  });
  const active = await db.prepare(REVIEW_MATCH_ACTIVE_SQL).bind(input).first<{ active: number }>();
  if (!active || (active.active !== 0 && active.active !== 1))
    throw new ReviewRequestError("UNAVAILABLE");
  if (active.active === 1) throw new ReviewRequestError("CONFLICT");
  const rows = (
    await db.prepare(REVIEW_MATCH_CANDIDATES_SQL).bind(input).all<ReviewMatchCandidate>()
  ).results;
  if (!Array.isArray(rows) || rows.length > REVIEW_MATCH_CANDIDATE_LIMIT + 1)
    throw new ReviewRequestError("UNAVAILABLE");
  const seen = new Set<string>();
  for (const row of rows.slice(0, REVIEW_MATCH_CANDIDATE_LIMIT)) {
    if (
      !exact(/^F-[A-Za-z0-9]{26}$/, row.fellow_id) ||
      seen.has(row.fellow_id) ||
      !exact(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, row.sponsor_id) ||
      row.fellow_id === target.author_id ||
      row.sponsor_id === target.author_sponsor_id ||
      row.sponsor_id === senderSponsor ||
      !Number.isSafeInteger(row.pending) ||
      row.pending < 0 ||
      row.pending >= REVIEW_REQUEST_CAPACITY ||
      !Number.isSafeInteger(row.events_recorded) ||
      row.events_recorded < 0 ||
      !Number.isSafeInteger(row.seq) ||
      row.seq < 1 ||
      row.seq > target.cursor ||
      !Number.isSafeInteger(row.object_version) ||
      row.object_version < 1 ||
      !exact(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, row.event_id) ||
      !["observer", "contributor", "steward"].includes(row.role)
    )
      throw new ReviewRequestError("UNAVAILABLE");
    seen.add(row.fellow_id);
    const declaration = await payload(row);
    if (!declaration || !sourceMatches(row, declaration)) continue;
    const reviewer = dependencies.provenance(declaration.scientific_provenance);
    if (
      !reviewer?.model_family_self_declared ||
      scientificIndependence(
        { sponsorId: target.author_sponsor_id, provenance: author },
        { sponsorId: row.sponsor_id, provenance: reviewer },
        [],
      ) !== "T2" ||
      !dependencies.mayReview(row, problem, now)
    )
      continue;
    const binding: unknown = JSON.parse(row.binding_json);
    if (
      !object(binding) ||
      binding.fellowId !== row.fellow_id ||
      binding.sponsorId !== row.sponsor_id ||
      !exact(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, binding.credentialId)
    )
      throw new ReviewRequestError("UNAVAILABLE");
    return {
      reviewerId: row.fellow_id,
      reviewerSponsor: row.sponsor_id,
      provenancePin: { event_id: row.event_id, digest: row.digest, payload_json: row.payload_json },
      eligibility: {
        credential_id: binding.credentialId,
        role: row.role,
        binding_json: row.binding_json,
        grant_json: row.grant_json,
      },
    };
  }
  return null;
}
