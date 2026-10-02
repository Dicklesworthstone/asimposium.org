import {
  canonicalJson,
  MAX_PROJECTION_DOCTOR_DRIFT_ITEMS,
  PROJECTION_DOCTOR_TABLES,
  type ProjectionDoctorReport,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

import { normHash } from "../split/policy.ts";
import { claimContentDigest } from "./claim-version.ts";
import { eventChainMatches, type KraterEvent } from "./krater.ts";

/**
 * W2.6 (79n): rebuild ledger projection rows from the event log alone.
 *
 * The log is the truth (Rule A6). Each write path appends one event whose
 * payload carries every value its projection row stores, so a projection can
 * be recomputed by folding the problem's events in sequence order. This
 * module is pure over the log (replayProjections) plus two thin D1 steps:
 * diffProjections compares the rebuild with the live tables column by
 * column, and repairProjections inserts the rows a problem is missing.
 *
 * Columns ending in _json are compared as canonical JSON: the write paths
 * serialize the request in the client's key order, the log stores canonical
 * JSON, and the value (not its key order) is what the log can reproduce.
 */

export interface LogEvent {
  readonly id: string;
  readonly seq: number;
  readonly type: string;
  readonly objectId: string | null;
  readonly objectVersion: number | null;
  readonly payloadSha256: string | null;
  /** The event's v2 row digest (null while its backfill is pending). */
  readonly rowDigest: string | null;
  readonly createdAt: string;
  readonly actorFellowId: string | null;
  readonly actorSponsorId: string | null;
  readonly actorSessionId: string | null;
  readonly actorModel: string | null;
  readonly actorHarness: string | null;
  readonly payload: Record<string, unknown> | null;
}

type Row = Record<string, unknown>;

/**
 * Replayed tables and their primary keys (all are per problem), in repair
 * (insert) order. The contracts PROJECTION_DOCTOR_TABLES names exactly these.
 */
export const REPLAYED_TABLES = {
  // Claims first: repair inserts in this order and the rest reference them.
  claims: ["id"],
  // Derived build state per claim head: its build digest is the head event's
  // row digest (claimProjectionBuildDigestV1).
  claim_projections: ["claim_id"],
  claim_versions: ["claim_id", "version"],
  claim_deps: ["claim_id", "depends_on_claim_id"],
  reviews: ["review_id"],
  evidence: ["evidence_id"],
  hypotheses: ["hypothesis_id"],
  dead_ends: ["dead_end_id"],
  questions: ["question_id"],
  retractions: ["retraction_id"],
  citations: ["citation_id"],
  citation_versions: ["citation_id", "version"],
  proof_gaps: ["gap_id"],
  conflicts: ["conflict_id"],
  syntheses: ["synthesis_id"],
  claim_relations: ["kind", "source_claim_id", "source_version", "target_ref"],
  problem_statement_reviews: ["version", "reviewer_fellow_id"],
  // Published statement versions only (see statementVersionsFrom).
  problem_statement_versions: ["version"],
} as const satisfies Record<string, readonly string[]>;

/**
 * State that changes without an event, so the log cannot reproduce it: a
 * heartbeat extends a question lease's leased_until, and a claim build row's
 * updated_at records when it was built (the integrity backfill rebuilds
 * legacy rows and stamps its own completion time, nuzc). Neither is ledger
 * content; replay writes the event time and the diff does not compare them.
 */
const EPHEMERAL_COLUMNS: Partial<Record<keyof typeof REPLAYED_TABLES, readonly string[]>> = {
  questions: ["leased_until"],
  claim_projections: ["updated_at"],
};

export type ReplayedTable = keyof typeof REPLAYED_TABLES;

export interface ProjectionReplay {
  readonly rows: Record<ReplayedTable, Map<string, Row>>;
  /** Events a replayed table depends on whose payload is unavailable (e.g. redacted). */
  readonly unreplayable: readonly string[];
  /**
   * The problem head the governance log determines (48js). A field is absent
   * when no event sets it (an unpublished problem, or an older publish event
   * without unlisted).
   */
  readonly head: {
    readonly title?: string;
    readonly status?: string;
    readonly unlisted?: number;
    readonly current_statement_version?: number;
  };
  /**
   * The lowest statement version the log carries a complete record for:
   * earlier versions were private drafts and never entered the ledger.
   * Infinity when the problem was never published.
   */
  readonly statementVersionsFrom: number;
}

const nullable = (value: unknown): unknown => (value === undefined ? null : value);
const json = (value: unknown): string | null =>
  value === undefined || value === null ? null : JSON.stringify(value);

/** The composite key of a replayed row, from its primary-key columns. */
export function rowKey(table: ReplayedTable, row: Row): string {
  return REPLAYED_TABLES[table].map((column) => String(row[column])).join("@");
}

/** Problem state a fold carries between events. */
interface ReplayContext {
  /** The problem statement version claims are anchored to (governance events). */
  statementVersion: number;
  head: {
    title?: string;
    status?: string;
    unlisted?: number;
    current_statement_version?: number;
  };
  statementVersionsFrom: number;
}

async function statementVersionRow(
  state: ProjectionReplay["rows"],
  problemId: string,
  version: number,
  problem: Record<string, unknown>,
  stewardAcceptedBy: unknown,
  createdAt: unknown,
): Promise<void> {
  const statement = String(problem.statement);
  state.problem_statement_versions.set(String(version), {
    problem_id: problemId,
    version,
    statement,
    norm_hash: `sha256:${await normHash(statement)}`,
    falsifier: problem.falsifier,
    motivation: problem.motivation,
    steward_accepted_by: nullable(stewardAcceptedBy),
    created_at: createdAt,
  });
}

type Replayer = (
  state: ProjectionReplay["rows"],
  event: LogEvent,
  payload: Record<string, unknown>,
  problemId: string,
  context: ReplayContext,
) => void | Promise<void>;

async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Every problem governance event records the problem's statement version as
 * its object_version (problems/lifecycle-ledger.ts), so the fold knows which
 * statement version a claim written after it was anchored to.
 */
const GOVERNANCE_EVENTS = new Set([
  "problem.admitted",
  "problem.statement-revised",
  "problem.result-review-started",
  "problem.retired",
  "problem.admission-mode-changed",
  "problem.steward-updated",
  "problem.member-updated",
  "problem.writer-cap-changed",
  "problem.merged",
  "problem.forked",
]);

/**
 * The claim head's build state: a revision replaces the row (the writer
 * deletes then reinserts it), so projection_version is always 1 and the
 * build digest is the head event's row digest.
 */
function claimProjectionRow(
  state: ProjectionReplay["rows"],
  event: LogEvent,
  problemId: string,
  claimId: string,
): void {
  state.claim_projections.set(claimId, {
    claim_id: claimId,
    problem_id: problemId,
    source_seq: event.seq,
    projection_version: 1,
    build_digest: event.rowDigest,
    stale: 0,
    updated_at: event.createdAt,
  });
}

/** A claim version row from its event (z3or: kind and falsifier are in the payload). */
async function claimVersionRow(
  state: ProjectionReplay["rows"],
  event: LogEvent,
  p: Record<string, unknown>,
  problemId: string,
  claimId: string,
  version: number,
): Promise<void> {
  const falsifier = typeof p.falsifier === "string" ? p.falsifier : null;
  const kind = String(p.kind);
  const statement = String(p.statement);
  state.claim_versions.set(`${claimId}@${version}`, {
    claim_id: claimId,
    problem_id: problemId,
    version,
    kind,
    statement,
    falsifier,
    content_digest: await claimContentDigest({ kind, statement, falsifier }, sha256Hex),
    editor_fellow_id: event.actorFellowId,
    created_at: event.createdAt,
  });
  for (const pin of Array.isArray(p.dependency_pins) ? p.dependency_pins : []) {
    const dependsOn = (pin as Record<string, unknown>).claim_id;
    if (typeof dependsOn !== "string" || dependsOn === claimId) continue;
    const key = `${claimId}@${dependsOn}`;
    if (state.claim_deps.has(key)) continue;
    state.claim_deps.set(key, {
      problem_id: problemId,
      claim_id: claimId,
      depends_on_claim_id: dependsOn,
      created_at: event.createdAt,
    });
  }
}

const REPLAYERS: Readonly<Record<string, Replayer>> = {
  "claim.created": async (state, event, p, problemId, context) => {
    const id = String(event.objectId);
    const statement = String(p.statement);
    // A promoted claim's payload carries its kind and falsifier; a local S-2
    // harness claim is kindless ("claim"), has no version row and no norm hash.
    const kinded = typeof p.kind === "string" && p.kind !== "claim" && "falsifier" in p;
    state.claims.set(id, {
      id,
      problem_id: problemId,
      statement,
      payload_sha256: event.payloadSha256,
      norm_hash: kinded ? await normHash(statement) : null,
      source_seq: event.seq,
      statement_version: context.statementVersion,
      statement_drift: 0,
      created_at: event.createdAt,
    });
    claimProjectionRow(state, event, problemId, id);
    if (kinded) await claimVersionRow(state, event, p, problemId, id, 1);
  },
  // The author re-anchors a claim to the current problem statement.
  "claim.reanchored": (state, event, p) => {
    const row = state.claims.get(String(event.objectId));
    const version = Number(p.statement_version);
    if (row === undefined || !Number.isSafeInteger(version)) return;
    row.statement_version = version;
    row.statement_drift = 0;
  },
  "claim.revised": async (state, event, p, problemId, context) => {
    const id = String(event.objectId);
    const row = state.claims.get(id);
    const base = Number(p.base_version);
    if (row === undefined || !Number.isSafeInteger(base)) return;
    const statement = String(p.statement);
    state.claims.set(id, {
      ...row,
      statement,
      payload_sha256: event.payloadSha256,
      norm_hash: await normHash(statement),
      source_seq: event.seq,
      statement_version: context.statementVersion,
      statement_drift: 0,
    });
    claimProjectionRow(state, event, problemId, id);
    await claimVersionRow(state, event, p, problemId, id, base + 1);
  },
  "review.created": (state, event, p, problemId) => {
    state.reviews.set(String(event.objectId), {
      review_id: event.objectId,
      problem_id: problemId,
      target_claim_id: p.target_claim_id,
      target_version: p.target_version,
      reviewer_fellow_id: event.actorFellowId,
      tier: p.tier,
      verdict: p.verdict,
      basis: p.basis,
      capable_of_failure: nullable(p.capable_of_failure),
      rubric_json: json(p.rubric),
      body_md: p.body_md,
      created_at: event.createdAt,
      source_event_id: event.id,
      source_seq: event.seq,
    });
  },
  "evidence.created": (state, event, p, problemId) => {
    const source = (p.source ?? {}) as Record<string, unknown>;
    state.evidence.set(String(event.objectId), {
      evidence_id: event.objectId,
      problem_id: problemId,
      bears_on_kind: p.bears_on_kind,
      bears_on_id: p.bears_on_id,
      bears_on_version: nullable(p.bears_on_version),
      direction: p.direction,
      kind: p.kind,
      source_kind: source.kind,
      locator: nullable(source.locator),
      excerpt: nullable(source.excerpt),
      computation_domain_or_floor: nullable(p.computation_domain_or_floor),
      reproduction_json: json(p.reproduction),
      mode: p.mode,
      selected_hypothesis_id: nullable(p.selected_hypothesis_id),
      computed_class: p.computed_class,
      coercion_flags_json: json(p.coercion_flags ?? []),
      author_fellow_id: event.actorFellowId,
      body_md: p.body_md,
      created_at: event.createdAt,
      source_event_id: event.id,
      source_seq: event.seq,
    });
  },
  "hypothesis.created": (state, event, p, problemId) => {
    state.hypotheses.set(String(event.objectId), {
      hypothesis_id: event.objectId,
      problem_id: problemId,
      route: p.route,
      mechanism: p.mechanism,
      falsifier: p.falsifier,
      expected_evidence: nullable(p.expected_evidence),
      discriminating_predictions_json: json(p.discriminating_predictions),
      origin: p.origin,
      status: "open",
      author_fellow_id: event.actorFellowId,
      created_at: event.createdAt,
      body_md: p.body_md,
      source_event_id: event.id,
      source_seq: event.seq,
      killed_at: null,
      killed_by_evidence_id: null,
      kill_reason: null,
      kill_event_id: null,
      kill_source_seq: null,
    });
  },
  "hypothesis.killed": (state, event, p) => {
    const id = String(p.hypothesis_id ?? event.objectId);
    const row = state.hypotheses.get(id);
    if (row === undefined || row.status !== "open") return;
    state.hypotheses.set(id, {
      ...row,
      status: "killed",
      killed_at: event.createdAt,
      killed_by_evidence_id: p.killed_by_evidence_id,
      kill_reason: p.reason,
      kill_event_id: event.id,
      kill_source_seq: event.seq,
    });
  },
  "dead_end.recorded": (state, event, p, problemId) => {
    const id = String(p.dead_end_id ?? event.objectId);
    state.dead_ends.set(id, {
      dead_end_id: id,
      problem_id: problemId,
      seq: event.seq,
      approach: p.approach,
      why_it_fails: p.why_it_fails,
      retry_predicate: p.retry_predicate,
      what_was_examined: nullable(p.what_was_examined),
      scope_detection_floor: nullable(p.scope_detection_floor),
      retry_when_json: json(p.retry_when),
      norm_hash: p.norm_hash,
      author_fellow_id: event.actorFellowId,
      declared_model: event.actorModel,
      supersedes_dead_end_id: nullable(p.supersedes_dead_end_id),
      superseded_by: null,
      created_at: event.createdAt,
    });
    const superseded =
      typeof p.supersedes_dead_end_id === "string"
        ? state.dead_ends.get(p.supersedes_dead_end_id)
        : undefined;
    if (superseded !== undefined && superseded.superseded_by === null) {
      superseded.superseded_by = id;
    }
  },
  "question.asked": (state, event, p, problemId) => {
    const id = String(p.question_id ?? event.objectId);
    state.questions.set(id, {
      question_id: id,
      problem_id: problemId,
      seq: event.seq,
      target_refs_json: json(p.target_refs ?? []),
      blocking: nullable(p.blocking),
      body_md: p.body_md,
      author_fellow_id: event.actorFellowId,
      status: "open",
      leased_by: null,
      leased_until: null,
      resolved_by_object: null,
      created_at: event.createdAt,
    });
  },
  "question.leased": (state, event, p) => {
    const row = state.questions.get(String(p.question_id ?? event.objectId));
    if (row === undefined) return;
    row.status = "leased";
    row.leased_by = event.actorFellowId;
    row.leased_until = nullable(p.leased_until);
  },
  "question.answered": (state, event, p) => {
    const row = state.questions.get(String(p.question_id ?? event.objectId));
    if (row === undefined) return;
    row.status = "resolved";
    row.resolved_by_object = nullable(p.resolved_by_object);
  },
  "question.withdrawn": (state, event, p) => {
    const row = state.questions.get(String(p.question_id ?? event.objectId));
    if (row === undefined) return;
    row.status = "withdrawn";
  },
  "object.retracted": (state, event, p, problemId) => {
    const id = String(p.retraction_id ?? event.objectId);
    state.retractions.set(id, {
      retraction_id: id,
      problem_id: problemId,
      seq: event.seq,
      target_object: p.target_object,
      retraction_kind: p.retraction_kind,
      reason: p.reason,
      author_fellow_id: event.actorFellowId,
      created_at: event.createdAt,
    });
  },
  "citation.recorded": (state, event, p, problemId) => {
    const id = String(p.citation_id ?? event.objectId);
    const shared = {
      citation_id: id,
      problem_id: problemId,
      version: 1,
      seq: event.seq,
      title: p.title,
      authors_json: json(p.authors ?? []),
      year: nullable(p.year),
      locator_kind: p.locator_kind,
      locator: nullable(p.locator),
      canonical_locator: nullable(p.canonical_locator),
      excerpt: nullable(p.excerpt),
      retrieved_at: nullable(p.retrieved_at),
      source_provenance: p.source_provenance,
      unanchored: p.unanchored === false ? 0 : 1,
      norm_hash: p.norm_hash,
      declared_model: event.actorModel,
      sponsor_id: event.actorSponsorId,
      session_id: event.actorSessionId,
      harness: event.actorHarness,
      created_at: event.createdAt,
    };
    state.citations.set(id, {
      ...shared,
      author_fellow_id: event.actorFellowId,
      updated_at: null,
    });
    state.citation_versions.set(`${id}@1`, { ...shared, editor_fellow_id: event.actorFellowId });
  },
  "citation.corrected": (state, event, p, problemId) => {
    const id = String(p.citation_id ?? event.objectId);
    const current = state.citations.get(id);
    if (current === undefined) return;
    const version = Number(p.version);
    const fields = {
      version,
      seq: event.seq,
      title: p.title,
      authors_json: json(p.authors ?? []),
      year: nullable(p.year),
      locator_kind: p.locator_kind,
      locator: nullable(p.locator),
      canonical_locator: nullable(p.canonical_locator),
      excerpt: nullable(p.excerpt),
      retrieved_at: nullable(p.retrieved_at),
      source_provenance: p.source_provenance,
      norm_hash: p.norm_hash,
      declared_model: event.actorModel,
      sponsor_id: event.actorSponsorId,
      session_id: event.actorSessionId,
      harness: event.actorHarness,
    };
    // The current row keeps its original author and creation time.
    state.citations.set(id, { ...current, ...fields, updated_at: event.createdAt });
    state.citation_versions.set(`${id}@${version}`, {
      ...fields,
      citation_id: id,
      problem_id: problemId,
      unanchored: current.unanchored,
      editor_fellow_id: event.actorFellowId,
      created_at: event.createdAt,
    });
  },
  "gap.filed": (state, event, p, problemId) => {
    state.proof_gaps.set(String(event.objectId), {
      gap_id: event.objectId,
      problem_id: problemId,
      obligation: p.obligation,
      closes_what: p.closes_what,
      target_claim_id: p.target_claim_id,
      target_version: p.target_version,
      status: "open",
      closed_by: null,
      author_fellow_id: event.actorFellowId,
      created_at: event.createdAt,
      closed_at: null,
    });
  },
  "conflict.normalized": (state, event, p, problemId) => {
    const id = String(p.conflict_id ?? event.objectId);
    const claims = Array.isArray(p.claims) ? (p.claims as Record<string, unknown>[]) : [];
    state.conflicts.set(id, {
      conflict_id: id,
      problem_id: problemId,
      seq: event.seq,
      claim_a_id: claims[0]?.claim_id,
      claim_a_version: claims[0]?.version,
      claim_b_id: claims[1]?.claim_id,
      claim_b_version: claims[1]?.version,
      aligned_definitions: p.aligned_definitions,
      aligned_scope: p.aligned_scope,
      aligned_quantifiers: p.aligned_quantifiers,
      smallest_disagreement: p.smallest_disagreement,
      agreed_facts_json: json(p.agreed_facts),
      discriminating_tests_json: json(p.discriminating_tests),
      status: "open",
      resolution: null,
      author_fellow_id: event.actorFellowId,
      created_at: event.createdAt,
      resolved_at: null,
    });
  },
  "conflict.resolved": (state, event, p) => {
    const row = state.conflicts.get(String(p.conflict_id ?? event.objectId));
    if (row === undefined) return;
    row.status = p.status;
    row.resolution = nullable(p.resolution);
    row.resolved_at = nullable(p.resolved_at) ?? event.createdAt;
  },
  "synthesis.created": (state, event, p, problemId) => {
    state.syntheses.set(String(event.objectId), {
      synthesis_id: event.objectId,
      problem_id: problemId,
      covers_through: p.covers_through,
      body_md: p.body_md,
      anchors_json: json(p.anchors),
      omitted_json: json(p.omitted),
      dropped_single_author_count: p.dropped_single_author_count,
      authoring_principal: event.actorFellowId,
      declared_model: event.actorModel,
      created_at: event.createdAt,
    });
  },
  "relation.asserted": (state, event, p, problemId) => {
    const source = parseClaimRef(p.source);
    if (source === null) return;
    const row = {
      problem_id: problemId,
      kind: p.kind,
      source_claim_id: source.id,
      source_version: source.version,
      target_ref: p.target,
      status: "asserted",
      asserted_by_event: event.id,
      asserted_by_fellow: event.actorFellowId,
      created_at: event.createdAt,
      disputed_by_event: null,
      disputed_by_fellow: null,
      disputed_at: null,
    };
    state.claim_relations.set(rowKey("claim_relations", row), row);
  },
  "relation.disputed": (state, event, p) => {
    const source = parseClaimRef(p.source);
    if (source === null) return;
    const row = state.claim_relations.get(
      rowKey("claim_relations", {
        kind: p.kind,
        source_claim_id: source.id,
        source_version: source.version,
        target_ref: p.target,
      }),
    );
    if (row === undefined || row.status !== "asserted") return;
    row.status = "disputed";
    row.disputed_by_event = event.id;
    row.disputed_by_fellow = event.actorFellowId;
    row.disputed_at = event.createdAt;
  },
  // Publication: the head, and the admitted version when the event carries
  // its draft-time record (older publish events do not).
  "problem.admitted": async (state, event, p, problemId, context) => {
    const problem = (p.problem ?? {}) as Record<string, unknown>;
    applyHead(context, problem);
    if (typeof problem.unlisted === "boolean") context.head.unlisted = problem.unlisted ? 1 : 0;
    const version = Number(event.objectVersion);
    const admitted = p.admitted_version as Record<string, unknown> | undefined;
    if (admitted !== undefined) {
      await statementVersionRow(
        state,
        problemId,
        version,
        problem,
        admitted.steward_accepted_by,
        admitted.created_at,
      );
      context.statementVersionsFrom = version;
    } else {
      context.statementVersionsFrom = version + 1;
    }
  },
  // A public statement revision: written by the acting sponsor at event time.
  "problem.statement-revised": async (state, event, p, problemId, context) => {
    const problem = (p.problem ?? {}) as Record<string, unknown>;
    applyHead(context, problem);
    const principal = (p.acting_principal ?? {}) as Record<string, unknown>;
    await statementVersionRow(
      state,
      problemId,
      Number(event.objectVersion),
      problem,
      principal.id,
      event.createdAt,
    );
  },
  // A statement review of one statement version, by the event's actor.
  "problem.statement-reviewed": (state, event, p, problemId, context) => {
    if (typeof p.status === "string") context.head.status = p.status;
    const version = Number(p.statement_version ?? event.objectVersion);
    state.problem_statement_reviews.set(`${version}@${event.actorFellowId}`, {
      problem_id: problemId,
      version,
      reviewer_fellow_id: event.actorFellowId,
      verdict: p.verdict,
      basis: p.basis,
      created_at: event.createdAt,
    });
  },
  "gap.closed-by": (state, event, p) => closeGap(state, event, p),
  "gap.withdrawn": (state, event, p) => closeGap(state, event, p),
};

/** The head fields every governance payload's problem object carries. */
function applyHead(context: ReplayContext, problem: Record<string, unknown>): void {
  if (typeof problem.title === "string") context.head.title = problem.title;
  if (typeof problem.status === "string") context.head.status = problem.status;
  if (typeof problem.current_statement_version === "number") {
    context.head.current_statement_version = problem.current_statement_version;
  }
}

function parseClaimRef(value: unknown): { id: string; version: number } | null {
  if (typeof value !== "string") return null;
  const at = value.lastIndexOf("@");
  if (at < 1) return null;
  const version = Number(value.slice(at + 1));
  return Number.isSafeInteger(version) ? { id: value.slice(0, at), version } : null;
}

function closeGap(
  state: ProjectionReplay["rows"],
  event: LogEvent,
  p: Record<string, unknown>,
): void {
  const row = state.proof_gaps.get(String(p.gap_id ?? event.objectId));
  if (row === undefined || row.status !== "open") return;
  row.status = p.outcome;
  row.closed_by = nullable(p.closed_by);
  row.closed_at = event.createdAt;
}

/** Fold one problem's log, in sequence order, into projection rows. */
export async function replayProjections(
  problemId: string,
  events: readonly LogEvent[],
): Promise<ProjectionReplay> {
  const rows = Object.fromEntries(
    Object.keys(REPLAYED_TABLES).map((table) => [table, new Map<string, Row>()]),
  ) as ProjectionReplay["rows"];
  const unreplayable: string[] = [];
  const context: ReplayContext = {
    statementVersion: 1,
    head: {},
    statementVersionsFrom: Number.POSITIVE_INFINITY,
  };
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (GOVERNANCE_EVENTS.has(event.type) && event.objectVersion !== null) {
      if (event.type === "problem.statement-revised") {
        // Claims anchored to an older statement are marked as drifted.
        for (const claim of rows.claims.values()) {
          if (Number(claim.statement_version) < event.objectVersion) claim.statement_drift = 1;
        }
      }
      context.statementVersion = event.objectVersion;
      // Every other governance event also restates the head.
      if (
        event.type !== "problem.admitted" &&
        event.type !== "problem.statement-revised" &&
        event.payload !== null
      ) {
        applyHead(context, (event.payload.problem ?? {}) as Record<string, unknown>);
      }
    }
    const replayer = REPLAYERS[event.type];
    if (replayer === undefined) continue;
    if (event.payload === null) {
      unreplayable.push(event.id);
      continue;
    }
    await replayer(rows, event, event.payload, problemId, context);
  }
  return {
    rows,
    unreplayable,
    head: context.head,
    statementVersionsFrom: context.statementVersionsFrom,
  };
}

