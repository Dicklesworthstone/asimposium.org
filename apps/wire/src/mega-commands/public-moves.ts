import {
  generateMoveTemplatesDocument,
  getMoveTemplate,
  type MoveDiscoveryOmission,
  type NextMoveCandidate,
  NextMoveCandidateSchema,
  PUBLIC_MOVES_PAGE_SIZE,
  PublicLedgerProblemIdSchema,
  type PublicMovesQuery,
  type PublicMovesResponse,
  PublicMovesResponseSchema,
  type PublicProblemMoves,
  PublicProblemMovesSchema,
} from "@asimposium/contracts";
import type { ReviewQueueItem, ReviewQueueResponse } from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import { loadReviewQueue } from "../discovery/review-queue-service.ts";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import { loadLiveHypotheses } from "../ledger/hypotheses-service.ts";
import {
  type PublishedProblemFormulation,
  readPublishedProblemFormulation,
} from "../ledger/problem-formulation-read.ts";
import { composeDiscriminateMove } from "./discriminate-moves.ts";
import { selectFormalizeMove } from "./formalize-moves.ts";
import { loadFormalizationFrictionMove } from "./friction-moves-service.ts";
import { loadProofGapMove } from "./gap-moves-service.ts";
import { selectThirdAlternative } from "./hypothesis-moves.ts";
import { firstClaimMove, loadLedgerMoveQueue, selectPublicLedgerMoves } from "./ledger-moves.ts";
import { compareMovePriority, selectTriageMove, uniqueMoves } from "./move-selection.ts";
import { selectSharpenStatementMove } from "./sharpen-moves.ts";

export const PUBLIC_MOVES_BOUNDARY =
  "public-needs-v1: canonical statement-sharpening, review, refutation, formalization-friction, proof-gap, load-bearing formalization, third-alternative, discrimination-draft and first-claim selectors. At most two review pages and the selectors' own bounded inputs per problem. Identity-specific work, private sessions and workshop contents are not examined. Read the pinned public inputs, then use authenticated /v1/p/:id/next to check your eligibility. Discovery grants no write permission, assignment, reservation or scientific standing.";
export const GLOBAL_MOVES_BOUNDARY = `${PUBLIC_MOVES_BOUNDARY} Each live page examines at most ${PUBLIC_MOVES_PAGE_SIZE} listed working problems in ASCII ID order. Canonical move priority and review consequence rank the examined needs, not popularity. Each problem has its own captured cursor; next_after continues the admission order, not a global optimum or frozen global snapshot.`;

const READ_ONLY_VIEWER = {
  role: "none" as const,
  effective_permissions: {
    read: true as const,
    session_open: false as const,
    workshop_push: false as const,
    promote: false as const,
    review: false as const,
  },
};

interface MoveHead {
  id: string;
  cursor: number;
  status: string;
  unlisted: number;
  has_claims: number;
  current_statement_version: number;
  controls_revision: number;
}
const HEAD_COLUMNS = `p.id, p.public_seq AS cursor, p.status, p.unlisted, p.current_statement_version,
  EXISTS (SELECT 1 FROM events e WHERE e.problem_id = p.id AND e.seq <= p.public_seq
    AND e.object_kind = 'claim' AND e.type IN ('claim.created','claim.revised')) AS has_claims,
  COALESCE((SELECT MAX(cc.rowid) FROM content_controls cc WHERE cc.problem_id = p.id),0)
    AS controls_revision`;
export const PUBLIC_MOVE_HEAD_SQL = `SELECT ${HEAD_COLUMNS} FROM problems p
  WHERE p.id = ? AND p.status != 'private-draft' AND (p.unlisted = 0 OR ? = 1)
    AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}`;
export const PUBLIC_MOVE_DISCOVERY_SQL = `SELECT ${HEAD_COLUMNS} FROM problems p
  WHERE p.id > ? AND p.unlisted = 0
    AND p.status IN ('active','dormant','under-result-review','sharpening')
    AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
  ORDER BY p.id COLLATE BINARY LIMIT ?`;

/** Revalidate exact canonical publication pins, never any event that happens
 * to share an object/version. Claim references without an explicit pin resolve
 * their publication before applying present-day availability controls. */
