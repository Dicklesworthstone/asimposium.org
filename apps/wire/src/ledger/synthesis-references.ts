import type { SynthesisAnchor } from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";

const MAX_ANCHORS = 1000;
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 4 * 1024 * 1024;
const GUARDS_PER_STATEMENT = 16;

export interface SynthesisAnchorSource {
  readonly eventId: string;
  readonly payloadDigest: string;
  readonly payloadJson: string;
  readonly problemId: string;
  readonly seq: number;
}

export interface SynthesisValidationResult {
  readonly valid: boolean;
  readonly unanchored: readonly string[];
  readonly maxLedgerSeq: number;
  readonly reason?: string;
  /** Every accepted reference is normalized to one immutable publication. */
  readonly anchors: readonly SynthesisAnchor[];
  /** Ephemeral source witnesses; never written into the public synthesis. */
  readonly sources: readonly SynthesisAnchorSource[];
}

const ANCHOR_TYPES = {
  claim: ["claim.created", "claim.revised", "claim.reanchored"],
  evidence: ["evidence.created"],
  review: ["review.created"],
  hypothesis: ["hypothesis.created", "hypothesis.killed", "hypothesis.deferred", "hypothesis.resumed", "hypothesis.narrowed", "hypothesis.superseded"],
  "dead-end": ["dead_end.recorded"],
  gap: ["gap.filed", "gap.closed-by", "gap.withdrawn"],
  conflict: ["conflict.normalized", "conflict.resolved"],
  citation: ["citation.recorded", "citation.corrected"],
  statement: ["problem.admitted", "problem.statement-revised"],
} as const;

interface AnchorRow {
  anchor_index: number;
  event_id: string | null;
}
interface SourceRow {
  event_id: string;
  object_id: string;
  object_version: number;
  seq: number;
  payload_sha256: string;
  source_bytes: number | null;
  payload_json: string | null;
}

/** Resolve at a frozen public cut before applying current content controls.
 * In particular, a hidden latest publication must not silently fall back to
 * an older visible one. Historical references identify publications; they do
 * not assert that a retracted finding still earns scientific standing. */
