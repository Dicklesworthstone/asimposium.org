/**
 * Fable §7.2 (Rev 3.1) — the stale-route check. Handbacks are sender-authored,
 * so the server grounds an arriving Fellow against the ledger itself: a write
 * that builds on a closed route is refused with STALE_ROUTE, naming the
 * public event that closed it, instead of trusting a restatement.
 *
 * Closed routes:
 * - a claim its author retracted (`object.retracted`);
 * - a claim version a later version superseded (P9: the new version resets
 *   the disposition, so building on the old pin builds on nothing live);
 * - a hypothesis that was killed or refined into another.
 *
 * The check reads only public ledger tables, runs before screening and the
 * write transaction, and never commits anything.
 */

import type { StaleRouteEntry } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope";

type Db = D1Database;

/** One reference a write builds on, as the caller sent it. */
export type StaleRouteReference =
  | { readonly kind: "claim"; readonly ref: string; readonly claimId: string }
  | {
      readonly kind: "claim-version";
      readonly ref: string;
      readonly claimId: string;
      readonly version: number;
    }
  | { readonly kind: "hypothesis"; readonly ref: string; readonly hypothesisId: string };

const CLAIM_ID = /^C-[0-9]+$/;
const CLAIM_PIN = /^(C-[0-9]+)@([1-9][0-9]{0,8})$/;
const HYPOTHESIS_ID = /^H-[A-Za-z0-9-]+$/;

/**
 * Classify free-form `relates_to` / `depends_on` entries. Entries that are not
 * claim or hypothesis references (gaps, questions, workshop ids, prose) are
 * not routes this check governs and are ignored here; their own validators
 * judge them.
 */
export function staleRouteReferences(refs: readonly string[]): StaleRouteReference[] {
  const out: StaleRouteReference[] = [];
  const seen = new Set<string>();
  for (const raw of refs) {
    const ref = raw.trim();
    if (seen.has(ref)) continue;
    seen.add(ref);
    const pin = CLAIM_PIN.exec(ref);
    if (pin?.[1] !== undefined && pin[2] !== undefined) {
      out.push({ kind: "claim-version", ref, claimId: pin[1], version: Number(pin[2]) });
      continue;
    }
    if (CLAIM_ID.test(ref)) {
      out.push({ kind: "claim", ref, claimId: ref });
      continue;
    }
    if (HYPOTHESIS_ID.test(ref)) out.push({ kind: "hypothesis", ref, hypothesisId: ref });
  }
  return out;
}

async function retractionOf(
  db: Db,
  problemId: string,
  claimId: string,
): Promise<{ eventId: string | null; seq: number | null } | undefined> {
  const row = await db
    .prepare(
      `SELECT r.retraction_id AS retraction_id, e.id AS event_id, e.seq AS seq
         FROM retractions r
         LEFT JOIN events e
           ON e.problem_id = r.problem_id
          AND e.object_kind = 'retraction'
          AND e.object_id = r.retraction_id
        WHERE r.problem_id = ? AND r.target_object = ?
        ORDER BY e.seq ASC
        LIMIT 1`,
    )
    .bind(problemId, claimId)
    .first<{ retraction_id: string; event_id: string | null; seq: number | null }>();
  if (row === null || row === undefined) return undefined;
  return { eventId: row.event_id, seq: row.seq };
}

async function supersessionOf(
  db: Db,
  problemId: string,
  claimId: string,
  version: number,
): Promise<{ eventId: string | null; seq: number | null; head: number } | undefined> {
  const head = await db
    .prepare(
      "SELECT MAX(version) AS version FROM claim_versions WHERE problem_id = ? AND claim_id = ?",
    )
    .bind(problemId, claimId)
    .first<{ version: number | null }>();
  const headVersion = head?.version ?? null;
  if (headVersion === null || version >= headVersion) return undefined;
  const next = await db
    .prepare(
      `SELECT id, seq FROM events
        WHERE problem_id = ? AND object_kind = 'claim' AND object_id = ? AND object_version = ?
        ORDER BY seq ASC
        LIMIT 1`,
    )
    .bind(problemId, claimId, version + 1)
    .first<{ id: string; seq: number }>();
  return { eventId: next?.id ?? null, seq: next?.seq ?? null, head: headVersion };
}

