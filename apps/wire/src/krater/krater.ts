import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_STATEMENT_BYTES = 8_192;
const MAX_EVENT_PAGE_SIZE = 200;
const MAX_CHAIN_RETRIES = 16;
const MAX_INTEGRITY_BACKFILL_EVENTS = 512;
const REDACTION_REASONS = new Set(["legal", "privacy", "severe-safety"]);

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
  seq: number;
  idempotent: boolean;
  preCursor: number;
  postCursor: number;
  payloadSha256: string;
  rowDigest: string;
  buildDigest: string;
  chainDigest: string;
  checkpointDigest: string;
  transactionMs: number;
  d1RowsRead: number;
  d1RowsWritten: number;
  d1SqlMs: number | null;
  /** D1 does not expose lock wait separately; do not relabel elapsed time as lock wait. */
  lockWaitMs: null;
  retryCount: number;
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

function requireIdentifier(label: string, value: string): void {
  if (!IDENTIFIER.test(value)) inputError(`${label} must be a bounded identifier.`);
}

function validateWriteInput(input: KraterWriteInput): void {
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
  if (Number.isNaN(Date.parse(input.createdAt))) {
    inputError("createdAt must be an ISO-8601 timestamp.");
  }
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
  if (!Number.isInteger(seq) || seq < 1) inputError("chain sequence must be a positive integer.");
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
  return { public_seq: row.public_seq, chain_digest: row.chain_digest };
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
  return row;
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
  return row;
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
  return row;
}

function backfillRequired(message: string): never {
  throw new KraterIntegrityBackfillRequiredError(message);
}

async function readIntegrityBackfill(
  db: D1Database,
  problemId: string,
): Promise<IntegrityBackfillRow | null> {
  return statement(
    db,
    "SELECT state, legacy_event_count FROM krater_integrity_backfill WHERE problem_id = ?",
    problemId,
  ).first<IntegrityBackfillRow>();
}

/**
 * The first event of a problem still missing either digest, or null when every envelope is
 * digested.
 *
 * This is the cheap form of "is the upgrade finished?". `LIMIT 1` lets the engine stop at the
 * first counter-example rather than proving the negative by reading the whole log, and one
 * column crosses the boundary instead of eleven. Exported for direct unit and property
 * coverage: its equivalence to the exhaustive predicate it replaced is the load-bearing
 * claim, so it is tested rather than assumed.
 */
export async function firstUndigestedEvent(
  db: D1Database,
  problemId: string,
): Promise<string | null> {
  requireIdentifier("problemId", problemId);
  const row = await statement(
    db,
    `SELECT id FROM events
     WHERE problem_id = ? AND (row_digest IS NULL OR chain_digest IS NULL)
     ORDER BY seq ASC LIMIT 1`,
    problemId,
  ).first<{ id: string }>();
  return row?.id ?? null;
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
): Promise<void> {
  requireIdentifier("problemId", problemId);
  if (Number.isNaN(Date.parse(completedAt)))
    inputError("completedAt must be an ISO-8601 timestamp.");

  const rawHead = await statement(
    db,
    "SELECT public_seq, chain_digest FROM problems WHERE id = ?",
    problemId,
  ).first<ProblemHeadRow>();
  if (rawHead === null) {
    throw new KraterProblemNotFoundError("problem must exist before integrity replay.");
  }
  const storedBackfill = await readIntegrityBackfill(db, problemId);
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
  // an existence question, which reads at most one row and short-circuits on the first
  // counter-example instead of proving the point by exhaustion.
  if (storedBackfill?.state === "complete" && rawHead.chain_digest !== null) {
    const undigested = await firstUndigestedEvent(db, problemId);
    if (undigested === null) return;
  }

  const events = await statement(
    db,
    `SELECT id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256,
            row_digest, chain_digest, created_at
     FROM events WHERE problem_id = ? ORDER BY seq ASC`,
    problemId,
  ).all<EventRow>();

  if (events.results.length > MAX_INTEGRITY_BACKFILL_EVENTS) {
    backfillRequired(
      "the legacy problem exceeds the bounded integrity replay limit; use the future range-aware backfill.",
    );
  }

  if (
    rawHead.chain_digest !== null ||
    events.results.some((event) => event.row_digest !== null || event.chain_digest !== null)
  ) {
    backfillRequired("the legacy integrity state is partial; refusing to overwrite a digest.");
  }
  if (rawHead.public_seq !== events.results.length) {
    backfillRequired("the legacy cursor does not match a complete contiguous envelope history.");
  }

  let priorChainDigest = await genesisChainDigest(problemId);
  const updates: D1PreparedStatement[] = [
    statement(
      db,
      `INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at)
       VALUES (?, 'required', ?, NULL) ON CONFLICT(problem_id) DO NOTHING`,
      problemId,
      events.results.length,
    ),
  ];
  for (const [index, event] of events.results.entries()) {
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
      events.results.length,
      completedAt,
      problemId,
    ),
  );
  try {
    await db.batch(updates);
  } catch (_error) {
    const rechecked = await readIntegrityBackfill(db, problemId);
    if (rechecked?.state !== "complete") {
      backfillRequired(
        "the integrity replay could not atomically complete; no digest was defaulted.",
      );
    }
  }
}

