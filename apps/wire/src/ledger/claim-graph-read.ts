import type { D1Database } from "@cloudflare/workers-types";
import { hiddenByContentControlSql } from "../krater/public-content.ts";
import type { ClaimDependencySnapshot } from "./claim-dependency-snapshot.ts";
import { computeDependencyCeilings, type DependencyCeiling, type PremiseStanding } from "./dependency-ceiling.ts";

export const CLAIM_GRAPH_ROOT_LIMIT = 4;
export const CLAIM_GRAPH_SELECTION = "latest-public-claim-heads-v1";
export const CLAIM_GRAPH_BOUNDARY =
  "At most four most recently published claim heads at this cursor are examined. Each path follows exact publication pins, not typed relation assertions or later replacement versions. The canonical scientific fold supplies each premise's own standing; an evidence ceiling is not a truth verdict. Missing science, incomplete ancestry, unexamined roots and pack-budget omissions remain explicit. This is not a complete problem graph or a global ranking.";

/** Select envelopes, not bodies, before doing any scientific work. A hidden
 * or unreadable head never falls back to an older version. The fifth envelope
 * proves root-selection truncation and never causes a scientific read. */
export const CLAIM_GRAPH_ROOTS_SQL = `
WITH input(j) AS (VALUES (?)),
scope AS MATERIALIZED (
  SELECT p.id, json_extract(j, '$.cursor') AS cut FROM problems p, input
  WHERE p.id = json_extract(j, '$.problem') AND p.status <> 'private-draft'
    AND p.public_seq >= json_extract(j, '$.cursor')
    AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
),
heads AS MATERIALIZED (
  SELECT e.* FROM events e JOIN scope s ON s.id = e.problem_id
  WHERE e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised') AND e.seq <= s.cut
    AND NOT EXISTS (
      SELECT 1 FROM events later WHERE later.problem_id = e.problem_id AND later.object_id = e.object_id
        AND later.object_kind = 'claim' AND later.type IN ('claim.created', 'claim.revised')
        AND later.seq <= s.cut AND (later.object_version > e.object_version
          OR (later.object_version = e.object_version AND later.seq > e.seq))
    )
  ORDER BY e.seq DESC, e.id ASC LIMIT ${CLAIM_GRAPH_ROOT_LIMIT + 1}
)
SELECT s.id AS problem_id, s.cut AS through, e.id AS event_id, e.seq,
  e.object_id AS claim_id, e.object_version AS version,
  (SELECT COUNT(*) FROM (SELECT duplicate.id FROM events duplicate
    WHERE duplicate.problem_id = e.problem_id AND duplicate.object_id = e.object_id
      AND duplicate.object_version = e.object_version AND duplicate.object_kind = 'claim'
      AND duplicate.type IN ('claim.created', 'claim.revised') AND duplicate.seq <= s.cut LIMIT 2)) AS publications,
  (EXISTS (SELECT 1 FROM event_content c WHERE c.event_id = e.id
    AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL)
    AND NOT ${hiddenByContentControlSql("e.problem_id", "e.object_id")}
    AND NOT ${hiddenByContentControlSql("e.problem_id", "e.object_id || '@' || e.object_version")}
    AND NOT ${hiddenByContentControlSql("e.problem_id", "'#' || e.seq")}) AS available
FROM scope s LEFT JOIN heads e ON e.problem_id = s.id ORDER BY e.seq DESC, e.id ASC`;

interface GraphRootRow {
  readonly problem_id: string;
  readonly through: number;
  readonly event_id: string | null;
  readonly seq: number | null;
  readonly claim_id: string | null;
  readonly version: number | null;
  readonly publications: number;
  readonly available: number;
}

export interface ClaimGraphSummary {
  readonly problem: string;
  readonly through: number;
  readonly target: string;
  readonly standing: PremiseStanding;
  readonly chain: DependencyCeiling;
  readonly closure: {
    readonly scope: "publication-pins";
    readonly complete: boolean;
    readonly verified_premises: number;
    readonly recorded_edges: number;
    readonly unavailable_references: number;
  };
  readonly limiting_premise: {
    readonly target: string;
    readonly standing: PremiseStanding | null;
    readonly read_url: string;
  };
  readonly read_url: string;
}

export interface ClaimGraphRead {
  readonly scopeAvailable: boolean;
  readonly selection: typeof CLAIM_GRAPH_SELECTION;
  readonly rootsExamined: number;
  readonly truncated: boolean;
  readonly graphs: ClaimGraphSummary[];
  readonly omitted: { reason: string; detail: string }[];
}

export type ClaimGraphSnapshotReader = (
  db: D1Database, problem: string, cursor: number, target: string,
) => Promise<ClaimDependencySnapshot>;

