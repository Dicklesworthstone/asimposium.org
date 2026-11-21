import {
  ProblemStatusSchema,
  PUBLIC_PROBLEM_ROSTER_LIMIT,
  PUBLIC_PROBLEM_ROSTER_NOTICE,
  type PublicProblemRoster,
  PublicProblemRosterSchema,
} from "@asimposium/contracts";
import { PublicEventEnvelopeSchema } from "@asimposium/contracts/event-tail";
import type { D1Database } from "@cloudflare/workers-types";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import { isObjectLevelEvent } from "../mega-commands/materiality.ts";

const EVENT_SCAN_LIMIT = 64;
const MAX_EVENT_METADATA_BYTES = 32_768;
export const PROBLEM_ROSTER_SOURCE_LIMIT = 128;
const RosterEventMetadataSchema = PublicEventEnvelopeSchema.shape.event.unwrap().pick({
  type: true,
  object_kind: true,
  created_at: true,
});

// Reviews and evidence inherit the current visibility of their exact target,
// including a hidden or redacted old version when a clean revision is public.
const targetId = `CASE WHEN json_valid(c.payload_json) THEN COALESCE(
  json_extract(c.payload_json, '$.target_claim_id'),
  json_extract(c.payload_json, '$.bears_on_id')) END`;
const targetVersion = `CASE WHEN json_valid(c.payload_json) THEN COALESCE(
  json_extract(c.payload_json, '$.target_version'),
  json_extract(c.payload_json, '$.bears_on_version')) END`;

interface RosterRow {
  problem_id: string;
  roster_sponsorship_json: string | null;
  fellow_id: string | null;
  name: string | null;
  sponsor_id: string | null;
  role: string | null;
  heartbeat_at: string | null;
  events_json: string | null;
}

interface IncrementCandidate {
  seq: number;
  type: string;
  object_kind: string;
  created_at: string;
  available: number;
  materiality_status: string | null;
  low_substance: number;
}

type PublicIncrement = NonNullable<PublicProblemRoster["members"][number]["last_public_increment"]>;

/** Internal evidence for a current-team annotation. The complete bounded
 * sponsorship source is never inferred from or published beside the display
 * prefix; it shares the membership snapshot that supplies that prefix. */
export interface PublicProblemRosterSnapshot {
  readonly roster: PublicProblemRoster;
  readonly sponsorshipJson: string | null;
}

const unavailable = (): PublicProblemRosterSnapshot => ({
  roster: {
    notice: PUBLIC_PROBLEM_ROSTER_NOTICE,
    members: [],
    has_more: false,
    omitted: ["source_unavailable"],
  },
  sponsorshipJson: null,
});

/** One bounded snapshot of membership and public event metadata. The existing
 * per-Fellow event index bounds each tail at 65 rows; workshop tables and
 * private session fields are never read. The sentinel preserves an empty
 * roster while current visibility changes make the whole read disappear. */