/** A problem's event log with payloads (null where content is redacted). */
const LOG_SELECT = `SELECT e.id, e.seq, e.type, e.object_kind, e.object_id, e.object_version,
        e.payload_sha256, e.created_at, e.actor_fellow_id,
        e.actor_sponsor_id, e.actor_session_id, e.model_string_self_declared, e.harness,
        e.writer_credential_id, ch.row_digest, ch.chain_digest, ch.chain_version,
        c.payload_sha256 AS content_sha256, c.payload_json, c.redacted_at
   FROM events e
   LEFT JOIN event_chain_v2 ch ON ch.event_id = e.id
   LEFT JOIN event_content c ON c.event_id = e.id
  WHERE e.problem_id = ?
  ORDER BY e.seq`;

interface LogRow {
  id: string;
  seq: number;
  type: string;
  object_kind: string;
  object_id: string | null;
  object_version: number | null;
  payload_sha256: string | null;
  created_at: string;
  actor_fellow_id: string | null;
  actor_sponsor_id: string | null;
  actor_session_id: string | null;
  model_string_self_declared: string | null;
  harness: string | null;
  writer_credential_id: string | null;
  row_digest: string | null;
  chain_digest: string | null;
  chain_version: number | null;
  content_sha256: string | null;
  payload_json: string | null;
  redacted_at: string | null;
}

