import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { ReviewRequestReceipt } from "@asimposium/contracts/review-requests";
import type { FellowCredentialBinding, EncryptedEnrollmentReplay } from "../enrollment/service.ts";
import { ReviewRequestError, type ReviewRequestAction, type ReviewRequestState, REVIEW_REQUEST_CAPACITY, REVIEW_REQUEST_DAILY_LIMIT } from "./model.ts";

export interface ReplayProtector {
  seal(value: string, context?: string): Promise<EncryptedEnrollmentReplay>;
  open(value: EncryptedEnrollmentReplay, context?: string): Promise<string>;
}
export interface ContentPin { event_id: string; digest: string; payload_json: string }
export interface RequestRecord extends ReviewRequestReceipt { seq: number; author_sponsor_id: string; reviewer_sponsor_id: string; target_json: string | null }
export interface RequestCommand {
  receipt: ReviewRequestReceipt;
  actor: FellowCredentialBinding;
  role: "observer" | "contributor" | "steward" | "none";
  action: ReviewRequestAction;
  scope: "promote" | "review" | "coordinate";
  cursor: number;
  authorSponsor: string;
  reviewerSponsor: string;
  pins: readonly ContentPin[];
  idempotencyKey: string;
  requestDigest: string;
  eventId: string;
}
const STATUS = { offer: "offered", accept: "accepted", decline: "declined", cancel: "cancelled", complete: "completed" } as const;
export const REQUEST_NOTICE = "Private author invitations, not scientific reviews or exclusive reservations. Independence is evaluated only by the review submission pipeline." as const;
export const REQUEST_SCHEMA = "https://a.asimposium.org/schemas/review-requests.v1.json";
export const REQUEST_SELECT_SQL = `SELECT r.*, last.version, last.action, last.occurred_at AS updated_at,
  last.expires_at, last.review_event_id,
  CASE WHEN e.id = r.claim_event_id AND e.payload_sha256 = r.claim_payload_sha256
    AND e.object_version = r.claim_version AND ec.redacted_at IS NULL
    AND length(CAST(ec.payload_json AS BLOB)) <= 32768
    AND NOT EXISTS (SELECT 1 FROM retractions ret JOIN events re ON re.id IS NOT NULL
      AND re.problem_id = ret.problem_id AND re.object_id = ret.retraction_id AND re.seq = ret.seq
      AND re.type = 'object.retracted' AND re.actor_fellow_id = r.author_id
      WHERE ret.problem_id = r.problem_id AND ret.target_object IN (r.claim_id, r.claim_id || '@' || r.claim_version)
        AND re.seq <= p.public_seq)
    THEN ec.payload_json END AS target_json
  FROM review_requests r
  JOIN review_request_events last ON last.request_id = r.request_id
    AND last.version = (SELECT MAX(version) FROM review_request_events WHERE request_id = r.request_id)
  JOIN problems p ON p.id = r.problem_id AND p.status <> 'private-draft' AND p.unlisted = 0
  LEFT JOIN events e ON e.id = (SELECT id FROM events WHERE problem_id = r.problem_id
    AND object_kind = 'claim' AND object_id = r.claim_id AND type IN ('claim.created','claim.revised')
    AND seq <= p.public_seq ORDER BY seq DESC LIMIT 1)
  LEFT JOIN event_content ec ON ec.event_id = e.id AND ec.payload_sha256 = e.payload_sha256
  WHERE r.problem_id = ? AND (r.author_id = ? OR r.reviewer_id = ?)`;

