import type { MoveTemplate, NextMoveCandidate } from "@asimposium/contracts";
import type { ProofGapRecord, ProofGapsQuery } from "@asimposium/contracts/proof-gaps";
import type { D1Database } from "@cloudflare/workers-types";
import { proofGapPath } from "../ledger/proof-gaps-face.ts";
import { gapPayload, type ProofGapPage } from "../ledger/proof-gaps-read.ts";

export const GAP_MOVE_MAX_PAGES = 2;
export const GAP_MOVES_BOUNDARY =
  "Close-gap examines at most sixteen unowned gap admissions at one problem cursor, oldest filing first. Current leases are coordination, not historical science. Withdrawn, unreadable and superseded target versions are not recommended. A recommendation neither closes nor reserves a gap; submission must recheck current state and cite real work.";

export interface GapMoveSelection {
  move: NextMoveCandidate | null;
  degraded: boolean;
}
export interface GapMoveSource {
  load(db: D1Database, problem: string, cursor: number, now: number): Promise<GapMoveSelection>;
}
export interface GapMoveDependencies {
  page(
    db: D1Database,
    problem: string,
    query: ProofGapsQuery,
    unownedAt: string,
  ): Promise<ProofGapPage>;
  template(): MoveTemplate;
}
interface TargetRow {
  gap_id: string;
  claim_id: string;
  version: number;
  event_id: string;
  seq: number;
  payload_sha256: string;
  payload_json: string | null;
  gap_json: string | null;
}

/** Recheck current content and leases with the exact target at the captured
 * cut. No mutable claim/proof-gap text is used as publication authority. */
