import type { GapFileRequest, GapTransitionRequest } from "@asimposium/contracts";
import type { ProofGapEvent, ProofGapRecord, ProofGapsQuery, ProofGapsResponse } from "@asimposium/contracts/proof-gaps";
import type { D1Database } from "@cloudflare/workers-types";

const PAGE_SIZE = 8;
const MAX_CONTENT_BYTES = 16384;
export class ProofGapReadError extends Error {
  constructor(readonly code: "query" | "not-found" | "unavailable") {
    super(`PROOF_GAPS_${code}`);
  }
}
/** Production supplies the existing write schemas. These are decoders, not a
 * scientific evaluator: a recorded closure is not independent verification. */
export interface ProofGapDecoders {
  filed(value: unknown): GapFileRequest | null;
  settled(value: unknown): GapTransitionRequest | null;
}
export interface ProofGapPage {
  face: ProofGapsResponse;
  unlisted: boolean;
  problemStatus: string;
}
interface Head { id: string; public_seq: number; unlisted: number; status: string }
interface Row {
  gap_id: string;
  event_count: number;
  filed_version: number;
  last_version: number;
  last_type: string;
  filing_json: string;
  last_json: string;
  filed_body: string | null;
  last_body: string | null;
}
export const PROOF_GAPS_HEAD_SQL = `SELECT id, public_seq, unlisted, status FROM problems
  WHERE id = ? AND status <> 'private-draft'`;
const eventJson = (alias: string) => `json_object(
  'event_id', ${alias}.id, 'seq', ${alias}.seq, 'payload_sha256', ${alias}.payload_sha256,
  'created_at', ${alias}.created_at, 'fellow_id', ${alias}.actor_fellow_id,
  'sponsor_id', ${alias}.actor_sponsor_id, 'session_id', ${alias}.actor_session_id,
  'model_string_self_declared', ${alias}.model_string_self_declared, 'harness', ${alias}.harness)`;

/** Fixed query text; only bound values vary. Eight admissions plus lookahead,
 * two bounded bodies per admission, and at most three envelope-count rows.
 * The event stream, not proof_gaps, determines both content and lifecycle. */
export function proofGapsSql(unowned: boolean): string {
  return `WITH cut AS (
    SELECT id, ? AS cursor FROM problems WHERE id = ? AND public_seq >= ? AND status <> 'private-draft'
  ), admitted AS (
    SELECT g.* FROM cut JOIN events g ON g.problem_id = cut.id
    WHERE g.object_kind = 'gap' AND g.type = 'gap.filed' AND g.seq <= cut.cursor
      AND g.seq > ? AND (? IS NULL OR g.object_id = ?)
      AND g.seq = (SELECT MIN(a.seq) FROM events a WHERE a.problem_id = g.problem_id
        AND a.object_kind = 'gap' AND a.object_id = g.object_id AND a.type = 'gap.filed')
      ${unowned ? `AND NOT EXISTS (SELECT 1 FROM events done WHERE done.problem_id = g.problem_id
        AND done.object_kind = 'gap' AND done.object_id = g.object_id
        AND done.seq > g.seq AND done.seq <= cut.cursor
        AND done.type IN ('gap.closed-by', 'gap.withdrawn'))
      AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.problem_id = g.problem_id
        AND (l.object_id = g.object_id OR l.object_ref = g.object_id)
        AND l.status = 'active' AND l.leased_until > ?)` : ""}
    ORDER BY g.seq, g.id LIMIT 9
  )
  SELECT g.object_id AS gap_id, g.object_version AS filed_version,
    h.object_version AS last_version, h.type AS last_type,
    (SELECT COUNT(*) FROM (SELECT 1 FROM events n WHERE n.problem_id = g.problem_id
      AND n.object_kind = 'gap' AND n.object_id = g.object_id AND n.seq <= cut.cursor LIMIT 3)) AS event_count,
    ${eventJson("g")} AS filing_json, ${eventJson("h")} AS last_json,
    CASE WHEN c.redacted_at IS NULL AND length(CAST(c.payload_json AS BLOB)) <= ${MAX_CONTENT_BYTES}
      THEN c.payload_json END AS filed_body,
    CASE WHEN hc.redacted_at IS NULL AND length(CAST(hc.payload_json AS BLOB)) <= ${MAX_CONTENT_BYTES}
      THEN hc.payload_json END AS last_body
  FROM admitted g JOIN cut ON cut.id = g.problem_id
  JOIN events h ON h.id = (SELECT n.id FROM events n WHERE n.problem_id = g.problem_id
    AND n.object_kind = 'gap' AND n.object_id = g.object_id AND n.seq <= cut.cursor
    ORDER BY n.seq DESC LIMIT 1)
  LEFT JOIN event_content c ON c.event_id = g.id AND c.payload_sha256 = g.payload_sha256
  LEFT JOIN event_content hc ON hc.event_id = h.id AND hc.payload_sha256 = h.payload_sha256
  ORDER BY g.seq, g.id`;
}
export async function gapPayload(text: string | null, expected: string): Promise<unknown | undefined> {
  if (typeof text !== "string" || text.length > MAX_CONTENT_BYTES || !/^[0-9a-f]{64}$/.test(expected)) return undefined;
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MAX_CONTENT_BYTES) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  if ([...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("") !== expected) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}
function exact(pattern: RegExp, value: unknown): value is string {
  return typeof value === "string" && pattern.exec(value)?.[0] === value;
}
function event(value: string, cursor: number): ProofGapEvent {
  const row = JSON.parse(value) as ProofGapEvent;
  if (!row || !exact(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, row.event_id) ||
      !Number.isSafeInteger(row.seq) || row.seq < 1 || row.seq > cursor ||
      !exact(/^[0-9a-f]{64}$/, row.payload_sha256) ||
      typeof row.created_at !== "string" || !Number.isFinite(Date.parse(row.created_at)) ||
      new Date(row.created_at).toISOString() !== row.created_at) throw new ProofGapReadError("unavailable");
  return row;
}
function checkedHead(head: Head | null, problem: string): Head {
  if (!head) throw new ProofGapReadError("not-found");
  if (head.id !== problem || !Number.isSafeInteger(head.public_seq) || head.public_seq < 0 ||
      ![0, 1].includes(head.unlisted) || typeof head.status !== "string" || head.status === "private-draft") {
    throw new ProofGapReadError("unavailable");
  }
  return head;
}