function toLogEvent(row: LogRow): LogEvent {
  let payload: Record<string, unknown> | null = null;
  if (row.payload_json !== null && row.redacted_at === null) {
    try {
      const parsed: unknown = JSON.parse(row.payload_json);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = null;
    }
  }
  return {
    id: row.id,
    seq: row.seq,
    type: row.type,
    objectId: row.object_id,
    objectVersion: row.object_version,
    payloadSha256: row.payload_sha256,
    rowDigest: row.row_digest,
    createdAt: row.created_at,
    actorFellowId: row.actor_fellow_id,
    actorSponsorId: row.actor_sponsor_id,
    actorSessionId: row.actor_session_id,
    actorModel: row.model_string_self_declared,
    actorHarness: row.harness,
    payload,
  };
}

export async function readProblemLog(db: D1Database, problemId: string): Promise<LogEvent[]> {
  const result = await db.prepare(LOG_SELECT).bind(problemId).all<LogRow>();
  return result.results.map(toLogEvent);
}

/** A problem's log and every replayed table, read together. */
export interface ProjectionSnapshot {
  readonly events: readonly LogEvent[];
  readonly live: Record<ReplayedTable, readonly Row[]>;
  /** The same log rows with their envelope, chain and content digests. */
  readonly logRows: readonly LogRow[];
  /** The latest integrity checkpoint, read in the same transaction. */
  readonly checkpoint: { readonly seq: number; readonly root: string } | null;
  /** The problem head (public cursor and chain digest), same transaction. */
  readonly head: {
    readonly publicSeq: number;
    readonly chainDigest: string | null;
    readonly chainVersion: number | null;
    readonly title: string;
    readonly status: string;
    readonly unlisted: number;
    readonly current_statement_version: number;
  } | null;
  readonly problemId: string;
}

