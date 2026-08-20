import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_STATEMENT_BYTES = 8_192;
const MAX_EVENT_PAGE_SIZE = 200;
const MAX_CHAIN_RETRIES = 16;
const MAX_INTEGRITY_BACKFILL_EVENTS = 512;
const REDACTION_REASONS = new Set(["legal", "privacy", "severe-safety"]);
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface KraterWriteInput {
  problemId: string;
  claimId: string;
  eventId: string;
  idempotencyKey: string;
  statement: string;
  createdAt: string;
}

export interface KraterWriteResult {
  eventId: string;
  claimId: string;
  seq: number;
  idempotent: boolean;
  preCursor: number;
  postCursor: number;
  payloadSha256: string;
  rowDigest: string;
  buildDigest: string;
  chainDigest: string;
  checkpointDigest: string;
  /**
   * Time from the first head read through the post-write verification reads, across every
   * retry attempt.
   *
   * Not the transaction's duration, despite what this field was called: the span includes a
   * head read before `db.batch` and four verification reads after it, and D1 does not expose
   * the transaction's own time separately. Naming it for the batch would have been the same
   * class of error as reporting lock wait, which this deliberately does not do.
   */
  writePhaseMs: number;
  /**
   * Rows read by the final settled `db.batch` only.
   *
   * This is a subtotal, not the write's row cost: the head read and the four post-write
   * verification reads use `.first()`, which discards `meta`. Rejected retry attempts are also
   * excluded: D1 throws without a `D1Result` or `meta` for a failed batch. No complete row total
   * is published, because it cannot be computed from the available measurements.
   */
  successfulBatchRowsRead: number;
  /** Rows written by the final settled `db.batch` only, as D1 reports them. */
  successfulBatchRowsWritten: number;
  /** Engine-reported SQL time for the final settled `db.batch` only. */
  successfulBatchSqlMs: number | null;
  /** What the completeness preflight cost, which `writePhaseMs` excludes entirely. */
  preflight: KraterPreflightCost;
  /**
   * Wall time from function entry to return: validation, preflight, payload and request
   * hashing, every retry, and the verification reads. Complete, unlike the row counts.
   */
  writeClaimWallMs: number;
  /** D1 does not expose lock wait separately; do not relabel elapsed time as lock wait. */
  lockWaitMs: null;
  retryCount: number;
}

/**
 * Test scheduling hooks for the local S-2 harness. They can delay a write at
 * a named causal boundary, but cannot supply a sequence or alter any database
 * value. Production callers omit this argument.
 */
export interface KraterWriteHooks {
  afterReadHead?: (head: Readonly<{ publicSeq: number; chainDigest: string }>) => Promise<void>;
}

/**
 * Statements a higher-level write needs committed with the Krater envelope.
 *
 * The callback runs after the durable head has supplied the candidate sequence
 * and before the single D1 batch. It may prepare statements only; it must not
 * execute them. Session promotion uses this seam to persist its sealed exact
 * response in the same transaction as the claim, projection, event and outbox.
 */
export interface KraterAtomicCompanion {
  readonly requestDigest?: string;
  readonly claimIdForSequence?: (sequence: number) => string;
  readonly statementsForAttempt: (attempt: {
    readonly sequence: number;
    readonly claimId: string;
    readonly eventId: string;
  }) => Promise<readonly D1PreparedStatement[]> | readonly D1PreparedStatement[];
}

export interface KraterEvent {
  eventId: string;
  problemId: string;
  seq: number;
  type: "claim.created";
  objectId: string;
  payloadSha256: string;
  rowDigest: string;
  chainDigest: string;
  createdAt: string;
}

export interface ClaimProjection {
  claimId: string;
  problemId: string;
  sourceSeq: number;
  projectionVersion: number;
  buildDigest: string;
  stale: boolean;
}

export interface KraterCheckpoint {
  problemId: string;
  checkpointSeq: number;
  rootChainDigest: string;
  checkpointDigest: string;
  checkpointVersion: 1;
  /** ADR-23 signatures are not implemented; this foundation is explicitly unsigned. */
  checkpointMode: "unsigned-v0";
}

export interface KraterIntegrityState {
  chainDigest: string;
  checkpointDigest: string | null;
}

export interface KraterOutboxRecord {
  eventId: string;
  state: "pending" | "delivered";
  kind: "search.index";
}

export class KraterValidationError extends Error {
  readonly code = "KRATER_INPUT_INVALID";
}

export class KraterReadError extends Error {
  readonly code = "KRATER_READ_INVALID";
}

export class KraterIdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";
}

export class KraterProblemNotFoundError extends Error {
  readonly code = "KRATER_PROBLEM_NOT_FOUND";
}

export class KraterReplayError extends Error {
  readonly code = "KRATER_REPLAY_INVALID";
}

export class KraterIntegrityBackfillRequiredError extends Error {
  readonly code = "KRATER_INTEGRITY_BACKFILL_REQUIRED";
}

/**
 * D1 INTEGER values are wider than JavaScript's exact integer range. Krater's
 * sequence participates in event and chain digests, so accepting an inexact
 * predecessor would let two distinct durable values share one JS candidate.
 */
export class KraterSequenceExhaustedError extends Error {
  readonly code = "KRATER_SEQUENCE_EXHAUSTED";
}

interface IdempotencyRow {
  request_digest: string;
  event_id: string | null;
  event_seq: number | null;
}

interface SequenceRow {
  public_seq: number;
}

interface ProblemHeadRow {
  public_seq: number;
  chain_digest: string | null;
}

interface IntegrityProblemHeadRow {
  public_seq: number;
  chain_digest: string;
}

interface EventRow {
  id: string;
  problem_id: string;
  seq: number;
  type: "claim.created";
  object_kind: "claim";
  object_id: string;
  object_version: number;
  payload_sha256: string;
  row_digest: string | null;
  chain_digest: string | null;
  created_at: string;
}

interface ProjectionRow {
  claim_id: string;
  problem_id: string;
  source_seq: number;
  projection_version: number;
  build_digest: string;
  stale: number;
}

interface CheckpointRow {
  problem_id: string;
  checkpoint_seq: number;
  root_chain_digest: string;
  checkpoint_digest: string;
  checkpoint_version: 1;
  checkpoint_mode: "unsigned-v0";
}

interface IntegrityBackfillRow {
  state: "required" | "complete";
  legacy_event_count: number;
}

interface CursorRow {
  public_seq: number;
}

interface CountRow {
  count: number;
}

function inputError(message: string): never {
  throw new KraterValidationError(message);
}

function readError(message: string): never {
  throw new KraterReadError(message);
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function requireInputSequence(value: unknown, label: string, allowZero: boolean): number {
  if (!isSafeNonnegativeInteger(value) || (!allowZero && value === 0)) {
    inputError(`${label} must be a ${allowZero ? "nonnegative" : "positive"} safe integer.`);
  }
  return value;
}

function requireStoredSequence(value: unknown, label: string, allowZero: boolean): number {
  if (!isSafeNonnegativeInteger(value) || (!allowZero && value === 0)) {
    readError(`${label} stored an inexact or invalid sequence.`);
  }
  return value;
}

function eventRowWithSafeSequence(row: EventRow): EventRow {
  return { ...row, seq: requireStoredSequence(row.seq, "event", false) };
}

function requireIdentifier(label: string, value: string): void {
  if (!IDENTIFIER.test(value)) inputError(`${label} must be a bounded identifier.`);
}

function requireServerTimestampMillis(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    inputError("server timestamp must be a representable nonnegative millisecond instant.");
  }
}

