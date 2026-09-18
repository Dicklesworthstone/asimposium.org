import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { GroundingWitness } from "./evidence-grounding.ts";

export interface GuardedScientificIdentity {
  readonly eventId: string;
  readonly payloadDigest: string;
  /** Exact, digest-verified source bytes captured by admission, never logged. */
  readonly payloadJson?: string;
  readonly problemId?: string;
  readonly groundingWitnesses?: readonly GroundingWitness[];
}
const IDENTITIES_PER_STATEMENT = 16; // Four parameters each, below D1's 100.
const MAX_IDENTITIES = 256;
const MAX_BYTES = 4 * 1024 * 1024;
export class ScientificGuardError extends Error {
  constructor() {
    super("SCIENTIFIC_REFERENCE_CHANGED: inconsistent or unbounded publication witnesses");
  }
}

/** Recheck the complete resolved graph INSIDE the event/projection/replay
 * batch. Shared ancestors count once. Conflicting read snapshots fail rather
 * than letting Map insertion order choose a digest or discard stronger pins.
 * Each statement is bounded without serializing source JSON into another JSON
 * parameter; even heavily escaped 512 KiB work products fit D1's row limit. */
export function prepareScientificContentGuards(
  db: D1Database,
  inputs: readonly GuardedScientificIdentity[],
): D1PreparedStatement[] {
  const unique = new Map<string, GuardedScientificIdentity>();
  let bytes = 0;
  const add = (candidate: GuardedScientificIdentity) => {
    if (
      !candidate ||
      typeof candidate.eventId !== "string" ||
      candidate.eventId.length < 1 ||
      candidate.eventId.length > 160 ||
      typeof candidate.payloadDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(candidate.payloadDigest) ||
      (candidate.payloadJson !== undefined && typeof candidate.payloadJson !== "string") ||
      (candidate.problemId !== undefined &&
        (typeof candidate.problemId !== "string" || candidate.problemId.length > 160))
    )
      throw new ScientificGuardError();
    const prior = unique.get(candidate.eventId);
    if (
      prior &&
      (prior.payloadDigest !== candidate.payloadDigest ||
        (prior.payloadJson !== undefined &&
          candidate.payloadJson !== undefined &&
          prior.payloadJson !== candidate.payloadJson) ||
        (prior.problemId !== undefined &&
          candidate.problemId !== undefined &&
          prior.problemId !== candidate.problemId))
    )
      throw new ScientificGuardError();
    const payloadJson = prior?.payloadJson ?? candidate.payloadJson;
    if (prior?.payloadJson === undefined && payloadJson !== undefined) {
      const size = new TextEncoder().encode(payloadJson).byteLength;
      if (size < 1 || size > 512 * 1024) throw new ScientificGuardError();
      bytes += size;
    }
    unique.set(candidate.eventId, {
      eventId: candidate.eventId,
      payloadDigest: candidate.payloadDigest,
      ...(payloadJson !== undefined ? { payloadJson } : {}),
      ...((prior?.problemId ?? candidate.problemId) !== undefined
        ? { problemId: prior?.problemId ?? candidate.problemId }
        : {}),
    });
    if (unique.size > MAX_IDENTITIES || bytes > MAX_BYTES) throw new ScientificGuardError();
  };
  for (const input of inputs) {
    add(input);
    if (input.groundingWitnesses !== undefined) {
      if (!Array.isArray(input.groundingWitnesses) || input.groundingWitnesses.length > 64)
        throw new ScientificGuardError();
      for (const witness of input.groundingWitnesses) add(witness);
    }
  }
  const rows = [...unique.values()];
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < rows.length; offset += IDENTITIES_PER_STATEMENT) {
    const chunk = rows.slice(offset, offset + IDENTITIES_PER_STATEMENT);
    statements.push(
      db
        .prepare(`WITH expected(event_id,digest,body,problem_id) AS (
      VALUES ${chunk.map(() => "(?,?,?,?)").join(",")}
    ) SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM expected w WHERE NOT EXISTS (
        SELECT 1 FROM events e JOIN event_content c ON c.event_id = e.id
          AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
        JOIN problems p ON p.id = e.problem_id AND p.status <> 'private-draft' AND e.seq <= p.public_seq
        WHERE e.id = w.event_id AND e.payload_sha256 = w.digest
          AND (w.body IS NULL OR c.payload_json = w.body)
          AND (w.problem_id IS NULL OR e.problem_id = w.problem_id)
          AND NOT EXISTS (SELECT 1 FROM scientific_withdrawals retired WHERE retired.source_event_id = e.id)
      )
    ) THEN 1 ELSE json_extract('[]', '$[SCIENTIFIC_REFERENCE_CHANGED') END`)
        .bind(
          ...chunk.flatMap((row) => [
            row.eventId,
            row.payloadDigest,
            row.payloadJson ?? null,
            row.problemId ?? null,
          ]),
        ),
    );
  }
  return statements;
}