const CLASSES = new Set(["assertion", "heuristic", "citation", "computation", "certified"]);
const DISPOSITIONS = new Set(["draft", "open", "malformed", "disputed", "corroborated", "strongly-supported", "refuted", "reduced-to", "withdrawn", "superseded"]);
const REVIEW_STATES = new Set(["unreviewed", "review-requested", "under-review", "contested", "independently-checked"]);

function exactTarget(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 &&
    /^C-[0-9]+@[1-9][0-9]*$/.exec(value)?.[0] === value &&
    Number.isSafeInteger(Number(value.split("@")[1]));
}

function safeStanding(state: PremiseStanding, target: string): PremiseStanding {
  if (!state || typeof state.complete !== "boolean" || typeof state.stale !== "boolean" ||
      (state.disposition !== null && !DISPOSITIONS.has(state.disposition)) ||
      (state.review_state !== null && !REVIEW_STATES.has(state.review_state)) ||
      (state.own_ceiling !== null && !CLASSES.has(state.own_ceiling)) ||
      (state.latest_version !== null && (!Number.isSafeInteger(state.latest_version) ||
        state.latest_version < Number(target.split("@")[1]))) ||
      (state.complete && (state.stale || state.disposition === null || state.review_state === null ||
        state.own_ceiling === null || state.latest_version === null)) ||
      (!state.complete && (state.disposition !== null || state.review_state !== null || state.own_ceiling !== null)))
    throw new Error("Inconsistent premise standing.");
  return {
    complete: state.complete, disposition: state.disposition, review_state: state.review_state,
    stale: state.stale, latest_version: state.latest_version, own_ceiling: state.own_ceiling,
  };
}

/** The shared reader has already verified source bytes. Cross-check identities,
 * graph shape and calculator summaries before projecting aggregate metadata.
 * Copy only known fields: neither source prose nor adapter annotations may
 * become an instruction. Unknown ancestry remains unknown, not an empty DAG.
 */
export function summarizeClaimGraph(
  snapshot: ClaimDependencySnapshot, problem: string, cursor: number, target: string,
): ClaimGraphSummary {
  const closure = snapshot.closure;
  if (snapshot.problem !== problem || snapshot.target !== target || snapshot.through !== cursor ||
      !exactTarget(target) || !Number.isSafeInteger(cursor) || cursor < 0 ||
      !closure || closure.root_available !== true || typeof closure.complete !== "boolean" ||
      !Array.isArray(closure.nodes) || closure.nodes.length > 63 ||
      !Array.isArray(closure.edges) || closure.edges.length > 1024 ||
      !Array.isArray(closure.unavailable) || closure.unavailable.length > 1024 ||
      !closure.unavailable.every(exactTarget) || (closure.complete && closure.unavailable.length !== 0))
    throw new Error("Inconsistent claim graph snapshot.");
  const targets = [target, ...closure.nodes.map((node) => node.target)];
  const known = new Set(targets);
  if (known.size !== targets.length || !targets.every(exactTarget) || snapshot.assessments.size !== known.size)
    throw new Error("Inconsistent graph identities.");
  const children = new Map(targets.map((pin) => [pin, new Set<string>()]));
  const broken = new Set<string>();
  for (const edge of closure.edges) {
    if (!known.has(edge.from) || !exactTarget(edge.to) || typeof edge.available !== "boolean" ||
        children.get(edge.from)!.has(edge.to) || (edge.available && !known.has(edge.to)))
      throw new Error("Inconsistent publication edge.");
    children.get(edge.from)!.add(edge.to);
    if (children.get(edge.from)!.size > 16) throw new Error("Unbounded publication fan-out.");
    if (!edge.available) broken.add(edge.from);
  }
  if (closure.complete && broken.size > 0) throw new Error("Incomplete graph marked complete.");
  const reached = new Set([target]);
  const pending = [target];
  for (let index = 0; index < pending.length; index++) {
    for (const child of children.get(pending[index]!)!) {
      if (known.has(child) && !reached.has(child)) { reached.add(child); pending.push(child); }
    }
  }
  if (reached.size !== known.size) throw new Error("Detached premise in graph.");
  const unknownHistory = new Set(closure.nodes.filter((node) => node.pins === null).map((node) => node.target));
  if (closure.complete && unknownHistory.size > 0) throw new Error("Unknown history marked complete.");
  const standings = new Map<string, PremiseStanding>();
  for (const pin of targets) {
    const assessment = snapshot.assessments.get(pin);
    if (!assessment || assessment.scope !== "publication-pins" || assessment.problem !== problem ||
        assessment.target !== pin || assessment.through !== cursor)
      throw new Error("Premise assessment does not match the graph cut.");
    standings.set(pin, safeStanding(assessment.standing, pin));
  }
  const calculated = computeDependencyCeilings(targets.map((pin) => ({
    target: pin, standing: standings.get(pin)!,
    dependencies: broken.has(pin) || unknownHistory.has(pin) || (pin === target && !closure.complete)
      ? null : [...children.get(pin)!],
  })));
  for (const pin of targets) {
    const expected = calculated.get(pin)!;
    const recorded = snapshot.assessments.get(pin)!.chain;
    if (!recorded || recorded.complete !== expected.complete || recorded.ceiling !== expected.ceiling ||
        recorded.reason !== expected.reason || !Array.isArray(recorded.weakest_path) ||
        recorded.weakest_path.length !== expected.weakest_path.length ||
        !recorded.weakest_path.every((step, index) => step === expected.weakest_path[index]))
      throw new Error("Graph path differs from the canonical chain assessment.");
  }
  const chain = calculated.get(target)!;
  if (chain.weakest_path.length > 65) throw new Error("Unbounded limiting path.");
  const limiting = chain.weakest_path.at(-1)!;
  const readUrl = (pin: string) => `/p/${encodeURIComponent(problem)}/claims/${pin}.md?through=${cursor}`;
  return {
    problem, through: cursor, target, standing: standings.get(target)!,
    chain: { ...chain, weakest_path: [...chain.weakest_path] },
    closure: { scope: "publication-pins", complete: closure.complete,
      verified_premises: closure.nodes.length, recorded_edges: closure.edges.length,
      unavailable_references: closure.unavailable.length },
    limiting_premise: { target: limiting, standing: standings.get(limiting) ?? null, read_url: readUrl(limiting) },
    read_url: readUrl(target),
  };
}