/** Create a synthetic problem root for the local S-2 worker harness. */
export async function ensureProblem(
  db: D1Database,
  problemId: string,
  createdAt: string,
): Promise<void> {
  requireIdentifier("problemId", problemId);
  if (Number.isNaN(Date.parse(createdAt))) inputError("createdAt must be an ISO-8601 timestamp.");
  await statement(
    db,
    `INSERT INTO problems (id, public_seq, created_at, updated_at)
     VALUES (?, 0, ?, ?) ON CONFLICT(id) DO NOTHING`,
    problemId,
    createdAt,
    createdAt,
  ).run();
  await backfillKraterIntegrity(db, problemId, createdAt);
}

/**
 * Canonical Krater v0 write. The statements are a single D1 batch. A stale
 * predecessor chain digest triggers an event-insert abort, rolling the whole
 * batch back before a bounded retry obtains a fresh durable head.
 */
export async function writeClaim(
  db: D1Database,
  input: KraterWriteInput,
): Promise<KraterWriteResult> {
  validateWriteInput(input);
  await backfillKraterIntegrity(db, input.problemId, input.createdAt);
  const payloadJson = payloadFor(input);
  const [payloadSha256, requestDigest] = await Promise.all([
    sha256Hex(payloadJson),
    sha256Hex(requestFor(input)),
  ]);
  const startedAt = performance.now();
  let retryCount = 0;

  while (retryCount <= MAX_CHAIN_RETRIES) {
    const before = await readProblemHead(db, input.problemId);
    const expectedSeq = before.public_seq + 1;
    const [nextChainDigest, nextRowDigest] = await Promise.all([
      eventChainDigest(input.problemId, expectedSeq, payloadSha256, before.chain_digest),
      eventRowDigest(input, expectedSeq, payloadSha256),
    ]);
    const [nextBuildDigest, nextCheckpointDigest] = await Promise.all([
      projectionBuildDigest(payloadSha256, nextRowDigest),
      checkpointDigest(input.problemId, expectedSeq, nextChainDigest),
    ]);

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
          `UPDATE problems SET public_seq = ?, chain_digest = ?, updated_at = ?
           WHERE id = ? AND public_seq = ? AND chain_digest = ? AND EXISTS (
             SELECT 1 FROM idempotency
             WHERE problem_id = ? AND idempotency_key = ? AND event_id IS NULL
           )
           RETURNING public_seq`,
          expectedSeq,
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
          input.claimId,
          input.statement,
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
          input.claimId,
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
           SELECT ?, ?, ?, 'claim.created', 'claim', ?, 1, ?, ?, ?, ?
           FROM idempotency
           WHERE problem_id = ? AND idempotency_key = ? AND event_id IS NULL`,
          input.eventId,
          input.problemId,
          expectedSeq,
          input.claimId,
          payloadSha256,
          nextRowDigest,
          nextChainDigest,
          input.createdAt,
          input.problemId,
          input.idempotencyKey,
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
          input.claimId,
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
          input.createdAt,
          input.problemId,
          input.idempotencyKey,
        ),
        statement(
          db,
          `INSERT INTO integrity_checkpoints
             (problem_id, checkpoint_seq, root_chain_digest, checkpoint_digest, checkpoint_version,
              checkpoint_mode, created_at)
           SELECT ?, ?, ?, ?, 1, 'unsigned-v0', ?
           FROM idempotency i
           WHERE i.problem_id = ? AND i.idempotency_key = ? AND i.event_id IS NULL`,
          input.problemId,
          expectedSeq,
          nextChainDigest,
          nextCheckpointDigest,
          input.createdAt,
          input.problemId,
          input.idempotencyKey,
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

    const allocated = results[1]?.results[0]?.public_seq;
    if (allocated !== undefined && allocated !== settled.event_seq) {
      throw new Error("Krater sequence allocation disagreed with the settled event.");
    }

    const [event, projection, checkpoint, after] = await Promise.all([
      readEventById(db, settled.event_id),
      readEventById(db, settled.event_id).then((persisted) => readProjectionByEvent(db, persisted)),
      readEventById(db, settled.event_id).then((persisted) => readCheckpointByEvent(db, persisted)),
      readProblemHead(db, input.problemId),
    ]);
    if (event.seq !== settled.event_seq || checkpoint.root_chain_digest !== event.chain_digest) {
      throw new Error("Krater persisted integrity records disagree.");
    }
    if (event.row_digest === null || event.chain_digest === null) {
      throw new Error("Krater write did not persist integrity digests.");
    }

    return {
      eventId: settled.event_id,
      seq: settled.event_seq,
      idempotent: allocated === undefined,
      preCursor: before.public_seq,
      postCursor: after.public_seq,
      payloadSha256: event.payload_sha256,
      rowDigest: event.row_digest,
      buildDigest: projection.build_digest,
      chainDigest: event.chain_digest,
      checkpointDigest: checkpoint.checkpoint_digest,
      transactionMs: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
      d1RowsRead: metricSum(results, "rows_read"),
      d1RowsWritten: metricSum(results, "rows_written"),
      d1SqlMs: sqlDuration(results),
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
    return row.public_seq;
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
    !Number.isInteger(afterSeq) ||
    afterSeq < 0 ||
    !Number.isInteger(limit) ||
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
    return result.results.map((row) => {
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
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_EVENT_PAGE_SIZE) {
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
      sourceSeq: row.source_seq,
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
    if (event.problemId !== problemId || event.seq !== priorSeq + 1) return false;
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
  return cursor === (events[events.length - 1]?.seq ?? 0);
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
    !Number.isInteger(limit) ||
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
