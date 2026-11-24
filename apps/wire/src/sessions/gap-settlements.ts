import { GapFileRequestSchema } from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { eventContentHiddenSql } from "../krater/public-content.ts";
import {
  checkedScientificPayload,
  type ScientificContentIdentity,
  ScientificInputError,
  scientificContentGuards,
} from "../ledger/scientific-checks.ts";

export interface OpenGapSource extends ScientificContentIdentity {
  readonly gapId: string;
  readonly problemId: string;
  readonly payloadJson: string;
}

/** Only the exact, available filing can authorize closing or withdrawing a
 * gap. A retained open projection cannot revive a settled or unreadable
 * obligation. Coordination leases have object_kind='proof_gap', so every
 * additional canonical gap event makes this open history unavailable. */
export async function findOpenGapSource(
  db: D1Database,
  problemId: string,
  gapId: string,
): Promise<OpenGapSource | null> {
  const row = await db
    .prepare(`SELECT e.id AS event_id, e.seq, e.object_version,
      e.payload_sha256, c.payload_json
    FROM proof_gaps g JOIN problems p ON p.id = g.problem_id
    JOIN events e ON e.problem_id = g.problem_id AND e.object_id = g.gap_id
      AND e.object_kind = 'gap' AND e.type = 'gap.filed'
    JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
      AND c.redacted_at IS NULL
    WHERE g.problem_id = ? AND g.gap_id = ? AND g.status = 'open'
      AND p.status <> 'private-draft' AND e.seq <= p.public_seq
      AND length(CAST(c.payload_json AS BLOB)) <= 16384
      AND NOT ${eventContentHiddenSql("e")}
      AND NOT EXISTS (SELECT 1 FROM scientific_withdrawals retired WHERE retired.source_event_id = e.id)
      AND NOT EXISTS (SELECT 1 FROM events other WHERE other.problem_id = e.problem_id
        AND other.object_kind = 'gap' AND other.object_id = e.object_id
        AND other.id <> e.id)
    LIMIT 1`)
    .bind(problemId, gapId)
    .first<{
      event_id: string;
      seq: number;
      object_version: number;
      payload_sha256: string;
      payload_json: string;
    }>();
  if (
    row === null ||
    !Number.isSafeInteger(row.seq) ||
    row.seq < 1 ||
    gapId !== `G-${row.seq}` ||
    row.object_version !== 1
  )
    return null;
  try {
    const payload = await checkedScientificPayload(row);
    if (!GapFileRequestSchema.safeParse(payload).success) return null;
    return {
      gapId,
      eventId: row.event_id,
      payloadDigest: row.payload_sha256,
      payloadJson: row.payload_json,
      problemId,
    };
  } catch (error) {
    if (error instanceof ScientificInputError) return null;
    throw error;
  }
}

/** The companion runs after this attempt's event has been inserted. Ignore
 * only that exact event and the captured filing; every other gap lifecycle
 * event invalidates the open source and rolls back the complete batch. */
export function gapSettlementGuards(
  db: D1Database,
  source: OpenGapSource,
  settlementEventId: string,
): D1PreparedStatement[] {
  return [
    ...scientificContentGuards(db, [source]),
    db
      .prepare(`SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM events e WHERE e.problem_id = ? AND e.object_kind = 'gap'
          AND e.object_id = ? AND e.id NOT IN (?, ?)
      ) THEN 1 ELSE json_extract('[]', '$[SCIENTIFIC_REFERENCE_CHANGED') END`)
      .bind(source.problemId, source.gapId, source.eventId, settlementEventId),
  ];
}