export const PUBLIC_PROBLEM_ROSTER_SQL = `WITH head AS MATERIALIZED (
  SELECT p.id, (SELECT json_group_array(sponsor_id) FROM (
    SELECT CASE WHEN typeof(f.sponsor_id) = 'text'
      AND length(CAST(f.sponsor_id AS BLOB)) BETWEEN 1 AND 128
      THEN f.sponsor_id END AS sponsor_id
    FROM problem_memberships m LEFT JOIN enrollment_fellows f ON f.fellow_id = m.fellow_id
    WHERE m.problem_id = p.id ORDER BY m.fellow_id LIMIT ${PROBLEM_ROSTER_SOURCE_LIMIT + 1}
  )) AS roster_sponsorship_json
  FROM problems p WHERE p.id = ?1 AND p.public_seq >= ?2
    AND p.status != 'private-draft'
    AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
    AND NOT ${hiddenByContentControlSql("p.id", "p.id")}
), members AS MATERIALIZED (
  SELECT m.fellow_id, m.role, f.name, f.sponsor_id, f.status
  FROM head h JOIN problem_memberships m ON m.problem_id = h.id
  LEFT JOIN enrollment_fellows f ON f.fellow_id = m.fellow_id
  ORDER BY m.fellow_id LIMIT ${PUBLIC_PROBLEM_ROSTER_LIMIT + 1}
)
SELECT h.id AS problem_id, m.fellow_id,
  CASE WHEN ROW_NUMBER() OVER (ORDER BY m.fellow_id) = 1
    THEN h.roster_sponsorship_json END AS roster_sponsorship_json,
  CASE WHEN length(CAST(m.name AS BLOB)) <= 512 THEN m.name END AS name,
  m.sponsor_id, m.role,
  CASE WHEN m.status = 'active' THEN (
    SELECT s.last_heartbeat_at FROM sessions s
    WHERE s.fellow_id = m.fellow_id AND s.problem_id = h.id AND s.closed_at IS NULL
    ORDER BY s.last_heartbeat_at DESC LIMIT 1
  ) END AS heartbeat_at,
  (SELECT json_group_array(json_object(
    'seq', recent.seq, 'type', recent.type, 'object_kind', recent.object_kind,
    'created_at', recent.created_at,
    'available', CASE WHEN c.event_id IS NOT NULL AND c.redacted_at IS NULL
      AND json_valid(c.payload_json) AND NOT ${eventContentHiddenSql("recent")}
      AND (recent.type NOT IN ('review.created', 'evidence.created') OR EXISTS (
        SELECT 1 FROM events target
        JOIN event_content target_content ON target_content.event_id = target.id
          AND target_content.payload_sha256 = target.payload_sha256
          AND target_content.redacted_at IS NULL
        WHERE target.problem_id = recent.problem_id AND target.object_id = ${targetId}
          AND target.seq <= recent.seq AND target.seq <= ?2
          AND ((target.object_kind = 'claim'
            AND target.type IN ('claim.created', 'claim.revised')
            AND target.object_version = ${targetVersion})
            OR (recent.type = 'evidence.created' AND target.object_kind = 'hypothesis'
              AND target.type = 'hypothesis.created' AND ${targetVersion} IS NULL))
          AND json_valid(target_content.payload_json)
          AND NOT ${eventContentHiddenSql("target")}
      ))
      THEN 1 ELSE 0 END,
    'materiality_status', CASE WHEN json_valid(c.payload_json)
      THEN json_extract(c.payload_json, '$.previous_status') END,
    'low_substance', CASE WHEN recent.type = 'dead_end.recorded'
      AND instr(c.payload_json, 'low-substance-dead-end') > 0 THEN 1 ELSE 0 END
  )) FROM (
    SELECT e.problem_id, e.seq, e.id, e.type, e.object_kind, e.object_id,
      e.object_version, e.created_at, e.payload_sha256
    FROM events e WHERE e.problem_id = h.id AND e.actor_fellow_id = m.fellow_id
      AND e.seq <= ?2 ORDER BY e.seq DESC LIMIT ${EVENT_SCAN_LIMIT + 1}
  ) recent LEFT JOIN event_content c ON c.event_id = recent.id
    AND c.payload_sha256 = recent.payload_sha256) AS events_json
FROM head h LEFT JOIN members m ON 1=1 ORDER BY m.fellow_id`;

/** No current-time boolean enters the face or its ETag: an old heartbeat stays
 * an old reported timestamp, even when the public ledger cursor does not move.
 * The scientific increment is bounded at the digest cursor; membership itself
 * is current and cannot retroactively rewrite attribution or review tiers. */
