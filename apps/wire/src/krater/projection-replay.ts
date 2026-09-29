import { canonicalJson } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

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
  readonly createdAt: string;
  readonly actorFellowId: string | null;
  readonly payload: Record<string, unknown> | null;
}

type Row = Record<string, unknown>;

/** Replayed tables and their primary keys (all are per problem). */
export const REPLAYED_TABLES = {
  reviews: ["review_id"],
  evidence: ["evidence_id"],
  hypotheses: ["hypothesis_id"],
} as const satisfies Record<string, readonly string[]>;

export type ReplayedTable = keyof typeof REPLAYED_TABLES;

export interface ProjectionReplay {
  readonly rows: Record<ReplayedTable, Map<string, Row>>;
  /** Events a replayed table depends on whose payload is unavailable (e.g. redacted). */
  readonly unreplayable: readonly string[];
}

const nullable = (value: unknown): unknown => (value === undefined ? null : value);
const json = (value: unknown): string | null =>
  value === undefined || value === null ? null : JSON.stringify(value);

type Replayer = (
  state: ProjectionReplay["rows"],
  event: LogEvent,
  payload: Record<string, unknown>,
  problemId: string,
) => void;

const REPLAYERS: Readonly<Record<string, Replayer>> = {
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
};

/** Fold one problem's log, in sequence order, into projection rows. */
export function replayProjections(
  problemId: string,
  events: readonly LogEvent[],
): ProjectionReplay {
  const rows = {
    reviews: new Map<string, Row>(),
    evidence: new Map<string, Row>(),
    hypotheses: new Map<string, Row>(),
  };
  const unreplayable: string[] = [];
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const replayer = REPLAYERS[event.type];
    if (replayer === undefined) continue;
    if (event.payload === null) {
      unreplayable.push(event.id);
      continue;
    }
    replayer(rows, event, event.payload, problemId);
  }
  return { rows, unreplayable };
}

/** A problem's event log with payloads (null where content is redacted). */
export async function readProblemLog(db: D1Database, problemId: string): Promise<LogEvent[]> {
  const result = await db
    .prepare(
      `SELECT e.id, e.seq, e.type, e.object_id, e.created_at, e.actor_fellow_id,
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
      created_at: string;
      actor_fellow_id: string | null;
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
      createdAt: row.created_at,
      actorFellowId: row.actor_fellow_id,
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
  const rebuilt = replay ?? replayProjections(problemId, await readProblemLog(db, problemId));
  const drift: ProjectionDrift[] = [];
  for (const table of Object.keys(REPLAYED_TABLES) as ReplayedTable[]) {
    const [pk] = REPLAYED_TABLES[table];
    const live = await db
      .prepare(`SELECT * FROM ${table} WHERE problem_id = ?`)
      .bind(problemId)
      .all<Row>();
    const liveByKey = new Map(live.results.map((row) => [String(row[pk]), row]));
    const expected = rebuilt.rows[table];
    for (const [key, row] of expected) {
      const actual = liveByKey.get(key);
      if (actual === undefined) {
        drift.push({ table, key, kind: "missing_row" });
        continue;
      }
      for (const column of Object.keys(actual)) {
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

/**
 * Insert the replayed rows a problem is missing (the restore case: the log
 * came back, its projections did not). Replayed tables are append-only by
 * trigger, so a row that exists but differs, or exists with no log behind it,
 * is not rewritten here: that refuses with PROJECTION_DRIFT_NOT_REPAIRABLE for
 * an operator. Also refuses when any relevant payload is unreplayable
 * (redacted), rather than rebuilding a partial board.
 */
export async function repairProjections(db: D1Database, problemId: string): Promise<number> {
  const replay = replayProjections(problemId, await readProblemLog(db, problemId));
  if (replay.unreplayable.length > 0) throw new Error("PROJECTION_REBUILD_UNREPLAYABLE");
  const { drift } = await diffProjections(db, problemId, replay);
  if (drift.some((item) => item.kind !== "missing_row")) {
    throw new Error("PROJECTION_DRIFT_NOT_REPAIRABLE");
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