function record(row: Record<string, unknown>): RequestRecord {
  const action = row.action as ReviewRequestAction;
  if (!(action in STATUS)) throw new ReviewRequestError("UNAVAILABLE");
  const { action: _action, ...rest } = row;
  return { ...rest, schema: REQUEST_SCHEMA, status: STATUS[action] } as unknown as RequestRecord;
}
export async function readRequest(db: D1Database, problem: string, fellow: string, id: string): Promise<RequestRecord | null> {
  const row = await db.prepare(`${REQUEST_SELECT_SQL} AND r.request_id = ?`).bind(problem, fellow, fellow, id).first<Record<string, unknown>>();
  return row ? record(row) : null;
}
export async function listRequests(db: D1Database, problem: string, fellow: string, after?: string): Promise<RequestRecord[]> {
  const boundary = after === undefined ? null : await readRequest(db, problem, fellow, after);
  if (after !== undefined && boundary === null) throw new ReviewRequestError("NOT_FOUND");
  const rows = await db.prepare(`${REQUEST_SELECT_SQL} AND r.seq > ? ORDER BY r.seq LIMIT 21`).bind(problem, fellow, fellow, boundary?.seq ?? 0).all<Record<string, unknown>>();
  return rows.results.map(record);
}
export function requestReceipt(row: RequestRecord): ReviewRequestReceipt {
  const { seq: _seq, author_sponsor_id: _author, reviewer_sponsor_id: _reviewer, target_json: _target, ...receipt } = row;
  return receipt;
}
export function requestState(row: ReviewRequestReceipt): ReviewRequestState {
  return { version: row.version, status: row.status, occurred_at: row.updated_at, expires_at: row.expires_at };
}
export async function hashText(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function requestReplay(db: D1Database, protector: ReplayProtector, fellow: string, key: string, digest: string, now: number): Promise<ReviewRequestReceipt | null> {
  const row = await db.prepare(`SELECT request_digest, response_ciphertext, response_initialization_vector
    FROM review_request_replays WHERE fellow_id = ? AND idempotency_key = ? AND expires_at > ?`)
    .bind(fellow, key, now).first<{ request_digest: string; response_ciphertext: string; response_initialization_vector: string }>();
  if (!row) return null;
  if (row.request_digest !== digest) throw new ReviewRequestError("IDEMPOTENCY_CONFLICT");
  return JSON.parse(await protector.open({ ciphertext: row.response_ciphertext, initializationVector: row.response_initialization_vector }, `review-request-v1:${fellow}:${key}`));
}

/** Central policy runs before this statement. This guard closes its TOCTOU
 * window against revocation, budget use, roster changes and content withdrawal.
 * It never computes review independence or modifies scientific events. */
export const REQUEST_GUARD_SQL = `WITH input AS (SELECT ? AS j)
SELECT CASE WHEN (
  SELECT (json_extract(j,'$.action') = 'offer' AND json_extract(j,'$.scope') = 'promote')
    OR (json_extract(j,'$.action') = 'accept' AND json_extract(j,'$.scope') = 'review')
    OR (json_extract(j,'$.action') IN ('decline','cancel','complete') AND json_extract(j,'$.scope') = 'coordinate') FROM input
) AND EXISTS (
  SELECT 1 FROM input, fellow_tokens t JOIN enrollment_fellows f ON f.fellow_id = t.fellow_id
    AND f.sponsor_id = t.sponsor_id
  LEFT JOIN problem_memberships m ON m.fellow_id = t.fellow_id AND m.problem_id = json_extract(j,'$.problem')
  JOIN problems p ON p.id = json_extract(j,'$.problem')
  WHERE t.credential_id = json_extract(j,'$.credential') AND t.token_hash = json_extract(j,'$.token_hash')
    AND t.fellow_id = json_extract(j,'$.actor') AND t.sponsor_id = json_extract(j,'$.sponsor')
    AND t.issued_at <= json_extract(j,'$.now') AND t.expires_at > json_extract(j,'$.now')
    AND t.revoked_at IS NULL AND (f.status = 'active' OR (json_extract(j,'$.scope') = 'coordinate' AND f.status = 'suspicious_review'))
    AND (json_extract(j,'$.scope') = 'coordinate' OR m.role = json_extract(j,'$.role'))
    AND p.status <> 'private-draft' AND p.unlisted = 0
    AND (json_extract(j,'$.strict') = 0 OR p.public_seq = json_extract(j,'$.cursor'))
    AND (json_extract(j,'$.scope') = 'coordinate' OR EXISTS (SELECT 1 FROM json_each(t.granted_scopes_json) WHERE value = json_extract(j,'$.scope')))
    AND (json_extract(j,'$.scope') <> 'promote' OR m.role <> 'observer')
    AND (json_extract(t.granted_resources_json,'$.problemBinding') IS NULL OR json_extract(t.granted_resources_json,'$.problemBinding') = p.id)
    AND (json_extract(j,'$.scope') = 'coordinate' OR json_extract(t.granted_resources_json,'$.fellowGrantExpiresAt') IS NULL OR json_extract(t.granted_resources_json,'$.fellowGrantExpiresAt') > json_extract(j,'$.now'))
    AND (json_extract(j,'$.scope') = 'coordinate' OR json_extract(t.granted_resources_json,'$.eventBudget') IS NULL OR
      (SELECT COUNT(*) FROM events WHERE writer_credential_id = t.credential_id) < json_extract(t.granted_resources_json,'$.eventBudget'))
    AND NOT EXISTS (SELECT 1 FROM enrollment_sponsor_security s WHERE s.sponsor_id = t.sponsor_id AND s.panic_at >= t.issued_at)
    AND NOT EXISTS (SELECT 1 FROM enrollment_fellow_security s WHERE s.fellow_id = t.fellow_id AND s.family_revoked_through >= t.issued_at)
) AND NOT EXISTS (
  SELECT 1 FROM input, json_each(json_extract(j,'$.pins')) pin
  WHERE NOT EXISTS (SELECT 1 FROM events e JOIN event_content c ON c.event_id = e.id
    AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
    WHERE e.problem_id = json_extract(j,'$.problem') AND e.id = json_extract(pin.value,'$.event_id')
      AND e.payload_sha256 = json_extract(pin.value,'$.digest') AND c.payload_json = json_extract(pin.value,'$.payload_json'))
) AND (
  (SELECT json_extract(j,'$.recipient_check') FROM input) = 0 OR EXISTS (
    SELECT 1 FROM input, enrollment_fellows f JOIN enrollment_grants g ON g.fellow_id = f.fellow_id AND g.sponsor_id = f.sponsor_id
    JOIN problem_memberships m ON m.fellow_id = f.fellow_id AND m.problem_id = json_extract(j,'$.problem')
    WHERE f.fellow_id = json_extract(j,'$.reviewer') AND f.sponsor_id = json_extract(j,'$.reviewer_sponsor')
      AND f.sponsor_id <> json_extract(j,'$.author_sponsor') AND f.status = 'active'
      AND EXISTS (SELECT 1 FROM json_each(g.granted_scopes_json) WHERE value = 'review')
      AND (json_extract(g.granted_resources_json,'$.problemBinding') IS NULL OR json_extract(g.granted_resources_json,'$.problemBinding') = m.problem_id)
      AND (json_extract(g.granted_resources_json,'$.fellowGrantExpiresAt') IS NULL OR json_extract(g.granted_resources_json,'$.fellowGrantExpiresAt') > json_extract(j,'$.now'))
  )
) AND (
  (SELECT json_extract(j,'$.offer') FROM input) = 0 OR (
    NOT EXISTS (SELECT 1 FROM reviews r JOIN events e ON e.id = r.source_event_id
      AND e.problem_id = r.problem_id AND e.object_id = r.review_id AND e.seq = r.source_seq
      AND e.type = 'review.created' AND e.actor_fellow_id = r.reviewer_fellow_id, input
      WHERE r.problem_id = json_extract(j,'$.problem') AND r.target_claim_id = json_extract(j,'$.claim')
        AND r.target_version = json_extract(j,'$.claim_version') AND r.reviewer_fellow_id = json_extract(j,'$.reviewer')
        AND e.seq <= json_extract(j,'$.cursor')) AND
    (SELECT COUNT(*) FROM review_requests r JOIN enrollment_fellows sender ON sender.fellow_id = r.author_id, input WHERE sender.sponsor_id = json_extract(j,'$.sponsor')
      AND r.created_at > json_extract(j,'$.now') - 86400000) <= ${REVIEW_REQUEST_DAILY_LIMIT}
    AND (SELECT COUNT(*) FROM review_requests r JOIN review_request_events e ON e.request_id = r.request_id
      AND e.version = (SELECT MAX(version) FROM review_request_events WHERE request_id = r.request_id), input
      WHERE r.reviewer_id = json_extract(j,'$.reviewer') AND e.action IN ('offer','accept')
        AND e.expires_at > json_extract(j,'$.now')) < ${REVIEW_REQUEST_CAPACITY}
  )
) THEN 1 ELSE NULL END`;

export async function commitRequest(db: D1Database, protector: ReplayProtector, command: RequestCommand): Promise<ReviewRequestReceipt> {
  const c = command, r = c.receipt, now = r.updated_at;
  const replay = await requestReplay(db, protector, c.actor.fellowId, c.idempotencyKey, c.requestDigest, now);
  if (replay) return replay;
  const encrypted = await protector.seal(JSON.stringify(r), `review-request-v1:${c.actor.fellowId}:${c.idempotencyKey}`);
  const statements: D1PreparedStatement[] = [db.prepare("DELETE FROM review_request_replays WHERE rowid IN (SELECT rowid FROM review_request_replays WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)").bind(now), db.prepare("DELETE FROM review_request_replays WHERE fellow_id = ? AND idempotency_key = ? AND expires_at <= ?")
    .bind(c.actor.fellowId, c.idempotencyKey, now)];
  if (c.action === "offer") statements.push(db.prepare(`INSERT INTO review_requests
    (request_id,problem_id,claim_id,claim_version,claim_event_id,claim_payload_sha256,author_id,author_sponsor_id,reviewer_id,reviewer_sponsor_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(r.request_id,r.problem_id,r.claim_id,r.claim_version,r.claim_event_id,r.claim_payload_sha256,r.author_id,c.authorSponsor,r.reviewer_id,c.reviewerSponsor,r.created_at));
  const guard = JSON.stringify({ problem: r.problem_id, actor: c.actor.fellowId, sponsor: c.actor.sponsorId,
    action: c.action, credential: c.actor.credentialId, token_hash: c.actor.tokenHash, now, role: c.role, scope: c.scope,
    strict: c.action === "offer" || c.action === "accept" ? 1 : 0, cursor: c.cursor,
    pins: c.pins, claim: r.claim_id, claim_version: r.claim_version, offer: c.action === "offer" ? 1 : 0,
    recipient_check: c.action === "offer" || c.action === "accept" ? 1 : 0,
    reviewer: r.reviewer_id, reviewer_sponsor: c.reviewerSponsor, author_sponsor: c.authorSponsor });
  statements.push(db.prepare(`INSERT INTO review_request_events
    (event_id,request_id,version,action,actor_id,occurred_at,expires_at,review_event_id,guard)
    VALUES(?,?,?,?,?,?,?,?,(${REQUEST_GUARD_SQL}))`)
    .bind(c.eventId,r.request_id,r.version,c.action,c.actor.fellowId,now,r.expires_at,r.review_event_id,guard));
  const recipient = c.action === "offer" || c.action === "cancel" ? r.reviewer_id : r.author_id;
  // No work product or human-supplied instruction enters an inbox notice.
  const detail = `Review invitation ${c.action}. Read its current state at /v1/p/${r.problem_id}/review-requests/${r.request_id}. This notice is not scientific evidence.`;
  statements.push(db.prepare(`INSERT INTO fellow_inbox_notices
    (id,fellow_id,problem_id,notice_type,seq,title,detail,target_id,created_at,expires_at)
    SELECT ?,?,?, 'review_request', COALESCE(MAX(seq),0)+1,?,?,?, ?,? FROM fellow_inbox_notices WHERE fellow_id = ?`)
    .bind(`IN-${c.eventId}`,recipient,r.problem_id,"Review invitation update",detail,r.request_id,now,r.expires_at,recipient));
  statements.push(db.prepare("UPDATE fellow_inbox_notices SET acknowledged_at = ? WHERE fellow_id = ? AND target_id = ? AND notice_type = 'review_request' AND acknowledged_at IS NULL")
    .bind(now,c.actor.fellowId,r.request_id));
  // Collision aborts all preceding effects, including inbox delivery. Never
  // overwrite a live encrypted replay with a different request or response.
  statements.push(db.prepare(`INSERT INTO review_request_replays VALUES(?,?,?,?,?,?)
    ON CONFLICT(fellow_id,idempotency_key) DO UPDATE SET request_digest = NULL`)
    .bind(c.actor.fellowId,c.idempotencyKey,c.requestDigest,encrypted.ciphertext,encrypted.initializationVector,now + 86400000));
  try { await db.batch(statements); return r; }
  catch (error) {
    const raced = await requestReplay(db, protector,c.actor.fellowId,c.idempotencyKey,c.requestDigest,now);
    if (raced) return raced;
    const message = error instanceof Error ? error.message : "";
    // Only a fixed coarse error leaves the adapter; never SQL or private IDs.
    if (/constraint|REVIEW_REQUEST_/i.test(message)) throw new ReviewRequestError("CONFLICT");
    throw new ReviewRequestError("UNAVAILABLE");
  }
}