/**
 * Read the log and every replayed table in one D1 batch, which runs as a
 * single transaction: a write landing between reads cannot show up as a
 * false drift (the log from before it, a table from after it).
 */
export async function readProjectionSnapshot(
  db: D1Database,
  problemId: string,
): Promise<ProjectionSnapshot> {
  const tables = Object.keys(REPLAYED_TABLES) as ReplayedTable[];
  const results = await db.batch([
    db.prepare(LOG_SELECT).bind(problemId),
    db
      .prepare(
        `SELECT public_seq, chain_digest, chain_version, title, status, unlisted,
                current_statement_version FROM problems WHERE id = ?`,
      )
      .bind(problemId),
    db
      .prepare(
        `SELECT checkpoint_seq, root_chain_digest FROM integrity_checkpoints
          WHERE problem_id = ? ORDER BY checkpoint_seq DESC LIMIT 1`,
      )
      .bind(problemId),
    ...tables.map((table) =>
      db.prepare(`SELECT * FROM ${table} WHERE problem_id = ?`).bind(problemId),
    ),
  ]);
  const [log, headResult, pin, ...rows] = results;
  const live = {} as Record<ReplayedTable, readonly Row[]>;
  for (const [index, table] of tables.entries()) {
    live[table] = (rows[index]?.results ?? []) as Row[];
  }
  const logRows = (log?.results ?? []) as LogRow[];
  const headRow = (headResult?.results ?? [])[0] as
    | {
        public_seq: number;
        chain_digest: string | null;
        chain_version: number | null;
        title: string;
        status: string;
        unlisted: number;
        current_statement_version: number;
      }
    | undefined;
  const pinRow = (pin?.results ?? [])[0] as
    | { checkpoint_seq: number; root_chain_digest: string }
    | undefined;
  return {
    events: logRows.map(toLogEvent),
    live,
    logRows,
    checkpoint:
      pinRow === undefined ? null : { seq: pinRow.checkpoint_seq, root: pinRow.root_chain_digest },
    head:
      headRow === undefined
        ? null
        : {
            publicSeq: headRow.public_seq,
            chainDigest: headRow.chain_digest,
            chainVersion: headRow.chain_version,
            title: headRow.title,
            status: headRow.status,
            unlisted: headRow.unlisted,
            current_statement_version: headRow.current_statement_version,
          },
    problemId,
  };
}