/**
 * Accept only an exact UTC instant at the trusted Krater ingress seam.
 *
 * `createdAt` remains the caller's already-server-authored event/session instant;
 * the outbox uses its own server-issued timestamp below. Rejecting noncanonical and
 * future values here keeps neither path vulnerable to a client-supplied future clock.
 */
export function validateKraterIngressTimestamp(createdAt: string, serverNowMs: number): string {
  requireServerTimestampMillis(serverNowMs);
  if (!CANONICAL_UTC_TIMESTAMP.test(createdAt)) {
    inputError("createdAt must be an exact canonical UTC timestamp with millisecond precision.");
  }
  const parsed = Date.parse(createdAt);
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toISOString() !== createdAt) {
    inputError("createdAt must name a real canonical UTC instant.");
  }
  if (parsed > serverNowMs) {
    inputError("createdAt cannot be in the future relative to Krater's server clock.");
  }
  return createdAt;
}

/**
 * Capture an outbox timestamp once per write before any optimistic retry. This value
 * is server-authored, canonical UTC, and therefore cannot drift across a retry.
 */
export function serverAuthoredOutboxTimestamp(serverNowMs: number): string {
  requireServerTimestampMillis(serverNowMs);
  const timestamp = new Date(serverNowMs).toISOString();
  if (!CANONICAL_UTC_TIMESTAMP.test(timestamp)) {
    inputError("server clock did not produce a canonical UTC outbox timestamp.");
  }
  return timestamp;
}

function validateWriteInput(input: KraterWriteInput, serverNowMs: number): void {
  requireIdentifier("problemId", input.problemId);
  requireIdentifier("claimId", input.claimId);
  requireIdentifier("eventId", input.eventId);
  requireIdentifier("idempotencyKey", input.idempotencyKey);
  if (
    input.statement.trim().length === 0 ||
    new TextEncoder().encode(input.statement).byteLength > MAX_STATEMENT_BYTES
  ) {
    inputError("statement must be non-empty and within the Krater v0 byte limit.");
  }
  validateKraterIngressTimestamp(input.createdAt, serverNowMs);
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) inputError("canonical payload numbers must be finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`).join(",")}}`;
  }
  inputError("canonical payload values must be JSON values.");
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value);
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function payloadFor(input: KraterWriteInput): string {
  return canonicalJson({ claim_id: input.claimId, kind: "claim", statement: input.statement });
}

function requestFor(input: KraterWriteInput): string {
  return canonicalJson({ claim_id: input.claimId, statement: input.statement });
}

export async function genesisChainDigest(problemId: string): Promise<string> {
  requireIdentifier("problemId", problemId);
  return sha256Hex(canonicalJson({ kind: "krater.v0.genesis", problem_id: problemId }));
}

export async function eventChainDigest(
  problemId: string,
  seq: number,
  payloadSha256: string,
  previousChainDigest: string,
): Promise<string> {
  requireIdentifier("problemId", problemId);
  requireInputSequence(seq, "chain sequence", false);
  return sha256Hex(
    canonicalJson({
      payload_sha256: payloadSha256,
      previous_chain_digest: previousChainDigest,
      problem_id: problemId,
      seq,
    }),
  );
}

export async function eventRowDigest(
  input: KraterWriteInput,
  seq: number,
  payloadSha256: string,
): Promise<string> {
  requireInputSequence(seq, "event row sequence", false);
  return eventEnvelopeRowDigest({
    eventId: input.eventId,
    problemId: input.problemId,
    seq,
    type: "claim.created",
    objectKind: "claim",
    objectId: input.claimId,
    objectVersion: 1,
    payloadSha256,
    createdAt: input.createdAt,
  });
}

interface EventEnvelopeForDigest {
  eventId: string;
  problemId: string;
  seq: number;
  type: string;
  objectKind: string;
  objectId: string;
  objectVersion: number;
  payloadSha256: string;
  createdAt: string;
}

async function eventEnvelopeRowDigest(envelope: EventEnvelopeForDigest): Promise<string> {
  requireInputSequence(envelope.seq, "event envelope sequence", false);
  return sha256Hex(
    canonicalJson({
      created_at: envelope.createdAt,
      event_id: envelope.eventId,
      object_id: envelope.objectId,
      object_kind: envelope.objectKind,
      object_version: envelope.objectVersion,
      payload_sha256: envelope.payloadSha256,
      problem_id: envelope.problemId,
      seq: envelope.seq,
      type: envelope.type,
    }),
  );
}

export async function projectionBuildDigest(
  payloadSha256: string,
  rowDigest: string,
): Promise<string> {
  return sha256Hex(
    canonicalJson({ payload_sha256: payloadSha256, projection_version: 1, row_digest: rowDigest }),
  );
}

export async function checkpointDigest(
  problemId: string,
  seq: number,
  rootChainDigest: string,
): Promise<string> {
  requireInputSequence(seq, "checkpoint sequence", false);
  return sha256Hex(
    canonicalJson({
      checkpoint_version: 1,
      problem_id: problemId,
      root_chain_digest: rootChainDigest,
      seq,
    }),
  );
}

function statement(db: D1Database, sql: string, ...values: unknown[]): D1PreparedStatement {
  return db.prepare(sql).bind(...values);
}

function metricSum(
  results: readonly D1Result<unknown>[],
  field: "rows_read" | "rows_written",
): number {
  return results.reduce((total, result) => total + result.meta[field], 0);
}

function sqlDuration(results: readonly D1Result<unknown>[]): number | null {
  const durations = results
    .map((result) => result.meta.timings?.sql_duration_ms)
    .filter((duration): duration is number => duration !== undefined);
  return durations.length === 0 ? null : durations.reduce((total, duration) => total + duration, 0);
}

/**
 * What the completeness preflight cost, measured rather than asserted.
 *
 * The write receipt used to start its clock *after* this preflight, so the statements that run
 * before every write were absent from the only evidence the harness collected — including the
 * probe whose cost migration 0005 exists to bound. Reporting it separately keeps the two
 * halves distinguishable instead of folding an unmeasured cost into a total.
 */
export interface KraterPreflightCost {
  /** Rows the preflight read, summed across its statements as D1 reports them. */
  readonly rows_read: number;
  /** Rows the preflight wrote, including a legacy replay's `db.batch` statements. */
  readonly rows_written: number;
  /** Engine-reported SQL time for those statements; null when the engine reports none. */
  readonly sql_ms: number | null;
  /** How many statements the preflight issued. */
  readonly statements: number;
  /** Wall time inside the preflight, which on the replay path includes digest work. */
  readonly wall_ms: number;
  /** True when the problem was already upgraded and the preflight returned at the probe. */
  readonly upgraded_fast_path: boolean;
}

interface CostAccumulator {
  rows_read: number;
  rows_written: number;
  sql_ms: number;
  sql_reported: boolean;
  statements: number;
}

