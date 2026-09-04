import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_STATEMENT_BYTES = 8_192;
const MAX_EVENT_PAGE_SIZE = 200;
const MAX_CHAIN_RETRIES = 16;
const MAX_INTEGRITY_BACKFILL_EVENTS = 512;
const REDACTION_REASONS = new Set(["legal", "privacy", "severe-safety"]);
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The sole chain formula accepted by current writes, reads, replay, and exports. */
export const KRATER_CHAIN_VERSION = 2 as const;

export interface KraterWriteInput {
  problemId: string;
  claimId: string;
  eventId: string;
  idempotencyKey: string;
  statement: string;
  /**
   * The split/policy.ts normHash of the statement, supplied by the caller so
   * the claims row itself carries the normalized identity (P11). When set it
   * must be lowercase SHA-256 hex; the unique index on (problem_id, norm_hash)
   * then makes a concurrent duplicate promotion abort its own batch. Optional:
   * local S-2 harness callers omit it and insert NULL.
   */
  readonly normHash?: string;
  createdAt: string;
  /** Rule A3: the full attribution snapshot, recorded on the event. */
  readonly attribution?: {
    readonly fellowId: string;
    readonly sponsorId: string;
    readonly sessionId: string;
    readonly modelSelfDeclared: string;
    readonly harness: string;
    /** Durable per-credential accounting unit for grant-wide budgets (wqlf). */
    readonly credentialId?: string;
  };
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
  chainVersion: typeof KRATER_CHAIN_VERSION;
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
  afterReadHead?: (
    head: Readonly<{
      publicSeq: number;
      chainDigest: string;
      chainVersion: typeof KRATER_CHAIN_VERSION;
    }>,
  ) => Promise<void>;
}

/**
 * Statements a higher-level write needs committed with the Krater envelope.
 *
 * The callback prepares statements after the durable head has supplied the
 * candidate identity but before the single D1 batch. The returned statements
 * execute immediately after that batch settles `idempotency.event_id` and
 * `idempotency.event_seq`. Every companion must therefore bind the supplied
 * event ID and sequence as its exact settled-owner predicate; an
 * `event_id IS NULL` predicate cannot match in this phase. The callback may
 * prepare statements only and must not execute them.
 *
 * Session writes use this seam to persist their sealed exact response in the
 * same transaction as the ledger object, projection, event and outbox.
 */
export interface KraterAtomicCompanion {
  readonly requestDigest?: string;
  readonly claimIdForSequence?: (sequence: number) => string;
  readonly statementsAfterIdempotencySettlement: (settlement: {
    readonly sequence: number;
    readonly claimId: string;
    readonly eventId: string;
  }) => Promise<readonly D1PreparedStatement[]> | readonly D1PreparedStatement[];
}

export interface KraterEvent {
  eventId: string;
  problemId: string;
  seq: number;
  type: string;
  objectKind: string;
  objectId: string;
  objectVersion: number;
  payloadSha256: string;
  rowDigest: string;
  chainDigest: string;
  chainVersion: typeof KRATER_CHAIN_VERSION;
  createdAt: string;
  actorFellowId: string | null;
  actorSponsorId: string | null;
  actorSessionId: string | null;
  modelStringSelfDeclared: string | null;
  harness: string | null;
  writerCredentialId: string | null;
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
  chainVersion: typeof KRATER_CHAIN_VERSION;
  /** ADR-23 signatures are not implemented; this foundation is explicitly unsigned. */
  checkpointMode: "unsigned-v0";
}