export const GAP_MOVE_TARGETS_SQL = `WITH selected AS (
  SELECT json_extract(value,'$.gap_id') AS gap_id,
    json_extract(value,'$.event_id') AS gap_event,
    json_extract(value,'$.digest') AS gap_digest,
    json_extract(value,'$.claim_id') AS claim_id,
    json_extract(value,'$.version') AS version
  FROM json_each(?)
)
SELECT s.gap_id, e.object_id AS claim_id, e.object_version AS version,
  e.id AS event_id, e.seq, e.payload_sha256,
  CASE WHEN length(CAST(c.payload_json AS BLOB)) <= 16384 THEN c.payload_json END AS payload_json,
  CASE WHEN length(CAST(gc.payload_json AS BLOB)) <= 16384 THEN gc.payload_json END AS gap_json
FROM selected s JOIN problems p ON p.id = ? AND p.unlisted = 0
  AND p.status IN ('active','dormant','under-result-review') AND p.public_seq >= ?
JOIN events g ON g.problem_id = p.id AND g.id = s.gap_event AND g.object_id = s.gap_id
  AND g.object_kind = 'gap' AND g.type = 'gap.filed' AND g.payload_sha256 = s.gap_digest
JOIN event_content gc ON gc.event_id = g.id AND gc.payload_sha256 = g.payload_sha256 AND gc.redacted_at IS NULL
JOIN events e ON e.problem_id = p.id AND e.object_id = s.claim_id AND e.object_kind = 'claim'
  AND e.type IN ('claim.created','claim.revised') AND e.object_version = s.version
  AND e.seq < g.seq AND e.seq = (SELECT MAX(h.seq) FROM events h WHERE h.problem_id = p.id
    AND h.object_id = s.claim_id AND h.object_kind = 'claim'
    AND h.type IN ('claim.created','claim.revised') AND h.seq <= ?)
JOIN events origin ON origin.problem_id = p.id AND origin.object_id = e.object_id
  AND origin.object_kind = 'claim' AND origin.type = 'claim.created'
  AND origin.object_version = 1 AND origin.seq <= e.seq
JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
WHERE NOT EXISTS (SELECT 1 FROM retractions r JOIN events re
  ON re.problem_id = r.problem_id AND re.object_id = r.retraction_id AND re.seq = r.seq
    AND re.object_kind = 'retraction' AND re.type = 'object.retracted'
    AND re.actor_fellow_id = origin.actor_fellow_id
  WHERE r.problem_id = p.id AND r.target_object IN (e.object_id,e.object_id || '@' || e.object_version)
    AND re.seq <= ?)
AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.problem_id = p.id
  AND (l.object_id = g.object_id OR l.object_ref = g.object_id)
  AND l.status = 'active' AND l.leased_until > ?)
ORDER BY g.seq LIMIT 9`;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function readGapMoveTargets(
  db: D1Database,
  problem: string,
  cursor: number,
  now: string,
  gaps: readonly ProofGapRecord[],
): Promise<Map<string, TargetRow>> {
  if (gaps.length === 0) return new Map();
  if (gaps.length > 8) throw new Error("GAP_MOVE_PAGE_EXCEEDED");
  const rows = (
    await db
      .prepare(GAP_MOVE_TARGETS_SQL)
      .bind(
        JSON.stringify(
          gaps.map((gap) => ({
            gap_id: gap.gap_id,
            event_id: gap.filing.event_id,
            digest: gap.filing.payload_sha256,
            claim_id: gap.content?.target_claim_id,
            version: gap.content?.target_version,
          })),
        ),
        problem,
        cursor,
        cursor,
        cursor,
        now,
      )
      .all<TargetRow>()
  ).results;
  if (!Array.isArray(rows) || rows.length > gaps.length)
    throw new Error("GAP_MOVE_TARGETS_INVALID");
  const result = new Map<string, TargetRow>();
  const seen = new Set<string>();
  for (const row of rows) {
    const gap = gaps.find((item) => item.gap_id === row.gap_id);
    if (
      !gap ||
      !gap.content ||
      seen.has(row.gap_id) ||
      gap.content.target_claim_id !== row.claim_id ||
      gap.content.target_version !== row.version ||
      !Number.isSafeInteger(row.seq) ||
      row.seq < 1 ||
      row.seq >= gap.filing.seq ||
      row.seq > cursor ||
      typeof row.event_id !== "string" ||
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.exec(row.event_id)?.[0] !== row.event_id
    ) {
      throw new Error("GAP_MOVE_TARGETS_INVALID");
    }
    seen.add(row.gap_id);
    const target = await gapPayload(row.payload_json, row.payload_sha256);
    const filing = await gapPayload(row.gap_json, gap.filing.payload_sha256);
    if (
      !record(target) ||
      !record(filing) ||
      target.claim_id !== row.claim_id ||
      typeof target.statement !== "string" ||
      target.statement.trim().length === 0 ||
      (row.version > 1 && target.base_version !== row.version - 1) ||
      filing.target_claim_id !== row.claim_id ||
      filing.target_version !== row.version
    )
      continue;
    result.set(row.gap_id, row);
  }
  return result;
}

/** Fixed site-authored instructions only: the obligation is read at its own
 * fenced public URL, never interpolated into this trusted move. */
function moveFor(
  problem: string,
  cursor: number,
  gap: ProofGapRecord,
  target: TargetRow,
  template: MoveTemplate,
): NextMoveCandidate | null {
  if (template.availability !== "available" || template.move !== "close-gap") return null;
  return {
    move: "close-gap",
    why: "This is the oldest readable unowned gap among the examined admissions with a current exact-version claim target. Read the obligation and develop a real deduction or counterexample before recording any closure.",
    refs: [problem, gap.gap_id, `${target.claim_id}@${target.version}`],
    contract: {
      ...template,
      prefilled_hints: { gap_id: gap.gap_id, outcome: "closed-by" },
      preparation: {
        problem_id: problem,
        captured_cursor: cursor,
        gap_pin: {
          gap_id: gap.gap_id,
          event_id: gap.filing.event_id,
          seq: gap.filing.seq,
          payload_sha256: gap.filing.payload_sha256,
        },
        target_pin: {
          claim_id: target.claim_id,
          version: target.version,
          event_id: target.event_id,
          seq: target.seq,
          payload_sha256: target.payload_sha256,
        },
        read_first: { method: "GET", path: proofGapPath(problem, "md", cursor, gap.gap_id) },
        additional_reads: [
          {
            method: "GET",
            path: `/p/${problem}/claims/${target.claim_id}@${target.version}.md?through=${cursor}`,
          },
        ],
        open_session: {
          method: "POST",
          path: "/v1/sessions",
          idempotency_key_required: true,
          body: { problem_id: problem, intent: "prove" },
        },
        note: "Reuse an owned session or open one. Develop a deliberate work product privately; publish the actual claim or evidence through the existing validator. Only then supply its real closed_by reference. No reference, evidence, successful deduction or verdict is supplied by this recommendation. Re-read current gap and lease state before acting.",
      },
    },
    selection_boundary: GAP_MOVES_BOUNDARY,
  };
}

