import type { DeadEndRetryWhen, RecordDeadEndRequest } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

/** Discovery reads the existing firing index; it never fires a trigger or
 * changes the negative result. Prose and projection reasons are not predicates. */
export const RETRY_PAGE_SIZE = 8;
export const RETRY_MAX_BODY_BYTES = 32768;
export interface RetryCursor {
  readonly seq: number;
  readonly id: string;
}
export interface RetryEventPin {
  readonly event_id: string;
  readonly seq: number;
  readonly payload_sha256: string;
}
export interface RetryAdmission {
  problem_id: string;
  dead_end_id: string;
  trigger_kind: string;
  source_event_id: string;
  source_seq: number;
  source_digest: string;
  source_json: string | null;
  author_fellow_id: string;
  event_id: string;
  seq: number;
  event_type: string;
  object_kind: string;
  object_id: string;
  object_version: number;
  sponsor_id: string | null;
  payload_sha256: string;
  payload_json: string | null;
}
export interface VerifiedDeadEndRetry {
  readonly problem_id: string;
  readonly cursor: number;
  readonly dead_end_id: string;
  readonly author_fellow_id: string;
  readonly source: RecordDeadEndRequest & { retry_when: DeadEndRetryWhen };
  readonly publication: RetryEventPin;
  readonly firing: RetryEventPin;
}
export interface RetryReadDependencies {
  /** The production adapter projects the immutable writer envelope through the
   * existing dead-end request schema. Tests may supply an explicit decoder. */
  decodeSource(payload: Record<string, unknown>): RecordDeadEndRequest | null;
  /** Validate the typed trigger event and, where applicable, replay the canonical
   * scientific evaluator. No caller-controlled evaluator reaches production. */
  condition(
    db: D1Database,
    row: RetryAdmission,
    trigger: DeadEndRetryWhen,
    payload: Record<string, unknown>,
    through: number,
  ): Promise<"holds" | "not-held" | "unavailable">;
}
export interface RetryPage {
  readonly items: VerifiedDeadEndRetry[];
  readonly next: RetryCursor | null;
  readonly omitted: readonly ("page_limit" | "content_unavailable" | "condition_unavailable")[];
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function exact(pattern: RegExp, value: unknown): value is string {
  return typeof value === "string" && pattern.exec(value)?.[0] === value;
}
export async function verifiedRetryPayload(text: string | null, expected: string) {
  if (
    typeof text !== "string" ||
    text.length > RETRY_MAX_BODY_BYTES ||
    !exact(/^[0-9a-f]{64}$/, expected)
  )
    return null;
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > RETRY_MAX_BODY_BYTES) return null;
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (digest !== expected) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
export const RETRY_HEAD_SQL = `SELECT public_seq AS cursor FROM problems WHERE id = ?
  AND unlisted = 0 AND status IN ('active','dormant','under-result-review')`;
export const RETRY_PAGE_SQL = `SELECT d.problem_id, d.dead_end_id, t.trigger_kind,
  source.id AS source_event_id, source.seq AS source_seq, source.payload_sha256 AS source_digest,
  CASE WHEN length(CAST(sc.payload_json AS BLOB)) <= ${RETRY_MAX_BODY_BYTES} THEN sc.payload_json END AS source_json,
  source.actor_fellow_id AS author_fellow_id,
  e.id AS event_id, e.seq, e.type AS event_type, e.object_kind, e.object_id, e.object_version,
  e.actor_sponsor_id AS sponsor_id, e.payload_sha256,
  CASE WHEN length(CAST(ec.payload_json AS BLOB)) <= ${RETRY_MAX_BODY_BYTES} THEN ec.payload_json END AS payload_json
FROM dead_end_fired_triggers t
JOIN dead_ends d ON d.problem_id = t.problem_id AND d.dead_end_id = t.dead_end_id
JOIN events source ON source.problem_id = d.problem_id AND source.object_id = d.dead_end_id
  AND source.type = 'dead_end.recorded' AND source.object_kind = 'dead_end' AND source.object_version = 1
JOIN events e ON e.problem_id = d.problem_id AND e.id = t.event_id AND e.seq > source.seq
JOIN problems p ON p.id = d.problem_id
LEFT JOIN event_content sc ON sc.event_id = source.id AND sc.payload_sha256 = source.payload_sha256
  AND sc.redacted_at IS NULL
LEFT JOIN event_content ec ON ec.event_id = e.id AND ec.payload_sha256 = e.payload_sha256
  AND ec.redacted_at IS NULL
WHERE d.problem_id = ? AND p.unlisted = 0 AND p.status IN ('active','dormant','under-result-review')
  AND p.public_seq >= ? AND e.seq <= ? AND d.superseded_by IS NULL
  AND (e.seq > ? OR (e.seq = ? AND d.dead_end_id > ?))
ORDER BY e.seq, d.dead_end_id LIMIT ${RETRY_PAGE_SIZE + 1}`;

/** Recheck current withdrawal and supersession after scientific reads. The
 * source and firing event must still have exactly the bytes already verified. */
export const RETRY_AVAILABLE_SQL = `SELECT COUNT(*) AS available FROM json_each(?) pin
JOIN events e ON e.id = json_extract(pin.value,'$.event_id') AND e.problem_id = ?
JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
  AND c.redacted_at IS NULL AND c.payload_json = json_extract(pin.value,'$.payload_json')
JOIN problems p ON p.id = e.problem_id AND p.unlisted = 0
  AND p.status IN ('active','dormant','under-result-review')
WHERE e.payload_sha256 = json_extract(pin.value,'$.digest') AND e.seq <= ?
  AND EXISTS (SELECT 1 FROM dead_ends d WHERE d.problem_id = e.problem_id
    AND d.dead_end_id = ? AND d.superseded_by IS NULL)`;

/** Internal problem-local pagination. Advance by scanned firings, including
 * withheld ones. Later events cannot change the captured cut; current privacy,
 * withdrawal and supersession can still remove an actionable recommendation. */
export async function readDeadEndRetries(
  db: D1Database,
  problem: string,
  through: number,
  dependencies: RetryReadDependencies,
  after?: RetryCursor,
): Promise<RetryPage> {
  if (
    !exact(/^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/, problem) ||
    !Number.isSafeInteger(through) ||
    through < 0 ||
    (after !== undefined &&
      (!Number.isSafeInteger(after.seq) ||
        after.seq < 1 ||
        after.seq > through ||
        !exact(/^(?!.*--)DE-[A-Z0-9][A-Z0-9-]{0,40}$/, after.id)))
  )
    throw new Error("RETRY_SNAPSHOT_INVALID");
  const head = await db.prepare(RETRY_HEAD_SQL).bind(problem).first<{ cursor: number }>();
  if (!head || !Number.isSafeInteger(head.cursor) || head.cursor < through)
    throw new Error("RETRY_SNAPSHOT_UNAVAILABLE");
  const rows = (
    await db
      .prepare(RETRY_PAGE_SQL)
      .bind(problem, through, through, after?.seq ?? 0, after?.seq ?? 0, after?.id ?? "")
      .all<RetryAdmission>()
  ).results;
  if (!Array.isArray(rows) || rows.length > RETRY_PAGE_SIZE + 1)
    throw new Error("RETRY_ADMISSIONS_INVALID");
  const items: VerifiedDeadEndRetry[] = [];
  const omitted = new Set<RetryPage["omitted"][number]>();
  const seen = new Set<string>();
  let previous = after;
  for (const row of rows.slice(0, RETRY_PAGE_SIZE)) {
    if (
      row.problem_id !== problem ||
      !exact(/^(?!.*--)DE-[A-Z0-9][A-Z0-9-]{0,40}$/, row.dead_end_id) ||
      !exact(ID, row.source_event_id) ||
      !exact(ID, row.event_id) ||
      !exact(ID, row.author_fellow_id) ||
      !Number.isSafeInteger(row.source_seq) ||
      row.source_seq < 1 ||
      !Number.isSafeInteger(row.seq) ||
      row.seq <= row.source_seq ||
      row.seq > through ||
      !Number.isSafeInteger(row.object_version) ||
      row.object_version < 1 ||
      seen.has(row.dead_end_id) ||
      (previous !== undefined &&
        (row.seq < previous.seq || (row.seq === previous.seq && row.dead_end_id <= previous.id)))
    )
      throw new Error("RETRY_ADMISSIONS_INVALID");
    seen.add(row.dead_end_id);
    previous = { seq: row.seq, id: row.dead_end_id };
    const sourcePayload = await verifiedRetryPayload(row.source_json, row.source_digest);
    const eventPayload = await verifiedRetryPayload(row.payload_json, row.payload_sha256);
    const source = sourcePayload && dependencies.decodeSource(sourcePayload);
    if (
      !source ||
      !eventPayload ||
      !source.retry_when ||
      (sourcePayload?.dead_end_id !== undefined && sourcePayload.dead_end_id !== row.dead_end_id) ||
      source.retry_when.kind !== row.trigger_kind
    ) {
      omitted.add("content_unavailable");
      continue;
    }
    if (!retryEventMatches(row, source.retry_when, eventPayload)) {
      omitted.add("condition_unavailable");
      continue;
    }
    const condition = await dependencies.condition(
      db,
      row,
      source.retry_when,
      eventPayload,
      through,
    );
    if (condition !== "holds") {
      if (condition === "unavailable") omitted.add("condition_unavailable");
      continue;
    }
    const available = await db
      .prepare(RETRY_AVAILABLE_SQL)
      .bind(
        JSON.stringify([
          {
            event_id: row.source_event_id,
            digest: row.source_digest,
            payload_json: row.source_json,
          },
          { event_id: row.event_id, digest: row.payload_sha256, payload_json: row.payload_json },
        ]),
        problem,
        through,
        row.dead_end_id,
      )
      .first<{ available: number }>();
    if (available?.available !== 2) {
      omitted.add("content_unavailable");
      continue;
    }
    items.push({
      problem_id: problem,
      cursor: through,
      dead_end_id: row.dead_end_id,
      author_fellow_id: row.author_fellow_id,
      source: { ...source, retry_when: source.retry_when },
      publication: {
        event_id: row.source_event_id,
        seq: row.source_seq,
        payload_sha256: row.source_digest,
      },
      firing: { event_id: row.event_id, seq: row.seq, payload_sha256: row.payload_sha256 },
    });
  }
  const next = rows.length > RETRY_PAGE_SIZE ? (previous ?? null) : null;
  if (next) omitted.add("page_limit");
  return { items, next, omitted: [...omitted] };
}

/** Envelope and exact reference checks precede scientific evaluation. An
 * arbitrary event with the right timestamp cannot stand in for a firing. */
export function retryEventMatches(
  row: RetryAdmission,
  trigger: DeadEndRetryWhen,
  payload: Record<string, unknown>,
): boolean {
  switch (trigger.kind) {
    case "statement-revised":
      return (
        row.event_type === "problem.statement-revised" &&
        row.object_kind === "problem" &&
        row.object_id === row.problem_id &&
        row.object_version > 1
      );
    case "gap-closed":
      return (
        row.event_type === "gap.closed-by" &&
        row.object_kind === "gap" &&
        row.object_id === trigger.gap_id &&
        payload.gap_id === trigger.gap_id &&
        payload.outcome === "closed-by"
      );
    case "claim-reaches":
      if (row.event_type === "claim.revised")
        return (
          row.object_kind === "claim" &&
          row.object_id === trigger.claim_id &&
          payload.claim_id === trigger.claim_id
        );
      if (row.event_type === "review.created")
        return row.object_kind === "review" && payload.target_claim_id === trigger.claim_id;
      if (row.event_type === "evidence.created")
        return (
          row.object_kind === "evidence" &&
          payload.bears_on_kind === "claim" &&
          payload.bears_on_id === trigger.claim_id
        );
      return (
        row.event_type === "object.retracted" &&
        row.object_kind === "retraction" &&
        typeof payload.target_object === "string" &&
        (payload.target_object === trigger.claim_id ||
          new RegExp(`^${trigger.claim_id}@[1-9][0-9]*$`).exec(payload.target_object)?.[0] ===
            payload.target_object)
      );
  }
}
