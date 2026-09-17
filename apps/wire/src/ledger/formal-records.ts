import type { EvidenceRequest, ReviewRequest } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

export const FORMAL_RECORD_PAGE_SIZE = 8;
export const FORMAL_RECORD_MAX_BYTES = 262144;
export interface FormalRecordEvent {
  event_id: string;
  object_id: string;
  seq: number;
  payload_sha256: string;
  fellow_id: string;
  sponsor_id: string;
  session_id: string | null;
  model_string_self_declared: string | null;
  harness: string | null;
  created_at: string;
}
export interface FormalRecord {
  kind: "formal-artifact" | "formalization-friction" | "verification-report";
  publication: FormalRecordEvent;
  target: { claim_id: string; version: number };
  /** Declared work, not a server compilation, evidence class or scientific verdict. */
  content: EvidenceRequest | ReviewRequest;
}
export interface FormalRecordPage {
  problem_id: string;
  cursor: number;
  after: number;
  next_after: number | null;
  records: FormalRecord[];
  omitted: ("page_limit" | "content_unavailable" | "unsupported_record")[];
}
export interface FormalRecordDecoders {
  evidence(value: Record<string, unknown>): EvidenceRequest | null;
  review(value: Record<string, unknown>): ReviewRequest | null;
}
interface Row extends FormalRecordEvent {
  event_type: string;
  object_version: number;
  payload_json: string | null;
}
export interface FormalRecordRead extends FormalRecordPage {
  target: string | null;
  unlisted: boolean;
}
export class FormalRecordReadError extends Error {
  constructor(readonly code: "query" | "not-found" | "unavailable") {
    super(`FORMAL_RECORD_${code}`);
  }
}
interface Head {
  id: string;
  public_seq: number;
  status: string;
  unlisted: number;
}
export const FORMAL_RECORD_HEAD_SQL = `SELECT id, public_seq, status, unlisted FROM problems
  WHERE id = ? AND status <> 'private-draft'`;
// Scan admissions, not a mutable evidence kind or review-verification flag.
// Missing bytes cannot turn into a trustworthy empty formal record. LIMIT is
// before decoding; pages advance through ordinary and unavailable records.
export const FORMAL_RECORD_PAGE_SQL = `SELECT e.id AS event_id, e.object_id, e.seq,
  e.type AS event_type, e.object_version, e.payload_sha256,
  e.actor_fellow_id AS fellow_id, e.actor_sponsor_id AS sponsor_id,
  e.actor_session_id AS session_id, e.model_string_self_declared, e.harness, e.created_at,
  CASE WHEN c.redacted_at IS NULL AND length(CAST(c.payload_json AS BLOB)) <= ${FORMAL_RECORD_MAX_BYTES}
    THEN c.payload_json END AS payload_json
  FROM problems p JOIN events e ON e.problem_id = p.id
  LEFT JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
  WHERE p.id = ? AND p.status <> 'private-draft' AND p.public_seq >= ?
    AND e.seq > ? AND e.seq <= ?
    AND (? IS NULL OR e.object_id = ?)
    AND ((e.type = 'evidence.created' AND e.object_kind = 'evidence')
      OR (e.type = 'review.created' AND e.object_kind = 'review'))
  ORDER BY e.seq LIMIT ${FORMAL_RECORD_PAGE_SIZE + 1}`;

export async function formalRecordPayload(
  text: string | null,
  digest: string,
): Promise<Record<string, unknown> | null> {
  if (
    typeof text !== "string" ||
    text.length > FORMAL_RECORD_MAX_BYTES ||
    /^[0-9a-f]{64}$/.exec(digest)?.[0] !== digest
  )
    return null;
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > FORMAL_RECORD_MAX_BYTES) return null;
  const actual = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (actual !== digest) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
function exact(pattern: RegExp, value: unknown): value is string {
  return typeof value === "string" && pattern.exec(value)?.[0] === value;
}
function headValid(head: Head | undefined, problem: string, cursor: number): boolean {
  return (
    head?.id === problem &&
    head.status !== "private-draft" &&
    Number.isSafeInteger(head.public_seq) &&
    head.public_seq >= cursor &&
    [0, 1].includes(head.unlisted)
  );
}

/** The session owns the private context; this reader touches public ledger
 * events only. The caller supplies a captured cut. Privacy and content bytes
 * are rechecked together, and no projection or "certified" label is trusted. */