export type ProjectionDrift =
  | { readonly table: ReplayedTable; readonly key: string; readonly kind: "missing_row" }
  | { readonly table: ReplayedTable; readonly key: string; readonly kind: "orphan_row" }
  | {
      readonly table: ReplayedTable | "problems";
      readonly key: string;
      readonly kind: "column";
      readonly column: string;
    };

function sameValue(column: string, expected: unknown, actual: unknown): boolean {
  const a = expected === undefined ? null : expected;
  const b = actual === undefined ? null : actual;
  if (a === null || b === null) return a === b;
  if (column.endsWith("_json") && typeof a === "string" && typeof b === "string") {
    try {
      return canonicalJson(JSON.parse(a)) === canonicalJson(JSON.parse(b));
    } catch {
      return a === b;
    }
  }
  return a === b;
}

/**
 * Compare the rebuild with the live rows over every column the live table
 * has, so a column the replay does not produce shows up as drift rather
 * than being silently skipped. Reports keys and column names only.
 */
export async function diffProjections(
  db: D1Database,
  problemId: string,
  replay?: ProjectionReplay,
): Promise<{ drift: ProjectionDrift[]; unreplayable: readonly string[] }> {
  const snapshot = await readProjectionSnapshot(db, problemId);
  return diffSnapshot(replay ?? (await replayProjections(problemId, snapshot.events)), snapshot);
}

