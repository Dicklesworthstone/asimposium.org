import type { MoveTemplate, NextMoveCandidate, ProblemRole } from "@asimposium/contracts";
import type { ReviewQueueItem } from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import { rankReviewQueue } from "../discovery/review-queue-selection.ts";
import type { authorizeFellowWrite, FellowCredentialBinding } from "../enrollment/service.ts";
import {
  type HypothesisMoveSource,
  LIVE_MOVES_BOUNDARY,
  selectThirdAlternative,
} from "./hypothesis-moves.ts";
import { type LedgerMovesDependencies, loadLedgerMoves, reviewTargetKey } from "./ledger-moves.ts";
import type {
  MegaCommandsMoveProvider,
  ProblemMovesRequest,
  ProblemMovesResult,
  TriageMovesRequest,
  TriageMovesResult,
} from "./provider.ts";

export const TRIAGE_MAX_PROBLEMS = 4;
export const TRIAGE_CONCURRENCY = 2;
const TRIAGE_BOUNDARY = `${LIVE_MOVES_BOUNDARY} Triage examines at most ${TRIAGE_MAX_PROBLEMS} assigned problems in ASCII ID order, two queue pages per problem; each problem has its own captured cursor. Hypothesis selection examines at most three surviving routes plus lookahead at the membership read cursor.`;

export interface LiveMovesDependencies extends LedgerMovesDependencies {
  readonly authorize: typeof authorizeFellowWrite;
  readonly now: () => number;
  readonly firstClaimTemplate: () => MoveTemplate;
  /** Production supplies the canonical hypothesis reader; optional only for
   * isolated queue tests and partial deployments of the provider adapter. */
  readonly hypotheses?: HypothesisMoveSource;
}

/** Permission hints use the exact same central policy as the writes, with
 * current membership and grant-wide recorded usage. They are not write grants. */
export const MOVE_MEMBERSHIP_SQL = `SELECT m.role, p.public_seq AS cursor,
    EXISTS (SELECT 1 FROM events e WHERE e.problem_id = p.id AND e.seq <= p.public_seq
      AND e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised')) AS has_claims
  FROM problems p JOIN problem_memberships m ON m.problem_id = p.id AND m.fellow_id = ?
  WHERE p.id = ? AND p.unlisted = 0
    AND p.status IN ('active', 'dormant', 'under-result-review')`;
export const MOVE_USAGE_SQL = "SELECT COUNT(*) AS count FROM events WHERE writer_credential_id = ?";
const NO_PERMISSIONS = {
  read: true,
  session_open: false,
  workshop_push: false,
  promote: false,
  review: false,
};

export class LedgerMovesProvider implements MegaCommandsMoveProvider {
  constructor(private readonly dependencies: LiveMovesDependencies) {}

  private preflight(credential: FellowCredentialBinding, problemId: string, now: number): boolean {
    // The unscoped session admission policy also checks lifecycle, expiry and
    // problem binding, before any existence-sensitive read. Scope checks below
    // happen through the same policy with actual membership and usage.
    return (
      this.dependencies.authorize({
        effect: "session.open",
        credential,
        target: { kind: "session-admission", problemId },
        usage: { eventsRecorded: 0, artifactBytesRecorded: 0 },
        now,
      }).decision === "allow"
    );
  }

  private async usage(db: D1Database, credential: FellowCredentialBinding): Promise<number> {
    if (credential.grantedResources.eventBudget === undefined) return 0;
    const row = await db
      .prepare(MOVE_USAGE_SQL)
      .bind(credential.credentialId)
      .first<{ count: number }>();
    if (!row || !Number.isSafeInteger(row.count) || row.count < 0)
      throw new Error("MOVE_USAGE_UNAVAILABLE");
    return row.count;
  }

  /** Independent review needs stay first. A verified two-route frontier comes
   * before starting a new claim. One unavailable source cannot erase valid
   * recommendations from another, and no observer initiates a promote read. */
  private async withHypotheses(
    db: D1Database,
    problemId: string,
    cursor: number,
    permissions: Record<string, boolean>,
    selected: { moves: NextMoveCandidate[]; degraded: boolean },
  ): Promise<{ moves: NextMoveCandidate[]; degraded: boolean }> {
    const source = this.dependencies.hypotheses;
    if (!source || !permissions.session_open || !permissions.promote) return selected;
    try {
      const extra = selectThirdAlternative(
        problemId,
        cursor,
        await source.load(db, problemId, cursor),
        source.template,
      );
      return {
        moves:
          extra.move === null
            ? selected.moves
            : [
                ...selected.moves.filter((move) => move.move !== "state-claim"),
                extra.move,
                ...selected.moves.filter((move) => move.move === "state-claim"),
              ],
        degraded: selected.degraded || extra.degraded,
      };
    } catch {
      return { moves: selected.moves, degraded: true };
    }
  }