export interface KraterIntegrityState {
  chainDigest: string;
  chainVersion: typeof KRATER_CHAIN_VERSION;
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

export class KraterLedgerPreconditionError extends Error {
  readonly code = "KRATER_LEDGER_PRECONDITION_FAILED";
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
  chain_version: number | null;
}

interface BackfillProblemHeadRow extends ProblemHeadRow {
  v2_contiguity_guard_ready: number;
  terminal_v2_complete: number;
}

interface IntegrityProblemHeadRow {
  public_seq: number;
  chain_digest: string;
  chain_version: typeof KRATER_CHAIN_VERSION;
}

interface EventRow {
  id: string;
  problem_id: string;
  seq: number;
  type: string;
  object_kind: string;
  object_id: string;
  object_version: number;
  payload_sha256: string;
  row_digest: string | null;
  chain_digest: string | null;
  chain_version: number | null;
  created_at: string;
  actor_fellow_id: string | null;
  actor_sponsor_id: string | null;
  actor_session_id: string | null;
  model_string_self_declared: string | null;
  harness: string | null;
  writer_credential_id: string | null;
}

interface BackfillEventRow {
  id: string;
  problem_id: string;
  seq: number;
  type: string;
  object_kind: string;
  object_id: string;
  object_version: number;
  payload_sha256: string;
  stored_row_digest: string | null;
  stored_chain_digest: string | null;
  v2_row_digest: string | null;
  v2_chain_digest: string | null;
  v2_chain_version: number | null;
  created_at: string;
  actor_fellow_id: string | null;
  actor_sponsor_id: string | null;
  actor_session_id: string | null;
  model_string_self_declared: string | null;
  harness: string | null;
  writer_credential_id: string | null;
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
  root_chain_digest: string | null;
  checkpoint_digest: string | null;
  checkpoint_version: number;
  chain_version: number | null;
  checkpoint_mode: string;
}

interface ValidatedCheckpointRow {
  problem_id: string;
  checkpoint_seq: number;
  root_chain_digest: string;
  checkpoint_digest: string;
  checkpoint_version: 1;
  chain_version: typeof KRATER_CHAIN_VERSION;
  checkpoint_mode: "unsigned-v0";
}

interface LegacyCheckpointRow {
  problem_id: string;
  checkpoint_seq: number;
  root_chain_digest: string;
  checkpoint_digest: string;
  checkpoint_version: number;
  checkpoint_mode: string;
  created_at: string;
}

interface ClaimRow {
  id: string;
  problem_id: string;
  statement: string;
  payload_sha256: string;
  source_seq: number;
}

interface OutboxRow {
  event_id: string;
  problem_id: string;
  kind: string;
  dedupe_key: string;
  payload_sha256: string;
  state: string;
}

interface IntegrityBackfillRow {
  state: "required" | "complete";
  legacy_event_count: number;
  chain_version: number | null;
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
  if (input.normHash !== undefined && !/^[0-9a-f]{64}$/.test(input.normHash)) {
    inputError("normHash, when supplied, must be lowercase SHA-256 hex.");
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

export function canonicalClaimPayload(input: {
  readonly claimId: string;
  readonly kind: "claim";
  readonly statement: string;
}): string {
  return canonicalJson({ claim_id: input.claimId, kind: input.kind, statement: input.statement });
}

function payloadFor(input: KraterWriteInput): string {
  return canonicalClaimPayload({
    claimId: input.claimId,
    kind: "claim",
    statement: input.statement,
  });
}

function requestFor(input: KraterWriteInput): string {
  return canonicalJson({ claim_id: input.claimId, statement: input.statement });
}

export async function genesisChainDigest(problemId: string): Promise<string> {
  requireIdentifier("problemId", problemId);
  return sha256Hex(
    canonicalJson({
      chain_version: KRATER_CHAIN_VERSION,
      kind: "krater.genesis",
      problem_id: problemId,
    }),
  );
}

/** Frozen v1 derivations used only to validate immutable pre-0039 bytes. */
async function legacyGenesisChainDigestV1(problemId: string): Promise<string> {
  requireIdentifier("problemId", problemId);
  return sha256Hex(canonicalJson({ kind: "krater.v0.genesis", problem_id: problemId }));
}

async function legacyEventChainDigestV1(
  problemId: string,
  seq: number,
  payloadSha256: string,
  previousChainDigest: string,
): Promise<string> {
  requireIdentifier("problemId", problemId);
  requireInputSequence(seq, "legacy chain sequence", false);
  return sha256Hex(
    canonicalJson({
      payload_sha256: payloadSha256,
      previous_chain_digest: previousChainDigest,
      problem_id: problemId,
      seq,
    }),
  );
}

export async function eventChainDigest(
  problemId: string,
  seq: number,
  payloadSha256: string,
  rowDigest: string,
  previousChainDigest: string,
): Promise<string> {
  requireIdentifier("problemId", problemId);
  requireInputSequence(seq, "chain sequence", false);
  return sha256Hex(
    canonicalJson({
      chain_version: KRATER_CHAIN_VERSION,
      payload_sha256: payloadSha256,
      previous_chain_digest: previousChainDigest,
      problem_id: problemId,
      row_digest: rowDigest,
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
    actorFellowId: input.attribution?.fellowId ?? null,
    actorSponsorId: input.attribution?.sponsorId ?? null,
    actorSessionId: input.attribution?.sessionId ?? null,
    modelStringSelfDeclared: input.attribution?.modelSelfDeclared ?? null,
    harness: input.attribution?.harness ?? null,
    writerCredentialId: input.attribution?.credentialId ?? null,
  });
}

export interface EventEnvelopeForDigest {
  eventId: string;
  problemId: string;
  seq: number;
  type: string;
  objectKind: string;
  objectId: string;
  objectVersion: number;
  payloadSha256: string;
  createdAt: string;
  actorFellowId: string | null;
  actorSponsorId: string | null;
  actorSessionId: string | null;
  modelStringSelfDeclared: string | null;
  harness: string | null;
  writerCredentialId: string | null;
}

export async function eventEnvelopeRowDigest(envelope: EventEnvelopeForDigest): Promise<string> {
  requireInputSequence(envelope.seq, "event envelope sequence", false);
  return sha256Hex(
    canonicalJson({
      chain_version: KRATER_CHAIN_VERSION,
      created_at: envelope.createdAt,
      actor_fellow_id: envelope.actorFellowId,
      actor_session_id: envelope.actorSessionId,
      actor_sponsor_id: envelope.actorSponsorId,
      event_id: envelope.eventId,
      harness: envelope.harness,
      model_string_self_declared: envelope.modelStringSelfDeclared,
      object_id: envelope.objectId,
      object_kind: envelope.objectKind,
      object_version: envelope.objectVersion,
      payload_sha256: envelope.payloadSha256,
      problem_id: envelope.problemId,
      seq: envelope.seq,
      type: envelope.type,
      writer_credential_id: envelope.writerCredentialId,
    }),
  );
}

async function legacyEventEnvelopeRowDigestV1(envelope: EventEnvelopeForDigest): Promise<string> {
  requireInputSequence(envelope.seq, "legacy event envelope sequence", false);
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

/**
 * V1 claim projections are lossless one-event projections: their build digest
 * is the authoritative source event's row digest, not a second digest over a
 * subset of that event. Keep persistence and replay on this same contract.
 */
export function claimProjectionBuildDigestV1(eventRowDigest: string): string {
  return eventRowDigest;
}

export async function checkpointDigest(
  problemId: string,
  seq: number,
  rootChainDigest: string,
): Promise<string> {
  requireInputSequence(seq, "checkpoint sequence", false);
  return sha256Hex(
    canonicalJson({
      chain_version: KRATER_CHAIN_VERSION,
      checkpoint_version: 1,
      problem_id: problemId,
      root_chain_digest: rootChainDigest,
      seq,
    }),
  );
}

/** Frozen v1 checkpoint derivation used only to validate retained pre-0039 bytes. */
async function legacyCheckpointDigestV1(
  problemId: string,
  seq: number,
  rootChainDigest: string,
): Promise<string> {
  requireInputSequence(seq, "legacy checkpoint sequence", false);
  return sha256Hex(
    canonicalJson({
      checkpoint_version: 1,
      problem_id: problemId,
      root_chain_digest: rootChainDigest,
      seq,
    }),
  );
}

async function validateCurrentCheckpoint(
  row: CheckpointRow,
  expected: { readonly problemId: string; readonly seq: number; readonly rootChainDigest: string },
  detail: string,
): Promise<ValidatedCheckpointRow> {
  const checkpointSeq = requireStoredSequence(row.checkpoint_seq, "checkpoint sequence", false);
  requireCurrentChainVersion(row.chain_version, detail);
  const rootChainDigest = row.root_chain_digest;
  const storedCheckpointDigest = row.checkpoint_digest;
  if (
    row.problem_id !== expected.problemId ||
    checkpointSeq !== expected.seq ||
    row.checkpoint_version !== 1 ||
    row.checkpoint_mode !== "unsigned-v0" ||
    rootChainDigest === null ||
    rootChainDigest !== expected.rootChainDigest ||
    storedCheckpointDigest === null
  ) {
    backfillRequired(detail);
  }
  if (
    storedCheckpointDigest !==
    (await checkpointDigest(row.problem_id, checkpointSeq, rootChainDigest))
  ) {
    backfillRequired(detail);
  }
  return {
    problem_id: row.problem_id,
    checkpoint_seq: checkpointSeq,
    root_chain_digest: rootChainDigest,
    checkpoint_digest: storedCheckpointDigest,
    checkpoint_version: 1,
    chain_version: KRATER_CHAIN_VERSION,
    checkpoint_mode: "unsigned-v0",
  };
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
  return (
    /KRATER_CHAIN_HEAD_MISMATCH|SQLITE_BUSY|database is locked/i.test(message) ||
    /UNIQUE constraint failed: (?:claims|events|claim_projections|integrity_checkpoints)\./i.test(
      message,
    ) ||
    (/SQLITE_CONSTRAINT/i.test(message) &&
      /(?:claims|events|claim_projections|integrity_checkpoints)/i.test(message))
  );
}

async function readProblemHead(
  db: D1Database,
  problemId: string,
): Promise<IntegrityProblemHeadRow> {
  const row = await statement(
    db,
    "SELECT public_seq, chain_digest, chain_version FROM problems WHERE id = ?",
    problemId,
  ).first<ProblemHeadRow>();
  if (row === null)
    throw new KraterProblemNotFoundError("problem must exist before a Krater claim write.");
  if (row.chain_digest === null || row.chain_version !== KRATER_CHAIN_VERSION) {
    throw new KraterIntegrityBackfillRequiredError(
      "Krater integrity digests must be replayed from the immutable legacy envelopes first.",
    );
  }
  return {
    public_seq: requireStoredSequence(row.public_seq, "problem cursor", true),
    chain_digest: row.chain_digest,
    chain_version: KRATER_CHAIN_VERSION,
  };
}

async function readEventById(db: D1Database, eventId: string): Promise<EventRow> {
  const row = await statement(
    db,
    `SELECT e.id, e.problem_id, e.seq, e.type, e.object_kind, e.object_id, e.object_version,
            e.payload_sha256, c.row_digest, c.chain_digest, c.chain_version, e.created_at,
            e.actor_fellow_id, e.actor_sponsor_id, e.actor_session_id,
            e.model_string_self_declared, e.harness, e.writer_credential_id
     FROM events e
     LEFT JOIN event_chain_v2 c ON c.event_id = e.id
     WHERE e.id = ?`,
    eventId,
  ).first<EventRow>();
  if (row === null) throw new Error("Krater write did not persist an event envelope.");
  requireCurrentChainVersion(
    row.chain_version,
    "Krater write did not persist one current-version event chain.",
  );
  if (row.row_digest === null || row.chain_digest === null) {
    backfillRequired("Krater write did not persist complete v2 event digests.");
  }
  const safeRow = eventRowWithSafeSequence(row);
  const expectedRowDigest = await eventEnvelopeRowDigest({
    eventId: safeRow.id,
    problemId: safeRow.problem_id,
    seq: safeRow.seq,
    type: safeRow.type,
    objectKind: safeRow.object_kind,
    objectId: safeRow.object_id,
    objectVersion: safeRow.object_version,
    payloadSha256: safeRow.payload_sha256,
    createdAt: safeRow.created_at,
    actorFellowId: safeRow.actor_fellow_id,
    actorSponsorId: safeRow.actor_sponsor_id,
    actorSessionId: safeRow.actor_session_id,
    modelStringSelfDeclared: safeRow.model_string_self_declared,
    harness: safeRow.harness,
    writerCredentialId: safeRow.writer_credential_id,
  });
  if (safeRow.row_digest !== expectedRowDigest) {
    backfillRequired("the stored v2 row digest disagrees with its immutable event envelope.");
  }
  return safeRow;
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

async function readCheckpointByEvent(
  db: D1Database,
  event: EventRow,
): Promise<ValidatedCheckpointRow> {
  const row = await statement(
    db,
    `SELECT i.problem_id, i.checkpoint_seq, c.root_chain_digest, c.checkpoint_digest,
            i.checkpoint_version, c.chain_version, i.checkpoint_mode
     FROM integrity_checkpoints i
     LEFT JOIN checkpoint_chain_v2 c
       ON c.problem_id = i.problem_id AND c.checkpoint_seq = i.checkpoint_seq
     WHERE i.problem_id = ? AND i.checkpoint_seq = ?`,
    event.problem_id,
    event.seq,
  ).first<CheckpointRow>();
  if (row === null) throw new Error("Krater write did not persist an integrity checkpoint.");
  if (event.chain_digest === null) {
    backfillRequired("the stored event has no v2 chain root for its checkpoint.");
  }
  return validateCurrentCheckpoint(
    row,
    { problemId: event.problem_id, seq: event.seq, rootChainDigest: event.chain_digest },
    "the stored v2 checkpoint disagrees with its event chain root or metadata.",
  );
}

async function readClaimByEvent(db: D1Database, event: EventRow): Promise<ClaimRow> {
  const row = await statement(
    db,
    `SELECT id, problem_id, statement, payload_sha256, source_seq
     FROM claims WHERE id = ? AND problem_id = ? AND source_seq = ?`,
    event.object_id,
    event.problem_id,
    event.seq,
  ).first<ClaimRow>();
  if (row === null) throw new Error("Krater write did not persist its claim row.");
  return {
    ...row,
    source_seq: requireStoredSequence(row.source_seq, "claim source sequence", false),
  };
}

async function readOutboxByEvent(db: D1Database, event: EventRow): Promise<OutboxRow> {
  const row = await statement(
    db,
    `SELECT event_id, problem_id, kind, dedupe_key, payload_sha256, state
     FROM outbox WHERE event_id = ? AND problem_id = ? AND kind = 'search.index'`,
    event.id,
    event.problem_id,
  ).first<OutboxRow>();
  if (row === null) throw new Error("Krater write did not persist its search outbox handoff.");
  return row;
}

function backfillRequired(message: string): never {
  throw new KraterIntegrityBackfillRequiredError(message);
}

function requireCurrentChainVersion(
  value: unknown,
  message = "Krater integrity requires one complete v2 chain.",
): typeof KRATER_CHAIN_VERSION {
  if (value !== KRATER_CHAIN_VERSION) backfillRequired(message);
  return KRATER_CHAIN_VERSION;
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
      `SELECT state, legacy_event_count, chain_version
       FROM krater_integrity_backfill WHERE problem_id = ?`,
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

  const rawHead = await firstRowMeasured<BackfillProblemHeadRow>(
    cost,
    statement(
      db,
      `SELECT public_seq, chain_digest, chain_version,
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM krater_chain_v2_contiguity_migration_guard g
                  WHERE g.migration = '0040'
                    AND g.event_gap_count = 0
                    AND g.checkpoint_gap_count = 0
                ) THEN 1
                ELSE 0
              END AS v2_contiguity_guard_ready,
              CASE
                WHEN public_seq = 0 THEN 1
                WHEN EXISTS (
                  SELECT 1 FROM event_chain_v2 e
                  WHERE e.problem_id = problems.id
                    AND e.seq = problems.public_seq
                    AND e.chain_version = 2
                    AND e.chain_digest = problems.chain_digest
                ) AND EXISTS (
                  SELECT 1 FROM checkpoint_chain_v2 c
                  WHERE c.problem_id = problems.id
                    AND c.checkpoint_seq = problems.public_seq
                    AND c.chain_version = 2
                    AND c.root_chain_digest = problems.chain_digest
                ) THEN 1
                ELSE 0
              END AS terminal_v2_complete
       FROM problems WHERE id = ?`,
      problemId,
    ),
  );
  if (rawHead === null) {
    throw new KraterProblemNotFoundError("problem must exist before integrity replay.");
  }
  if (rawHead.v2_contiguity_guard_ready !== 1) {
    backfillRequired(
      "the v2 contiguity migration witness is absent; refusing both replay and fast-path writes.",
    );
  }
  const publicSeq = requireStoredSequence(rawHead.public_seq, "problem cursor", true);
  if (publicSeq >= Number.MAX_SAFE_INTEGER) {
    throw new KraterSequenceExhaustedError(
      "Krater sequence allocation refuses an inexact or exhausted predecessor.",
    );
  }
  const storedBackfill = await readIntegrityBackfill(db, problemId, cost);
  const emptyHeadHasExactGenesis =
    publicSeq !== 0 || rawHead.chain_digest === (await genesisChainDigest(problemId));
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
  // firstUndigestedEvent for the query plans on either side of it). Migration 0040 makes
  // both immutable v2 sidecar streams predecessor-contiguous, and the query requires that
  // migration's retained zero-gap witness. The two terminal sidecars are therefore bounded
  // witnesses for complete 1..public_seq ranges rather than merely evidence that the last rows
  // happen to exist.
  if (
    storedBackfill?.state === "complete" &&
    storedBackfill.chain_version === KRATER_CHAIN_VERSION &&
    rawHead.chain_digest !== null &&
    rawHead.chain_version === KRATER_CHAIN_VERSION &&
    emptyHeadHasExactGenesis &&
    rawHead.terminal_v2_complete === 1
  ) {
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
    `SELECT e.id, e.problem_id, e.seq, e.type, e.object_kind, e.object_id, e.object_version,
            e.payload_sha256, e.row_digest AS stored_row_digest,
            e.chain_digest AS stored_chain_digest, c.row_digest AS v2_row_digest,
            c.chain_digest AS v2_chain_digest, c.chain_version AS v2_chain_version,
            e.created_at, e.actor_fellow_id, e.actor_sponsor_id, e.actor_session_id,
            e.model_string_self_declared, e.harness, e.writer_credential_id
     FROM events e
     LEFT JOIN event_chain_v2 c ON c.event_id = e.id
     WHERE e.problem_id = ? ORDER BY e.seq ASC`,
    problemId,
  ).all<BackfillEventRow>();
  // The replay path's dominant read. Counting it keeps the two paths comparable in the receipt:
  // a legacy upgrade legitimately reads the whole log, an ordinary write must not.
  recordD1Result(cost, events);
  const legacyEvents = events.results.map((event) => ({
    ...event,
    seq: requireStoredSequence(event.seq, "event", false),
  }));

  if (legacyEvents.length > MAX_INTEGRITY_BACKFILL_EVENTS) {
    backfillRequired(
      "the legacy problem exceeds the bounded integrity replay limit; use the future range-aware backfill.",
    );
  }

  if (
    rawHead.chain_version !== null ||
    (storedBackfill !== null && storedBackfill.chain_version !== null) ||
    legacyEvents.some(
      (event) =>
        event.v2_row_digest !== null ||
        event.v2_chain_digest !== null ||
        event.v2_chain_version !== null,
    )
  ) {
    backfillRequired("the v2 integrity state is partial; refusing a mixed-version replay.");
  }
  if (
    legacyEvents.some(
      (event) => (event.stored_row_digest === null) !== (event.stored_chain_digest === null),
    )
  ) {
    backfillRequired("the legacy integrity columns are partial; refusing to infer authority.");
  }
  if (storedBackfill === null && (publicSeq !== 0 || legacyEvents.length !== 0)) {
    backfillRequired("the legacy integrity state is absent; refusing to infer authority.");
  }
  const everyLegacyEventWasDigested = legacyEvents.every(
    (event) => event.stored_row_digest !== null && event.stored_chain_digest !== null,
  );
  const everyLegacyEventWasUndigested = legacyEvents.every(
    (event) => event.stored_row_digest === null && event.stored_chain_digest === null,
  );
  const legacyWasComplete = rawHead.chain_digest !== null && everyLegacyEventWasDigested;
  const legacyWasUndigested = rawHead.chain_digest === null && everyLegacyEventWasUndigested;
  if (!legacyWasComplete && !legacyWasUndigested) {
    backfillRequired("the legacy head, replay state, and event digests disagree.");
  }
  if (publicSeq !== legacyEvents.length) {
    backfillRequired("the legacy cursor does not match a complete contiguous envelope history.");
  }
  const legacyCheckpointResult = await statement(
    db,
    `SELECT problem_id, checkpoint_seq, root_chain_digest, checkpoint_digest,
            checkpoint_version, checkpoint_mode, created_at
     FROM integrity_checkpoints WHERE problem_id = ? ORDER BY checkpoint_seq ASC`,
    problemId,
  ).all<LegacyCheckpointRow>();
  recordD1Result(cost, legacyCheckpointResult);
  const legacyCheckpoints = legacyCheckpointResult.results;
  if (
    (legacyWasComplete && legacyCheckpoints.length !== legacyEvents.length) ||
    (legacyWasUndigested && legacyCheckpoints.length !== 0)
  ) {
    backfillRequired("the legacy checkpoint stream is absent, partial, or ambiguous.");
  }

  let priorChainDigest = await genesisChainDigest(problemId);
  let priorLegacyChainDigest = await legacyGenesisChainDigestV1(problemId);
  const updates: D1PreparedStatement[] = [
    statement(
      db,
      `INSERT INTO krater_integrity_backfill
         (problem_id, state, legacy_event_count, completed_at, chain_version)
       VALUES (?, 'required', ?, NULL, NULL) ON CONFLICT(problem_id) DO NOTHING`,
      problemId,
      legacyEvents.length,
    ),
  ];
  for (const [index, event] of legacyEvents.entries()) {
    if (
      event.seq !== index + 1 ||
      event.type.length === 0 ||
      event.object_kind.length === 0 ||
      event.object_id.length === 0 ||
      !Number.isSafeInteger(event.object_version) ||
      event.object_version < 1
    ) {
      backfillRequired("the legacy event stream is not a contiguous canonical envelope history.");
    }
    const envelope: EventEnvelopeForDigest = {
      eventId: event.id,
      problemId: event.problem_id,
      seq: event.seq,
      type: event.type,
      objectKind: event.object_kind,
      objectId: event.object_id,
      objectVersion: event.object_version,
      payloadSha256: event.payload_sha256,
      createdAt: event.created_at,
      actorFellowId: event.actor_fellow_id,
      actorSponsorId: event.actor_sponsor_id,
      actorSessionId: event.actor_session_id,
      modelStringSelfDeclared: event.model_string_self_declared,
      harness: event.harness,
      writerCredentialId: event.writer_credential_id,
    };
    const rowDigest = await eventEnvelopeRowDigest(envelope);
    const legacyRowDigest = await legacyEventEnvelopeRowDigestV1(envelope);
    const legacyChainDigest = await legacyEventChainDigestV1(
      event.problem_id,
      event.seq,
      event.payload_sha256,
      priorLegacyChainDigest,
    );
    if (
      legacyWasComplete &&
      (event.stored_row_digest !== legacyRowDigest ||
        event.stored_chain_digest !== legacyChainDigest)
    ) {
      backfillRequired(
        "the stored v1 integrity bytes disagree with their immutable event history.",
      );
    }
    if (legacyWasComplete) {
      const legacyCheckpoint = legacyCheckpoints[index];
      if (
        legacyCheckpoint === undefined ||
        legacyCheckpoint.problem_id !== event.problem_id ||
        legacyCheckpoint.checkpoint_seq !== event.seq ||
        legacyCheckpoint.root_chain_digest !== legacyChainDigest ||
        legacyCheckpoint.checkpoint_version !== 1 ||
        legacyCheckpoint.checkpoint_mode !== "unsigned-v0" ||
        legacyCheckpoint.created_at !== event.created_at ||
        legacyCheckpoint.checkpoint_digest !==
          (await legacyCheckpointDigestV1(
            event.problem_id,
            event.seq,
            legacyCheckpoint.root_chain_digest,
          ))
      ) {
        backfillRequired(
          "the stored v1 checkpoint bytes disagree with their verified event chain.",
        );
      }
    }
    const chainDigest = await eventChainDigest(
      event.problem_id,
      event.seq,
      event.payload_sha256,
      rowDigest,
      priorChainDigest,
    );
    const digestCheckpoint = await checkpointDigest(event.problem_id, event.seq, chainDigest);
    // The compatibility digest is deliberately not compared with the v2 row
    // digest. V1 predated the attribution and writer-credential fields now in
    // the canonical envelope, so equal bytes would itself be a versioning bug.
    // The immutable legacy value remains audit history; only this sidecar is
    // authoritative for current reads, replay, exports, and checkpoints.
    updates.push(
      ...(event.stored_row_digest === null
        ? [
            statement(
              db,
              `UPDATE events SET row_digest = ?, chain_digest = ?
               WHERE id = ? AND row_digest IS NULL AND chain_digest IS NULL`,
              rowDigest,
              chainDigest,
              event.id,
            ),
          ]
        : []),
      statement(
        db,
        `INSERT INTO event_chain_v2
           (event_id, problem_id, seq, row_digest, chain_digest, chain_version)
         VALUES (?, ?, ?, ?, ?, 2)`,
        event.id,
        event.problem_id,
        event.seq,
        rowDigest,
        chainDigest,
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
      statement(
        db,
        `UPDATE claim_projections
         SET build_digest = ?, updated_at = ?
         WHERE problem_id = ? AND claim_id = ? AND source_seq = ? AND build_digest = ?`,
        rowDigest,
        completedAt,
        event.problem_id,
        event.object_id,
        event.seq,
        legacyRowDigest,
      ),
      statement(
        db,
        `INSERT INTO checkpoint_chain_v2
           (problem_id, checkpoint_seq, root_chain_digest, checkpoint_digest, chain_version)
         VALUES (?, ?, ?, ?, 2)
         ON CONFLICT(problem_id, checkpoint_seq) DO NOTHING`,
        event.problem_id,
        event.seq,
        chainDigest,
        digestCheckpoint,
      ),
    );
    priorChainDigest = chainDigest;
    priorLegacyChainDigest = legacyChainDigest;
  }
  if (legacyWasComplete && rawHead.chain_digest !== priorLegacyChainDigest) {
    backfillRequired("the stored v1 problem head disagrees with its verified event chain.");
  }
  updates.push(
    statement(
      db,
      `UPDATE problems SET chain_digest = ?, chain_version = 2
       WHERE id = ? AND chain_version IS NULL`,
      priorChainDigest,
      problemId,
    ),
    statement(
      db,
      `UPDATE krater_integrity_backfill
       SET state = 'complete', legacy_event_count = ?, completed_at = ?, chain_version = 2
       WHERE problem_id = ? AND state = 'required' AND chain_version IS NULL`,
      legacyEvents.length,
      completedAt,
      problemId,
    ),
  );
  try {
    const batchResults = await db.batch(updates);
    recordD1Results(cost, batchResults);
  } catch (_error) {
    // D1 can lose a batch response after committing it. Without result
    // metadata, this invocation cannot report truthful rows-written or SQL
    // cost, and a second read set could race a later append. Refuse this
    // indeterminate attempt; the caller's idempotent retry re-enters through
    // the ordinary fast path, which validates the durable v2 witnesses and
    // returns a complete receipt for that fresh preflight.
    backfillRequired(
      "the integrity replay batch outcome is indeterminate; retry the exact request through a fresh v2 preflight.",
    );
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
  const preflight = await backfillKraterIntegrity(
    db,
    input.problemId,
    input.createdAt,
    serverNowMs,
  );
  const companionRequestDigest = companion?.requestDigest;
  const claimIdForSequence = companion?.claimIdForSequence;
  if (companionRequestDigest !== undefined && !/^[0-9a-f]{64}$/.test(companionRequestDigest)) {
    inputError("an atomic companion request digest must be lowercase SHA-256 hex.");
  }
  const writePhaseStartedAt = performance.now();
  let retryCount = 0;

  while (retryCount <= MAX_CHAIN_RETRIES) {
    const before = await readProblemHead(db, input.problemId);
    await hooks.afterReadHead?.({
      publicSeq: before.public_seq,
      chainDigest: before.chain_digest,
      chainVersion: before.chain_version,
    });
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
    const nextRowDigest = await eventRowDigest(attemptInput, candidateSeq, payloadSha256);
    const nextChainDigest = await eventChainDigest(
      input.problemId,
      candidateSeq,
      payloadSha256,
      nextRowDigest,
      before.chain_digest,
    );
    const nextBuildDigest = claimProjectionBuildDigestV1(nextRowDigest);
    const nextCheckpointDigest = await checkpointDigest(
      input.problemId,
      candidateSeq,
      nextChainDigest,
    );

    const companionStatements =
      (await companion?.statementsAfterIdempotencySettlement({
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
           WHERE id = ? AND public_seq = ? AND chain_digest = ? AND chain_version = 2 AND EXISTS (
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
          `INSERT INTO claims (id, problem_id, statement, payload_sha256, norm_hash, source_seq, created_at)
           SELECT ?, p.id, ?, ?, ?, p.public_seq, ?
           FROM problems p
           JOIN idempotency i ON i.problem_id = p.id AND i.idempotency_key = ?
           WHERE p.id = ? AND i.event_id IS NULL`,
          attemptInput.claimId,
          attemptInput.statement,
          payloadSha256,
          attemptInput.normHash ?? null,
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
              row_digest, chain_digest, created_at,
              actor_fellow_id, actor_sponsor_id, actor_session_id,
              model_string_self_declared, harness, writer_credential_id)
           SELECT ?, p.id, p.public_seq, 'claim.created', 'claim', ?, 1, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?
           FROM problems p
           JOIN idempotency i ON i.problem_id = p.id AND i.idempotency_key = ?
           WHERE p.id = ? AND i.event_id IS NULL`,
          input.eventId,
          attemptInput.claimId,
          payloadSha256,
          nextRowDigest,
          nextChainDigest,
          input.createdAt,
          input.attribution?.fellowId ?? null,
          input.attribution?.sponsorId ?? null,
          input.attribution?.sessionId ?? null,
          input.attribution?.modelSelfDeclared ?? null,
          input.attribution?.harness ?? null,
          input.attribution?.credentialId ?? null,
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
      // The atomic replay companion deliberately aborts a same-caller-key
      // loser after another request has won ownership. Its head will differ,
      // but retrying can never make that loser own the replay row. True event
      // chain races surface one of the explicit retryable SQLite/trigger
      // errors; only those should consume the bounded retry budget here.
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

    const event = await readEventById(db, settled.event_id);
    const [projection, checkpoint, claim, outbox, after] = await Promise.all([
      readProjectionByEvent(db, event),
      readCheckpointByEvent(db, event),
      readClaimByEvent(db, event),
      readOutboxByEvent(db, event),
      readProblemHead(db, input.problemId),
    ]);
    const observedPayloadSha256 = await sha256Hex(
      canonicalClaimPayload({
        claimId: claim.id,
        kind: "claim",
        statement: claim.statement,
      }),
    );
    if (
      event.problem_id !== input.problemId ||
      event.type !== "claim.created" ||
      event.object_kind !== "claim" ||
      event.object_version !== 1 ||
      claim.id !== event.object_id ||
      claim.problem_id !== event.problem_id ||
      claim.source_seq !== event.seq ||
      claim.payload_sha256 !== event.payload_sha256 ||
      observedPayloadSha256 !== event.payload_sha256 ||
      outbox.event_id !== event.id ||
      outbox.problem_id !== event.problem_id ||
      outbox.kind !== "search.index" ||
      outbox.dedupe_key !== `search.index:${event.id}` ||
      outbox.payload_sha256 !== event.payload_sha256 ||
      (outbox.state !== "pending" && outbox.state !== "delivered")
    ) {
      throw new Error("Krater persisted claim, event, and outbox bindings disagree.");
    }
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
      chainVersion: KRATER_CHAIN_VERSION,
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

/**
 * W5.3 (P9): the revision write. Mints version @n+1 for an EXISTING claim in
 * one atomic batch: the immutable claim_versions row, the claims head update
 * (statement, norm_hash, payload digest, source sequence), the rebuilt
 * projection, the claim.revised event, its content, the outbox row and the
 * integrity checkpoint.
 *
 * The stale-base guard IS the primary key: inserting version base_version + 1
 * collides with claim_versions(claim_id, version) exactly when a concurrent
 * revision already minted it or the caller's base is behind the durable head,
 * so a stale replacement aborts its own whole batch instead of silently
 * strengthening or weakening a reviewed object. Callers map that constraint
 * error to OBJECT_VERSION_CONFLICT.
 *
 * Deliberately a sibling of writeClaim rather than a parameterization: the
 * promote path is under concurrent reshaping (session replay atomicity), and
 * consolidating the two writers mid-flight would couple their retries. The
 * shared pieces (head read, digest helpers, verification readers) are reused;
 * only the batch skeleton is mirrored.
 */
export interface KraterRevisionInput {
  problemId: string;
  /** The real, existing claim id ("C-12") — no placeholder dance here. */
  claimId: string;
  eventId: string;
  idempotencyKey: string;
  baseVersion: number;
  newVersion: number;
  kind: string;
  statement: string;
  falsifier: string | null;
  /** The claim-version content digest from mintClaimVersion. */
  contentDigest: string;
  editorFellowId: string;
  /** The split/policy.ts normHash of the NEW statement. */
  normHash: string;
  /** Rule A3: the full attribution snapshot, recorded on the claim.revised event. */
  readonly attribution?: {
    readonly fellowId: string;
    readonly sponsorId: string;
    readonly sessionId: string;
    readonly modelSelfDeclared: string;
    readonly harness: string;
    /** Durable per-credential accounting unit for grant-wide budgets (wqlf). */
    readonly credentialId?: string;
  };
  createdAt: string;
}

export function canonicalRevisionPayload(input: {
  readonly baseVersion: number;
  readonly claimId: string;
  readonly falsifier: string | null;
  readonly kind: string;
  readonly statement: string;
}): string {
  return canonicalJson({
    base_version: input.baseVersion,
    claim_id: input.claimId,
    falsifier: input.falsifier,
    kind: input.kind,
    statement: input.statement,
  });
}

function validateRevisionInput(input: KraterRevisionInput, serverNowMs: number): void {
  requireIdentifier("problemId", input.problemId);
  requireIdentifier("claimId", input.claimId);
  requireIdentifier("eventId", input.eventId);
  requireIdentifier("idempotencyKey", input.idempotencyKey);
  if (!Number.isSafeInteger(input.baseVersion) || input.baseVersion < 1) {
    inputError("baseVersion must be a positive safe integer.");
  }
  if (
    input.baseVersion >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(input.newVersion) ||
    input.newVersion !== input.baseVersion + 1
  ) {
    inputError("newVersion must be exactly baseVersion + 1 (P9 mints @n+1).");
  }
  if (
    input.statement.trim().length === 0 ||
    new TextEncoder().encode(input.statement).byteLength > MAX_STATEMENT_BYTES
  ) {
    inputError("statement must be non-empty and within the Krater v0 byte limit.");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(input.contentDigest)) {
    inputError("contentDigest must be a sha256-prefixed lowercase hex digest.");
  }
  if (!/^[0-9a-f]{64}$/.test(input.normHash)) {
    inputError("normHash must be lowercase SHA-256 hex.");
  }
  validateKraterIngressTimestamp(input.createdAt, serverNowMs);
}

export async function writeClaimRevision(
  db: D1Database,
  input: KraterRevisionInput,
  hooks: KraterWriteHooks = {},
  companion?: KraterAtomicCompanion,
): Promise<KraterWriteResult> {
  const writeClaimStartedAt = performance.now();
  const serverNowMs = Date.now();
  validateRevisionInput(input, serverNowMs);
  const outboxCreatedAt = serverAuthoredOutboxTimestamp(serverNowMs);
  const preflight = await backfillKraterIntegrity(
    db,
    input.problemId,
    input.createdAt,
    serverNowMs,
  );
  const companionRequestDigest = companion?.requestDigest;
  if (companionRequestDigest !== undefined && !/^[0-9a-f]{64}$/.test(companionRequestDigest)) {
    inputError("an atomic companion request digest must be lowercase SHA-256 hex.");
  }
  const writePhaseStartedAt = performance.now();
  let retryCount = 0;

  while (retryCount <= MAX_CHAIN_RETRIES) {
    const before = await readProblemHead(db, input.problemId);
    await hooks.afterReadHead?.({
      publicSeq: before.public_seq,
      chainDigest: before.chain_digest,
      chainVersion: before.chain_version,
    });
    if (
      !Number.isSafeInteger(before.public_seq) ||
      before.public_seq < 0 ||
      before.public_seq >= Number.MAX_SAFE_INTEGER
    ) {
      throw new KraterSequenceExhaustedError(
        "Krater sequence allocation refuses an inexact or exhausted predecessor.",
      );
    }
    const candidateSeq = before.public_seq + 1;
    const payloadJson = canonicalRevisionPayload({
      baseVersion: input.baseVersion,
      claimId: input.claimId,
      falsifier: input.falsifier,
      kind: input.kind,
      statement: input.statement,
    });
    const [payloadSha256, requestDigest] = await Promise.all([
      sha256Hex(payloadJson),
      companionRequestDigest === undefined
        ? sha256Hex(
            canonicalJson({
              base_version: input.baseVersion,
              claim_id: input.claimId,
              statement: input.statement,
            }),
          )
        : Promise.resolve(companionRequestDigest),
    ]);
    const nextRowDigest = await eventEnvelopeRowDigest({
      eventId: input.eventId,
      problemId: input.problemId,
      seq: candidateSeq,
      type: "claim.revised",
      objectKind: "claim",
      objectId: input.claimId,
      objectVersion: input.newVersion,
      payloadSha256,
      createdAt: input.createdAt,
      actorFellowId: input.attribution?.fellowId ?? null,
      actorSponsorId: input.attribution?.sponsorId ?? null,
      actorSessionId: input.attribution?.sessionId ?? null,
      modelStringSelfDeclared: input.attribution?.modelSelfDeclared ?? null,
      harness: input.attribution?.harness ?? null,
      writerCredentialId: input.attribution?.credentialId ?? null,
    });
    const nextChainDigest = await eventChainDigest(
      input.problemId,
      candidateSeq,
      payloadSha256,
      nextRowDigest,
      before.chain_digest,
    );
    const nextBuildDigest = claimProjectionBuildDigestV1(nextRowDigest);
    const nextCheckpointDigest = await checkpointDigest(
      input.problemId,
      candidateSeq,
      nextChainDigest,
    );

    const companionStatements =
      (await companion?.statementsAfterIdempotencySettlement({
        sequence: candidateSeq,
        claimId: input.claimId,
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
           WHERE id = ? AND public_seq = ? AND chain_digest = ? AND chain_version = 2 AND EXISTS (
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
        // The stale-base / double-mint guard: this INSERT collides with the
        // claim_versions primary key exactly when the durable head is not at
        // base_version, aborting the whole batch.
        statement(
          db,
          `INSERT INTO claim_versions
             (claim_id, problem_id, version, kind, statement, falsifier,
              content_digest, editor_fellow_id, created_at)
           SELECT ?, p.id, ?, ?, ?, ?, ?, ?, ?
           FROM problems p
           JOIN claims c ON c.problem_id = p.id AND c.id = ?
           JOIN idempotency i ON i.problem_id = p.id AND i.idempotency_key = ?
           WHERE p.id = ? AND i.event_id IS NULL`,
          input.claimId,
          input.newVersion,
          input.kind,
          input.statement,
          input.falsifier,
          input.contentDigest,
          input.editorFellowId,
          input.createdAt,
          input.claimId,
          input.idempotencyKey,
          input.problemId,
        ),
        // claim_projections carries a triple FK into claims(problem_id, id,
        // source_seq), so the old derived projection row must be dropped
        // BEFORE the claims head moves to the new sequence (Rule A6: the log
        // is the truth; projections are rebuildable). The new row lands two
        // statements below against the moved head.
        statement(
          db,
          `DELETE FROM claim_projections
           WHERE problem_id = ? AND claim_id = ?`,
          input.problemId,
          input.claimId,
        ),
        statement(
          db,
          `UPDATE claims SET statement = ?, payload_sha256 = ?, norm_hash = ?, source_seq = p.public_seq
           FROM problems p
           WHERE p.id = ? AND claims.problem_id = p.id AND claims.id = ?
             AND EXISTS (
               SELECT 1 FROM idempotency i
               WHERE i.problem_id = p.id AND i.idempotency_key = ? AND i.event_id IS NULL
             )`,
          input.statement,
          payloadSha256,
          input.normHash,
          input.problemId,
          input.claimId,
          input.idempotencyKey,
        ),
        statement(
          db,
          `INSERT INTO claim_projections
             (claim_id, problem_id, source_seq, projection_version, build_digest, stale, updated_at)
           SELECT ?, p.id, p.public_seq, 1, ?, 0, ?
           FROM problems p
           WHERE p.id = ?
           ON CONFLICT(problem_id, claim_id) DO UPDATE SET
             source_seq = excluded.source_seq,
             projection_version = projection_version + 1,
             build_digest = excluded.build_digest,
             stale = 0,
             updated_at = excluded.updated_at`,
          input.claimId,
          nextBuildDigest,
          input.createdAt,
          input.problemId,
        ),
        statement(
          db,
          `INSERT INTO events
             (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256,
              row_digest, chain_digest, created_at,
              actor_fellow_id, actor_sponsor_id, actor_session_id,
              model_string_self_declared, harness, writer_credential_id)
           SELECT ?, p.id, p.public_seq, 'claim.revised', 'claim', ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?
           FROM problems p
           JOIN idempotency i ON i.problem_id = p.id AND i.idempotency_key = ?
           WHERE p.id = ? AND i.event_id IS NULL`,
          input.eventId,
          input.claimId,
          input.newVersion,
          payloadSha256,
          nextRowDigest,
          nextChainDigest,
          input.createdAt,
          input.attribution?.fellowId ?? null,
          input.attribution?.sponsorId ?? null,
          input.attribution?.sessionId ?? null,
          input.attribution?.modelSelfDeclared ?? null,
          input.attribution?.harness ?? null,
          input.attribution?.credentialId ?? null,
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
      throw new KraterProblemNotFoundError("problem must exist before a Krater revision write.");
    }
    if (settled.request_digest !== requestDigest) {
      throw new KraterIdempotencyConflictError(
        "an idempotency key cannot represent two request digests.",
      );
    }
    if (settled.event_id === null || settled.event_seq === null) {
      throw new Error("Krater revision did not settle an event envelope.");
    }
    const settledEventSeq = requireStoredSequence(
      settled.event_seq,
      "idempotency event sequence",
      false,
    );
    const event = await readEventById(db, settled.event_id);
    const [projection, checkpoint, claim] = await Promise.all([
      readProjectionByEvent(db, event),
      readCheckpointByEvent(db, event),
      readClaimByEvent(db, event),
    ]);
    const observedPayloadSha256 = await sha256Hex(
      canonicalRevisionPayload({
        baseVersion: input.baseVersion,
        claimId: input.claimId,
        falsifier: input.falsifier,
        kind: input.kind,
        statement: claim.statement,
      }),
    );
    if (
      event.problem_id !== input.problemId ||
      event.type !== "claim.revised" ||
      event.object_kind !== "claim" ||
      event.object_version !== input.newVersion ||
      claim.id !== event.object_id ||
      claim.problem_id !== event.problem_id ||
      claim.source_seq !== event.seq ||
      observedPayloadSha256 !== event.payload_sha256 ||
      projection.source_seq !== event.seq
    ) {
      throw new Error("Krater persisted revision bindings disagree.");
    }
    if (event.seq !== settledEventSeq || checkpoint.root_chain_digest !== event.chain_digest) {
      throw new Error("Krater persisted integrity records disagree.");
    }
    if (event.row_digest === null || event.chain_digest === null) {
      throw new Error("Krater revision did not persist integrity digests.");
    }

    const after = await readProblemHead(db, input.problemId);
    return {
      eventId: settled.event_id,
      claimId: event.object_id,
      seq: settledEventSeq,
      idempotent: false,
      preCursor: before.public_seq,
      postCursor: after.public_seq,
      payloadSha256: event.payload_sha256,
      rowDigest: event.row_digest,
      buildDigest: projection.build_digest,
      chainDigest: event.chain_digest,
      chainVersion: KRATER_CHAIN_VERSION,
      checkpointDigest: checkpoint.checkpoint_digest,
      writePhaseMs: Math.round((performance.now() - writePhaseStartedAt) * 1_000) / 1_000,
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

/**
 * One event-sourced transaction for ledger object kinds whose projection row
 * is supplied by the route. The event, content, object projection, checkpoint,
 * idempotency settlement, and sealed response companion share one D1 batch.
 *
 * `preconditionSql` is internal SQL (never request text) appended to both the
 * sequence election and event insertion. It lets a guarded transition such as
 * hypothesis kill admit only an open route. Projection statements execute
 * after the immutable event exists and must bind that event id; any constraint
 * failure rolls the complete batch back.
 */
export interface KraterLedgerEventInput {
  readonly problemId: string;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly eventType: string;
  readonly objectKind: string;
  readonly objectId: string;
  readonly objectVersion: number;
  readonly payloadJson: string;
  readonly createdAt: string;
  readonly attribution: {
    readonly fellowId: string;
    readonly sponsorId: string;
    readonly sessionId: string;
    readonly modelSelfDeclared: string;
    readonly harness: string;
    readonly credentialId?: string;
  };
}

export interface KraterLedgerProjectionPlan {
  readonly preconditionSql?: string;
  readonly preconditionBindings?: readonly unknown[];
  readonly statementsAfterEvent: (settlement: {
    readonly sequence: number;
    readonly eventId: string;
    readonly objectId: string;
    readonly payloadSha256: string;
  }) => Promise<readonly D1PreparedStatement[]> | readonly D1PreparedStatement[];
}

export async function writeLedgerEvent(
  db: D1Database,
  input: KraterLedgerEventInput,
  projection: KraterLedgerProjectionPlan,
  _hooks: KraterWriteHooks = {},
  companion?: KraterAtomicCompanion,
): Promise<KraterWriteResult> {
  const writeStartedAt = performance.now();
  const serverNowMs = Date.now();
  requireIdentifier("problemId", input.problemId);
  requireIdentifier("eventId", input.eventId);
  requireIdentifier("idempotencyKey", input.idempotencyKey);
  requireIdentifier("eventType", input.eventType);
  requireIdentifier("objectKind", input.objectKind);
  requireIdentifier("objectId", input.objectId);
  requireIdentifier("attribution.fellowId", input.attribution.fellowId);
  requireIdentifier("attribution.sponsorId", input.attribution.sponsorId);
  requireIdentifier("attribution.sessionId", input.attribution.sessionId);
  if (
    !Number.isSafeInteger(input.objectVersion) ||
    input.objectVersion < 1 ||
    !/^[0-9a-f]{64}$/.test(input.requestDigest)
  ) {
    inputError("ledger object version and request digest must be exact bounded values.");
  }
  if (
    input.payloadJson.length === 0 ||
    new TextEncoder().encode(input.payloadJson).byteLength > 512 * 1024
  ) {
    inputError("ledger payload JSON must be non-empty and within the ingress byte limit.");
  }
  try {
    JSON.parse(input.payloadJson);
  } catch {
    inputError("ledger payload must be valid JSON.");
  }
  validateKraterIngressTimestamp(input.createdAt, serverNowMs);
  const preconditionSql = projection.preconditionSql ?? "";
  if (preconditionSql !== "" && !/^\s+AND\s+/u.test(preconditionSql)) {
    inputError("ledger precondition SQL must be an appended AND predicate.");
  }
  const preconditionBindings = projection.preconditionBindings ?? [];
  const preflight = await backfillKraterIntegrity(
    db,
    input.problemId,
    input.createdAt,
    serverNowMs,
  );
  const writePhaseStartedAt = performance.now();
  let retryCount = 0;

  while (retryCount <= MAX_CHAIN_RETRIES) {
    const before = await readProblemHead(db, input.problemId);
    if (
      !Number.isSafeInteger(before.public_seq) ||
      before.public_seq < 0 ||
      before.public_seq >= Number.MAX_SAFE_INTEGER
    ) {
      throw new KraterSequenceExhaustedError(
        "Krater sequence allocation refuses an inexact or exhausted predecessor.",
      );
    }
    const candidateSeq = before.public_seq + 1;
    const payloadSha256 = await sha256Hex(input.payloadJson);
    const nextRowDigest = await eventEnvelopeRowDigest({
      eventId: input.eventId,
      problemId: input.problemId,
      seq: candidateSeq,
      type: input.eventType,
      objectKind: input.objectKind,
      objectId: input.objectId,
      objectVersion: input.objectVersion,
      payloadSha256,
      createdAt: input.createdAt,
      actorFellowId: input.attribution.fellowId,
      actorSponsorId: input.attribution.sponsorId,
      actorSessionId: input.attribution.sessionId,
      modelStringSelfDeclared: input.attribution.modelSelfDeclared,
      harness: input.attribution.harness,
      writerCredentialId: input.attribution.credentialId ?? null,
    });
    const nextChainDigest = await eventChainDigest(
      input.problemId,
      candidateSeq,
      payloadSha256,
      nextRowDigest,
      before.chain_digest,
    );
    const nextCheckpointDigest = await checkpointDigest(
      input.problemId,
      candidateSeq,
      nextChainDigest,
    );

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
          input.requestDigest,
          input.createdAt,
          input.problemId,
        ),
        statement(
          db,
          `UPDATE problems SET public_seq = public_seq + 1, chain_digest = ?, updated_at = ?
           WHERE id = ? AND public_seq = ? AND chain_digest = ? AND chain_version = 2
             AND EXISTS (
               SELECT 1 FROM idempotency
               WHERE problem_id = ? AND idempotency_key = ? AND request_digest = ?
                 AND event_id IS NULL
             )${preconditionSql}
           RETURNING public_seq`,
          nextChainDigest,
          input.createdAt,
          input.problemId,
          before.public_seq,
          before.chain_digest,
          input.problemId,
          input.idempotencyKey,
          input.requestDigest,
          ...preconditionBindings,
        ),
        statement(
          db,
          `INSERT INTO events
             (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256,
              row_digest, chain_digest, created_at,
              actor_fellow_id, actor_sponsor_id, actor_session_id,
              model_string_self_declared, harness, writer_credential_id)
           SELECT ?, p.id, p.public_seq, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM problems p
           JOIN idempotency i ON i.problem_id = p.id AND i.idempotency_key = ?
             AND i.request_digest = ?
           WHERE p.id = ? AND i.event_id IS NULL
             AND p.public_seq = ? AND p.chain_digest = ?${preconditionSql}`,
          input.eventId,
          input.eventType,
          input.objectKind,
          input.objectId,
          input.objectVersion,
          payloadSha256,
          nextRowDigest,
          nextChainDigest,
          input.createdAt,
          input.attribution.fellowId,
          input.attribution.sponsorId,
          input.attribution.sessionId,
          input.attribution.modelSelfDeclared,
          input.attribution.harness,
          input.attribution.credentialId ?? null,
          input.idempotencyKey,
          input.requestDigest,
          input.problemId,
          candidateSeq,
          nextChainDigest,
          ...preconditionBindings,
        ),
        statement(
          db,
          `INSERT INTO event_content (event_id, payload_sha256, payload_json)
           SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM events WHERE id = ?)`,
          input.eventId,
          payloadSha256,
          input.payloadJson,
          input.eventId,
        ),
        ...(await projection.statementsAfterEvent({
          sequence: candidateSeq,
          eventId: input.eventId,
          objectId: input.objectId,
          payloadSha256,
        })),
        statement(
          db,
          `INSERT INTO integrity_checkpoints
             (problem_id, checkpoint_seq, root_chain_digest, checkpoint_digest,
              checkpoint_version, checkpoint_mode, created_at)
           SELECT e.problem_id, e.seq, ?, ?, 1, 'unsigned-v0', ?
           FROM events e WHERE e.id = ?`,
          nextChainDigest,
          nextCheckpointDigest,
          input.createdAt,
          input.eventId,
        ),
        statement(
          db,
          `UPDATE idempotency SET event_id = ?, event_seq = ?
           WHERE problem_id = ? AND idempotency_key = ? AND request_digest = ?
             AND event_id IS NULL
             AND EXISTS (SELECT 1 FROM events WHERE id = ?)`,
          input.eventId,
          candidateSeq,
          input.problemId,
          input.idempotencyKey,
          input.requestDigest,
          input.eventId,
        ),
        ...((await companion?.statementsAfterIdempotencySettlement({
          sequence: candidateSeq,
          claimId: input.objectId,
          eventId: input.eventId,
        })) ?? []),
        // A failed guarded transition must not retain an unresolved key. A
        // concurrent/same-key winner has event_id set and is never touched.
        statement(
          db,
          `DELETE FROM idempotency
           WHERE problem_id = ? AND idempotency_key = ? AND request_digest = ?
             AND event_id IS NULL`,
          input.problemId,
          input.idempotencyKey,
          input.requestDigest,
        ),
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
      throw new KraterLedgerPreconditionError("the guarded ledger transition no longer applies.");
    }
    if (settled.request_digest !== input.requestDigest) {
      throw new KraterIdempotencyConflictError("the idempotency key names another request.");
    }
    if (settled.event_id === null || settled.event_seq === null) {
      throw new Error("Krater ledger write did not settle an event envelope.");
    }
    const event = await readEventById(db, settled.event_id);
    const checkpoint = await readCheckpointByEvent(db, event);
    const after = await readProblemHead(db, input.problemId);
    return {
      eventId: event.id,
      claimId: event.object_id,
      seq: event.seq,
      idempotent: event.id !== input.eventId,
      preCursor: before.public_seq,
      postCursor: after.public_seq,
      payloadSha256: event.payload_sha256,
      rowDigest: event.row_digest ?? "",
      buildDigest: "",
      chainDigest: event.chain_digest ?? "",
      chainVersion: KRATER_CHAIN_VERSION,
      checkpointDigest: checkpoint.checkpoint_digest,
      writePhaseMs: Math.round((performance.now() - writePhaseStartedAt) * 1_000) / 1_000,
      successfulBatchRowsRead: metricSum(results, "rows_read"),
      successfulBatchRowsWritten: metricSum(results, "rows_written"),
      successfulBatchSqlMs: sqlDuration(results),
      preflight,
      writeClaimWallMs: Math.round((performance.now() - writeStartedAt) * 1_000) / 1_000,
      lockWaitMs: null,
      retryCount,
    };
  }

  throw new Error("Krater chain retry budget exhausted.");
}

/**
 * W5.5: the proof-gap ledger write (file or settle) — one atomic batch per
 * event, mirroring the Krater envelope. Gap ids derive from the shared
 * problem sequence (`G-<seq>`), so allocation races resolve exactly like
 * claim ids: the loser's batch aborts on the primary key and retries against
 * the moved head.
 *
 * Settle mode guards every post-bump statement on the gap still being open,
 * so a concurrent transition wins and this batch commits nothing.
 */
export type KraterGapInput =
  | {
      readonly mode: "filed";
      readonly problemId: string;
      readonly eventId: string;
      readonly idempotencyKey: string;
      readonly obligation: string;
      readonly closesWhat: string;
      readonly targetClaimId: string;
      readonly targetVersion: number;
      readonly authorFellowId: string;
      /** Durable per-credential accounting unit for grant-wide budgets (wqlf). */
      readonly writerCredentialId?: string;
      readonly createdAt: string;
    }
  | {
      readonly mode: "closed-by" | "withdrawn";
      readonly problemId: string;
      readonly eventId: string;
      readonly idempotencyKey: string;
      readonly gapId: string;
      readonly closedBy: string | null;
      readonly actorFellowId: string;
      /** Durable per-credential accounting unit for grant-wide budgets (wqlf). */
      readonly writerCredentialId?: string;
      readonly createdAt: string;
    };

function canonicalGapPayload(input: KraterGapInput): string {
  return canonicalJson(
    input.mode === "filed"
      ? {
          closes_what: input.closesWhat,
          obligation: input.obligation,
          target_claim_id: input.targetClaimId,
          target_version: input.targetVersion,
        }
      : { closed_by: input.closedBy, gap_id: input.gapId, outcome: input.mode },
  );
}

export async function writeGapEvent(
  db: D1Database,
  input: KraterGapInput,
  _hooks: KraterWriteHooks = {},
  companion?: KraterAtomicCompanion,
): Promise<KraterWriteResult> {
  const writeClaimStartedAt = performance.now();
  const serverNowMs = Date.now();
  const outboxCreatedAt = serverAuthoredOutboxTimestamp(serverNowMs);
  const preflight = await backfillKraterIntegrity(
    db,
    input.problemId,
    input.createdAt,
    serverNowMs,
  );
  const writePhaseStartedAt = performance.now();
  let retryCount = 0;

  while (retryCount <= MAX_CHAIN_RETRIES) {
    const before = await readProblemHead(db, input.problemId);
    if (
      !Number.isSafeInteger(before.public_seq) ||
      before.public_seq < 0 ||
      before.public_seq >= Number.MAX_SAFE_INTEGER
    ) {
      throw new KraterSequenceExhaustedError(
        "Krater sequence allocation refuses an inexact or exhausted predecessor.",
      );
    }
    const candidateSeq = before.public_seq + 1;
    const gapId = input.mode === "filed" ? `G-${candidateSeq}` : input.gapId;
    const payloadJson = canonicalGapPayload(input);
    const payloadSha256 = await sha256Hex(payloadJson);
    const actorFellowId = input.mode === "filed" ? input.authorFellowId : input.actorFellowId;
    const nextRowDigest = await eventEnvelopeRowDigest({
      eventId: input.eventId,
      problemId: input.problemId,
      seq: candidateSeq,
      type: `gap.${input.mode}`,
      objectKind: "gap",
      objectId: gapId,
      objectVersion: 1,
      payloadSha256,
      createdAt: input.createdAt,
      actorFellowId,
      actorSponsorId: null,
      actorSessionId: null,
      modelStringSelfDeclared: null,
      harness: null,
      writerCredentialId: input.writerCredentialId ?? null,
    });
    const nextChainDigest = await eventChainDigest(
      input.problemId,
      candidateSeq,
      payloadSha256,
      nextRowDigest,
      before.chain_digest,
    );
    const nextCheckpointDigest = await checkpointDigest(
      input.problemId,
      candidateSeq,
      nextChainDigest,
    );
    // Settle mode guards every post-bump statement on THIS attempt owning
    // the transition: the UPDATE stamps status + closed_at together, and a
    // concurrent winner leaves those untouched, so a losing batch no-ops
    // entirely instead of fabricating a second settle event.
    const settleGuardSql =
      input.mode === "filed"
        ? ""
        : ` AND EXISTS (
             SELECT 1 FROM proof_gaps g
             WHERE g.problem_id = ?
               AND g.gap_id = ?
               AND g.status = ?
               AND g.closed_at IS ?
           )`;
    const settleGuardBinds: readonly string[] =
      input.mode === "filed" ? [] : [input.problemId, input.gapId, input.mode, input.createdAt];

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
          payloadSha256,
          input.createdAt,
          input.problemId,
        ),
        statement(
          db,
          `UPDATE problems SET public_seq = public_seq + 1, chain_digest = ?, updated_at = ?
           WHERE id = ? AND public_seq = ? AND chain_digest = ? AND chain_version = 2 AND EXISTS (
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
        ...(input.mode === "filed"
          ? [
              statement(
                db,
                `INSERT INTO proof_gaps (gap_id, problem_id, obligation, closes_what,
                   target_claim_id, target_version, status, author_fellow_id, created_at)
                 SELECT ${gapId.startsWith("G-") ? `'${gapId.replaceAll("'", "''")}'` : "NULL"}, p.id, ?, ?, ?, ?, 'open', ?, ?
                 FROM problems p
                 JOIN claims c ON c.problem_id = p.id AND c.id = ?
                 JOIN idempotency i ON i.problem_id = p.id AND i.idempotency_key = ?
                 WHERE p.id = ? AND i.event_id IS NULL`,
                input.obligation,
                input.closesWhat,
                input.targetClaimId,
                input.targetVersion,
                input.authorFellowId,
                input.createdAt,
                input.targetClaimId,
                input.idempotencyKey,
                input.problemId,
              ),
            ]
          : [
              statement(
                db,
                `UPDATE proof_gaps SET status = ?, closed_by = ?, closed_at = ?
                 WHERE problem_id = ? AND gap_id = ? AND status = 'open'`,
                input.mode,
                input.closedBy,
                input.createdAt,
                input.problemId,
                input.gapId,
              ),
            ]),
        statement(
          db,
          `INSERT INTO events
             (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256,
              row_digest, chain_digest, created_at,
              actor_fellow_id, actor_sponsor_id, actor_session_id,
              model_string_self_declared, harness, writer_credential_id)
           SELECT ?, p.id, p.public_seq, 'gap.${input.mode}', 'gap', ?, 1, ?, ?, ?, ?,
                  ?, NULL, NULL, NULL, NULL, ?
           FROM problems p
           JOIN idempotency i ON i.problem_id = p.id AND i.idempotency_key = ?
           WHERE p.id = ? AND i.event_id IS NULL${settleGuardSql}`,
          input.eventId,
          gapId,
          payloadSha256,
          nextRowDigest,
          nextChainDigest,
          input.createdAt,
          actorFellowId,
          input.writerCredentialId ?? null,
          input.idempotencyKey,
          input.problemId,
          ...settleGuardBinds,
        ),
        statement(
          db,
          `INSERT INTO event_content (event_id, payload_sha256, payload_json)
           SELECT ?, ?, ?
           FROM idempotency i
           WHERE i.problem_id = ? AND i.idempotency_key = ? AND i.event_id IS NULL${settleGuardSql}`,
          input.eventId,
          payloadSha256,
          payloadJson,
          input.problemId,
          input.idempotencyKey,
          ...settleGuardBinds,
        ),
        statement(
          db,
          `INSERT INTO outbox (event_id, problem_id, kind, dedupe_key, payload_sha256, created_at)
           SELECT ?, ?, 'search.index', ?, ?, ?
           FROM idempotency i
           WHERE i.problem_id = ? AND i.idempotency_key = ? AND i.event_id IS NULL${settleGuardSql}`,
          input.eventId,
          input.problemId,
          `search.index:${input.eventId}`,
          payloadSha256,
          outboxCreatedAt,
          input.problemId,
          input.idempotencyKey,
          ...settleGuardBinds,
        ),
        statement(
          db,
          `INSERT INTO integrity_checkpoints
             (problem_id, checkpoint_seq, root_chain_digest, checkpoint_digest, checkpoint_version,
              checkpoint_mode, created_at)
           SELECT p.id, p.public_seq, p.chain_digest, ?, 1, 'unsigned-v0', ?
           FROM problems p
           JOIN idempotency i ON i.problem_id = p.id AND i.idempotency_key = ?
           WHERE p.id = ? AND i.event_id IS NULL${settleGuardSql}`,
          nextCheckpointDigest,
          input.createdAt,
          input.idempotencyKey,
          input.problemId,
          ...settleGuardBinds,
        ),
        statement(
          db,
          `UPDATE idempotency
           SET event_id = ?, event_seq = (SELECT seq FROM events WHERE id = ?)
           WHERE problem_id = ? AND idempotency_key = ? AND event_id IS NULL
             AND EXISTS (SELECT 1 FROM events WHERE id = ?)${settleGuardSql}`,
          input.eventId,
          input.eventId,
          input.problemId,
          input.idempotencyKey,
          input.eventId,
          ...settleGuardBinds,
        ),
        ...((await companion?.statementsAfterIdempotencySettlement({
          sequence: candidateSeq,
          claimId: gapId,
          eventId: input.eventId,
        })) ?? []),
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
    if (settled === null || settled.event_id === null || settled.event_seq === null) {
      // A settled-gap race leaves every guarded statement a no-op; the caller
      // sees GAP_ALREADY_SETTLED rather than a fabricated event envelope.
      throw new Error("Krater gap write did not settle an event envelope.");
    }
    const after = await readProblemHead(db, input.problemId);
    return {
      eventId: settled.event_id,
      claimId: gapId,
      seq: settled.event_seq,
      idempotent: false,
      preCursor: before.public_seq,
      postCursor: after.public_seq,
      payloadSha256,
      rowDigest: nextRowDigest,
      buildDigest: "",
      chainDigest: nextChainDigest,
      chainVersion: KRATER_CHAIN_VERSION,
      checkpointDigest: nextCheckpointDigest,
      writePhaseMs: Math.round((performance.now() - writePhaseStartedAt) * 1_000) / 1_000,
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

/**
 * W5.5: the relation-assertion write (ADR-21). One atomic batch: the
 * claim_relations row (natural key — a duplicate edge refuses here), the
 * relation.asserted event, content, outbox and checkpoint. The edge's public
 * cite is the assertion event's #seq.
 */
export interface KraterRelationInput {
  readonly problemId: string;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly sourceClaimId: string;
  readonly sourceVersion: number;
  readonly targetRef: string;
  readonly assertedByFellow: string;
  /** Durable per-credential accounting unit for grant-wide budgets (wqlf). */
  readonly writerCredentialId?: string;
  readonly createdAt: string;
}
export async function writeRelationEvent(
  db: D1Database,
  input: KraterRelationInput,
  companion?: KraterAtomicCompanion,
): Promise<KraterWriteResult> {
  const writeClaimStartedAt = performance.now();
  const serverNowMs = Date.now();
  const outboxCreatedAt = serverAuthoredOutboxTimestamp(serverNowMs);
  const preflight = await backfillKraterIntegrity(
    db,
    input.problemId,
    input.createdAt,
    serverNowMs,
  );
  const writePhaseStartedAt = performance.now();
  let retryCount = 0;

  while (retryCount <= MAX_CHAIN_RETRIES) {
    const before = await readProblemHead(db, input.problemId);
    if (
      !Number.isSafeInteger(before.public_seq) ||
      before.public_seq < 0 ||
      before.public_seq >= Number.MAX_SAFE_INTEGER
    ) {
      throw new KraterSequenceExhaustedError(
        "Krater sequence allocation refuses an inexact or exhausted predecessor.",
      );
    }
    const candidateSeq = before.public_seq + 1;
    const objectId = `${input.sourceClaimId}@${input.sourceVersion}-${input.kind}-${input.targetRef}`;
    const payloadJson = canonicalJson({
      kind: input.kind,
      source: `${input.sourceClaimId}@${input.sourceVersion}`,
      target: input.targetRef,
    });
    const payloadSha256 = await sha256Hex(payloadJson);
    const nextRowDigest = await eventEnvelopeRowDigest({
      eventId: input.eventId,
      problemId: input.problemId,
      seq: candidateSeq,
      type: "relation.asserted",
      objectKind: "relation",
      objectId,
      objectVersion: 1,
      payloadSha256,
      createdAt: input.createdAt,
      actorFellowId: input.assertedByFellow,
      actorSponsorId: null,
      actorSessionId: null,
      modelStringSelfDeclared: null,
      harness: null,
      writerCredentialId: input.writerCredentialId ?? null,
    });
    const nextChainDigest = await eventChainDigest(
      input.problemId,
      candidateSeq,
      payloadSha256,
      nextRowDigest,
      before.chain_digest,
    );
    const nextCheckpointDigest = await checkpointDigest(
      input.problemId,
      candidateSeq,
      nextChainDigest,
    );

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
          payloadSha256,
          input.createdAt,
          input.problemId,
        ),
        statement(
          db,
          `UPDATE problems SET public_seq = public_seq + 1, chain_digest = ?, updated_at = ?
           WHERE id = ? AND public_seq = ? AND chain_digest = ? AND chain_version = 2 AND EXISTS (
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
          `INSERT INTO claim_relations
             (problem_id, kind, source_claim_id, source_version, target_ref,
              status, asserted_by_event, asserted_by_fellow, created_at)
           SELECT p.id, ?, ?, ?, ?, 'asserted', ?, ?, ?
           FROM problems p
           JOIN claims c ON c.problem_id = p.id AND c.id = ?
           JOIN idempotency i ON i.problem_id = p.id AND i.idempotency_key = ?
           WHERE p.id = ? AND i.event_id IS NULL`,
          input.kind,
          input.sourceClaimId,
          input.sourceVersion,
          input.targetRef,
          input.eventId,
          input.assertedByFellow,
          input.createdAt,
          input.sourceClaimId,
          input.idempotencyKey,
          input.problemId,
        ),
        statement(
          db,
          `INSERT INTO events
             (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256,
              row_digest, chain_digest, created_at,
              actor_fellow_id, actor_sponsor_id, actor_session_id,
              model_string_self_declared, harness, writer_credential_id)
           SELECT ?, p.id, p.public_seq, 'relation.asserted', 'relation', ?, 1, ?, ?, ?, ?,
                  ?, NULL, NULL, NULL, NULL, ?
           FROM problems p
           JOIN idempotency i ON i.problem_id = p.id AND i.idempotency_key = ?
           WHERE p.id = ? AND i.event_id IS NULL`,
          input.eventId,
          objectId,
          payloadSha256,
          nextRowDigest,
          nextChainDigest,
          input.createdAt,
          input.assertedByFellow,
          input.writerCredentialId ?? null,
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
        ...((await companion?.statementsAfterIdempotencySettlement({
          sequence: candidateSeq,
          claimId: objectId,
          eventId: input.eventId,
        })) ?? []),
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
    if (settled === null || settled.event_id === null || settled.event_seq === null) {
      throw new Error("Krater relation write did not settle an event envelope.");
    }
    const after = await readProblemHead(db, input.problemId);
    return {
      eventId: settled.event_id,
      claimId: objectId,
      seq: settled.event_seq,
      idempotent: false,
      preCursor: before.public_seq,
      postCursor: after.public_seq,
      payloadSha256,
      rowDigest: nextRowDigest,
      buildDigest: "",
      chainDigest: nextChainDigest,
      chainVersion: KRATER_CHAIN_VERSION,
      checkpointDigest: nextCheckpointDigest,
      writePhaseMs: Math.round((performance.now() - writePhaseStartedAt) * 1_000) / 1_000,
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
    await readProblemHead(db, problemId);
    const result = await statement(
      db,
      `SELECT e.id, e.problem_id, e.seq, e.type, e.object_kind, e.object_id, e.object_version,
              e.payload_sha256, c.row_digest, c.chain_digest, c.chain_version, e.created_at,
              e.actor_fellow_id, e.actor_sponsor_id, e.actor_session_id,
              e.model_string_self_declared, e.harness, e.writer_credential_id
       FROM events e
       LEFT JOIN event_chain_v2 c ON c.event_id = e.id
       WHERE e.problem_id = ? AND e.seq > ? ORDER BY e.seq ASC LIMIT ?`,
      problemId,
      afterSeq,
      limit,
    ).all<EventRow>();
    return Promise.all(
      result.results.map(async (rawRow) => {
        const row = eventRowWithSafeSequence(rawRow);
        if (row.row_digest === null || row.chain_digest === null) {
          backfillRequired("event reads require one complete v2 Krater integrity replay.");
        }
        requireCurrentChainVersion(row.chain_version);
        const expectedRowDigest = await eventEnvelopeRowDigest({
          eventId: row.id,
          problemId: row.problem_id,
          seq: row.seq,
          type: row.type,
          objectKind: row.object_kind,
          objectId: row.object_id,
          objectVersion: row.object_version,
          payloadSha256: row.payload_sha256,
          createdAt: row.created_at,
          actorFellowId: row.actor_fellow_id,
          actorSponsorId: row.actor_sponsor_id,
          actorSessionId: row.actor_session_id,
          modelStringSelfDeclared: row.model_string_self_declared,
          harness: row.harness,
          writerCredentialId: row.writer_credential_id,
        });
        if (row.row_digest !== expectedRowDigest) {
          backfillRequired("event reads refuse a v2 row digest that disagrees with its envelope.");
        }
        return {
          eventId: row.id,
          problemId: row.problem_id,
          seq: row.seq,
          type: row.type,
          objectKind: row.object_kind,
          objectId: row.object_id,
          objectVersion: row.object_version,
          payloadSha256: row.payload_sha256,
          rowDigest: row.row_digest,
          chainDigest: row.chain_digest,
          chainVersion: KRATER_CHAIN_VERSION,
          createdAt: row.created_at,
          actorFellowId: row.actor_fellow_id,
          actorSponsorId: row.actor_sponsor_id,
          actorSessionId: row.actor_session_id,
          modelStringSelfDeclared: row.model_string_self_declared,
          harness: row.harness,
          writerCredentialId: row.writer_credential_id,
        };
      }),
    );
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
        `SELECT i.problem_id, i.checkpoint_seq, c.root_chain_digest, c.checkpoint_digest,
                i.checkpoint_version, c.chain_version, i.checkpoint_mode
         FROM integrity_checkpoints i
         LEFT JOIN checkpoint_chain_v2 c
           ON c.problem_id = i.problem_id AND c.checkpoint_seq = i.checkpoint_seq
         WHERE i.problem_id = ? ORDER BY i.checkpoint_seq DESC LIMIT 1`,
        problemId,
      ).first<CheckpointRow>(),
    ]);
    if (head.public_seq > 0 && checkpoint === null) {
      const hasEvents = await statement(
        db,
        "SELECT 1 FROM events WHERE problem_id = ? LIMIT 1",
        problemId,
      ).first();
      if (hasEvents !== null) {
        backfillRequired("a nonempty v2 chain must have a current-version checkpoint.");
      }
    }
    const validatedCheckpoint =
      checkpoint === null
        ? null
        : await validateCurrentCheckpoint(
            checkpoint,
            {
              problemId,
              seq: head.public_seq,
              rootChainDigest: head.chain_digest,
            },
            "the v2 checkpoint does not bind the durable problem head and exact digest.",
          );
    return {
      chainDigest: head.chain_digest,
      chainVersion: KRATER_CHAIN_VERSION,
      checkpointDigest: validatedCheckpoint?.checkpoint_digest ?? null,
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

/** Read the exact current-version checkpoint stream used by exports/backups. */
export async function readCheckpoints(
  db: D1Database,
  problemId: string,
): Promise<KraterCheckpoint[]> {
  requireIdentifier("problemId", problemId);
  try {
    const head = await readProblemHead(db, problemId);
    const result = await statement(
      db,
      `SELECT i.problem_id, i.checkpoint_seq, c.root_chain_digest, c.checkpoint_digest,
              i.checkpoint_version, c.chain_version, i.checkpoint_mode,
              e.chain_digest AS event_chain_digest
       FROM integrity_checkpoints i
       LEFT JOIN checkpoint_chain_v2 c
         ON c.problem_id = i.problem_id AND c.checkpoint_seq = i.checkpoint_seq
       LEFT JOIN event_chain_v2 e
         ON e.problem_id = i.problem_id AND e.seq = i.checkpoint_seq
       WHERE i.problem_id = ? ORDER BY i.checkpoint_seq ASC`,
      problemId,
    ).all<CheckpointRow & { event_chain_digest: string | null }>();
    if (result.results.length !== head.public_seq) {
      backfillRequired("the v2 checkpoint stream is incomplete for the durable problem cursor.");
    }
    return Promise.all(
      result.results.map(async (row, index) => {
        if (row.event_chain_digest === null) {
          backfillRequired("the checkpoint stream is missing its exact v2 event-chain root.");
        }
        const validated = await validateCurrentCheckpoint(
          row,
          {
            problemId,
            seq: index + 1,
            rootChainDigest: row.event_chain_digest,
          },
          "the checkpoint stream mixes identities, versions, roots, or digests.",
        );
        return {
          problemId: validated.problem_id,
          checkpointSeq: validated.checkpoint_seq,
          rootChainDigest: validated.root_chain_digest,
          checkpointDigest: validated.checkpoint_digest,
          checkpointVersion: 1,
          chainVersion: KRATER_CHAIN_VERSION,
          checkpointMode: "unsigned-v0",
        };
      }),
    );
  } catch (error) {
    if (
      error instanceof KraterProblemNotFoundError ||
      error instanceof KraterIntegrityBackfillRequiredError
    ) {
      throw error;
    }
    readError("checkpoint stream could not be read.");
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
      buildDigest: claimProjectionBuildDigestV1(event.rowDigest),
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
      event.chainVersion !== KRATER_CHAIN_VERSION ||
      !isSafeNonnegativeInteger(event.seq) ||
      event.seq === 0 ||
      event.seq !== priorSeq + 1 ||
      !Number.isSafeInteger(event.objectVersion) ||
      event.objectVersion < 1
    ) {
      return false;
    }
    const expectedRow = await eventEnvelopeRowDigest({
      eventId: event.eventId,
      problemId: event.problemId,
      seq: event.seq,
      type: event.type,
      objectKind: event.objectKind,
      objectId: event.objectId,
      objectVersion: event.objectVersion,
      payloadSha256: event.payloadSha256,
      createdAt: event.createdAt,
      actorFellowId: event.actorFellowId,
      actorSponsorId: event.actorSponsorId,
      actorSessionId: event.actorSessionId,
      modelStringSelfDeclared: event.modelStringSelfDeclared,
      harness: event.harness,
      writerCredentialId: event.writerCredentialId,
    });
    if (expectedRow !== event.rowDigest) return false;
    const expected = await eventChainDigest(
      event.problemId,
      event.seq,
      event.payloadSha256,
      expectedRow,
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
        current.buildDigest === projection.buildDigest &&
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
      statement(db, "SELECT COUNT(*) AS count FROM event_chain_v2 WHERE problem_id = ?", problemId),
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
      statement(
        db,
        "SELECT COUNT(*) AS count FROM checkpoint_chain_v2 WHERE problem_id = ?",
        problemId,
      ),
    ]);
    const names = [
      "claims",
      "claim_projections",
      "events",
      "event_chain_v2",
      "event_content",
      "public_claim_fts",
      "idempotency",
      "outbox",
      "integrity_checkpoints",
      "checkpoint_chain_v2",
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