export const PUBLIC_MOVE_REFERENCES_SQL = `WITH cut AS (SELECT ? AS problem_id, ? AS cursor)
  SELECT COUNT(*) AS missing FROM json_each(?) target CROSS JOIN cut
  WHERE NOT EXISTS (
    SELECT 1 FROM events e JOIN event_content c ON c.event_id = e.id
      AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
    WHERE e.problem_id = cut.problem_id AND e.seq <= cut.cursor
      AND e.object_id = json_extract(target.value,'$.id')
      AND e.object_kind = json_extract(target.value,'$.kind')
      AND (json_extract(target.value,'$.version') IS NULL
        OR e.object_version = json_extract(target.value,'$.version'))
      AND e.id = COALESCE(json_extract(target.value,'$.event_id'), (
        SELECT source.id FROM events source
        WHERE source.problem_id = cut.problem_id AND source.object_kind = 'claim'
          AND source.type IN ('claim.created','claim.revised')
          AND source.object_id = json_extract(target.value,'$.id')
          AND source.object_version = json_extract(target.value,'$.version')
          AND source.seq <= cut.cursor
        ORDER BY source.seq DESC LIMIT 1
      ))
      AND (json_extract(target.value,'$.seq') IS NULL OR e.seq = json_extract(target.value,'$.seq'))
      AND (json_extract(target.value,'$.payload_sha256') IS NULL
        OR e.payload_sha256 = json_extract(target.value,'$.payload_sha256'))
      AND NOT ${eventContentHiddenSql("e")}
  )`;

interface PublicationReference {
  id: string;
  kind: "claim" | "hypothesis" | "gap" | "evidence" | "problem";
  version?: number;
  event_id?: string;
  seq?: number;
  payload_sha256?: string;
}

function validHead(row: MoveHead): boolean {
  return (
    PublicLedgerProblemIdSchema.safeParse(row.id).success &&
    Number.isSafeInteger(row.cursor) &&
    row.cursor >= 0 &&
    Number.isSafeInteger(row.controls_revision) &&
    row.controls_revision >= 0 &&
    Number.isSafeInteger(row.current_statement_version) &&
    row.current_statement_version >= 1 &&
    (row.unlisted === 0 || row.unlisted === 1) &&
    (row.has_claims === 0 || row.has_claims === 1) &&
    typeof row.status === "string"
  );
}

function omitted(reason: MoveDiscoveryOmission["reason"], detail: string): MoveDiscoveryOmission {
  return { reason, detail };
}

function emptyProblem(head: MoveHead, omissions: MoveDiscoveryOmission[] = []): PublicProblemMoves {
  return PublicProblemMovesSchema.parse({
    problem_id: head.id,
    viewer: READ_ONLY_VIEWER,
    primary_move: null,
    alternatives: [],
    captured_cursor: head.cursor,
    degraded: omissions.length > 0,
    ...(omissions.length ? { degraded_reason: "MOVES_PARTIAL" } : {}),
    omitted: omissions,
    selection_boundary: PUBLIC_MOVES_BOUNDARY,
  });
}

export interface PublicMoveSelectors {
  queue: typeof loadReviewQueue;
  gaps: typeof loadProofGapMove;
  frictions: typeof loadFormalizationFrictionMove;
  formalize: typeof selectFormalizeMove;
  hypotheses: typeof loadLiveHypotheses;
  formulation: typeof readPublishedProblemFormulation;
  sharpen: typeof selectSharpenStatementMove;
}
const production: PublicMoveSelectors = {
  queue: loadReviewQueue,
  gaps: loadProofGapMove,
  frictions: loadFormalizationFrictionMove,
  formalize: selectFormalizeMove,
  hypotheses: loadLiveHypotheses,
  formulation: readPublishedProblemFormulation,
  sharpen: selectSharpenStatementMove,
};

interface SelectedProblem {
  face: PublicProblemMoves;
  items: ReviewQueueItem[];
}

