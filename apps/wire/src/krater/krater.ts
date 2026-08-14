import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_STATEMENT_BYTES = 8_192;

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
  payloadSha256: string;
  transactionMs: number;
  d1RowsRead: number;
  d1RowsWritten: number;
  d1SqlMs: number | null;
  /** D1 does not expose lock wait separately; do not relabel elapsed time as lock wait. */
  lockWaitMs: null;
}

export interface KraterEvent {
  eventId: string;
  problemId: string;
  seq: number;
  type: "claim.created";
  objectId: string;
  payloadSha256: string;
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

export class KraterValidationError extends Error {
  readonly code = "KRATER_INPUT_INVALID";
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

interface IdempotencyRow {
  request_digest: string;
  event_id: string | null;
  event_seq: number | null;
}

interface SequenceRow {
  public_seq: number;
}

interface EventRow {
  id: string;
  problem_id: string;
  seq: number;
  type: "claim.created";
  object_id: string;
  payload_sha256: string;
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

interface CursorRow {
  public_seq: number;
}

interface CountRow {
  count: number;
}

function inputError(message: string): never {
  throw new KraterValidationError(message);
}

function requireIdentifier(label: string, value: string): void {
  if (!IDENTIFIER.test(value)) {
    inputError(`${label} must be a bounded identifier.`);
  }
}

function validateWriteInput(input: KraterWriteInput): void {
  requireIdentifier("problemId", input.problemId);
  requireIdentifier("claimId", input.claimId);
  requireIdentifier("eventId", input.eventId);
  requireIdentifier("idempotencyKey", input.idempotencyKey);
  if (input.statement.trim().length === 0 || new TextEncoder().encode(input.statement).byteLength > MAX_STATEMENT_BYTES) {
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
  if (Array.isArray(value)) {
    return `[${value.map(canonicalValue).join(",")}]`;
  }
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

function statement(db: D1Database, sql: string, ...values: unknown[]): D1PreparedStatement {
  return db.prepare(sql).bind(...values);
}

function metricSum(results: readonly D1Result<unknown>[], field: "rows_read" | "rows_written"): number {
  return results.reduce((total, result) => total + result.meta[field], 0);
}

function sqlDuration(results: readonly D1Result<unknown>[]): number | null {
  const durations = results
    .map((result) => result.meta.timings?.sql_duration_ms)
    .filter((duration): duration is number => duration !== undefined);
  return durations.length === 0 ? null : durations.reduce((total, duration) => total + duration, 0);
}

/** Create a synthetic problem root for the local S-2 worker harness. */
export async function ensureProblem(db: D1Database, problemId: string, createdAt: string): Promise<void> {
  requireIdentifier("problemId", problemId);
  if (Number.isNaN(Date.parse(createdAt))) inputError("createdAt must be an ISO-8601 timestamp.");
  await statement(
    db,
    "INSERT INTO problems (id, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
    problemId,
    createdAt,
    createdAt,
  ).run();
}

/**
 * Canonical Krater v0 write. Every SQL statement below is submitted in exactly
 * one D1 batch, which D1 commits atomically or rolls back as a unit.
 *
 * The public sequence is allocated by `UPDATE ... RETURNING`, never by an
 * application counter. Every dependent insert reads that allocated value from
 * the problem row inside the same batch.
 */
export async function writeClaim(db: D1Database, input: KraterWriteInput): Promise<KraterWriteResult> {
  validateWriteInput(input);
  const payloadJson = payloadFor(input);
  const [payloadSha256, requestDigest] = await Promise.all([
    sha256Hex(payloadJson),
    sha256Hex(requestFor(input)),
  ]);
  const startedAt = performance.now();

  const results = await db.batch<SequenceRow>([
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
      `UPDATE problems SET public_seq = public_seq + 1, updated_at = ?
       WHERE id = ? AND EXISTS (
         SELECT 1 FROM idempotency
         WHERE problem_id = ? AND idempotency_key = ? AND event_id IS NULL
       )
       RETURNING public_seq`,
      input.createdAt,
      input.problemId,
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
      payloadSha256,
      input.createdAt,
      input.idempotencyKey,
      input.problemId,
    ),
    statement(
      db,
      `INSERT INTO events
         (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256, created_at)
       SELECT ?, p.id, p.public_seq, 'claim.created', 'claim', ?, 1, ?, ?
       FROM problems p
       JOIN idempotency i ON i.problem_id = p.id AND i.idempotency_key = ?
       WHERE p.id = ? AND i.event_id IS NULL`,
      input.eventId,
      input.claimId,
      payloadSha256,
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

  const settled = await statement(
    db,
    "SELECT request_digest, event_id, event_seq FROM idempotency WHERE problem_id = ? AND idempotency_key = ?",
    input.problemId,
    input.idempotencyKey,
  ).first<IdempotencyRow>();
  if (settled === null) {
    throw new KraterProblemNotFoundError("problem must exist before a Krater claim write.");
  }
  if (settled.request_digest !== requestDigest) {
    throw new KraterIdempotencyConflictError("an idempotency key cannot represent two request digests.");
  }
  if (settled.event_id === null || settled.event_seq === null) {
    throw new Error("Krater write did not settle an event envelope.");
  }

  const allocated = results[1]?.results[0]?.public_seq;
  if (allocated !== undefined && allocated !== settled.event_seq) {
    throw new Error("Krater sequence allocation disagreed with the settled event.");
  }

  return {
    eventId: settled.event_id,
    seq: settled.event_seq,
    idempotent: allocated === undefined,
    payloadSha256,
    transactionMs: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
    d1RowsRead: metricSum(results, "rows_read"),
    d1RowsWritten: metricSum(results, "rows_written"),
    d1SqlMs: sqlDuration(results),
    lockWaitMs: null,
  };
}

export async function readCursor(db: D1Database, problemId: string): Promise<number> {
  requireIdentifier("problemId", problemId);
  const row = await statement(db, "SELECT public_seq FROM problems WHERE id = ?", problemId).first<CursorRow>();
  if (row === null) throw new KraterProblemNotFoundError("problem cursor does not exist.");
  return row.public_seq;
}

export async function readEvents(
  db: D1Database,
  problemId: string,
  afterSeq: number,
  limit: number,
): Promise<KraterEvent[]> {
  requireIdentifier("problemId", problemId);
  if (!Number.isInteger(afterSeq) || afterSeq < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    inputError("cursor reads require bounded integer pagination.");
  }
  const result = await statement(
    db,
    `SELECT id, problem_id, seq, type, object_id, payload_sha256, created_at
     FROM events WHERE problem_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
    problemId,
    afterSeq,
    limit,
  ).all<EventRow>();
  return result.results.map((row) => ({
    eventId: row.id,
    problemId: row.problem_id,
    seq: row.seq,
    type: row.type,
    objectId: row.object_id,
    payloadSha256: row.payload_sha256,
    createdAt: row.created_at,
  }));
}

export async function readClaimProjections(db: D1Database, problemId: string): Promise<ClaimProjection[]> {
  requireIdentifier("problemId", problemId);
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
}

export function replayClaimProjections(events: readonly KraterEvent[]): ClaimProjection[] {
  const projections: ClaimProjection[] = [];
  let priorSeq = 0;
  for (const event of events) {
    if (event.type !== "claim.created" || event.seq !== priorSeq + 1) {
      throw new KraterReplayError("event replay requires contiguous claim.created envelopes.");
    }
    projections.push({
      claimId: event.objectId,
      problemId: event.problemId,
      sourceSeq: event.seq,
      projectionVersion: 1,
      buildDigest: event.payloadSha256,
      stale: false,
    });
    priorSeq = event.seq;
  }
  return projections;
}

export function projectionReplayMatches(
  events: readonly KraterEvent[],
  projections: readonly ClaimProjection[],
): boolean {
  return canonicalJson(replayClaimProjections(events)) === canonicalJson(projections);
}

export async function searchPublicClaims(
  db: D1Database,
  query: string,
  limit: number,
): Promise<{ claimId: string; problemId: string }[]> {
  if (query.trim().length === 0 || query.length > 128 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    inputError("FTS search requires a bounded non-empty query and limit.");
  }
  const result = await statement(
    db,
    "SELECT claim_id, problem_id FROM public_claim_fts WHERE public_claim_fts MATCH ? LIMIT ?",
    query,
    limit,
  ).all<{ claim_id: string; problem_id: string }>();
  return result.results.map((row) => ({ claimId: row.claim_id, problemId: row.problem_id }));
}

/** Rebuild the public-only FTS foundation from durable claims without touching event envelopes. */
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

export async function inspectProblem(db: D1Database, problemId: string): Promise<Record<string, number>> {
  requireIdentifier("problemId", problemId);
  const results = await db.batch<CountRow>([
    statement(db, "SELECT COUNT(*) AS count FROM claims WHERE problem_id = ?", problemId),
    statement(db, "SELECT COUNT(*) AS count FROM claim_projections WHERE problem_id = ?", problemId),
    statement(db, "SELECT COUNT(*) AS count FROM events WHERE problem_id = ?", problemId),
    statement(db, "SELECT COUNT(*) AS count FROM idempotency WHERE problem_id = ?", problemId),
    statement(db, "SELECT COUNT(*) AS count FROM outbox WHERE problem_id = ?", problemId),
  ]);
  const names = ["claims", "claim_projections", "events", "idempotency", "outbox"] as const;
  return Object.fromEntries(
    names.map((name, index) => [name, results[index]?.results[0]?.count ?? 0]),
  );
}

export function deterministicWorkload(seed: string, count: number, createdAt: string): KraterWriteInput[] {
  requireIdentifier("seed", seed);
  if (!Number.isInteger(count) || count < 1 || count > 64) inputError("workload count must be 1 through 64.");
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
