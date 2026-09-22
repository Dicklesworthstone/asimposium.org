import { EVENT_TAIL_PROBLEM_PATTERN } from "../../../../packages/contracts/src/event-tail-model.ts";

/** This synchronous download is bounded; larger ledgers use paginated event faces. */
export const PUBLIC_EXPORT_MAX_EVENTS = 10_000;
export const PUBLIC_EXPORT_MAX_BYTES = 8 * 1024 * 1024;
const PAYLOAD_CHUNK = 50;
const MAX_PAYLOAD_CHARACTERS = 16_384; // The canonical v3 parser's payload limit.

/** Read-only structural D1 boundary; also executable against actual SQLite. */
export interface PublicExportDatabase {
  prepare(sql: string): {
    bind(...values: (string | number | null)[]): {
      all<T>(): Promise<{ results: T[] }>;
    };
  };
}
export interface PublicExportCut {
  readonly problemId: string;
  readonly through: number;
  readonly unlisted: boolean;
}
export interface PublicExportEventRef {
  readonly eventId: string;
  readonly problemId: string;
  readonly seq: number;
  readonly payloadSha256: string;
}

/** Never include payloads, private state, identifiers or database errors in diagnostics. */
export class PublicExportUnavailableError extends Error {
  constructor() {
    super("PUBLIC_EXPORT_UNAVAILABLE");
  }
}

function validateCut(cut: PublicExportCut): void {
  if (
    !EVENT_TAIL_PROBLEM_PATTERN.test(cut.problemId) ||
    !Number.isSafeInteger(cut.through) ||
    cut.through < 0 ||
    cut.through > PUBLIC_EXPORT_MAX_EVENTS ||
    typeof cut.unlisted !== "boolean"
  ) throw new PublicExportUnavailableError();
}

/** Capture a finite public cut before reading pages; no tail-chasing under appends. */
export async function readPublicExportCut(
  db: PublicExportDatabase,
  problemId: string,
): Promise<PublicExportCut> {
  if (!EVENT_TAIL_PROBLEM_PATTERN.test(problemId)) throw new PublicExportUnavailableError();
  const result = await db.prepare(`SELECT
    CASE WHEN typeof(public_seq) = 'integer' AND public_seq BETWEEN 0 AND ?
      THEN public_seq END AS through, unlisted
    FROM problems WHERE id = ? AND status != 'private-draft'`)
    .bind(PUBLIC_EXPORT_MAX_EVENTS, problemId)
    .all<{ through: number | null; unlisted: number }>();
  const row = result.results[0];
  if (result.results.length !== 1 || !row || row.through === null ||
    (row.unlisted !== 0 && row.unlisted !== 1)) throw new PublicExportUnavailableError();
  const cut = { problemId, through: row.through, unlisted: row.unlisted === 1 };
  validateCut(cut);
  return cut;
}

/** v3 needs every sequence and its exact payload. A partial prefix is not an archive. */
export async function collectPublicExportEvents<T extends PublicExportEventRef>(
  cut: PublicExportCut,
  readPage: (afterSeq: number, limit: number) => Promise<readonly T[]>,
  signal?: AbortSignal,
): Promise<T[]> {
  validateCut(cut);
  const events: T[] = [];
  const ids = new Set<string>();
  let bytes = 0;
  while (events.length < cut.through) {
    signal?.throwIfAborted();
    const limit = Math.min(200, cut.through - events.length);
    const page = await readPage(events.length, limit);
    if (page.length !== limit) throw new PublicExportUnavailableError();
    for (const event of page) {
      if (event.problemId !== cut.problemId || event.seq !== events.length + 1 ||
        typeof event.eventId !== "string" || event.eventId.length === 0 ||
        ids.has(event.eventId) || !/^[a-f0-9]{64}$/.test(event.payloadSha256)) {
        throw new PublicExportUnavailableError();
      }
      bytes += new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (bytes > PUBLIC_EXPORT_MAX_BYTES) throw new PublicExportUnavailableError();
      ids.add(event.eventId);
      events.push(event);
    }
  }
  signal?.throwIfAborted();
  return events;
}

/** Read content and publication authority in the same SELECT. Missing/redacted,
 * wrong-problem, digest-detached and oversized content cannot become a `{}` placeholder.
 */