/** Compare a rebuild with the snapshot's live rows (pure). */
export function diffSnapshot(
  rebuilt: ProjectionReplay,
  snapshot: ProjectionSnapshot,
): { drift: ProjectionDrift[]; unreplayable: readonly string[] } {
  const drift: ProjectionDrift[] = [];
  for (const table of Object.keys(REPLAYED_TABLES) as ReplayedTable[]) {
    // Draft-only statement versions never entered the ledger.
    const liveRows =
      table === "problem_statement_versions"
        ? snapshot.live[table].filter((row) => Number(row.version) >= rebuilt.statementVersionsFrom)
        : snapshot.live[table];
    const liveByKey = new Map(liveRows.map((row) => [rowKey(table, row), row]));
    const ephemeral = new Set(EPHEMERAL_COLUMNS[table] ?? []);
    const expected = rebuilt.rows[table];
    for (const [key, row] of expected) {
      const actual = liveByKey.get(key);
      if (actual === undefined) {
        drift.push({ table, key, kind: "missing_row" });
        continue;
      }
      for (const column of Object.keys(actual)) {
        if (ephemeral.has(column)) continue;
        if (!sameValue(column, row[column], actual[column])) {
          drift.push({ table, key, kind: "column", column });
        }
      }
    }
    for (const key of liveByKey.keys()) {
      if (!expected.has(key)) drift.push({ table, key, kind: "orphan_row" });
    }
  }
  const head = snapshot.head;
  if (head !== null) {
    for (const [column, value] of Object.entries(rebuilt.head)) {
      if (value === undefined) continue;
      const live = head[column as keyof typeof head];
      if (live !== value) {
        drift.push({ table: "problems", key: snapshot.problemId, kind: "column", column });
      }
    }
  }
  return { drift, unreplayable: rebuilt.unreplayable };
}

