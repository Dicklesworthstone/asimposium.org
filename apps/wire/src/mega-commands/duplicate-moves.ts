import { getMoveTemplate, type NextMoveCandidate, ProblemIdSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import { relationObjectId } from "../ledger/relations.ts";
import { checkedScientificPayload } from "../ledger/scientific-checks.ts";
import { normalizeClaimStatement } from "../split/policy.ts";

export const DUPLICATE_MOVES_BOUNDARY =
  "At most 64 current claim publications and eight matching pairs are examined at the current cursor. P11 normalization is a discovery hint, not proof of equivalence. Inspect exact statements and their assumptions before asserting a reviewable relation; both claims remain in the ledger. Existing exact-pair relations, including disputed ones, are not reasserted.";

const CLAIM_LIMIT = 64;
const PAIR_LIMIT = 8;
const CONTENT_BYTES = 32_768;
const TOTAL_BYTES = 262_144;

/** Select heads before applying visibility so a withheld revision cannot revive
 * its predecessor. Mutable norm_hash projections are never scientific input.
 * New P11 writes prevent exact duplicates; legacy/imported records can still
 * need consolidation, without a special production path for test fixtures. */
const DUPLICATE_HEADS_SQL = `
WITH input(problem, cut) AS (VALUES (?, ?)),
scope AS MATERIALIZED (
  SELECT p.id, input.cut FROM problems p, input
  WHERE p.id = input.problem AND p.public_seq = input.cut AND p.status <> 'private-draft'
    AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
),
publications AS MATERIALIZED (
  SELECT e.*, ROW_NUMBER() OVER (
    PARTITION BY e.object_id ORDER BY e.object_version DESC, e.seq DESC
  ) AS publication_rank
  FROM events e JOIN scope s ON s.id = e.problem_id
  WHERE e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised') AND e.seq <= s.cut
),
heads AS MATERIALIZED (
  SELECT e.*, ROW_NUMBER() OVER (ORDER BY e.object_id) AS ordinal
  FROM publications e WHERE e.publication_rank = 1
  ORDER BY e.object_id LIMIT ${CLAIM_LIMIT + 1}
),
sized AS MATERIALIZED (
  SELECT e.*, c.payload_json,
    CASE WHEN e.ordinal <= ${CLAIM_LIMIT} AND c.redacted_at IS NULL
      AND NOT ${eventContentHiddenSql("e")}
      AND length(CAST(c.payload_json AS BLOB)) <= ${CONTENT_BYTES}
      THEN length(CAST(c.payload_json AS BLOB)) END AS source_bytes
  FROM heads e LEFT JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
),
budgeted AS MATERIALIZED (
  SELECT *, SUM(COALESCE(source_bytes, 0)) OVER (ORDER BY ordinal) AS total_bytes FROM sized
)
SELECT s.id AS scope_id, s.cut AS through, e.id AS event_id, e.seq,
  e.object_id AS claim_id, e.object_version AS version, e.payload_sha256,
  EXISTS (SELECT 1 FROM retractions r JOIN events re ON re.problem_id = r.problem_id
    AND re.object_kind = 'retraction' AND re.object_id = r.retraction_id
    AND re.type = 'object.retracted' AND re.seq <= s.cut
    WHERE r.problem_id = s.id AND r.target_object IN (e.object_id, e.object_id || '@' || e.object_version)) AS retired,
  CASE WHEN e.source_bytes IS NOT NULL AND e.total_bytes <= ${TOTAL_BYTES}
    THEN e.payload_json END AS payload_json
FROM scope s LEFT JOIN budgeted e ON e.problem_id = s.id
ORDER BY e.object_id`;

interface ClaimSource {
  readonly scope_id: string;
  readonly through: number;
  readonly event_id: string;
  readonly seq: number;
  readonly claim_id: string;
  readonly version: number;
  readonly payload_sha256: string;
  readonly payload_json: string;
  readonly retired: number;
}

function pin(source: ClaimSource): string {
  return `${source.claim_id}@${source.version}`;
}

/** A second bounded read checks both exact sources, current controls and the
 * head before emitting an actionable pair. Relation existence is only a
 * duplicate-write guard: a hidden or disputed assertion never becomes proof. */
const DUPLICATE_PAIRS_SQL = `
WITH input(j) AS (VALUES (?)),
scope AS (SELECT p.id, p.public_seq FROM problems p, input
  WHERE p.id = json_extract(j, '$.problem') AND p.public_seq = json_extract(j, '$.cursor')
    AND p.status <> 'private-draft' AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}),
pairs AS (SELECT CAST(pair.key AS INTEGER) AS ordinal, pair.value AS pair_json
  FROM input, json_each(j, '$.pairs') pair),
eligible AS MATERIALIZED (
SELECT pairs.ordinal,
  EXISTS (SELECT 1 FROM events r WHERE r.problem_id = s.id AND r.seq <= s.public_seq
  AND r.object_kind = 'relation' AND r.type = 'relation.asserted'
  AND r.object_id IN (json_extract(pair_json, '$.forward'), json_extract(pair_json, '$.reverse'))) AS recorded,
  (SELECT COUNT(*) FROM json_each(pair_json, '$.sources') source
    JOIN events e ON e.problem_id = s.id AND e.id = json_extract(source.value, '$.event_id')
      AND e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised')
      AND e.seq <= s.public_seq AND e.payload_sha256 = json_extract(source.value, '$.payload_sha256')
    JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
      AND c.payload_json = json_extract(source.value, '$.payload_json') AND c.redacted_at IS NULL
    WHERE NOT ${eventContentHiddenSql("e")}) AS live_sources
FROM pairs, scope s)
SELECT EXISTS(SELECT 1 FROM scope) AS scope_available,
  EXISTS(SELECT 1 FROM eligible WHERE live_sources <> 2) AS unavailable,
  (SELECT ordinal FROM eligible WHERE recorded = 0 AND live_sources = 2
    ORDER BY ordinal LIMIT 1) AS ordinal`;

export interface DuplicateMoveResult {
  readonly move: NextMoveCandidate | null;
  readonly degraded: boolean;
}

export async function selectCollapseDuplicateMove(
  db: D1Database,
  problemId: string,
  cursor: number,
): Promise<DuplicateMoveResult> {
  try {
    if (
      !ProblemIdSchema.safeParse(problemId).success ||
      !Number.isSafeInteger(cursor) ||
      cursor < 0
    )
      return { move: null, degraded: true };
    const result = await db.prepare(DUPLICATE_HEADS_SQL).bind(problemId, cursor).all<ClaimSource>();
    const rows = result.results;
    if (
      !Array.isArray(rows) ||
      rows.length === 0 ||
      rows.length > CLAIM_LIMIT + 1 ||
      rows.some((row) => row.scope_id !== problemId || row.through !== cursor)
    )
      return { move: null, degraded: true };
    if (rows.length === 1 && rows[0]?.event_id === null) return { move: null, degraded: false };
    let degraded = rows.length > CLAIM_LIMIT,
      bytes = 0;
    const groups = new Map<string, ClaimSource[]>();
    for (const row of rows.slice(0, CLAIM_LIMIT)) {
      if (row.retired === 1) continue;
      if (
        !row.event_id ||
        !/^C-[0-9]+$/.test(row.claim_id) ||
        !Number.isSafeInteger(row.version) ||
        row.version < 1 ||
        !Number.isSafeInteger(row.seq) ||
        row.seq < 1 ||
        row.seq > cursor ||
        typeof row.payload_json !== "string"
      ) {
        degraded = true;
        continue;
      }
      bytes += new TextEncoder().encode(row.payload_json).byteLength;
      if (bytes > TOTAL_BYTES) {
        degraded = true;
        break;
      }
      let payload: Record<string, unknown>;
      try {
        payload = await checkedScientificPayload(row);
      } catch {
        degraded = true;
        continue;
      }
      if (
        payload.claim_id !== row.claim_id ||
        typeof payload.statement !== "string" ||
        !payload.statement.trim() ||
        (row.version > 1 && payload.base_version !== row.version - 1)
      ) {
        degraded = true;
        continue;
      }
      const key = normalizeClaimStatement(payload.statement);
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    const pairs: { sources: [ClaimSource, ClaimSource]; forward: string; reverse: string }[] = [];
    pairSelection: for (const group of groups.values()) {
      for (const [index, source] of group.entries())
        for (const target of group.slice(index + 1)) {
          if (pairs.length >= PAIR_LIMIT) {
            degraded = true;
            break pairSelection;
          }
          pairs.push({
            sources: [source, target],
            forward: relationObjectId({
              sourceClaimId: source.claim_id,
              sourceVersion: source.version,
              kind: "equivalent-to",
              targetRef: pin(target),
            }),
            reverse: relationObjectId({
              sourceClaimId: target.claim_id,
              sourceVersion: target.version,
              kind: "equivalent-to",
              targetRef: pin(source),
            }),
          });
        }
    }
    if (pairs.length === 0) return { move: null, degraded };
    const selected = await db
      .prepare(DUPLICATE_PAIRS_SQL)
      .bind(JSON.stringify({ problem: problemId, cursor, pairs }))
      .first<{ ordinal: number | null; scope_available: number; unavailable: number }>();
    if (!selected || selected.scope_available !== 1) return { move: null, degraded: true };
    degraded ||= selected.unavailable !== 0;
    if (selected.ordinal === null) return { move: null, degraded };
    const pair = pairs[selected.ordinal];
    if (!pair) return { move: null, degraded: true };
    const [source, target] = pair.sources;

    const template = getMoveTemplate("collapse-duplicate");
    if (template.availability !== "available") {
      return { move: null, degraded: true };
    }

    const sourceTarget = pin(source);
    const targetRef = pin(target);

    return {
      move: {
        move: "collapse-duplicate",
        why: `${sourceTarget} and ${targetRef} share P11-normalized statement text. This is not proof of equivalence: inspect their assumptions, definitions and scope before recording a reviewable relation.`,
        refs: [problemId, sourceTarget, targetRef],
        contract: {
          ...template,
          prefilled_hints: {
            ...template.prefilled_hints,
            kind: "equivalent-to",
            source_claim_id: source.claim_id,
            source_version: source.version,
            target: targetRef,
          },
          preparation: {
            problem_id: problemId,
            captured_cursor: cursor,
            source_claim: sourceTarget,
            target_claim: targetRef,
            read_first: [sourceTarget, targetRef].map((claim) => ({
              method: "GET",
              path: `/p/${encodeURIComponent(problemId)}/claims/${encodeURIComponent(claim)}.md?through=${cursor}`,
            })),
            open_session: {
              method: "POST",
              path: "/v1/sessions",
              idempotency_key_required: true,
              body: { problem_id: problemId, intent: "explore" },
            },
            note: "Read both exact statements first. Assert an equivalence only if its scientific conditions hold; normalization does not establish them. Both claims remain in the ledger.",
          },
        },
        selection_boundary: DUPLICATE_MOVES_BOUNDARY,
      },
      degraded,
    };
  } catch {
    return { move: null, degraded: true };
  }
}