function newCostAccumulator(): CostAccumulator {
  return { rows_read: 0, rows_written: 0, sql_ms: 0, sql_reported: false, statements: 0 };
}

function recordD1Result<T>(cost: CostAccumulator, result: D1Result<T>): void {
  cost.rows_read += result.meta.rows_read;
  cost.rows_written += result.meta.rows_written;
  cost.statements += 1;
  const reported = result.meta.timings?.sql_duration_ms;
  if (reported !== undefined) {
    cost.sql_ms += reported;
    cost.sql_reported = true;
  }
}

function recordD1Results<T>(cost: CostAccumulator, results: readonly D1Result<T>[]): void {
  for (const result of results) recordD1Result(cost, result);
}

/**
 * Read one row while recording what the engine charged for it.
 *
 * `.first()` discards `meta`, so a preflight built from it cannot report rows read at all. This
 * runs the same statement through `.all()` purely to keep the metrics, and returns the first
 * row so callers read exactly as they did before.
 */
async function firstRowMeasured<T>(
  cost: CostAccumulator,
  prepared: D1PreparedStatement,
): Promise<T | null> {
  const result = await prepared.all<T>();
  recordD1Result(cost, result);
  return result.results[0] ?? null;
}

function settleCost(
  cost: CostAccumulator,
  startedAt: number,
  upgradedFastPath: boolean,
): KraterPreflightCost {
  return {
    rows_read: cost.rows_read,
    rows_written: cost.rows_written,
    sql_ms: cost.sql_reported ? Math.round(cost.sql_ms * 1_000) / 1_000 : null,
    statements: cost.statements,
    wall_ms: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
    upgraded_fast_path: upgradedFastPath,
  };
}

function isRetryableChainConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /KRATER_CHAIN_HEAD_MISMATCH|SQLITE_BUSY|database is locked/i.test(message);
}

async function readProblemHead(
  db: D1Database,
  problemId: string,
): Promise<IntegrityProblemHeadRow> {
  const row = await statement(
    db,
    "SELECT public_seq, chain_digest FROM problems WHERE id = ?",
    problemId,
  ).first<ProblemHeadRow>();
  if (row === null)
    throw new KraterProblemNotFoundError("problem must exist before a Krater claim write.");
  if (row.chain_digest === null) {
    throw new KraterIntegrityBackfillRequiredError(
      "Krater integrity digests must be replayed from the immutable legacy envelopes first.",
    );
  }
  return {
    public_seq: requireStoredSequence(row.public_seq, "problem cursor", true),
    chain_digest: row.chain_digest,
  };
}

async function readEventById(db: D1Database, eventId: string): Promise<EventRow> {
  const row = await statement(
    db,
    `SELECT id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256,
            row_digest, chain_digest, created_at
     FROM events WHERE id = ?`,
    eventId,
  ).first<EventRow>();
  if (row === null) throw new Error("Krater write did not persist an event envelope.");
  return eventRowWithSafeSequence(row);
}

async function readProjectionByEvent(db: D1Database, event: EventRow): Promise<ProjectionRow> {
  const row = await statement(
    db,
    `SELECT claim_id, problem_id, source_seq, projection_version, build_digest, stale
     FROM claim_projections WHERE claim_id = ? AND problem_id = ? AND source_seq = ?`,
    event.object_id,
    event.problem_id,
    event.seq,
  ).first<ProjectionRow>();
  if (row === null) throw new Error("Krater write did not persist a projection.");
  return {
    ...row,
    source_seq: requireStoredSequence(row.source_seq, "projection source sequence", false),
  };
}

async function readCheckpointByEvent(db: D1Database, event: EventRow): Promise<CheckpointRow> {
  const row = await statement(
    db,
    `SELECT problem_id, checkpoint_seq, root_chain_digest, checkpoint_digest, checkpoint_version,
            checkpoint_mode
     FROM integrity_checkpoints WHERE problem_id = ? AND checkpoint_seq = ?`,
    event.problem_id,
    event.seq,
  ).first<CheckpointRow>();
  if (row === null) throw new Error("Krater write did not persist an integrity checkpoint.");
  return {
    ...row,
    checkpoint_seq: requireStoredSequence(row.checkpoint_seq, "checkpoint sequence", false),
  };
}

function backfillRequired(message: string): never {
  throw new KraterIntegrityBackfillRequiredError(message);
}

async function readIntegrityBackfill(
  db: D1Database,
  problemId: string,
  cost: CostAccumulator,
): Promise<IntegrityBackfillRow | null> {
  return firstRowMeasured<IntegrityBackfillRow>(
    cost,
    statement(
      db,
      "SELECT state, legacy_event_count FROM krater_integrity_backfill WHERE problem_id = ?",
      problemId,
    ),
  );
}

/**
 * The first event of a problem still missing either digest, or null when every envelope is
 * digested.
 *
 * `LIMIT 1` alone does not make this cheap. For a healthy problem there is no matching row,
 * so the engine has to prove a negative, and without a matching index that means visiting
 * every envelope of the problem — `EXPLAIN QUERY PLAN` on a 0004-era schema reports
 * `SEARCH events USING INDEX sqlite_autoindex_events_2 (problem_id=?)`, i.e. a seek to the
 * problem followed by a filter across its whole log.
 *
 * Migration 0005 adds a partial index over exactly this predicate, so the plan becomes
 * `SEARCH events USING INDEX events_undigested_idx (problem_id=?)`. Rows live in that index
 * only while they are undigested, which means the set is empty for every upgraded problem:
 * the cost tracks outstanding legacy work rather than ledger size. The index is ordered
 * `(problem_id, seq)`, so the ORDER BY is satisfied without a sort.
 *
 * It is a search, not a covering read: the index holds `(problem_id, seq)` and this selects
 * `id`, so a row that matches still costs a table visit. On the healthy path nothing matches,
 * so nothing is visited — the bound claimed here is "does not grow with the problem's history",
 * measured as rows read by `firstUndigestedEvent`, and is not a claim of constant cost.
 *
 * Exported so the equivalence to the exhaustive predicate it replaced is testable rather than
 * assumed; `s2-client.ts` pins the case that distinguishes them, a partly digested log.
 */
/**
 * The probe's SQL, named once so the query that runs and the query whose plan is asserted can
 * never drift apart. A partial index is only used when the query's restriction implies the
 * index's own predicate, so a copy edited in one place and not the other would silently
 * degrade the plan while every test still passed.
 */
export const UNDIGESTED_EVENT_PROBE_SQL = `SELECT id FROM events
     WHERE problem_id = ? AND (row_digest IS NULL OR chain_digest IS NULL)
     ORDER BY seq ASC LIMIT 1`;

/** The index migration 0005 adds for that predicate. */
export const UNDIGESTED_EVENT_INDEX = "events_undigested_idx";

/**
 * The exact plan step the probe must produce once 0005 is applied.
 *
 * `USING INDEX`, not `USING COVERING INDEX`: the index carries `(problem_id, seq)` and the
 * probe selects `id`, so a matching row still costs a table visit. That is deliberate and
 * harmless — the healthy path has no matching row, so nothing is visited — but it means the
 * plan must never be described as index-only. `TABLE` is optional because SQLite spells the
 * same plan `SEARCH TABLE events ...` in older releases; table, index and the constrained
 * column are pinned exactly.
 */