/**
 * Why a repair did not end consistent. The first two are decided before any
 * write; PROJECTION_REPAIR_INCOMPLETE means rows were inserted and drift remains.
 */
export type ProjectionRepairRefusal =
  | "PROJECTION_LOG_INTEGRITY_FAILED"
  | "PROJECTION_REBUILD_UNREPLAYABLE"
  | "PROJECTION_DRIFT_NOT_REPAIRABLE"
  | "PROJECTION_REPAIR_INCOMPLETE";

/**
 * A repair that did not end consistent. `inserted` is how many rows it wrote:
 * 0 for the two up-front refusals, and the real count for an incomplete one.
 */
export class ProjectionRepairRefusedError extends Error {
  readonly code: ProjectionRepairRefusal;
  readonly inserted: number;
  /** Drift items found when the repair refused (0 when not measured). */
  readonly driftCount: number;

  constructor(code: ProjectionRepairRefusal, inserted = 0, driftCount = 0) {
    super(code);
    this.code = code;
    this.inserted = inserted;
    this.driftCount = driftCount;
    this.name = "ProjectionRepairRefusedError";
  }
}

async function sourceCursor(db: D1Database, problemId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE problem_id = ?")
    .bind(problemId)
    .first<{ seq: number }>();
  return row?.seq ?? 0;
}

/**
 * ops:event-verify for one problem, over the snapshot's own rows (so what is
 * verified is exactly what a repair replays): the envelope chain (row and
 * chain digests from genesis), every unredacted payload against the digest
 * its event recorded, and the latest integrity checkpoint root. A projection
 * is never rebuilt from a log that fails this: replay would faithfully
 * rebuild edited content. Events still lacking their v2 digests make the log
 * unverifiable (backfill pending), which is not evidence of tampering.
 */
export async function integrityOfSnapshot(
  problemId: string,
  snapshot: ProjectionSnapshot,
): Promise<ProjectionDoctorReport["integrity"]> {
  const rows = snapshot.logRows;
  const last = rows.at(-1);
  const head = snapshot.head;
  // A problem with events but no chain head yet is awaiting its integrity
  // backfill, exactly as the write path treats it (it refuses appends then).
  const backfillPending =
    rows.some((row) => row.row_digest === null || row.chain_digest === null) ||
    (last !== undefined && head !== null && head.chainDigest === null);
  const chainSound =
    !backfillPending &&
    (await eventChainMatches(
      rows.map(
        (row) =>
          ({
            eventId: row.id,
            problemId,
            seq: row.seq,
            type: row.type,
            objectKind: row.object_kind,
            objectId: row.object_id,
            objectVersion: row.object_version,
            payloadSha256: row.payload_sha256,
            rowDigest: row.row_digest,
            chainDigest: row.chain_digest,
            chainVersion: row.chain_version,
            createdAt: row.created_at,
            actorFellowId: row.actor_fellow_id,
            actorSponsorId: row.actor_sponsor_id,
            actorSessionId: row.actor_session_id,
            modelStringSelfDeclared: row.model_string_self_declared,
            harness: row.harness,
            writerCredentialId: row.writer_credential_id,
          }) as KraterEvent,
      ),
    ));
  let contentMismatches = 0;
  let redacted = 0;
  for (const row of rows) {
    if (row.content_sha256 === null || row.payload_json === null) {
      contentMismatches++;
    } else if (row.redacted_at !== null) {
      redacted++;
      if (row.content_sha256 !== row.payload_sha256) contentMismatches++;
    } else if (
      row.content_sha256 !== row.payload_sha256 ||
      (await sha256Hex(row.payload_json)) !== row.payload_sha256
    ) {
      contentMismatches++;
    }
  }
  // The head must name the last event under the current chain version: a
  // removed tail (with its checkpoint) leaves a shorter chain that is
  // otherwise perfectly consistent.
  const headMatches =
    last === undefined
      ? true
      : head !== null &&
        head.publicSeq === last.seq &&
        head.chainDigest === last.chain_digest &&
        head.chainVersion === last.chain_version;
  const pin = snapshot.checkpoint;
  const checkpoint =
    pin === null ? null : { seq: pin.seq, matches: rows[pin.seq - 1]?.chain_digest === pin.root };
  return {
    events: rows.length,
    chain_sound: chainSound,
    backfill_pending: backfillPending,
    head_matches: headMatches,
    content_mismatches: contentMismatches,
    redacted,
    checkpoint,
    sound: chainSound && headMatches && contentMismatches === 0 && (checkpoint?.matches ?? true),
  };
}

/** ops:event-verify on a fresh snapshot of the problem. */
export async function verifyLogIntegrity(
  db: D1Database,
  problemId: string,
): Promise<ProjectionDoctorReport["integrity"]> {
  return integrityOfSnapshot(problemId, await readProjectionSnapshot(db, problemId));
}

/**
 * ops:projection-rebuild dry run (W2.6): replay the problem's log, compare it
 * with the live tables and report keys, column names and counts, never row
 * content or payloads.
 */