async function selectProblem(
  db: D1Database,
  head: MoveHead,
  now: number,
  selectors: PublicMoveSelectors,
): Promise<SelectedProblem> {
  if (!["active", "dormant", "under-result-review", "sharpening"].includes(head.status))
    return { face: emptyProblem(head), items: [] };
  const omissions: MoveDiscoveryOmission[] = [];
  const candidates: NextMoveCandidate[] = [];
  let items: ReviewQueueItem[] = [];
  let formulation: PublishedProblemFormulation | undefined;
  const hypothesisPins = new Map<string, PublicationReference[]>();
  const collect = (result: { move: NextMoveCandidate | null; degraded: boolean }, name: string) => {
    if (result.move) candidates.push(result.move);
    if (result.degraded)
      omissions.push(
        omitted(
          "selector_unavailable",
          `${name} selection is incomplete within its canonical input bounds.`,
        ),
      );
  };
  const attempt = async (
    name: string,
    run: () => Promise<{ move: NextMoveCandidate | null; degraded: boolean }>,
  ) => {
    try {
      collect(await run(), name);
    } catch {
      omissions.push(
        omitted("selector_unavailable", `${name} inputs are temporarily unavailable.`),
      );
    }
  };

  if (head.has_claims === 0 || head.status === "sharpening") {
    try {
      formulation = await selectors.formulation(db, head.id, head.cursor);
      if (formulation?.problem.current_statement_version !== head.current_statement_version)
        formulation = undefined;
    } catch {
      /* A retained projection is not a fallback publication. */
    }
    if (!formulation)
      omissions.push(
        omitted(
          "content_unavailable",
          "The current published problem formulation could not be verified. Statement work was withheld.",
        ),
      );
  }
  if (head.status === "sharpening") {
    if (formulation)
      await attempt("Statement sharpening", () => selectors.sharpen(db, head.id, head.cursor));
  } else if (head.has_claims === 0) {
    if (formulation) {
      const move = firstClaimMove(
        head.id,
        head.cursor,
        getMoveTemplate("state-claim"),
        PUBLIC_MOVES_BOUNDARY,
      );
      if (move) candidates.push(move);
    }
  } else {
    // Share exact admissions with formalization instead of independently
    // sampling another queue or evaluating scientific standing a second way.
    const pages = new Map<string, ReviewQueueResponse>();
    const queue: typeof loadReviewQueue = async (database, query, snapshot) => {
      const key = JSON.stringify(query);
      let result = pages.get(key);
      if (!result) {
        result = await selectors.queue(database, query, snapshot);
        pages.set(key, result);
      }
      return result;
    };
    try {
      const result = await loadLedgerMoveQueue(db, head.id, { loadQueue: queue }, head.cursor, {
        includeUnlisted: head.unlisted === 1,
      });
      items = result.items;
      candidates.push(...selectPublicLedgerMoves(items, getMoveTemplate));
      if (result.degraded)
        omissions.push(
          omitted(
            "content_unavailable",
            "Some canonical review admissions could not be examined; read the public review queue for further work.",
          ),
        );
      await attempt("Formalization friction", () =>
        selectors.frictions(db, head.id, head.cursor, items),
      );
      await attempt("Load-bearing formalization", () =>
        selectors.formalize(db, head.id, head.cursor, {
          load: (database, problem, cursor, after) =>
            queue(
              database,
              { problem, ...(after === undefined ? {} : { after }) },
              { problemId: problem, through: cursor, includeUnlisted: head.unlisted === 1 },
            ),
          template: () => getMoveTemplate("formalize"),
        }),
      );
    } catch {
      omissions.push(
        omitted("selector_unavailable", "Canonical review inputs are temporarily unavailable."),
      );
    }
    await attempt("Proof gap", () => selectors.gaps(db, head.id, head.cursor, now));
  }
  if (head.status !== "sharpening")
    try {
      const hypotheses = await selectors.hypotheses(db, head.id, head.cursor);
      for (const item of hypotheses?.face.hypotheses ?? []) {
        hypothesisPins.set(
          item.hypothesis_id,
          [item.publication, item.last_event].map((pin) => ({
            id: item.hypothesis_id,
            kind: "hypothesis",
            version: 1,
            event_id: pin.event_id,
            seq: pin.seq,
            payload_sha256: pin.payload_sha256,
          })),
        );
      }
      collect(
        selectThirdAlternative(head.id, head.cursor, hypotheses, () =>
          getMoveTemplate("third-alternative"),
        ),
        "Third alternative",
      );
      if (head.unlisted === 0)
        collect(
          composeDiscriminateMove(head.id, head.cursor, hypotheses, () =>
            getMoveTemplate("discriminate"),
          ),
          "Discrimination",
        );
    } catch {
      omissions.push(
        omitted(
          "selector_unavailable",
          "Canonical active-hypothesis inputs are temporarily unavailable.",
        ),
      );
    }

  const safe = candidates.filter((move) => {
    const preparation = move.contract.preparation as Record<string, unknown> | undefined;
    return (
      NextMoveCandidateSchema.safeParse(move).success &&
      move.refs[0] === head.id &&
      preparation?.problem_id === head.id &&
      preparation.captured_cursor === head.cursor
    );
  });
  if (safe.length !== candidates.length)
    omissions.push(
      omitted(
        "snapshot_changed",
        "A recommendation did not match the captured public problem cut and was withheld.",
      ),
    );
  const ranked = uniqueMoves(safe).sort(compareMovePriority);
  const selected = ranked.slice(0, 3);
  if (ranked.length > selected.length)
    omissions.push(
      omitted(
        "selection_limit",
        "Only one primary move and two alternatives are shown; further needs remain in the canonical public reads.",
      ),
    );
  const refs: PublicationReference[] = [];
  if (
    formulation &&
    selected.some((move) => ["state-claim", "sharpen-statement"].includes(move.move))
  )
    refs.push({
      id: head.id,
      kind: "problem",
      version: head.current_statement_version,
      ...formulation.publication,
    });
  for (const move of selected) {
    const preparation = move.contract.preparation as Record<string, unknown>;
    const pinned = new Map<string, PublicationReference>();
    for (const [key, kind, field] of [
      ["target_pin", "claim", "claim_id"],
      ["gap_pin", "gap", "gap_id"],
      ["friction_pin", "evidence", "evidence_id"],
    ] as const) {
      const pin = preparation[key] as Record<string, unknown> | undefined;
      if (!pin) continue;
      if (
        typeof pin[field] !== "string" ||
        typeof pin.event_id !== "string" ||
        typeof pin.seq !== "number" ||
        !Number.isSafeInteger(pin.seq) ||
        typeof pin.payload_sha256 !== "string"
      )
        throw new Error("PUBLIC_MOVE_PIN_INVALID");
      const reference: PublicationReference = {
        id: pin[field],
        kind,
        event_id: pin.event_id,
        seq: pin.seq,
        payload_sha256: pin.payload_sha256,
        ...(typeof pin.version === "number" ? { version: pin.version } : {}),
      };
      pinned.set(
        `${reference.id}${reference.version === undefined ? "" : `@${reference.version}`}`,
        reference,
      );
    }
    const dependencies = preparation.dependency_focus as Record<string, unknown> | undefined;
    const paths = [dependencies?.dependency_path, dependencies?.limiting_path].flatMap((path) =>
      Array.isArray(path) ? path : [],
    );
    for (const ref of new Set([...move.refs.slice(1), ...paths])) {
      if (typeof ref !== "string") throw new Error("PUBLIC_MOVE_REFERENCE_INVALID");
      if (ref === `S@${head.current_statement_version}` && formulation) continue;
      const exact = pinned.get(ref);
      const hypotheses = hypothesisPins.get(ref);
      if (exact) refs.push(exact);
      else if (hypotheses) refs.push(...hypotheses);
      else {
        const claim = /^(C-[A-Za-z0-9-]+)@([1-9][0-9]*)$/.exec(ref);
        const id = claim?.[1];
        const version = Number(claim?.[2]);
        if (!id || !Number.isSafeInteger(version)) throw new Error("PUBLIC_MOVE_REFERENCE_INVALID");
        refs.push({ id, kind: "claim", version });
      }
    }
  }
  const current = await db
    .prepare(PUBLIC_MOVE_HEAD_SQL)
    .bind(head.id, head.unlisted)
    .first<MoveHead>();
  if (!current || JSON.stringify(current) !== JSON.stringify(head))
    return {
      face: emptyProblem(head, [
        omitted(
          "snapshot_changed",
          "Public scope or its ledger/content-control cut changed during selection. Retry this read.",
        ),
      ]),
      items: [],
    };
  if (refs.length > 0) {
    const visible = await db
      .prepare(PUBLIC_MOVE_REFERENCES_SQL)
      .bind(head.id, head.cursor, JSON.stringify(refs))
      .first<{ missing: number }>();
    if (visible?.missing !== 0)
      return {
        face: emptyProblem(head, [
          omitted(
            "content_unavailable",
            "A selected public input was withdrawn or hidden during selection. Retry this read.",
          ),
        ]),
        items: [],
      };
  }
  return {
    face: PublicProblemMovesSchema.parse({
      ...emptyProblem(head, omissions),
      primary_move: selected[0] ?? null,
      alternatives: selected.slice(1),
    }),
    items,
  };
}