const UNDIGESTED_PROBE_SEARCH_DETAIL =
  /^SEARCH (?:TABLE )?events USING INDEX events_undigested_idx \(problem_id=\?\)$/;

export interface UndigestedProbeResult {
  /** The first still-undigested envelope of the problem, or null when the log is complete. */
  readonly event_id: string | null;
  readonly rows_read: number;
  readonly sql_ms: number | null;
  readonly wall_ms: number;
}

export async function firstUndigestedEvent(
  db: D1Database,
  problemId: string,
): Promise<UndigestedProbeResult> {
  requireIdentifier("problemId", problemId);
  const startedAt = performance.now();
  const cost = newCostAccumulator();
  const row = await firstRowMeasured<{ id: string }>(
    cost,
    statement(db, UNDIGESTED_EVENT_PROBE_SQL, problemId),
  );
  return {
    event_id: row?.id ?? null,
    rows_read: cost.rows_read,
    sql_ms: cost.sql_reported ? Math.round(cost.sql_ms * 1_000) / 1_000 : null,
    wall_ms: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
  };
}

export interface UndigestedProbePlan {
  /** True when every step of the plan is served by the partial index. */
  readonly uses_index: boolean;
  /**
   * True when no step is a table scan.
   *
   * Named for what the predicate actually proves. It was `index_only`, which claimed covering
   * behaviour the index does not have: `id` is not in the index, so SQLite may still visit the
   * table for a row that matches. Only the absence of a scan is established here.
   */
  readonly avoids_table_scan: boolean;
  /** True when the plan is exactly one step and that step is the expected index search. */
  readonly matches_expected_search: boolean;
  /** The single plan step when there is exactly one, so the assertion can name what it saw. */
  readonly search_detail: string | null;
  readonly index_name: string;
  /** Plan step descriptions, as the engine reports them. */
  readonly steps: readonly string[];
}

/**
 * The query plan the engine actually chooses for the completeness probe.
 *
 * Comments claiming an index is used are not evidence; this makes the claim executable. It
 * explains `UNDIGESTED_EVENT_PROBE_SQL` itself rather than a restatement of it, so the
 * assertion tracks the query that runs on every write.
 *
 * Callers pass a problem id only — never SQL. The statement text is owned here.
 */
export async function explainUndigestedEventProbe(
  db: D1Database,
  problemId: string,
): Promise<UndigestedProbePlan> {
  requireIdentifier("problemId", problemId);
  const explained = await statement(
    db,
    `EXPLAIN QUERY PLAN ${UNDIGESTED_EVENT_PROBE_SQL}`,
    problemId,
  ).all<{ detail: string }>();
  const steps = explained.results.map((row) => row.detail);
  const searchDetail = steps.length === 1 ? (steps[0] ?? null) : null;
  return {
    uses_index: steps.length > 0 && steps.every((step) => step.includes(UNDIGESTED_EVENT_INDEX)),
    avoids_table_scan: steps.every((step) => !step.startsWith("SCAN")),
    matches_expected_search:
      searchDetail !== null && UNDIGESTED_PROBE_SEARCH_DETAIL.test(searchDetail),
    search_detail: searchDetail,
    index_name: UNDIGESTED_EVENT_INDEX,
    steps,
  };
}

/**
 * Bounded, deterministic replay for an old 0001 database. It derives every
 * value using WebCrypto from stored immutable envelopes; it never substitutes
 * a SQL default or a synthetic digest. Larger or inconsistent histories remain
 * explicitly blocked for an operator-run, range-aware backfill.
 */
export async function backfillKraterIntegrity(
  db: D1Database,
  problemId: string,
  completedAt: string,
  serverNowMs: number = Date.now(),
): Promise<KraterPreflightCost> {
  requireIdentifier("problemId", problemId);
  validateKraterIngressTimestamp(completedAt, serverNowMs);

  // Measured from the first statement, because this whole function runs before every write and
  // was previously invisible to the receipt.
  const preflightStartedAt = performance.now();
  const cost = newCostAccumulator();

  const rawHead = await firstRowMeasured<ProblemHeadRow>(
    cost,
    statement(db, "SELECT public_seq, chain_digest FROM problems WHERE id = ?", problemId),
  );
  if (rawHead === null) {
    throw new KraterProblemNotFoundError("problem must exist before integrity replay.");
  }
  const publicSeq = requireStoredSequence(rawHead.public_seq, "problem cursor", true);
  const storedBackfill = await readIntegrityBackfill(db, problemId, cost);
  // An already-upgraded problem is done, whatever its size. This check must precede the
  // bounded-replay limit below: every write calls this function, so testing the limit first
  // made a healthy, fully-digested problem permanently unwritable once it passed 512 events
  // — the 513th write succeeded and every later one was refused with
  // KRATER_INTEGRITY_BACKFILL_REQUIRED, naming a replay that had already completed and that
  // would itself refuse at that size. The limit belongs to the legacy upgrade path, which is
  // the only caller that can actually perform the replay.
  //
  // It also has to be answered *without* materializing the event log. Every write calls this
  // function, and loading every envelope of a problem to conclude "already upgraded" made
  // write cost grow with problem history: eleven columns per row crossing the D1 boundary and
  // an N-element array walked by `.every()`, on every single write. The predicate is
  // unchanged — the same three conditions in the same order — but the third is now asked as
  // an existence question, answered by the partial index migration 0005 adds (see
  // firstUndigestedEvent for the query plans on either side of it).
  if (storedBackfill?.state === "complete" && rawHead.chain_digest !== null) {
    const probe = await firstUndigestedEvent(db, problemId);
    cost.rows_read += probe.rows_read;
    cost.statements += 1;
    if (probe.sql_ms !== null) {
      cost.sql_ms += probe.sql_ms;
      cost.sql_reported = true;
    }
    if (probe.event_id === null) return settleCost(cost, preflightStartedAt, true);
  }

  const events = await statement(
    db,
    `SELECT id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256,
            row_digest, chain_digest, created_at
     FROM events WHERE problem_id = ? ORDER BY seq ASC`,
    problemId,
  ).all<EventRow>();
  // The replay path's dominant read. Counting it keeps the two paths comparable in the receipt:
  // a legacy upgrade legitimately reads the whole log, an ordinary write must not.
  recordD1Result(cost, events);
  const legacyEvents = events.results.map(eventRowWithSafeSequence);

  if (legacyEvents.length > MAX_INTEGRITY_BACKFILL_EVENTS) {
    backfillRequired(
      "the legacy problem exceeds the bounded integrity replay limit; use the future range-aware backfill.",
    );
  }

  if (
    rawHead.chain_digest !== null ||
    legacyEvents.some((event) => event.row_digest !== null || event.chain_digest !== null)
  ) {
    backfillRequired("the legacy integrity state is partial; refusing to overwrite a digest.");
  }
  if (publicSeq !== legacyEvents.length) {
    backfillRequired("the legacy cursor does not match a complete contiguous envelope history.");
  }

  let priorChainDigest = await genesisChainDigest(problemId);
  const updates: D1PreparedStatement[] = [
    statement(
      db,
      `INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at)
       VALUES (?, 'required', ?, NULL) ON CONFLICT(problem_id) DO NOTHING`,
      problemId,
      legacyEvents.length,
    ),
  ];
  for (const [index, event] of legacyEvents.entries()) {
    if (
      event.seq !== index + 1 ||
      event.type !== "claim.created" ||
      event.object_kind !== "claim" ||
      event.object_version !== 1
    ) {
      backfillRequired(
        "the legacy event stream is not a contiguous Krater claim envelope history.",
      );
    }
    const rowDigest = await eventEnvelopeRowDigest({
      eventId: event.id,
      problemId: event.problem_id,
      seq: event.seq,
      type: event.type,
      objectKind: event.object_kind,
      objectId: event.object_id,
      objectVersion: event.object_version,
      payloadSha256: event.payload_sha256,
      createdAt: event.created_at,
    });
    const chainDigest = await eventChainDigest(
      event.problem_id,
      event.seq,
      event.payload_sha256,
      priorChainDigest,
    );
    const digestCheckpoint = await checkpointDigest(event.problem_id, event.seq, chainDigest);
    updates.push(
      statement(
        db,
        `UPDATE events SET row_digest = ?, chain_digest = ?
         WHERE id = ? AND row_digest IS NULL AND chain_digest IS NULL`,
        rowDigest,
        chainDigest,
        event.id,
      ),
      statement(
        db,
        `INSERT INTO integrity_checkpoints
           (problem_id, checkpoint_seq, root_chain_digest, checkpoint_digest, checkpoint_version,
            checkpoint_mode, created_at)
         VALUES (?, ?, ?, ?, 1, 'unsigned-v0', ?)
         ON CONFLICT(problem_id, checkpoint_seq) DO NOTHING`,
        event.problem_id,
        event.seq,
        chainDigest,
        digestCheckpoint,
        event.created_at,
      ),
    );
    priorChainDigest = chainDigest;
  }
  updates.push(
    statement(
      db,
      "UPDATE problems SET chain_digest = ? WHERE id = ? AND chain_digest IS NULL",
      priorChainDigest,
      problemId,
    ),
    statement(
      db,
      `UPDATE krater_integrity_backfill
       SET state = 'complete', legacy_event_count = ?, completed_at = ?
       WHERE problem_id = ? AND state = 'required'`,
      legacyEvents.length,
      completedAt,
      problemId,
    ),
  );
  try {
    const batchResults = await db.batch(updates);
    recordD1Results(cost, batchResults);
  } catch (_error) {
    const rechecked = await readIntegrityBackfill(db, problemId, cost);
    if (rechecked?.state !== "complete") {
      backfillRequired(
        "the integrity replay could not atomically complete; no digest was defaulted.",
      );
    }
  }
  return settleCost(cost, preflightStartedAt, false);
}