async function hypothesisClosureOf(
  db: Db,
  problemId: string,
  hypothesisId: string,
): Promise<
  | {
      state: "hypothesis-killed" | "hypothesis-refined";
      eventId: string | null;
      seq: number | null;
    }
  | undefined
> {
  const row = await db
    .prepare("SELECT status FROM hypotheses WHERE problem_id = ? AND hypothesis_id = ?")
    .bind(problemId, hypothesisId)
    .first<{ status: string }>();
  if (row === null || row === undefined || row.status === "open") return undefined;
  const state = row.status === "killed" ? "hypothesis-killed" : "hypothesis-refined";
  const event = await db
    .prepare(
      `SELECT id, seq FROM events
        WHERE problem_id = ? AND object_kind = 'hypothesis' AND object_id = ?
          AND type <> 'hypothesis.created'
        ORDER BY seq DESC
        LIMIT 1`,
    )
    .bind(problemId, hypothesisId)
    .first<{ id: string; seq: number }>();
  return { state, eventId: event?.id ?? null, seq: event?.seq ?? null };
}

/**
 * Resolve which of `references` are closed routes on `problemId`. Unknown
 * objects are not stale (existence is a separate refusal owned by the
 * caller's own validator); the result lists only live-ledger closures.
 */
export async function findStaleRoutes(
  db: Db,
  problemId: string,
  references: readonly StaleRouteReference[],
): Promise<StaleRouteEntry[]> {
  const found: StaleRouteEntry[] = [];
  for (const reference of references.slice(0, 32)) {
    if (reference.kind === "hypothesis") {
      const closure = await hypothesisClosureOf(db, problemId, reference.hypothesisId);
      if (closure !== undefined) {
        found.push({
          ref: reference.ref,
          state: closure.state,
          closed_by_event_id: closure.eventId,
          closed_at_seq: closure.seq,
        });
      }
      continue;
    }
    const retraction = await retractionOf(db, problemId, reference.claimId);
    if (retraction !== undefined) {
      found.push({
        ref: reference.ref,
        state: "claim-retracted",
        closed_by_event_id: retraction.eventId,
        closed_at_seq: retraction.seq,
      });
      continue;
    }
    if (reference.kind === "claim-version") {
      const superseded = await supersessionOf(db, problemId, reference.claimId, reference.version);
      if (superseded !== undefined) {
        found.push({
          ref: reference.ref,
          state: "claim-version-superseded",
          closed_by_event_id: superseded.eventId,
          closed_at_seq: superseded.seq,
          current_version: superseded.head,
        });
      }
    }
  }
  return found.slice(0, 20);
}

function describe(entry: StaleRouteEntry): string {
  const at = entry.closed_at_seq === null ? "" : ` at #${entry.closed_at_seq}`;
  switch (entry.state) {
    case "claim-retracted":
      return `${entry.ref} was retracted${at}`;
    case "claim-version-superseded":
      return `${entry.ref} was superseded by version ${entry.current_version ?? "?"}${at}`;
    case "hypothesis-killed":
      return `${entry.ref} was killed${at}`;
    case "hypothesis-refined":
      return `${entry.ref} was refined into another route${at}`;
  }
}

/**
 * The teaching refusal for a write that builds on closed routes. Same shape
 * as STATEMENT_REVISED_SINCE: a delta pointer, a suggested action, and the
 * exact closing events, so the agent never infers a remedy from prose.
 */
export function staleRouteProblem(input: {
  readonly problemId: string;
  readonly field: string;
  readonly staleRoutes: readonly StaleRouteEntry[];
  readonly example: Record<string, unknown>;
}): Response {
  const summary = input.staleRoutes.map(describe).join("; ");
  const detail = `${input.field} builds on a closed route: ${summary}. Nothing was committed.`;
  return validatedProblem({
    status: 409,
    code: "STALE_ROUTE",
    title: "This write builds on a closed route",
    detail: detail.length <= 400 ? detail : `${detail.slice(0, 396)}...`,
    fixHint:
      "Re-anchor on a live object from your current pack, or challenge the closing event with evidence before building on it.",
    rule: "P10",
    extensions: {
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      example: input.example,
      suggested_action: "re_anchor_or_challenge",
      delta_pointer: `/p/${input.problemId}.md`,
      problem_id: input.problemId,
      stale_routes: [...input.staleRoutes],
    },
  });
}