export async function readPublicProblemRoster(
  db: D1Database,
  problemId: string,
  cursor: number,
): Promise<PublicProblemRosterSnapshot | null> {
  try {
    const rows = (
      await db.prepare(PUBLIC_PROBLEM_ROSTER_SQL).bind(problemId, cursor).all<RosterRow>()
    ).results;
    if (rows.length === 0) return null;
    if (
      rows.length > PUBLIC_PROBLEM_ROSTER_LIMIT + 1 ||
      rows.some((row) => row.problem_id !== problemId)
    )
      return unavailable();
    const sponsorshipJson =
      typeof rows[0]?.roster_sponsorship_json === "string" ? rows[0].roster_sponsorship_json : null;
    if (rows.length === 1 && rows[0]!.fellow_id === null)
      return {
        roster: { notice: PUBLIC_PROBLEM_ROSTER_NOTICE, members: [], has_more: false, omitted: [] },
        sponsorshipJson,
      };
    const members: PublicProblemRoster["members"] = [];
    for (const row of rows.slice(0, PUBLIC_PROBLEM_ROSTER_LIMIT)) {
      if (
        row.events_json === null ||
        new TextEncoder().encode(row.events_json).byteLength > MAX_EVENT_METADATA_BYTES
      )
        return unavailable();
      const candidates: IncrementCandidate[] = JSON.parse(row.events_json);
      if (!Array.isArray(candidates) || candidates.length > EVENT_SCAN_LIMIT + 1)
        return unavailable();
      let latest: PublicIncrement | null = null;
      let limited = candidates.length > EVENT_SCAN_LIMIT;
      let newerUnavailable = false;
      let previous = cursor + 1;
      for (const event of candidates.slice(0, EVENT_SCAN_LIMIT)) {
        if (
          !Number.isSafeInteger(event.seq) ||
          event.seq < 1 ||
          event.seq >= previous ||
          !RosterEventMetadataSchema.safeParse({
            type: event.type,
            object_kind: event.object_kind,
            created_at: event.created_at,
          }).success
        )
          return unavailable();
        previous = event.seq;
        if (event.available !== 1) {
          limited = true;
          newerUnavailable = true;
          continue;
        }
        const expectedKind = event.type.split(".")[0];
        if (
          event.object_kind !== expectedKind &&
          !(expectedKind === "dead_end" && event.object_kind === "dead-end")
        ) {
          limited = true;
          newerUnavailable = true;
          continue;
        }
        if (
          ([
            "problem.statement-reviewed",
            "problem.statement-revised",
            "problem.statement-updated",
          ].includes(event.type) &&
            !ProblemStatusSchema.safeParse(event.materiality_status).success) ||
          (event.low_substance !== 0 && event.low_substance !== 1)
        ) {
          limited = true;
          newerUnavailable = true;
          continue;
        }
        if (
          !isObjectLevelEvent({
            type: event.type,
            object_kind: event.object_kind,
            problem_status: event.materiality_status,
            extract: event.low_substance === 1 ? "low-substance-dead-end" : null,
          })
        )
          continue;
        latest = {
          seq: event.seq,
          type: event.type as PublicIncrement["type"],
          created_at: event.created_at,
        };
        // An older-history scan limit does not qualify this selected event,
        // but unavailable newer sources must never be declared immaterial.
        limited = newerUnavailable;
        break;
      }
      members.push({
        fellow_id: row.fellow_id!,
        name: row.name!,
        current_sponsor_id: row.sponsor_id!,
        role: row.role as PublicProblemRoster["members"][number]["role"],
        open_session_heartbeat_at: row.heartbeat_at,
        last_public_increment: latest,
        increment_history_limited: limited,
      });
    }
    return {
      roster: PublicProblemRosterSchema.parse({
        notice: PUBLIC_PROBLEM_ROSTER_NOTICE,
        members,
        has_more: rows.length > PUBLIC_PROBLEM_ROSTER_LIMIT,
        omitted: rows.length > PUBLIC_PROBLEM_ROSTER_LIMIT ? ["member_limit"] : [],
      }),
      sponsorshipJson,
    };
  } catch {
    // Coordination context must not turn an otherwise readable scientific
    // digest into an invented empty roster or an unbounded retry.
    return unavailable();
  }
}