/** Create a synthetic problem root for the local S-2 worker harness. */
export async function ensureProblem(
  db: D1Database,
  problemId: string,
  createdAt: string,
  serverNowMs: number = Date.now(),
): Promise<void> {
  requireIdentifier("problemId", problemId);
  validateKraterIngressTimestamp(createdAt, serverNowMs);
  await statement(
    db,
    `INSERT INTO problems (id, public_seq, created_at, updated_at)
     VALUES (?, 0, ?, ?) ON CONFLICT(id) DO NOTHING`,
    problemId,
    createdAt,
    createdAt,
  ).run();
  await backfillKraterIntegrity(db, problemId, createdAt, serverNowMs);
}

/**
 * Canonical Krater v0 write. The statements are a single D1 batch. A stale
 * predecessor chain digest triggers an event-insert abort, rolling the whole
 * batch back before a bounded retry obtains a fresh durable head.
 */
export async function writeClaim(
  db: D1Database,
  input: KraterWriteInput,
  hooks: KraterWriteHooks = {},
  companion?: KraterAtomicCompanion,
): Promise<KraterWriteResult> {
  const writeClaimStartedAt = performance.now();
  const serverNowMs = Date.now();
  validateWriteInput(input, serverNowMs);
  const outboxCreatedAt = serverAuthoredOutboxTimestamp(serverNowMs);
  const preflight = await backfillKraterIntegrity(db, input.problemId, input.createdAt, serverNowMs);
  const companionRequestDigest = companion?.requestDigest;
  const claimIdForSequence = companion?.claimIdForSequence;
  if (companionRequestDigest !== undefined && !/^[0-9a-f]{64}$/.test(companionRequestDigest)) {
    inputError("an atomic companion request digest must be lowercase SHA-256 hex.");
  }
  const writePhaseStartedAt = performance.now();
  let retryCount = 0;

  while (retryCount <= MAX_CHAIN_RETRIES) {
    const before = await readProblemHead(db, input.problemId);
    await hooks.afterReadHead?.({ publicSeq: before.public_seq, chainDigest: before.chain_digest });
    if (
      !Number.isSafeInteger(before.public_seq) ||
      before.public_seq < 0 ||
      before.public_seq >= Number.MAX_SAFE_INTEGER
    ) {
      throw new KraterSequenceExhaustedError(
        "Krater sequence allocation refuses an inexact or exhausted predecessor.",
      );
    }
    // This candidate is cryptographic input derived from a durable predecessor.
    // SQLite, not this value, allocates the stored sequence below.
    const candidateSeq = before.public_seq + 1;
    const attemptInput =
      claimIdForSequence === undefined
        ? input
        : { ...input, claimId: claimIdForSequence(candidateSeq) };
    requireIdentifier("claimId", attemptInput.claimId);
    const payloadJson = payloadFor(attemptInput);
    const [payloadSha256, requestDigest] = await Promise.all([
      sha256Hex(payloadJson),
      companionRequestDigest === undefined
        ? sha256Hex(requestFor(attemptInput))
        : Promise.resolve(companionRequestDigest),
    ]);
    const [nextChainDigest, nextRowDigest] = await Promise.all([
      eventChainDigest(input.problemId, candidateSeq, payloadSha256, before.chain_digest),
      eventRowDigest(attemptInput, candidateSeq, payloadSha256),
    ]);
    const [nextBuildDigest, nextCheckpointDigest] = await Promise.all([
      projectionBuildDigest(payloadSha256, nextRowDigest),
      checkpointDigest(input.problemId, candidateSeq, nextChainDigest),
    ]);

    const companionStatements =
      (await companion?.statementsForAttempt({
        sequence: candidateSeq,
        claimId: attemptInput.claimId,
        eventId: input.eventId,
      })) ?? [];
    let results: D1Result<SequenceRow>[];
    try {
      results = await db.batch<SequenceRow>([
        statement(
          db,
          `INSERT INTO idempotency (problem_id, idempotency_key, request_digest, created_at)
           SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM problems WHERE id = ?)
           ON CONFLICT(problem_id, idempotency_key) DO NOTHING`,
          input.problemId,
          input.idempotencyKey,
          requestDigest,
          input.createdAt,
          input.problemId,
        ),
        statement(
          db,
          `UPDATE problems SET public_seq = public_seq + 1, chain_digest = ?, updated_at = ?
           WHERE id = ? AND public_seq = ? AND chain_digest = ? AND EXISTS (
             SELECT 1 FROM idempotency
             WHERE problem_id = ? AND idempotency_key = ? AND event_id IS NULL
           )
           RETURNING public_seq`,
          nextChainDigest,
          input.createdAt,
          input.problemId,
          before.public_seq,
          before.chain_digest,
          input.problemId,
          input.idempotencyKey,
        ),
        statement(
          db,
          `INSERT INTO claims (id, problem_id, statement, payload_sha256, source_seq, created_at)
           SELECT ?, p.id, ?, ?, p.public_seq, ?
           FROM problems p
           JOIN idempotency i ON i.problem_id = p.id AND i.idempotency_key = ?
           WHERE p.id = ? AND i.event_id IS NULL`,
          attemptInput.claimId,
          attemptInput.statement,
          payloadSha256,
          input.createdAt,
          input.idempotencyKey,
          input.problemId,
        ),
        statement(
          db,
          `INSERT INTO claim_projections
             (claim_id, problem_id, source_seq, projection_version, build_digest, stale, updated_at)
           SELECT ?, p.id, p.public_seq, 1, ?, 0, ?
           FROM problems p
           JOIN idempotency i ON i.problem_id = p.id AND i.idempotency_key = ?
           WHERE p.id = ? AND i.event_id IS NULL`,
          attemptInput.claimId,
          nextBuildDigest,
          input.createdAt,
          input.idempotencyKey,
          input.problemId,
        ),
        statement(
          db,
          `INSERT INTO events
             (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256,
              row_digest, chain_digest, created_at)
           SELECT ?, p.id, p.public_seq, 'claim.created', 'claim', ?, 1, ?, ?, ?, ?
           FROM problems p
           JOIN idempotency i ON i.problem_id = p.id AND i.idempotency_key = ?
           WHERE p.id = ? AND i.event_id IS NULL`,
          input.eventId,
          attemptInput.claimId,
          payloadSha256,
          nextRowDigest,
          nextChainDigest,
          input.createdAt,
          input.idempotencyKey,
          input.problemId,
        ),
        statement(
          db,
          `INSERT INTO event_content (event_id, payload_sha256, payload_json)
           SELECT ?, ?, ?
           FROM idempotency i
           WHERE i.problem_id = ? AND i.idempotency_key = ? AND i.event_id IS NULL`,
          input.eventId,
          payloadSha256,
          payloadJson,
          input.problemId,
          input.idempotencyKey,
        ),
        statement(
          db,
          `INSERT INTO public_claim_fts (claim_id, problem_id, statement)
           SELECT c.id, c.problem_id, c.statement
           FROM claims c
           JOIN idempotency i ON i.problem_id = c.problem_id AND i.idempotency_key = ?
           WHERE c.id = ? AND i.event_id IS NULL`,
          input.idempotencyKey,
          attemptInput.claimId,
        ),
        statement(
          db,
          `INSERT INTO outbox (event_id, problem_id, kind, dedupe_key, payload_sha256, created_at)
           SELECT ?, ?, 'search.index', ?, ?, ?
           FROM idempotency i
           WHERE i.problem_id = ? AND i.idempotency_key = ? AND i.event_id IS NULL`,
          input.eventId,
          input.problemId,
          `search.index:${input.eventId}`,
          payloadSha256,
          outboxCreatedAt,
          input.problemId,
          input.idempotencyKey,
        ),
        statement(
          db,
          `INSERT INTO integrity_checkpoints
             (problem_id, checkpoint_seq, root_chain_digest, checkpoint_digest, checkpoint_version,
              checkpoint_mode, created_at)
           SELECT p.id, p.public_seq, p.chain_digest, ?, 1, 'unsigned-v0', ?
           FROM problems p
           JOIN idempotency i ON i.problem_id = p.id AND i.idempotency_key = ?
           WHERE p.id = ? AND i.event_id IS NULL`,
          nextCheckpointDigest,
          input.createdAt,
          input.idempotencyKey,
          input.problemId,
        ),
        statement(
          db,
          `UPDATE idempotency
           SET event_id = ?, event_seq = (SELECT seq FROM events WHERE id = ?)
           WHERE problem_id = ? AND idempotency_key = ? AND event_id IS NULL
             AND EXISTS (SELECT 1 FROM events WHERE id = ?)`,
          input.eventId,
          input.eventId,
          input.problemId,
          input.idempotencyKey,
          input.eventId,
        ),
        ...companionStatements,
      ]);
    } catch (error) {
      const latestHead = await readProblemHead(db, input.problemId);
      if (
        retryCount < MAX_CHAIN_RETRIES &&
        (isRetryableChainConflict(error) || latestHead.chain_digest !== before.chain_digest)
      ) {
        retryCount += 1;
        continue;
      }
      throw error;
    }

    const settled = await statement(
      db,
      `SELECT request_digest, event_id, event_seq
       FROM idempotency WHERE problem_id = ? AND idempotency_key = ?`,
      input.problemId,
      input.idempotencyKey,
    ).first<IdempotencyRow>();
    if (settled === null) {
      throw new KraterProblemNotFoundError("problem must exist before a Krater claim write.");
    }
    if (settled.request_digest !== requestDigest) {
      throw new KraterIdempotencyConflictError(
        "an idempotency key cannot represent two request digests.",
      );
    }
    if (settled.event_id === null || settled.event_seq === null) {
      throw new Error("Krater write did not settle an event envelope.");
    }
    const settledEventSeq = requireStoredSequence(
      settled.event_seq,
      "idempotency event sequence",
      false,
    );

    const allocated = results[1]?.results[0]?.public_seq;
    if (
      allocated !== undefined &&
      requireStoredSequence(allocated, "allocated problem cursor", false) !== settledEventSeq
    ) {
      throw new Error("Krater sequence allocation disagreed with the settled event.");
    }

    const [event, projection, checkpoint, after] = await Promise.all([
      readEventById(db, settled.event_id),
      readEventById(db, settled.event_id).then((persisted) => readProjectionByEvent(db, persisted)),
      readEventById(db, settled.event_id).then((persisted) => readCheckpointByEvent(db, persisted)),
      readProblemHead(db, input.problemId),
    ]);
    if (event.seq !== settledEventSeq || checkpoint.root_chain_digest !== event.chain_digest) {
      throw new Error("Krater persisted integrity records disagree.");
    }
    if (event.row_digest === null || event.chain_digest === null) {
      throw new Error("Krater write did not persist integrity digests.");
    }

    const writePhaseMs = Math.round((performance.now() - writePhaseStartedAt) * 1_000) / 1_000;
    return {
      eventId: settled.event_id,
      claimId: event.object_id,
      seq: settledEventSeq,
      idempotent: allocated === undefined,
      preCursor: before.public_seq,
      postCursor: after.public_seq,
      payloadSha256: event.payload_sha256,
      rowDigest: event.row_digest,
      buildDigest: projection.build_digest,
      chainDigest: event.chain_digest,
      checkpointDigest: checkpoint.checkpoint_digest,
      writePhaseMs,
      successfulBatchRowsRead: metricSum(results, "rows_read"),
      successfulBatchRowsWritten: metricSum(results, "rows_written"),
      successfulBatchSqlMs: sqlDuration(results),
      preflight,
      writeClaimWallMs: Math.round((performance.now() - writeClaimStartedAt) * 1_000) / 1_000,
      lockWaitMs: null,
      retryCount,
    };
  }

  throw new Error("Krater chain retry budget exhausted.");
}

