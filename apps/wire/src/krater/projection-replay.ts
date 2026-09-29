import {
  canonicalJson,
  MAX_PROJECTION_DOCTOR_DRIFT_ITEMS,
  PROJECTION_DOCTOR_TABLES,
  type ProjectionDoctorReport,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

import { normHash } from "../split/policy.ts";
import { claimContentDigest } from "./claim-version.ts";

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
} as const satisfies Record<string, readonly string[]>;

/**
 * Coordination state that changes without an event, so the log cannot
 * reproduce it: a heartbeat extends a question lease's leased_until.
 */
const EPHEMERAL_COLUMNS: Partial<Record<keyof typeof REPLAYED_TABLES, readonly string[]>> = {
  questions: ["leased_until"],
};

export type ReplayedTable = keyof typeof REPLAYED_TABLES;

export interface ProjectionReplay {
  readonly rows: Record<ReplayedTable, Map<string, Row>>;
  /** Events a replayed table depends on whose payload is unavailable (e.g. redacted). */
  readonly unreplayable: readonly string[];
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
  "gap.closed-by": (state, event, p) => closeGap(state, event, p),
  "gap.withdrawn": (state, event, p) => closeGap(state, event, p),
};

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
  const context: ReplayContext = { statementVersion: 1 };
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (GOVERNANCE_EVENTS.has(event.type) && event.objectVersion !== null) {
      if (event.type === "problem.statement-revised") {
        // Claims anchored to an older statement are marked as drifted.
        for (const claim of rows.claims.values()) {
          if (Number(claim.statement_version) < event.objectVersion) claim.statement_drift = 1;
        }
      }
      context.statementVersion = event.objectVersion;
    }
    const replayer = REPLAYERS[event.type];
    if (replayer === undefined) continue;
    if (event.payload === null) {
      unreplayable.push(event.id);
      continue;
    }
    await replayer(rows, event, event.payload, problemId, context);
  }
  return { rows, unreplayable };
}

/** A problem's event log with payloads (null where content is redacted). */
export async function readProblemLog(db: D1Database, problemId: string): Promise<LogEvent[]> {
  const result = await db
    .prepare(
      `SELECT e.id, e.seq, e.type, e.object_id, e.object_version, e.payload_sha256,
              e.created_at, e.actor_fellow_id,
              e.actor_sponsor_id, e.actor_session_id, e.model_string_self_declared, e.harness,
              c.payload_json, c.redacted_at
         FROM events e LEFT JOIN event_content c ON c.event_id = e.id
        WHERE e.problem_id = ?
        ORDER BY e.seq`,
    )
    .bind(problemId)
    .all<{
      id: string;
      seq: number;
      type: string;
      object_id: string | null;
      object_version: number | null;
      payload_sha256: string | null;
      created_at: string;
      actor_fellow_id: string | null;
      actor_sponsor_id: string | null;
      actor_session_id: string | null;
      model_string_self_declared: string | null;
      harness: string | null;
      payload_json: string | null;
      redacted_at: string | null;
    }>();
  return result.results.map((row) => {
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
      createdAt: row.created_at,
      actorFellowId: row.actor_fellow_id,
      actorSponsorId: row.actor_sponsor_id,
      actorSessionId: row.actor_session_id,
      actorModel: row.model_string_self_declared,
      actorHarness: row.harness,
      payload,
    };
  });
}

export type ProjectionDrift =
  | { readonly table: ReplayedTable; readonly key: string; readonly kind: "missing_row" }
  | { readonly table: ReplayedTable; readonly key: string; readonly kind: "orphan_row" }
  | {
      readonly table: ReplayedTable;
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
  const rebuilt =
    replay ?? (await replayProjections(problemId, await readProblemLog(db, problemId)));
  const drift: ProjectionDrift[] = [];
  for (const table of Object.keys(REPLAYED_TABLES) as ReplayedTable[]) {
    const live = await db
      .prepare(`SELECT * FROM ${table} WHERE problem_id = ?`)
      .bind(problemId)
      .all<Row>();
    const liveByKey = new Map(live.results.map((row) => [rowKey(table, row), row]));
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
  return { drift, unreplayable: rebuilt.unreplayable };
}

/** A repair the log cannot perform safely; nothing was written. */
export class ProjectionRepairRefusedError extends Error {
  readonly code: "PROJECTION_REBUILD_UNREPLAYABLE" | "PROJECTION_DRIFT_NOT_REPAIRABLE";

  constructor(code: "PROJECTION_REBUILD_UNREPLAYABLE" | "PROJECTION_DRIFT_NOT_REPAIRABLE") {
    super(code);
    this.code = code;
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
 * ops:projection-rebuild dry run (W2.6): replay the problem's log, compare it
 * with the live tables and report keys, column names and counts, never row
 * content or payloads.
 */
export async function projectionDoctorReport(
  db: D1Database,
  problemId: string,
): Promise<ProjectionDoctorReport> {
  const events = await readProblemLog(db, problemId);
  const replay = await replayProjections(problemId, events);
  const { drift, unreplayable } = await diffProjections(db, problemId, replay);
  const tables = [];
  for (const table of PROJECTION_DOCTOR_TABLES) {
    const live = await db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE problem_id = ?`)
      .bind(problemId)
      .first<{ n: number }>();
    tables.push({ table, rebuilt_rows: replay.rows[table].size, live_rows: live?.n ?? 0 });
  }
  return {
    problem_id: problemId,
    mode: "dry-run",
    source_cursor: events.at(-1)?.seq ?? 0,
    status: unreplayable.length > 0 ? "unreplayable" : drift.length > 0 ? "drift" : "consistent",
    tables,
    drift: drift.slice(0, MAX_PROJECTION_DOCTOR_DRIFT_ITEMS),
    drift_count: drift.length,
    drift_truncated: drift.length > MAX_PROJECTION_DOCTOR_DRIFT_ITEMS,
    unreplayable_events: unreplayable.length,
    repairable: unreplayable.length === 0 && drift.every((item) => item.kind === "missing_row"),
  };
}

/** ops:projection-rebuild repair: insert the missing rows, then prove consistency. */
export async function repairProblemProjections(
  db: D1Database,
  problemId: string,
): Promise<{ inserted: number; sourceCursor: number }> {
  const inserted = await repairProjections(db, problemId);
  const after = await diffProjections(db, problemId);
  if (after.drift.length > 0 || after.unreplayable.length > 0) {
    throw new ProjectionRepairRefusedError("PROJECTION_DRIFT_NOT_REPAIRABLE");
  }
  return { inserted, sourceCursor: await sourceCursor(db, problemId) };
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
  const replay = await replayProjections(problemId, await readProblemLog(db, problemId));
  if (replay.unreplayable.length > 0) {
    throw new ProjectionRepairRefusedError("PROJECTION_REBUILD_UNREPLAYABLE");
  }
  const { drift } = await diffProjections(db, problemId, replay);
  if (drift.some((item) => item.kind !== "missing_row")) {
    throw new ProjectionRepairRefusedError("PROJECTION_DRIFT_NOT_REPAIRABLE");
  }
  const statements = drift.map((item) => {
    const row = replay.rows[item.table].get(item.key) as Row;
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