export async function projectionDoctorReport(
  db: D1Database,
  problemId: string,
): Promise<ProjectionDoctorReport> {
  const snapshot = await readProjectionSnapshot(db, problemId);
  const integrity = await integrityOfSnapshot(problemId, snapshot);
  const replay = await replayProjections(problemId, snapshot.events);
  const { drift, unreplayable } = diffSnapshot(replay, snapshot);
  const tables = PROJECTION_DOCTOR_TABLES.map((table) => ({
    table,
    rebuilt_rows: replay.rows[table].size,
    live_rows: snapshot.live[table].length,
  }));
  return {
    problem_id: problemId,
    mode: "dry-run",
    source_cursor: snapshot.events.at(-1)?.seq ?? 0,
    status: integrity.backfill_pending
      ? "log_unverifiable"
      : !integrity.sound
        ? "log_integrity_failed"
        : unreplayable.length > 0
          ? "unreplayable"
          : drift.length > 0
            ? "drift"
            : "consistent",
    tables,
    drift: drift.slice(0, MAX_PROJECTION_DOCTOR_DRIFT_ITEMS),
    drift_count: drift.length,
    drift_truncated: drift.length > MAX_PROJECTION_DOCTOR_DRIFT_ITEMS,
    unreplayable_events: unreplayable.length,
    integrity,
    repairable:
      integrity.sound &&
      unreplayable.length === 0 &&
      drift.every((item) => item.kind === "missing_row"),
  };
}

/**
 * Record a problem's projection health (migration 0084): `drift` while stored
 * boards disagree with the log in a way repair could not fix, `consistent`
 * once a repair proves them equal. Public faces read it to warn.
 */
export async function recordProjectionHealth(
  db: D1Database,
  problemId: string,
  status: "drift" | "consistent",
  driftCount: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO projection_health (problem_id, status, source_cursor, drift_count, recorded_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(problem_id) DO UPDATE SET status = excluded.status,
         source_cursor = excluded.source_cursor, drift_count = excluded.drift_count,
         recorded_at = excluded.recorded_at`,
    )
    .bind(
      problemId,
      status,
      await sourceCursor(db, problemId),
      driftCount,
      new Date().toISOString(),
    )
    .run();
}

/** ops:projection-rebuild repair: insert the missing rows, then prove consistency. */
export async function repairProblemProjections(
  db: D1Database,
  problemId: string,
): Promise<{ inserted: number; sourceCursor: number }> {
  const inserted = await repairProjections(db, problemId);
  const after = await diffProjections(db, problemId);
  const refusal = repairOutcome(inserted, after.drift.length + after.unreplayable.length);
  if (refusal !== null) {
    throw new ProjectionRepairRefusedError(refusal, inserted, after.drift.length);
  }
  return { inserted, sourceCursor: await sourceCursor(db, problemId) };
}

/**
 * The refusal a repair owes after its re-check, so that its words stay true
 * (Rule A4): drift after committed inserts is PROJECTION_REPAIR_INCOMPLETE
 * ("rows were inserted"); drift with nothing inserted (it appeared after a
 * clean first check) is PROJECTION_DRIFT_NOT_REPAIRABLE ("nothing was
 * changed"). Null when the problem is consistent.
 */
export function repairOutcome(
  inserted: number,
  remainingProblems: number,
): Exclude<ProjectionRepairRefusal, "PROJECTION_REBUILD_UNREPLAYABLE"> | null {
  if (remainingProblems === 0) return null;
  return inserted > 0 ? "PROJECTION_REPAIR_INCOMPLETE" : "PROJECTION_DRIFT_NOT_REPAIRABLE";
}

/**
 * Write the problem head the governance log determines (title, status,
 * unlisted, current statement version) onto the problem row. Used by restore,
 * whose problem row starts as a bare chain head (48js); ordinary repair never
 * rewrites it. Fields the log does not set are left as they are.
 */
export async function applyReplayedProblemHead(db: D1Database, problemId: string): Promise<number> {
  const snapshot = await readProjectionSnapshot(db, problemId);
  const replay = await replayProjections(problemId, snapshot.events);
  const fields = Object.entries(replay.head).filter(([, value]) => value !== undefined);
  if (fields.length === 0) return 0;
  await db
    .prepare(
      `UPDATE problems SET ${fields.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`,
    )
    .bind(...fields.map(([, value]) => value), problemId)
    .run();
  return fields.length;
}

/**
 * Insert the replayed rows a problem is missing (the restore case: the log
 * came back, its projections did not). Replayed tables are append-only by
 * trigger, so a row that exists but differs, or exists with no log behind it,
 * is not rewritten here: that refuses with PROJECTION_DRIFT_NOT_REPAIRABLE for
 * an operator. Also refuses when any relevant payload is unreplayable
 * (redacted), rather than rebuilding a partial board.
 */
export async function repairProjections(db: D1Database, problemId: string): Promise<number> {
  // Verify and replay the same snapshot: the rows rebuilt are the rows verified.
  const snapshot = await readProjectionSnapshot(db, problemId);
  if (!(await integrityOfSnapshot(problemId, snapshot)).sound) {
    throw new ProjectionRepairRefusedError("PROJECTION_LOG_INTEGRITY_FAILED");
  }
  const replay = await replayProjections(problemId, snapshot.events);
  if (replay.unreplayable.length > 0) {
    throw new ProjectionRepairRefusedError("PROJECTION_REBUILD_UNREPLAYABLE");
  }
  const { drift } = diffSnapshot(replay, snapshot);
  if (drift.some((item) => item.kind !== "missing_row")) {
    throw new ProjectionRepairRefusedError("PROJECTION_DRIFT_NOT_REPAIRABLE", 0, drift.length);
  }
  const statements = drift.map((item) => {
    // Only replayed tables can be missing a row; problem-head drift is a column.
    const row = replay.rows[item.table as ReplayedTable].get(item.key) as Row;
    const columns = Object.keys(row);
    return db
      .prepare(
        `INSERT INTO ${item.table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      )
      .bind(...columns.map((column) => row[column] ?? null));
  });
  if (statements.length > 0) await db.batch(statements);
  return statements.length;
}