export async function validateSynthesisAnchors(
  db: D1Database,
  problemId: string,
  coversThrough: number,
  anchors: readonly SynthesisAnchor[],
): Promise<SynthesisValidationResult> {
  const scope = await db
    .prepare(`SELECT public_seq AS max_seq FROM problems
    WHERE id = ? AND status <> 'private-draft' AND typeof(public_seq) = 'integer'
      AND NOT ${hiddenByContentControlSql("problems.id", "'problem'")}
      AND NOT ${hiddenByContentControlSql("problems.id", "problems.id")}`)
    .bind(problemId)
    .first<{ max_seq: number }>();
  const maxLedgerSeq =
    scope && Number.isSafeInteger(scope.max_seq) && scope.max_seq >= 0 ? scope.max_seq : 0;
  const refuse = (unanchored: readonly string[], reason: string): SynthesisValidationResult => ({
    valid: false,
    unanchored,
    maxLedgerSeq,
    reason,
    anchors: [],
    sources: [],
  });
  if (
    !scope ||
    !Number.isSafeInteger(coversThrough) ||
    coversThrough < 0 ||
    coversThrough > maxLedgerSeq
  )
    return refuse(
      [],
      `covers_through ${coversThrough} exceeds highest recorded problem sequence ${maxLedgerSeq}, or its public scope is unavailable`,
    );
  if (
    anchors.length > MAX_ANCHORS ||
    anchors.some(
      (anchor) =>
        !Object.hasOwn(ANCHOR_TYPES, anchor.target_kind) ||
        (anchor.target_version !== undefined &&
          (!Number.isSafeInteger(anchor.target_version) || anchor.target_version < 1)) ||
        (anchor.target_seq !== undefined &&
          (!Number.isSafeInteger(anchor.target_seq) || anchor.target_seq < 1)),
    )
  )
    return refuse([], "Synthesis anchors must be bounded, supported exact publication references.");
  if (anchors.length === 0)
    return maxLedgerSeq > 0
      ? refuse(
          ["EMPTY_ANCHORS"],
          "A synthesis on a problem with recorded events must reference at least one anchor",
        )
      : { valid: true, unanchored: [], maxLedgerSeq, anchors: [], sources: [] };

  const requests = anchors.map((anchor) => ({
    ...anchor,
    object_kind:
      anchor.target_kind === "statement"
        ? "problem"
        : anchor.target_kind === "dead-end"
          ? "dead_end"
          : anchor.target_kind,
    event_types: ANCHOR_TYPES[anchor.target_kind],
  }));
  const selected = (
    await db
      .prepare(`SELECT CAST(a.key AS INTEGER) AS anchor_index,
    (SELECT e.id FROM events e WHERE e.problem_id = ? AND e.seq <= ?
      AND e.object_id = json_extract(a.value, '$.target_id')
      AND e.object_kind = json_extract(a.value, '$.object_kind')
      AND e.type IN (SELECT value FROM json_each(json_extract(a.value, '$.event_types')))
      AND (json_extract(a.value, '$.target_version') IS NULL
        OR e.object_version = json_extract(a.value, '$.target_version'))
      AND (json_extract(a.value, '$.target_seq') IS NULL
        OR e.seq = json_extract(a.value, '$.target_seq'))
      ORDER BY e.seq DESC LIMIT 1) AS event_id
    FROM json_each(?) a ORDER BY CAST(a.key AS INTEGER)`)
      .bind(problemId, coversThrough, JSON.stringify(requests))
      .all<AnchorRow>()
  ).results;
  if (
    !Array.isArray(selected) ||
    selected.length !== anchors.length ||
    selected.some((row, index) => row.anchor_index !== index)
  )
    return refuse([], "The synthesis reference snapshot could not be established.");
  const ids = [
    ...new Set(selected.flatMap((row) => (row.event_id === null ? [] : [row.event_id]))),
  ];
  // Transfer each source body once, even when several assertions cite it.
  // Bound both individual and aggregate UTF-8 bytes before reading into JS.
  const rows =
    ids.length === 0
      ? []
      : (
          await db
            .prepare(`
    WITH admitted AS MATERIALIZED (
      SELECT e.id AS event_id, e.object_id, e.object_version, e.seq, e.payload_sha256,
        CASE WHEN c.event_id IS NOT NULL AND c.redacted_at IS NULL
          AND NOT ${eventContentHiddenSql("e")}
          THEN length(CAST(c.payload_json AS BLOB)) END AS source_bytes
      FROM json_each(?) wanted JOIN events e ON e.id = wanted.value
      JOIN problems p ON p.id = e.problem_id AND p.status <> 'private-draft'
      LEFT JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
      WHERE e.problem_id = ? AND e.seq <= ? AND e.seq <= p.public_seq
        AND NOT ${hiddenByContentControlSql("p.id", "p.id")}
    ), bounded AS MATERIALIZED (
      SELECT *, SUM(CASE WHEN source_bytes <= ${MAX_SOURCE_BYTES} THEN source_bytes ELSE 0 END)
        OVER (ORDER BY seq) AS total_bytes FROM admitted
    ) SELECT b.*, CASE WHEN b.source_bytes <= ${MAX_SOURCE_BYTES}
      AND b.total_bytes <= ${MAX_TOTAL_SOURCE_BYTES} THEN c.payload_json END AS payload_json
    FROM bounded b LEFT JOIN event_content c ON c.event_id = b.event_id
      AND c.payload_sha256 = b.payload_sha256
      AND b.source_bytes <= ${MAX_SOURCE_BYTES} AND b.total_bytes <= ${MAX_TOTAL_SOURCE_BYTES}
    ORDER BY b.seq`)
            .bind(JSON.stringify(ids), problemId, coversThrough)
            .all<SourceRow>()
        ).results;
  const available = new Map<string, SourceRow>();
  for (const row of rows) {
    if (
      row.payload_json === null ||
      typeof row.payload_json !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.payload_sha256) ||
      !Number.isSafeInteger(row.object_version) ||
      row.object_version < 1 ||
      !Number.isSafeInteger(row.seq) ||
      row.seq < 1 ||
      row.seq > coversThrough
    )
      continue;
    const bytes = new TextEncoder().encode(row.payload_json);
    if (bytes.byteLength > MAX_SOURCE_BYTES || bytes.byteLength !== row.source_bytes) continue;
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    if (
      [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("") !==
      row.payload_sha256
    )
      continue;
    try {
      const payload: unknown = JSON.parse(row.payload_json);
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
    } catch {
      continue;
    }
    available.set(row.event_id, row);
  }
  const normalized: SynthesisAnchor[] = [];
  const unanchored: string[] = [];
  for (const [index, anchor] of anchors.entries()) {
    const eventId = selected[index]?.event_id;
    const source = eventId ? available.get(eventId) : undefined;
    if (
      !source ||
      source.object_id !== anchor.target_id ||
      (anchor.target_version !== undefined && source.object_version !== anchor.target_version) ||
      (anchor.target_seq !== undefined && source.seq !== anchor.target_seq)
    ) {
      unanchored.push(anchor.target_id);
      continue;
    }
    normalized.push({ ...anchor, target_version: source.object_version, target_seq: source.seq });
  }
  if (unanchored.length > 0)
    return refuse(
      unanchored,
      "Anchors must identify currently public, digest-verified publications within the frozen synthesis window and source-byte budget.",
    );
  return {
    valid: true,
    unanchored: [],
    maxLedgerSeq,
    anchors: normalized,
    sources: [...available.values()].map((row) => ({
      eventId: row.event_id,
      payloadDigest: row.payload_sha256,
      payloadJson: row.payload_json as string,
      problemId,
      seq: row.seq,
    })),
  };
}