/** Bounded root discovery plus at most four existing two-query snapshots.
 * A bad root does not suppress independently readable roots; failures are
 * counted without returning storage errors or hidden source identifiers.
 */
export async function readClaimGraph(
  db: D1Database, problem: string, cursor: number, loadSnapshot?: ClaimGraphSnapshotReader,
): Promise<ClaimGraphRead> {
  if (/^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/.exec(problem)?.[0] !== problem ||
      !Number.isSafeInteger(cursor) || cursor < 0)
    throw new Error("An exact problem and public cursor are required.");
  const rows = (await db.prepare(CLAIM_GRAPH_ROOTS_SQL)
    .bind(JSON.stringify({ problem, cursor })).all<GraphRootRow>()).results;
  if (!Array.isArray(rows) || rows.length > CLAIM_GRAPH_ROOT_LIMIT + 1 ||
      rows.some((row) => row.problem_id !== problem || row.through !== cursor))
    throw new Error("Inconsistent root selection.");
  const result: ClaimGraphRead = {
    scopeAvailable: rows.length > 0, selection: CLAIM_GRAPH_SELECTION, rootsExamined: 0,
    truncated: rows.length > CLAIM_GRAPH_ROOT_LIMIT, graphs: [], omitted: [],
  };
  if (rows.length === 0) {
    result.omitted.push({ reason: "content_unavailable", detail: "claim-graph: problem or captured cursor unavailable" });
    return result;
  }
  if (rows.length === 1 && rows[0]!.event_id === null) return result;
  if (result.truncated) result.omitted.push({ reason: "candidate_limit", detail: "claim-graph: more current claim roots than the four-root selection bound" });
  let unavailable = 0, incomplete = 0, rootsExamined = 0;
  const seen = new Set<string>();
  let previous = Infinity;
  for (const row of rows.slice(0, CLAIM_GRAPH_ROOT_LIMIT)) {
    const target = `${row.claim_id}@${row.version}`;
    if (!row.event_id || !Number.isSafeInteger(row.seq) || row.seq! < 1 || row.seq! >= previous ||
        row.seq! > cursor || !exactTarget(target) || seen.has(row.claim_id!))
      throw new Error("Inconsistent root publication.");
    previous = row.seq!; seen.add(row.claim_id!);
    if (row.available !== 1 || row.publications !== 1) { unavailable++; continue; }
    rootsExamined++;
    try {
      // Import only for a readable root; a truly empty problem performs no
      // scientific reads and cannot be mistaken for an unavailable backend.
      const load = loadSnapshot ?? (await import("./claim-dependency-snapshot.ts")).readClaimDependencySnapshot;
      const snapshot = await load(db, problem, cursor, target);
      const summary = summarizeClaimGraph(snapshot, problem, cursor, target);
      // A current root selected above cannot legitimately acquire a later
      // head at the same cut; do not mix independent snapshot identities.
      if (summary.standing.latest_version !== null && summary.standing.latest_version !== row.version)
        throw new Error("Claim head changed across graph snapshots.");
      result.graphs.push(summary);
      if (!summary.chain.complete) incomplete++;
    } catch { unavailable++; }
  }
  if (unavailable) result.omitted.push({ reason: "content_unavailable", detail: `claim-graph: ${unavailable} selected root snapshot(s) unavailable` });
  if (incomplete) result.omitted.push({ reason: "premise_assessment_unavailable", detail: `claim-graph: ${incomplete} displayed chain(s) have no complete evidence ceiling; inspect their recorded reasons` });
  return { ...result, rootsExamined };
}
