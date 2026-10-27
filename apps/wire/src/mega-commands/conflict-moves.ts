import {
  ConflictingClaimRefSchema,
  getMoveTemplate,
  type NextMoveCandidate,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import { relationObjectId } from "../ledger/relations.ts";
import { sha256Hex } from "../split/policy.ts";

export const CONFLICT_MOVES_BOUNDARY =
  "Normalize-conflict selects an undisputed, published contradiction assertion between current claim versions at the captured cursor. Current visibility controls still apply. The assertion is not proof of incompatibility: inspect the exact statements and align definitions, scope and quantifiers before opening a conflict. At most eight eligible assertion sources are checked.";

const CANDIDATE_LIMIT = 8;
const CONTENT_BYTES = 65_536;

/** Projections locate candidates; immutable publications establish their pins.
 * Select heads before checking visibility, so an unavailable head never falls
 * back to an older statement. Dispute and normalization events obey the same
 * cut, while current content controls apply even to historical reads. */
const CONFLICT_CANDIDATES_SQL = `
WITH input(problem, cut) AS (VALUES (?, ?)),
scope AS MATERIALIZED (
  SELECT p.id, input.cut FROM problems p, input
  WHERE p.id = input.problem AND p.status <> 'private-draft' AND p.public_seq >= input.cut
    AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
),
candidates AS MATERIALIZED (
  SELECT a.id AS event_id, a.seq, a.object_id, a.payload_sha256,
    cr.source_claim_id, cr.source_version, cr.target_ref,
    target.object_id AS target_claim_id, target.object_version AS target_version,
    ac.payload_json, source.payload_sha256 AS source_sha256, sc.payload_json AS source_json,
    target.payload_sha256 AS target_sha256, tc.payload_json AS target_json
  FROM scope s JOIN claim_relations cr ON cr.problem_id = s.id AND cr.kind = 'contradicts'
  JOIN events a ON a.id = cr.asserted_by_event AND a.problem_id = s.id
    AND a.object_kind = 'relation' AND a.type = 'relation.asserted' AND a.object_version = 1
    AND a.seq <= s.cut
  JOIN events source ON source.problem_id = s.id AND source.object_kind = 'claim'
    AND source.object_id = cr.source_claim_id AND source.object_version = cr.source_version
    AND source.type IN ('claim.created', 'claim.revised') AND source.seq < a.seq
  JOIN events target ON target.problem_id = s.id AND target.object_kind = 'claim'
    AND target.object_id || '@' || target.object_version = cr.target_ref
    AND target.type IN ('claim.created', 'claim.revised') AND target.seq < a.seq
  JOIN event_content ac ON ac.event_id = a.id AND ac.payload_sha256 = a.payload_sha256
    AND ac.redacted_at IS NULL AND length(CAST(ac.payload_json AS BLOB)) <= ${CONTENT_BYTES}
  JOIN event_content sc ON sc.event_id = source.id AND sc.payload_sha256 = source.payload_sha256
    AND sc.redacted_at IS NULL AND length(CAST(sc.payload_json AS BLOB)) <= ${CONTENT_BYTES}
  JOIN event_content tc ON tc.event_id = target.id AND tc.payload_sha256 = target.payload_sha256
    AND tc.redacted_at IS NULL AND length(CAST(tc.payload_json AS BLOB)) <= ${CONTENT_BYTES}
  WHERE NOT ${eventContentHiddenSql("a")}
    AND NOT ${eventContentHiddenSql("source")}
    AND NOT ${eventContentHiddenSql("target")}
    AND NOT EXISTS (
      SELECT 1 FROM events newer WHERE newer.problem_id = s.id
        AND newer.object_kind = 'claim' AND newer.type IN ('claim.created', 'claim.revised')
        AND newer.seq <= s.cut
        AND ((newer.object_id = source.object_id AND (newer.object_version > source.object_version
          OR (newer.object_version = source.object_version AND newer.seq > source.seq)))
          OR (newer.object_id = target.object_id AND (newer.object_version > target.object_version
          OR (newer.object_version = target.object_version AND newer.seq > target.seq))))
    )
    AND NOT EXISTS (
      SELECT 1 FROM events dispute WHERE dispute.problem_id = s.id
        AND dispute.object_kind = 'relation' AND dispute.object_id = a.object_id
        AND dispute.type = 'relation.disputed' AND dispute.seq <= s.cut
    )
    AND NOT EXISTS (
      SELECT 1 FROM retractions r JOIN events re ON re.problem_id = r.problem_id
        AND re.object_kind = 'retraction' AND re.object_id = r.retraction_id
        AND re.type = 'object.retracted' AND re.seq <= s.cut
      WHERE r.problem_id = s.id AND r.target_object IN (
        source.object_id, source.object_id || '@' || source.object_version,
        target.object_id, target.object_id || '@' || target.object_version
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM conflicts c JOIN events ce ON ce.problem_id = c.problem_id
        AND ce.object_kind = 'conflict' AND ce.object_id = c.conflict_id
        AND ce.type = 'conflict.normalized' AND ce.seq = c.seq AND ce.seq <= s.cut
      WHERE c.problem_id = s.id
        AND ((c.claim_a_id = source.object_id AND c.claim_a_version = source.object_version
          AND c.claim_b_id = target.object_id AND c.claim_b_version = target.object_version)
          OR (c.claim_b_id = source.object_id AND c.claim_b_version = source.object_version
          AND c.claim_a_id = target.object_id AND c.claim_a_version = target.object_version))
    )
  ORDER BY a.seq, a.id LIMIT ${CANDIDATE_LIMIT + 1}
)
SELECT s.id AS scope_id, s.cut AS through, c.* FROM scope s
LEFT JOIN candidates c ON 1 = 1 ORDER BY c.seq, c.event_id`;

interface ConflictCandidate {
  readonly scope_id: string;
  readonly through: number;
  readonly event_id: string | null;
  readonly seq: number;
  readonly object_id: string;
  readonly payload_sha256: string;
  readonly payload_json: string;
  readonly source_claim_id: string;
  readonly source_version: number;
  readonly source_sha256: string;
  readonly source_json: string;
  readonly target_claim_id: string;
  readonly target_version: number;
  readonly target_ref: string;
  readonly target_sha256: string;
  readonly target_json: string;
}

async function checkedBody(raw: string, digest: string): Promise<Record<string, unknown> | null> {
  if (
    typeof raw !== "string" ||
    new TextEncoder().encode(raw).byteLength > CONTENT_BYTES ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    (await sha256Hex(raw)) !== digest
  )
    return null;
  try {
    const body: unknown = JSON.parse(raw);
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface ConflictMoveResult {
  readonly move: NextMoveCandidate | null;
  readonly degraded: boolean;
}

export async function selectNormalizeConflictMove(
  db: D1Database,
  problemId: string,
  cursor: number,
): Promise<ConflictMoveResult> {
  try {
    if (
      !/^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}(?![\s\S])/.test(problemId) ||
      !Number.isSafeInteger(cursor) ||
      cursor < 0
    )
      return { move: null, degraded: true };
    const rows = (
      await db.prepare(CONFLICT_CANDIDATES_SQL).bind(problemId, cursor).all<ConflictCandidate>()
    ).results;
    if (
      !Array.isArray(rows) ||
      rows.length === 0 ||
      rows.length > CANDIDATE_LIMIT + 1 ||
      rows.some((row) => row.scope_id !== problemId || row.through !== cursor)
    )
      return { move: null, degraded: true };
    if (rows.length === 1 && rows[0]?.event_id === null) return { move: null, degraded: false };
    let degraded = rows.length > CANDIDATE_LIMIT;
    let selected: ConflictCandidate | undefined;
    for (const row of rows.slice(0, CANDIDATE_LIMIT)) {
      const sourcePin = ConflictingClaimRefSchema.safeParse({
        claim_id: row.source_claim_id,
        version: row.source_version,
      });
      const targetPin = ConflictingClaimRefSchema.safeParse({
        claim_id: row.target_claim_id,
        version: row.target_version,
      });
      const [assertion, source, target] = await Promise.all([
        checkedBody(row.payload_json, row.payload_sha256),
        checkedBody(row.source_json, row.source_sha256),
        checkedBody(row.target_json, row.target_sha256),
      ]);
      if (
        !sourcePin.success ||
        !targetPin.success ||
        !Number.isSafeInteger(row.seq) ||
        row.seq < 1 ||
        row.seq > cursor ||
        row.source_claim_id === row.target_claim_id ||
        row.target_ref !== `${row.target_claim_id}@${row.target_version}` ||
        row.object_id !==
          relationObjectId({
            sourceClaimId: row.source_claim_id,
            sourceVersion: row.source_version,
            kind: "contradicts",
            targetRef: row.target_ref,
          }) ||
        assertion?.kind !== "contradicts" ||
        assertion.source !== `${row.source_claim_id}@${row.source_version}` ||
        assertion.target !== row.target_ref ||
        source?.claim_id !== row.source_claim_id ||
        target?.claim_id !== row.target_claim_id ||
        typeof source.statement !== "string" ||
        !source.statement.trim() ||
        typeof target.statement !== "string" ||
        !target.statement.trim()
      ) {
        degraded = true;
        continue;
      }
      selected = row;
      break;
    }
    if (selected === undefined) return { move: null, degraded };
    const row = selected;

    const template = getMoveTemplate("normalize-conflict");
    if (template.availability !== "available") {
      return { move: null, degraded: true };
    }

    const claimA = `${row.source_claim_id}@${row.source_version}`;
    const claimB = row.target_ref;

    return {
      move: {
        move: "normalize-conflict",
        why: `A published contradiction assertion links ${claimA} and ${claimB}, but these exact versions have no normalized conflict. Inspect their definitions, scope, and quantifiers before recording the disagreement.`,
        refs: [problemId, claimA, claimB],
        contract: {
          ...template,
          prefilled_hints: {
            claims: [
              { claim_id: row.source_claim_id, version: row.source_version },
              { claim_id: row.target_claim_id, version: row.target_version },
            ],
          },
          preparation: {
            problem_id: problemId,
            captured_cursor: cursor,
            claim_a: claimA,
            claim_b: claimB,
            read_first: {
              method: "GET",
              path: `/p/${encodeURIComponent(problemId)}/relations/${row.seq}.md`,
            },
            additional_reads: [claimA, claimB].map((claim) => ({
              method: "GET",
              path: `/p/${encodeURIComponent(problemId)}/claims/${claim}.md?through=${cursor}`,
            })),
            open_session: {
              method: "POST",
              path: "/v1/sessions",
              idempotency_key_required: true,
              body: { problem_id: problemId, intent: "explore" },
            },
            note: "Normalize apparent conflict by checking whether differences stem from notation, scope, or quantifiers before formally asserting a disagreement.",
          },
        },
        selection_boundary: CONFLICT_MOVES_BOUNDARY,
      },
      degraded,
    };
  } catch {
    return { move: null, degraded: true };
  }
}