  private async problem(
    db: D1Database,
    problemId: string,
    credential: FellowCredentialBinding,
    eventsRecorded: number,
    now: number,
  ) {
    const row = await db
      .prepare(MOVE_MEMBERSHIP_SQL)
      .bind(credential.fellowId, problemId)
      .first<{ role: string; cursor: number; has_claims: number }>();
    const role: ProblemRole | "none" =
      row?.role === "contributor" || row?.role === "steward" || row?.role === "observer"
        ? row.role
        : "none";
    if (role === "none")
      return {
        items: [] as ReviewQueueItem[],
        moves: [] as NextMoveCandidate[],
        degraded: false,
        continuation: null,
        role,
        effectivePermissions: { ...NO_PERMISSIONS },
      };
    const usage = { eventsRecorded, artifactBytesRecorded: 0 };
    const target = {
      kind: "existing-problem" as const,
      problemId,
      publication: "published" as const,
      unlisted: false,
      membershipRole: role,
    };
    const allowed = (effect: "promote" | "review" | "workshop.push") =>
      this.dependencies.authorize({ effect, credential, target, usage, now }).decision === "allow";
    const effectivePermissions = {
      read: true,
      session_open:
        this.dependencies.authorize({
          effect: "session.open",
          credential,
          target: { kind: "session-admission", problemId },
          usage,
          now,
        }).decision === "allow",
      workshop_push: allowed("workshop.push"),
      promote: allowed("promote"),
      review: allowed("review"),
    };
    if (
      !row ||
      !Number.isSafeInteger(row.cursor) ||
      row.cursor < 0 ||
      (row.has_claims !== 0 && row.has_claims !== 1)
    )
      throw new Error("MOVE_HEAD_UNAVAILABLE");
    if (row.has_claims === 0 && effectivePermissions.session_open && effectivePermissions.promote) {
      const template = this.dependencies.firstClaimTemplate();
      if (template.availability === "available" && template.move === "state-claim") {
        const move: NextMoveCandidate = {
          move: "state-claim",
          why: "No published claim envelopes exist at this problem cursor. Draft one self-contained claim and its falsifier in the private workshop before requesting promotion.",
          refs: [problemId],
          contract: {
            ...template,
            preparation: {
              problem_id: problemId,
              captured_cursor: row.cursor,
              read_first: { method: "GET", path: `/p/${encodeURIComponent(problemId)}.md` },
              open_session: {
                method: "POST",
                path: "/v1/sessions",
                idempotency_key_required: true,
                body: { problem_id: problemId, intent: "explore" },
              },
              workshop_first: {
                method: "POST",
                path: "/v1/sessions/{id}/workshop",
                idempotency_key_required: true,
                schema: "/schemas/sessions.v1.json#/properties/workshop_push_request",
                type: "claim-draft",
              },
              note: "Read the latest problem formulation; it may have changed since selection. Reuse an owned session or open one. Supply your own statement, falsifier and scientific provenance, then promote the returned workshop_id. No public claim is created by this recommendation.",
            },
          },
          selection_boundary: LIVE_MOVES_BOUNDARY,
        };
        return {
          items: [] as ReviewQueueItem[],
          ...(await this.withHypotheses(db, problemId, row.cursor, effectivePermissions, {
            moves: [move],
            degraded: false,
          })),
          continuation: null,
          role,
          effectivePermissions,
        };
      }
    }
    const result = await loadLedgerMoves(
      db,
      problemId,
      credential,
      effectivePermissions,
      this.dependencies,
    );
    return {
      ...result,
      ...(await this.withHypotheses(db, problemId, row.cursor, effectivePermissions, result)),
      role,
      effectivePermissions,
    };
  }