export async function loadGapMove(
  db: D1Database,
  problem: string,
  cursor: number,
  now: number,
  dependencies: GapMoveDependencies,
): Promise<GapMoveSelection> {
  if (
    !Number.isSafeInteger(now) ||
    now < 1 ||
    now > 8640000000000000 ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    /^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/.exec(problem)?.[0] !== problem
  )
    throw new Error("GAP_MOVE_INPUT_INVALID");
  const instant = new Date(now).toISOString();
  let after = 0,
    degraded = false;
  const seen = new Set<string>();
  for (let page = 0; page < GAP_MOVE_MAX_PAGES; page++) {
    const result = await dependencies.page(db, problem, { through: cursor, after }, instant);
    const face = result.face;
    if (
      result.unlisted ||
      !["active", "dormant", "under-result-review"].includes(result.problemStatus) ||
      face.problem_id !== problem ||
      face.cursor !== cursor ||
      face.after !== after ||
      face.target !== null ||
      face.gaps.length > 8
    )
      throw new Error("GAP_MOVE_SNAPSHOT_INVALID");
    degraded ||= face.omitted.some((reason) => reason !== "page_limit");
    let previous = after;
    for (const gap of face.gaps) {
      if (
        seen.has(gap.gap_id) ||
        gap.gap_id !== `G-${gap.filing.seq}` ||
        gap.filing.seq <= previous ||
        gap.filing.seq > cursor
      )
        throw new Error("GAP_MOVE_ORDER_INVALID");
      seen.add(gap.gap_id);
      previous = gap.filing.seq;
    }
    const ready = face.gaps.filter(
      (gap) =>
        gap.status === "open" &&
        gap.content !== null &&
        gap.last_event.event_id === gap.filing.event_id,
    );
    const targets = await readGapMoveTargets(db, problem, cursor, instant, ready);
    for (const gap of ready) {
      const target = targets.get(gap.gap_id);
      if (!target) {
        degraded = true;
        continue;
      }
      const move = moveFor(problem, cursor, gap, target, dependencies.template());
      return { move, degraded: degraded || move === null };
    }
    if (face.next_after === null) return { move: null, degraded };
    if (
      !Number.isSafeInteger(face.next_after) ||
      face.next_after <= after ||
      face.next_after !== previous ||
      face.next_after > cursor
    )
      throw new Error("GAP_MOVE_CURSOR_INVALID");
    after = face.next_after;
  }
  return { move: null, degraded: true };
}

/** Permission decisions are the provider's central-policy results, not caller
 * hints. Source failure keeps independent review/hypothesis recommendations. */
export async function withGapMove(
  db: D1Database,
  problem: string,
  cursor: number,
  now: number,
  permissions: Record<string, boolean>,
  selected: { moves: NextMoveCandidate[]; degraded: boolean },
  source?: GapMoveSource,
): Promise<{ moves: NextMoveCandidate[]; degraded: boolean }> {
  if (!source || !permissions.session_open || !permissions.promote) return selected;
  try {
    const extra = await source.load(db, problem, cursor, now);
    const review = selected.moves.filter(
      (move) => move.move === "review" || move.move === "add-refuter",
    );
    const other = selected.moves.filter(
      (move) => move.move !== "review" && move.move !== "add-refuter",
    );
    return {
      moves: extra.move === null ? selected.moves : [...review, extra.move, ...other],
      degraded: selected.degraded || extra.degraded,
    };
  } catch {
    return { moves: selected.moves, degraded: true };
  }
}