export async function readPublicExportPayloads(
  db: PublicExportDatabase,
  cut: PublicExportCut,
  events: readonly PublicExportEventRef[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  validateCut(cut);
  if (events.length !== cut.through || new Set(events.map((e) => e.eventId)).size !== events.length ||
    events.some((e, i) => e.problemId !== cut.problemId || e.seq !== i + 1)) {
    throw new PublicExportUnavailableError();
  }
  const payloads = new Map<string, string>();
  let bytes = 0;
  for (let offset = 0; offset < events.length; offset += PAYLOAD_CHUNK) {
    signal?.throwIfAborted();
    const chunk = events.slice(offset, offset + PAYLOAD_CHUNK);
    const rows = await db.prepare(`SELECT e.id AS event_id, e.seq,
      e.payload_sha256, c.payload_json
      FROM problems p JOIN events e ON e.problem_id = p.id
      JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
      WHERE p.id = ? AND p.status != 'private-draft' AND typeof(p.public_seq) = 'integer'
        AND p.public_seq BETWEEN ? AND 9007199254740991
        AND e.seq > 0 AND e.seq <= ? AND c.redacted_at IS NULL
        AND typeof(c.payload_json) = 'text' AND length(c.payload_json) <= ?
        AND length(CAST(c.payload_json AS BLOB)) <= ?
        AND e.id IN (${chunk.map(() => "?").join(", ")}) ORDER BY e.seq`)
      .bind(cut.problemId, cut.through, cut.through, MAX_PAYLOAD_CHARACTERS,
        MAX_PAYLOAD_CHARACTERS * 4, ...chunk.map((event) => event.eventId))
      .all<{ event_id: string; seq: number; payload_sha256: string; payload_json: string }>();
    if (rows.results.length !== chunk.length) throw new PublicExportUnavailableError();
    for (const [index, row] of rows.results.entries()) {
      const event = chunk[index];
      if (!event || row.event_id !== event.eventId || row.seq !== event.seq ||
        row.payload_sha256 !== event.payloadSha256 || typeof row.payload_json !== "string" ||
        row.payload_json.length > MAX_PAYLOAD_CHARACTERS) throw new PublicExportUnavailableError();
      const payloadBytes = new TextEncoder().encode(row.payload_json);
      bytes += payloadBytes.byteLength;
      if (bytes > PUBLIC_EXPORT_MAX_BYTES) throw new PublicExportUnavailableError();
      const digest = await crypto.subtle.digest("SHA-256", payloadBytes);
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      if (hash !== event.payloadSha256) throw new PublicExportUnavailableError();
      payloads.set(event.eventId, row.payload_json);
    }
  }
  signal?.throwIfAborted();
  return payloads;
}

/** Check every snapshot row again immediately before serving bytes/304. A
 * withdrawal during payload reads or compression wins over a previously built body.
 * Events/content digests are immutable; redaction and visibility are not.
 */
export async function revalidatePublicExportCut(
  db: PublicExportDatabase,
  cut: PublicExportCut,
): Promise<{ unlisted: boolean }> {
  validateCut(cut);
  const result = await db.prepare(`SELECT p.unlisted, COUNT(e.id) AS event_count,
    COUNT(c.event_id) AS content_count
    FROM problems p
    LEFT JOIN events e ON e.problem_id = p.id AND e.seq > 0 AND e.seq <= ?
    LEFT JOIN event_content c ON c.event_id = e.id
      AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
      AND typeof(c.payload_json) = 'text'
    WHERE p.id = ? AND p.status != 'private-draft' AND typeof(p.public_seq) = 'integer'
        AND p.public_seq BETWEEN ? AND 9007199254740991
    GROUP BY p.id, p.unlisted`)
    .bind(cut.through, cut.problemId, cut.through)
    .all<{ unlisted: number; event_count: number; content_count: number }>();
  const row = result.results[0];
  if (result.results.length !== 1 || !row || row.event_count !== cut.through ||
    row.content_count !== cut.through || (row.unlisted !== 0 && row.unlisted !== 1)) {
    throw new PublicExportUnavailableError();
  }
  return { unlisted: cut.unlisted || row.unlisted === 1 };
}