export async function readFormalRecords(
  db: D1Database,
  problem: string,
  cursor: number,
  decoders: FormalRecordDecoders,
  after = 0,
  target?: string,
): Promise<FormalRecordRead> {
  if (
    !exact(/^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/, problem) ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    !Number.isSafeInteger(after) ||
    after < 0 ||
    after > cursor ||
    (target !== undefined &&
      (!exact(/^[ER]-[A-Za-z0-9][A-Za-z0-9._:-]{0,125}$/, target) || after !== 0))
  )
    throw new Error("FORMAL_RECORD_QUERY_INVALID");
  const result = await db.batch([
    db.prepare(FORMAL_RECORD_HEAD_SQL).bind(problem),
    db
      .prepare(FORMAL_RECORD_PAGE_SQL)
      .bind(problem, cursor, after, cursor, target ?? null, target ?? null),
  ]);
  if (
    result.length !== 2 ||
    !Array.isArray(result[0]?.results) ||
    result[0].results.length !== 1 ||
    !headValid(result[0].results[0] as unknown as Head, problem, cursor) ||
    !Array.isArray(result[1]?.results) ||
    result[1].results.length > FORMAL_RECORD_PAGE_SIZE + 1
  )
    throw new Error("FORMAL_RECORD_SNAPSHOT_UNAVAILABLE");
  const rows = result[1].results as unknown as Row[];
  if (target !== undefined && (rows.length > 1 || rows.some((row) => row.object_id !== target)))
    throw new FormalRecordReadError("unavailable");
  const records: FormalRecord[] = [];
  const omitted = new Set<FormalRecordPage["omitted"][number]>();
  let previous = after;
  const seen = new Set<string>();
  for (const row of rows.slice(0, FORMAL_RECORD_PAGE_SIZE)) {
    if (
      !Number.isSafeInteger(row.seq) ||
      row.seq <= previous ||
      row.seq > cursor ||
      !exact(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, row.event_id) ||
      seen.has(row.event_id) ||
      !exact(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, row.fellow_id) ||
      !exact(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, row.sponsor_id)
    )
      throw new Error("FORMAL_RECORD_ENVELOPE_INVALID");
    previous = row.seq;
    seen.add(row.event_id);
    const payload = await formalRecordPayload(row.payload_json, row.payload_sha256);
    if (!payload) {
      omitted.add("content_unavailable");
      continue;
    }
    if (row.object_version !== 1) {
      omitted.add("unsupported_record");
      continue;
    }
    let kind: FormalRecord["kind"],
      content: FormalRecord["content"],
      target: FormalRecord["target"];
    if (row.event_type === "evidence.created") {
      if (
        !exact(/^E-[A-Za-z0-9]+$/, row.object_id) ||
        (payload.evidence_id !== undefined && payload.evidence_id !== row.object_id)
      ) {
        omitted.add("unsupported_record");
        continue;
      }
      if (payload.kind !== "formalization-friction" && payload.formal_artifact == null) continue;
      const evidence = decoders.evidence(payload);
      if (
        !evidence ||
        evidence.bears_on_kind !== "claim" ||
        (evidence.kind !== "formalization-friction" && evidence.formal_artifact === undefined)
      ) {
        omitted.add("unsupported_record");
        continue;
      }
      content = evidence;
      kind = evidence.formal_artifact === undefined ? "formalization-friction" : "formal-artifact";
      target = { claim_id: evidence.bears_on_id, version: evidence.bears_on_version };
    } else if (row.event_type === "review.created") {
      if (
        !exact(/^R-[A-Za-z0-9][A-Za-z0-9._:-]{0,125}$/, row.object_id) ||
        (payload.review_id !== undefined && payload.review_id !== row.object_id)
      ) {
        omitted.add("unsupported_record");
        continue;
      }
      if (payload.verification === null || payload.verification === undefined) continue;
      const review = decoders.review(payload);
      if (!review?.verification) {
        omitted.add("unsupported_record");
        continue;
      }
      content = review;
      kind = "verification-report";
      target = { claim_id: review.target_claim_id, version: review.target_version };
    } else {
      omitted.add("unsupported_record");
      continue;
    }
    if (
      !exact(/^C-[0-9]+$/, target.claim_id) ||
      !Number.isSafeInteger(target.version) ||
      target.version < 1
    ) {
      omitted.add("unsupported_record");
      continue;
    }
    const {
      event_type: _type,
      object_version: _version,
      payload_json: _bytes,
      ...publication
    } = row;
    records.push({ kind, publication, target, content });
  }
  const next = rows.length > FORMAL_RECORD_PAGE_SIZE ? previous : null;
  if (next !== null) omitted.add("page_limit");
  return {
    problem_id: problem,
    cursor,
    after,
    next_after: next,
    records,
    omitted: [...omitted],
    target: target ?? null,
    unlisted: (result[0].results[0] as unknown as Head).unlisted === 1,
  };
}

/** Public full-read entry: capture a cut only when the caller did not provide
 * one. The record reader rechecks current visibility together with its bytes.
 * A private/missing problem never becomes a distinguishable empty record list. */
export async function readFormalRecordResource(
  db: D1Database,
  problem: string,
  query: { through?: number; after?: number; target?: string },
  decoders: FormalRecordDecoders,
): Promise<FormalRecordRead> {
  if (
    !exact(/^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/, problem) ||
    (query.through !== undefined && (!Number.isSafeInteger(query.through) || query.through < 0)) ||
    (query.after !== undefined && (!Number.isSafeInteger(query.after) || query.after < 0)) ||
    (query.target !== undefined &&
      (!exact(/^[ER]-[A-Za-z0-9][A-Za-z0-9._:-]{0,125}$/, query.target) ||
        query.after !== undefined))
  )
    throw new FormalRecordReadError("query");
  const head = await db.prepare(FORMAL_RECORD_HEAD_SQL).bind(problem).first<Head>();
  if (!head) throw new FormalRecordReadError("not-found");
  if (!headValid(head, problem, 0)) throw new FormalRecordReadError("unavailable");
  const cursor = query.through ?? head.public_seq;
  if (cursor > head.public_seq || (query.after ?? 0) > cursor)
    throw new FormalRecordReadError("query");
  const result = await readFormalRecords(
    db,
    problem,
    cursor,
    decoders,
    query.after ?? 0,
    query.target,
  );
  if (query.target !== undefined && result.records.length === 0 && result.omitted.length === 0)
    throw new FormalRecordReadError("not-found");
  return result;
}