  async nextMoves(request: ProblemMovesRequest): Promise<ProblemMovesResult> {
    const { db, credential, problemId } = request;
    if (!db || !credential || credential.fellowId !== request.fellowId)
      return {
        primaryMove: null,
        alternatives: [],
        degraded: true,
        degradedReason: "MOVES_UNAVAILABLE",
        selectionBoundary: LIVE_MOVES_BOUNDARY,
        effectivePermissions: { ...NO_PERMISSIONS },
      };
    try {
      const now = this.dependencies.now();
      if (!this.preflight(credential, problemId, now))
        return {
          primaryMove: null,
          alternatives: [],
          degraded: false,
          selectionBoundary: LIVE_MOVES_BOUNDARY,
          effectivePermissions: { ...NO_PERMISSIONS },
        };
      const result = await this.problem(
        db,
        problemId,
        credential,
        await this.usage(db, credential),
        now,
      );
      return {
        primaryMove: result.moves[0] ?? null,
        alternatives: result.moves.slice(1, 3),
        degraded: result.degraded,
        ...(result.degraded ? { degradedReason: "MOVES_PARTIAL" } : {}),
        selectionBoundary: `${LIVE_MOVES_BOUNDARY}${result.continuation ? ` Continue discovery: ${result.continuation}` : ""}`,
        effectivePermissions: result.effectivePermissions,
      };
    } catch {
      // Never reflect SQL, exception messages, private IDs or credential details.
      return {
        primaryMove: null,
        alternatives: [],
        degraded: true,
        degradedReason: "MOVES_UNAVAILABLE",
        selectionBoundary: LIVE_MOVES_BOUNDARY,
        effectivePermissions: { ...NO_PERMISSIONS },
      };
    }
  }

  async triageMove(request: TriageMovesRequest): Promise<TriageMovesResult> {
    const { db, credential } = request;
    if (!db || !credential || credential.fellowId !== request.fellowId)
      return {
        move: null,
        degraded: true,
        degradedReason: "MOVES_UNAVAILABLE",
        selectionBoundary: TRIAGE_BOUNDARY,
      };
    try {
      const now = this.dependencies.now();
      const problems = [...new Set(request.assignments.map((assignment) => assignment.problem_id))]
        .filter((id) => this.preflight(credential, id, now))
        .sort();
      if (problems.length === 0)
        return { move: null, degraded: false, selectionBoundary: TRIAGE_BOUNDARY };
      const eventsRecorded = await this.usage(db, credential);
      const selected = problems.slice(0, TRIAGE_MAX_PROBLEMS);
      const results: Array<Awaited<ReturnType<LedgerMovesProvider["problem"]>> | null> =
        selected.map(() => null);
      let index = 0;
      let failed = false;
      await Promise.all(
        Array.from({ length: Math.min(TRIAGE_CONCURRENCY, selected.length) }, async () => {
          while (index < selected.length) {
            const position = index++;
            const id = selected[position];
            if (id === undefined) break;
            try {
              results[position] = await this.problem(db, id, credential, eventsRecorded, now);
            } catch {
              failed = true;
            }
          }
        }),
      );
      const moves = new Map<string, NextMoveCandidate>();
      const eligible: ReviewQueueItem[] = [];
      const continuations: string[] = [];
      let degraded = failed || problems.length > TRIAGE_MAX_PROBLEMS;
      for (const result of results) {
        if (result === null) continue;
        degraded ||= result.degraded;
        if (result.continuation) continuations.push(result.continuation);
        for (const move of result.moves) moves.set(`${move.refs[0]}/${move.refs[1]}`, move);
        eligible.push(...result.items.filter((item) => moves.has(reviewTargetKey(item))));
      }
      // Same ranking as public review discovery, over only this viewer's eligible
      // targets. Completion order of concurrent reads cannot change the winner.
      const first = rankReviewQueue(eligible)[0];
      return {
        // Existing independent checks come first, then a two-route alternative,
        // then an empty board. Cross-problem ties retain ASCII problem order.
        move: first
          ? (moves.get(reviewTargetKey(first)) ?? null)
          : ([...moves.values()].find((move) => move.move === "third-alternative") ??
            [...moves.values()].find((move) => move.move === "state-claim") ??
            null),
        degraded,
        ...(degraded
          ? { degradedReason: failed && moves.size === 0 ? "MOVES_UNAVAILABLE" : "MOVES_PARTIAL" }
          : {}),
        selectionBoundary: `${TRIAGE_BOUNDARY}${continuations.length ? ` Continue discovery: ${continuations.join(" ; ")}` : ""}`,
      };
    } catch {
      return {
        move: null,
        degraded: true,
        degradedReason: "MOVES_UNAVAILABLE",
        selectionBoundary: TRIAGE_BOUNDARY,
      };
    }
  }
}