export async function readCursor(db: D1Database, problemId: string): Promise<number> {
  requireIdentifier("problemId", problemId);
  try {
    const row = await statement(
      db,
      "SELECT public_seq FROM problems WHERE id = ?",
      problemId,
    ).first<CursorRow>();
    if (row === null) throw new KraterProblemNotFoundError("problem cursor does not exist.");
    return requireStoredSequence(row.public_seq, "problem cursor", true);
  } catch (error) {
    if (error instanceof KraterProblemNotFoundError) throw error;
    readError("cursor read could not be completed.");
  }
}

export async function readEvents(
  db: D1Database,
  problemId: string,
  afterSeq: number,
  limit: number,
): Promise<KraterEvent[]> {
  requireIdentifier("problemId", problemId);
  if (
    !isSafeNonnegativeInteger(afterSeq) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_EVENT_PAGE_SIZE
  ) {
    inputError("cursor reads require bounded integer pagination.");
  }
  try {
    const result = await statement(
      db,
      `SELECT id, problem_id, seq, type, object_id, payload_sha256, row_digest, chain_digest, created_at
       FROM events WHERE problem_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      problemId,
      afterSeq,
      limit,
    ).all<EventRow>();
    return result.results.map((rawRow) => {
      const row = eventRowWithSafeSequence(rawRow);
      if (row.row_digest === null || row.chain_digest === null) {
        backfillRequired("event reads require completed Krater integrity replay.");
      }
      return {
        eventId: row.id,
        problemId: row.problem_id,
        seq: row.seq,
        type: row.type,
        objectId: row.object_id,
        payloadSha256: row.payload_sha256,
        rowDigest: row.row_digest,
        chainDigest: row.chain_digest,
        createdAt: row.created_at,
      };
    });
  } catch (error) {
    if (
      error instanceof KraterValidationError ||
      error instanceof KraterIntegrityBackfillRequiredError
    ) {
      throw error;
    }
    readError("event cursor read could not be completed.");
  }
}

export async function readAllEvents(
  db: D1Database,
  problemId: string,
  pageSize = MAX_EVENT_PAGE_SIZE,
): Promise<KraterEvent[]> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_EVENT_PAGE_SIZE) {
    inputError("full replay requires a valid event page size.");
  }
  const events: KraterEvent[] = [];
  let afterSeq = 0;
  while (true) {
    const page = await readEvents(db, problemId, afterSeq, pageSize);
    if (page.length === 0) return events;
    const first = page[0];
    if (first === undefined || first.seq <= afterSeq) {
      readError("event pagination did not advance the cursor.");
    }
    events.push(...page);
    afterSeq = page[page.length - 1]?.seq ?? afterSeq;
    if (page.length < pageSize) return events;
  }
}

export async function readClaimProjections(
  db: D1Database,
  problemId: string,
): Promise<ClaimProjection[]> {
  requireIdentifier("problemId", problemId);
  try {
    const result = await statement(
      db,
      `SELECT claim_id, problem_id, source_seq, projection_version, build_digest, stale
       FROM claim_projections WHERE problem_id = ? ORDER BY source_seq ASC`,
      problemId,
    ).all<ProjectionRow>();
    return result.results.map((row) => ({
      claimId: row.claim_id,
      problemId: row.problem_id,
      sourceSeq: requireStoredSequence(row.source_seq, "projection source sequence", false),
      projectionVersion: row.projection_version,
      buildDigest: row.build_digest,
      stale: row.stale === 1,
    }));
  } catch (_error) {
    readError("projection read could not be completed.");
  }
}

export async function readIntegrityState(
  db: D1Database,
  problemId: string,
): Promise<KraterIntegrityState> {
  requireIdentifier("problemId", problemId);
  try {
    const [head, checkpoint] = await Promise.all([
      readProblemHead(db, problemId),
      statement(
        db,
        `SELECT checkpoint_digest FROM integrity_checkpoints
         WHERE problem_id = ? ORDER BY checkpoint_seq DESC LIMIT 1`,
        problemId,
      ).first<{ checkpoint_digest: string }>(),
    ]);
    return {
      chainDigest: head.chain_digest,
      checkpointDigest: checkpoint?.checkpoint_digest ?? null,
    };
  } catch (error) {
    if (
      error instanceof KraterProblemNotFoundError ||
      error instanceof KraterIntegrityBackfillRequiredError
    ) {
      throw error;
    }
    readError("integrity state could not be read.");
  }
}

export function replayClaimProjections(events: readonly KraterEvent[]): ClaimProjection[] {
  const projections: ClaimProjection[] = [];
  let priorSeq = 0;
  let problemId: string | undefined;
  for (const event of events) {
    if (
      event.type !== "claim.created" ||
      !isSafeNonnegativeInteger(event.seq) ||
      event.seq === 0 ||
      event.seq !== priorSeq + 1 ||
      (problemId !== undefined && event.problemId !== problemId)
    ) {
      throw new KraterReplayError(
        "event replay requires one contiguous claim.created problem stream.",
      );
    }
    problemId = event.problemId;
    projections.push({
      claimId: event.objectId,
      problemId: event.problemId,
      sourceSeq: event.seq,
      projectionVersion: 1,
      buildDigest: event.rowDigest,
      stale: false,
    });
    priorSeq = event.seq;
  }
  return projections;
}

export async function eventChainMatches(events: readonly KraterEvent[]): Promise<boolean> {
  if (events.length === 0) return true;
  const problemId = events[0]?.problemId;
  if (problemId === undefined) return true;
  let priorDigest = await genesisChainDigest(problemId);
  let priorSeq = 0;
  for (const event of events) {
    if (
      event.problemId !== problemId ||
      !isSafeNonnegativeInteger(event.seq) ||
      event.seq === 0 ||
      event.seq !== priorSeq + 1
    ) {
      return false;
    }
    const expected = await eventChainDigest(
      event.problemId,
      event.seq,
      event.payloadSha256,
      priorDigest,
    );
    if (expected !== event.chainDigest) return false;
    priorDigest = event.chainDigest;
    priorSeq = event.seq;
  }
  return true;
}

export function projectionReplayMatches(
  events: readonly KraterEvent[],
  projections: readonly ClaimProjection[],
): boolean {
  const replayed = replayClaimProjections(events);
  return (
    replayed.every((projection, index) => {
      const current = projections[index];
      return (
        current !== undefined &&
        current.claimId === projection.claimId &&
        current.problemId === projection.problemId &&
        current.sourceSeq === projection.sourceSeq &&
        current.projectionVersion === projection.projectionVersion &&
        current.stale === projection.stale
      );
    }) && replayed.length === projections.length
  );
}

export function cursorMatchesEvents(cursor: number, events: readonly KraterEvent[]): boolean {
  return (
    isSafeNonnegativeInteger(cursor) &&
    events.every((event) => isSafeNonnegativeInteger(event.seq) && event.seq > 0) &&
    cursor === (events[events.length - 1]?.seq ?? 0)
  );
}

export function outboxMatchesEvents(
  events: readonly KraterEvent[],
  outbox: readonly KraterOutboxRecord[],
): boolean {
  return (
    events.length === outbox.length &&
    events.every(
      (event) =>
        outbox.filter((item) => item.eventId === event.eventId).length === 1 &&
        outbox.some((item) => item.eventId === event.eventId && item.kind === "search.index"),
    )
  );
}

export function transactionBoundaryMatches(
  cursor: number,
  events: readonly KraterEvent[],
  projections: readonly ClaimProjection[],
  outbox: readonly KraterOutboxRecord[],
): boolean {
  return (
    cursorMatchesEvents(cursor, events) &&
    projectionReplayMatches(events, projections) &&
    outboxMatchesEvents(events, outbox)
  );
}

export function validateFtsReadInput(query: string, limit: number): void {
  if (
    query.trim().length === 0 ||
    query.length > 128 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  ) {
    inputError("FTS search requires a bounded non-empty query and limit.");
  }
}

export async function searchPublicClaims(
  db: D1Database,
  query: string,
  limit: number,
): Promise<{ claimId: string; problemId: string }[]> {
  validateFtsReadInput(query, limit);
  try {
    const result = await statement(
      db,
      "SELECT claim_id, problem_id FROM public_claim_fts WHERE public_claim_fts MATCH ? LIMIT ?",
      query,
      limit,
    ).all<{ claim_id: string; problem_id: string }>();
    return result.results.map((row) => ({ claimId: row.claim_id, problemId: row.problem_id }));
  } catch (_error) {
    readError("FTS query syntax is unsupported; use plain terms or valid FTS5 operators.");
  }
}

/** Rebuild public-only FTS from durable claims without touching event envelopes. */
export async function rebuildPublicClaimFts(db: D1Database, problemId: string): Promise<void> {
  requireIdentifier("problemId", problemId);
  await db.batch([
    statement(db, "DELETE FROM public_claim_fts WHERE problem_id = ?", problemId),
    statement(
      db,
      `INSERT INTO public_claim_fts (claim_id, problem_id, statement)
       SELECT id, problem_id, statement FROM claims WHERE problem_id = ? ORDER BY source_seq ASC`,
      problemId,
    ),
  ]);
}

export async function redactEventContent(
  db: D1Database,
  eventId: string,
  reason: string,
  redactedAt: string,
): Promise<void> {
  requireIdentifier("eventId", eventId);
  if (!REDACTION_REASONS.has(reason)) inputError("redaction reason is not recognized.");
  if (Number.isNaN(Date.parse(redactedAt))) inputError("redactedAt must be an ISO-8601 timestamp.");
  const existing = await statement(
    db,
    "SELECT event_id FROM event_content WHERE event_id = ?",
    eventId,
  ).first<{
    event_id: string;
  }>();
  if (existing === null) throw new KraterProblemNotFoundError("event content does not exist.");
  await statement(
    db,
    `UPDATE event_content
     SET payload_json = '{"control":"redacted"}', redacted_at = ?, redaction_reason = ?
     WHERE event_id = ?`,
    redactedAt,
    reason,
    eventId,
  ).run();
}

export async function attemptEnvelopeTamper(
  db: D1Database,
  eventId: string,
  operation: "update" | "delete",
): Promise<void> {
  requireIdentifier("eventId", eventId);
  if (operation === "update") {
    await statement(db, "UPDATE events SET type = 'claim.tampered' WHERE id = ?", eventId).run();
    return;
  }
  await statement(db, "DELETE FROM events WHERE id = ?", eventId).run();
}

/**
 * Local S-2 fault injection only. It deliberately corrupts asynchronous
 * metadata after the canonical write so the real DO quarantine path can prove
 * that it neither delivers nor mutates public projections or event envelopes.
 */
export async function plantMalformedOutboxForHarness(
  db: D1Database,
  eventId: string,
): Promise<void> {
  requireIdentifier("eventId", eventId);
  const result = await statement(
    db,
    "UPDATE outbox SET payload_sha256 = 'malformed' WHERE event_id = ? AND state = 'pending'",
    eventId,
  ).run();
  if (result.meta.changes !== 1) {
    throw new KraterProblemNotFoundError(
      "a pending outbox row must exist for the local fault fixture.",
    );
  }
}

export async function inspectProblem(
  db: D1Database,
  problemId: string,
): Promise<Record<string, number>> {
  requireIdentifier("problemId", problemId);
  try {
    const results = await db.batch<CountRow>([
      statement(db, "SELECT COUNT(*) AS count FROM claims WHERE problem_id = ?", problemId),
      statement(
        db,
        "SELECT COUNT(*) AS count FROM claim_projections WHERE problem_id = ?",
        problemId,
      ),
      statement(db, "SELECT COUNT(*) AS count FROM events WHERE problem_id = ?", problemId),
      statement(
        db,
        `SELECT COUNT(*) AS count
         FROM event_content c JOIN events e ON e.id = c.event_id
         WHERE e.problem_id = ?`,
        problemId,
      ),
      statement(
        db,
        "SELECT COUNT(*) AS count FROM public_claim_fts WHERE problem_id = ?",
        problemId,
      ),
      statement(db, "SELECT COUNT(*) AS count FROM idempotency WHERE problem_id = ?", problemId),
      statement(db, "SELECT COUNT(*) AS count FROM outbox WHERE problem_id = ?", problemId),
      statement(
        db,
        "SELECT COUNT(*) AS count FROM integrity_checkpoints WHERE problem_id = ?",
        problemId,
      ),
    ]);
    const names = [
      "claims",
      "claim_projections",
      "events",
      "event_content",
      "public_claim_fts",
      "idempotency",
      "outbox",
      "integrity_checkpoints",
    ] as const;
    return Object.fromEntries(
      names.map((name, index) => [name, results[index]?.results[0]?.count ?? 0]),
    );
  } catch (_error) {
    readError("problem state could not be inspected.");
  }
}

/**
 * Local rollback inspection deliberately reads the content table by its attempted event id.
 * Joining through `events` would hide the exact orphan this check exists to detect.
 */
export async function inspectEventContentByEventId(
  db: D1Database,
  eventId: string,
): Promise<number> {
  requireIdentifier("eventId", eventId);
  try {
    const row = await statement(
      db,
      "SELECT COUNT(*) AS count FROM event_content WHERE event_id = ?",
      eventId,
    ).first<CountRow>();
    if (row === null || !isSafeNonnegativeInteger(row.count)) {
      readError("event content inspection returned an invalid count.");
    }
    return row.count;
  } catch (error) {
    if (error instanceof KraterReadError) throw error;
    readError("event content could not be inspected.");
  }
}

export function deterministicWorkload(
  seed: string,
  count: number,
  createdAt: string,
): KraterWriteInput[] {
  requireIdentifier("seed", seed);
  if (!Number.isInteger(count) || count < 1 || count > 512) {
    inputError("workload count must be 1 through 512.");
  }
  return Array.from({ length: count }, (_, index) => {
    const suffix = `${seed}-${String(index + 1).padStart(3, "0")}`;
    return {
      problemId: `P-${seed}`,
      claimId: `C-${suffix}`,
      eventId: `E-${suffix}`,
      idempotencyKey: `IK-${suffix}`,
      statement: `Synthetic Krater claim ${suffix}.`,
      createdAt,
    };
  });
}