/** Keep the exact source witnesses available in the synthesis publication
 * transaction. Current controls/redactions win, while later publications do
 * not move the frozen cut. This is reference admission, not a standing vote. */
export function synthesisAnchorGuards(
  db: D1Database,
  problemId: string,
  coversThrough: number,
  sources: readonly SynthesisAnchorSource[],
): D1PreparedStatement[] {
  const guards: D1PreparedStatement[] = [];
  if (sources.length > MAX_ANCHORS) throw new Error("SYNTHESIS_REFERENCE_CHANGED");
  for (let offset = 0; offset < sources.length; offset += GUARDS_PER_STATEMENT) {
    const chunk = sources.slice(offset, offset + GUARDS_PER_STATEMENT);
    guards.push(
      db
        .prepare(`WITH expected(event_id,digest,body,seq) AS (
      VALUES ${chunk.map(() => "(?,?,?,?)").join(",")}
    ) SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM expected w WHERE NOT EXISTS (
        SELECT 1 FROM events e JOIN event_content c ON c.event_id = e.id
          AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
        JOIN problems p ON p.id = e.problem_id AND p.status <> 'private-draft'
        WHERE e.id = w.event_id AND e.payload_sha256 = w.digest AND e.seq = w.seq
          AND c.payload_json = w.body AND e.problem_id = ? AND e.seq <= ?
          AND e.seq <= p.public_seq AND NOT ${eventContentHiddenSql("e")}
          AND NOT ${hiddenByContentControlSql("p.id", "p.id")}
      )
    ) THEN 1 ELSE json_extract('[]', '$[SYNTHESIS_REFERENCE_CHANGED') END`)
        .bind(
          ...chunk.flatMap((source) => [
            source.eventId,
            source.payloadDigest,
            source.payloadJson,
            source.seq,
          ]),
          problemId,
          coversThrough,
        ),
    );
  }
  return guards;
}

export function isSynthesisReferenceChanged(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("SYNTHESIS_REFERENCE_CHANGED") ||
      (error.cause !== undefined && isSynthesisReferenceChanged(error.cause)))
  );
}