/** Known public URLs may name unlisted work, but never private drafts. */
export async function loadPublicProblemMoves(
  db: D1Database,
  problemId: string,
  options: { now?: number; selectors?: PublicMoveSelectors } = {},
): Promise<PublicProblemMoves | null> {
  const head = await db.prepare(PUBLIC_MOVE_HEAD_SQL).bind(problemId, 1).first<MoveHead>();
  if (!head) return null;
  if (!validHead(head)) throw new Error("PUBLIC_MOVE_HEAD_INVALID");
  try {
    return (
      await selectProblem(db, head, options.now ?? Date.now(), options.selectors ?? production)
    ).face;
  } catch {
    return emptyProblem(head, [
      omitted(
        "selector_unavailable",
        "The public scientific inputs for this problem are temporarily unavailable.",
      ),
    ]);
  }
}

/** No credential, membership, private session or workshop read enters this
 * path. All production selectors and scientific ranking are shared with next. */
export async function loadPublicMoves(
  db: D1Database | undefined,
  query: PublicMovesQuery = {},
  options: { now?: number; selectors?: PublicMoveSelectors } = {},
): Promise<PublicMovesResponse> {
  const base = {
    ...generateMoveTemplatesDocument(),
    discovery: {
      scope: "public-needs" as const,
      problems: [] as PublicProblemMoves[],
      scanned: 0,
      next_after: null as string | null,
      degraded: false,
      omitted: [] as MoveDiscoveryOmission[],
      selection_boundary: GLOBAL_MOVES_BOUNDARY,
    },
  };
  try {
    if (!db) throw new Error("PUBLIC_MOVES_DB_UNAVAILABLE");
    const read = async () =>
      (
        await db
          .prepare(PUBLIC_MOVE_DISCOVERY_SQL)
          .bind(query.after ?? "", PUBLIC_MOVES_PAGE_SIZE + 1)
          .all<MoveHead>()
      ).results;
    const heads = await read();
    if (
      !Array.isArray(heads) ||
      heads.length > PUBLIC_MOVES_PAGE_SIZE + 1 ||
      heads.some(
        (row, index) =>
          !validHead(row) ||
          row.unlisted !== 0 ||
          row.id <= (heads[index - 1]?.id ?? query.after ?? ""),
      )
    )
      throw new Error("PUBLIC_MOVES_HEADS_INVALID");
    const admitted = heads.slice(0, PUBLIC_MOVES_PAGE_SIZE);
    const selected: SelectedProblem[] = [];
    for (const head of admitted) {
      try {
        selected.push(
          await selectProblem(db, head, options.now ?? Date.now(), options.selectors ?? production),
        );
      } catch {
        selected.push({
          face: emptyProblem(head, [
            omitted(
              "selector_unavailable",
              "The public scientific inputs for this problem are temporarily unavailable.",
            ),
          ]),
          items: [],
        });
      }
    }
    // Check the admission set again after the bounded selector work. A hidden
    // problem must not survive in output, an omission, or a continuation ID.
    if (JSON.stringify(await read()) !== JSON.stringify(heads)) {
      base.discovery.degraded = true;
      base.discovery.omitted.push(
        omitted(
          "snapshot_changed",
          "Public admissions changed during selection. Retry this page; no earlier identifiers or continuation were retained.",
        ),
      );
      return PublicMovesResponseSchema.parse(base);
    }
    const pending = [...selected];
    while (pending.length > 0) {
      const best = selectTriageMove(
        pending.flatMap((row) => (row.face.primary_move ? [row.face.primary_move] : [])),
        pending.flatMap((row) => row.items),
      );
      const index = best ? pending.findIndex((row) => row.face.primary_move === best) : 0;
      const next = pending.splice(Math.max(0, index), 1)[0];
      if (!next) throw new Error("PUBLIC_MOVES_RANKING_UNAVAILABLE");
      base.discovery.problems.push(next.face);
    }
    base.discovery.scanned = admitted.length;
    base.discovery.degraded = selected.some((row) => row.face.degraded);
    if (heads.length > PUBLIC_MOVES_PAGE_SIZE) {
      const boundary = admitted.at(-1);
      if (!boundary) throw new Error("PUBLIC_MOVES_BOUNDARY_UNAVAILABLE");
      base.discovery.next_after = boundary.id;
      base.discovery.omitted.push(
        omitted(
          "page_limit",
          "Additional listed problems remain. Continue with next_after unchanged; ranking applies only to this live page.",
        ),
      );
    }
    return PublicMovesResponseSchema.parse(base);
  } catch {
    base.discovery.degraded = true;
    base.discovery.omitted.push(
      omitted(
        "selector_unavailable",
        "Live scientific needs are temporarily unavailable. The move catalog remains readable; retry discovery later.",
      ),
    );
    return PublicMovesResponseSchema.parse(base);
  }
}
