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

// Resolve the whole dependency set in ONE read snapshot. A large set must not
// consume one D1 round trip per reference, or mix heads and closing events from
// different snapshots. The JSON parameter also avoids a bind-variable ceiling.
// Retractions of an entire claim retain their existing meaning. A retraction
// of C-N@V closes that pin only; an unpinned reference resolves to the live head.
const STALE_ROUTES_SQL = `
  WITH input(j) AS (VALUES (?)),
  requested AS MATERIALIZED (
    SELECT CAST(entry.key AS INTEGER) AS ordinal,
      json_extract(input.j, '$.problem') AS problem_id,
      json_extract(entry.value, '$.kind') AS kind,
      json_extract(entry.value, '$.ref') AS ref,
      json_extract(entry.value, '$.claimId') AS claim_id,
      json_extract(entry.value, '$.version') AS version,
      json_extract(entry.value, '$.hypothesisId') AS hypothesis_id
    FROM input, json_each(input.j, '$.references') entry
  ),
  heads AS MATERIALIZED (
    SELECT claim_id, MAX(version) AS version FROM claim_versions
    WHERE problem_id = (SELECT json_extract(j, '$.problem') FROM input)
      AND claim_id IN (SELECT claim_id FROM requested WHERE claim_id IS NOT NULL)
    GROUP BY claim_id
  ),
  closures AS MATERIALIZED (
    SELECT requested.ordinal, requested.ref,
      CASE WHEN requested.kind = 'hypothesis' THEN (
        SELECT json_object(
          'state', CASE WHEN h.status = 'killed' THEN 'hypothesis-killed' ELSE 'hypothesis-refined' END,
          'closed_by_event_id', e.id, 'closed_at_seq', e.seq)
        FROM hypotheses h
        LEFT JOIN events e ON e.problem_id = h.problem_id
          AND e.object_kind = 'hypothesis' AND e.object_id = h.hypothesis_id
          AND e.type <> 'hypothesis.created'
        WHERE h.problem_id = requested.problem_id
          AND h.hypothesis_id = requested.hypothesis_id AND h.status <> 'open'
        ORDER BY e.seq DESC, e.id ASC LIMIT 1
      ) ELSE COALESCE((
        SELECT json_object('state', 'claim-retracted',
          'closed_by_event_id', e.id, 'closed_at_seq', e.seq)
        FROM retractions r
        LEFT JOIN events e ON e.problem_id = r.problem_id
          AND e.object_kind = 'retraction' AND e.object_id = r.retraction_id
          AND e.type = 'object.retracted'
        WHERE r.problem_id = requested.problem_id
          AND r.target_object IN (
            requested.claim_id,
            requested.claim_id || '@' || COALESCE(requested.version, heads.version)
          )
        ORDER BY e.seq ASC, r.retraction_id ASC, e.id ASC LIMIT 1
      ), (
        SELECT json_object('state', 'claim-version-superseded',
          'closed_by_event_id', e.id, 'closed_at_seq', e.seq,
          'current_version', heads.version)
        FROM (SELECT 1) sentinel
        LEFT JOIN events e ON e.problem_id = requested.problem_id
          AND e.object_kind = 'claim' AND e.object_id = requested.claim_id
          AND e.object_version = requested.version + 1
          AND e.type IN ('claim.created', 'claim.revised')
        WHERE requested.kind = 'claim-version' AND requested.version < heads.version
        ORDER BY e.seq ASC, e.id ASC LIMIT 1
      )) END AS closure_json
    FROM requested LEFT JOIN heads ON heads.claim_id = requested.claim_id
  )
  SELECT ref, closure_json FROM closures WHERE closure_json IS NOT NULL
  ORDER BY ordinal ASC LIMIT 20
`;

/**
 * Resolve which of `references` are closed routes on `problemId`. Unknown
 * objects are not stale (existence is a separate refusal owned by the
 * caller's own validator); the result lists only live-ledger closures.
 *
 * Bound the refusal's diagnostics, never the references being validated.
 * Callers may combine several individually bounded reference fields. Checking
 * only a prefix lets a closed route in a later field escape the promotion gate.
 * The SQL limit is applied after closure resolution, never to the input set.
 * This is a read-only preflight, not a substitute for commit-time race guards.
 */
export async function findStaleRoutes(
  db: Db,
  problemId: string,
  references: readonly StaleRouteReference[],
): Promise<StaleRouteEntry[]> {
  const unique: StaleRouteReference[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    const key =
      reference.kind === "hypothesis"
        ? `hypothesis:${reference.hypothesisId}`
        : reference.kind === "claim-version"
          ? `claim-version:${reference.claimId}@${reference.version}`
          : `claim:${reference.claimId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(reference);
  }
  if (unique.length === 0) return [];
  const rows = await db
    .prepare(STALE_ROUTES_SQL)
    .bind(JSON.stringify({ problem: problemId, references: unique }))
    .all<{ ref: string; closure_json: string }>();
  // The JSON is assembled by this query, not supplied by a ledger author.
  return rows.results.map((row) => ({ ref: row.ref, ...JSON.parse(row.closure_json) }));
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