/** unownedAt is a server clock used only for move selection. It is NOT a
 * public query parameter. Current leases are never called historical facts. */
export async function readProofGaps(
  db: D1Database, problem: string, query: ProofGapsQuery, decoders: ProofGapDecoders,
  unownedAt?: string,
): Promise<ProofGapPage> {
  const after = query.after ?? 0;
  if (!exact(/^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/, problem) ||
      !Number.isSafeInteger(after) || after < 0 ||
      (query.through !== undefined && (!Number.isSafeInteger(query.through) || query.through < 0)) ||
      (query.target !== undefined && (!exact(/^G-[0-9]+$/, query.target) || query.after !== undefined)) ||
      (unownedAt !== undefined && (!Number.isFinite(Date.parse(unownedAt)) || new Date(unownedAt).toISOString() !== unownedAt))) {
    throw new ProofGapReadError("query");
  }
  const first = checkedHead(await db.prepare(PROOF_GAPS_HEAD_SQL).bind(problem).first<Head>(), problem);
  const cursor = query.through ?? first.public_seq;
  if (cursor > first.public_seq || after > cursor) throw new ProofGapReadError("query");
  const values: (string | number | null)[] = [cursor, problem, cursor, after, query.target ?? null, query.target ?? null];
  if (unownedAt !== undefined) values.push(unownedAt);
  // Recheck current privacy with the bodies in one read transaction. Later
  // appends cannot move this cut; present-day withdrawal always applies.
  const batch = await db.batch([
    db.prepare(PROOF_GAPS_HEAD_SQL).bind(problem),
    db.prepare(proofGapsSql(unownedAt !== undefined)).bind(...values),
  ]);
  if (batch.length !== 2 || !Array.isArray(batch[0]?.results) || batch[0].results.length > 1 ||
      !Array.isArray(batch[1]?.results) || batch[1].results.length > PAGE_SIZE + 1) throw new ProofGapReadError("unavailable");
  const head = checkedHead((batch[0].results[0] ?? null) as Head | null, problem);
  if (head.public_seq < cursor) throw new ProofGapReadError("unavailable");
  const rows = batch[1].results as unknown as Row[];
  const omitted = new Set<ProofGapsResponse["omitted"][number]>();
  const gaps: ProofGapRecord[] = [];
  let previous = after;
  const seen = new Set<string>();
  for (const row of rows.slice(0, PAGE_SIZE)) {
    const filing = event(row.filing_json, cursor), last = event(row.last_json, cursor);
    if (row.gap_id !== `G-${filing.seq}` || filing.seq <= previous || seen.has(row.gap_id) ||
        (query.target !== undefined && row.gap_id !== query.target)) throw new ProofGapReadError("unavailable");
    previous = filing.seq; seen.add(row.gap_id);
    const raw = await gapPayload(row.filed_body, filing.payload_sha256);
    const content = raw === undefined ? null : decoders.filed(raw);
    if (content === null) omitted.add("content_unavailable");
    let status: ProofGapRecord["status"] = "unavailable", closedBy: string | null = null;
    if (row.filed_version === 1 && row.last_version === 1 && row.event_count === 1 && last.event_id === filing.event_id && row.last_type === "gap.filed") {
      status = "open";
    } else if (row.filed_version === 1 && row.last_version === 1 && row.event_count === 2 && last.seq > filing.seq && ["gap.closed-by", "gap.withdrawn"].includes(row.last_type)) {
      status = row.last_type === "gap.closed-by" ? "closed-by" : "withdrawn";
      const settled = await gapPayload(row.last_body, last.payload_sha256);
      if (settled === undefined) omitted.add("content_unavailable");
      else {
        const outcome = decoders.settled(settled);
        if (!outcome || outcome.gap_id !== row.gap_id || outcome.outcome !== status) status = "unavailable";
        else closedBy = outcome.closed_by ?? null;
      }
    }
    if (status === "unavailable") omitted.add("history_unavailable");
    gaps.push({ gap_id: row.gap_id, status, filing, last_event: last, content, closed_by: closedBy });
  }
  const more = rows.length > PAGE_SIZE;
  if (more) omitted.add("page_limit");
  return {
    unlisted: head.unlisted === 1, problemStatus: head.status,
    face: { schema: "https://a.asimposium.org/schemas/proof-gaps.v1.json", problem_id: problem,
      cursor, after, target: query.target ?? null, next_after: more ? previous : null,
      gaps, omitted: [...omitted] },
  };
}
