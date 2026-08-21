import {
  EnrollmentApprovedResponseSchema,
  EnrollmentClaimResponseSchema,
  FellowNameSchema,
} from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement, ExecutionContext } from "@cloudflare/workers-types";
import { createApp } from "../app.ts";
import { D1EnrollmentStore } from "../enrollment/d1-store.ts";
import { createEnrollmentRouter } from "../enrollment/router.ts";
import {
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "../enrollment/service.ts";
import type { Env } from "../env.ts";
import type { ClaimProjection, KraterWriteInput } from "./krater";
import {
  attemptEnvelopeTamper,
  backfillKraterIntegrity,
  cursorMatchesEvents,
  ensureProblem,
  eventChainMatches,
  explainUndigestedEventProbe,
  inspectEventContentByEventId,
  inspectProblem,
  KraterIdempotencyConflictError,
  KraterIntegrityBackfillRequiredError,
  KraterProblemNotFoundError,
  KraterReadError,
  KraterReplayError,
  KraterSequenceExhaustedError,
  KraterValidationError,
  plantMalformedOutboxForHarness,
  projectionReplayMatches,
  readAllEvents,
  readClaimProjections,
  readCursor,
  readEvents,
  readIntegrityState,
  rebuildPublicClaimFts,
  redactEventContent,
  searchPublicClaims,
  writeClaim,
} from "./krater";
import {
  KraterOutboxBindingError,
  type KraterOutboxEnv,
  type OutboxFaultMode,
  plantKraterOutboxStaleWrapForHarness,
  requestKraterOutbox,
} from "./outbox-do";

interface KraterHarnessEnv extends KraterOutboxEnv {
  DB: D1Database;
  /**
   * The local harness capability. Declared only by wrangler.s2.toml,
   * wrangler.s2-legacy.toml, and wrangler.s2-upgrade.toml, which exist to run this file under
   * Wrangler on a developer machine; no deployed configuration defines it. Optional in the type
   * because its absence is the production case and must be handled, not assumed away.
   */
  S2_LOCAL_HARNESS?: string;
  /**
   * Per-local-worker correlation token injected by `scripts/e2e-s2-krater.sh` with Wrangler's
   * `--var`. It prevents this run from borrowing a stale listener and makes the static capability
   * insufficient by itself. It is not a same-UID secrecy boundary: local peers can inspect argv
   * and process environments. The loopback bind is the network boundary.
   */
  S2_HARNESS_TOKEN?: string;
  /** A non-secret, per-worker identifier returned only after token authentication. */
  S2_HARNESS_RUN_ID?: string;
  /**
   * The enrollment replay key the mounted production `createApp` session stack
   * needs to build its replay protector (without it `enrollmentStack` yields no
   * session router). It is secret-shaped local replay material, NOT a deployed
   * binding: `scripts/e2e-s2-krater.sh` generates a fresh 43-char base64url key
   * per run and injects it via Wrangler `--var`, exactly like the harness token,
   * so `wrangler.s2.toml` stays byte-identical and no key is ever checked in.
   */
  ENROLLMENT_REPLAY_KEY?: string;
}

/**
 * The real production Stoa app, built once. Under the S-2 harness (and only
 * there) `handleHarnessRequest` delegates every non-`/__s2/` path to it, so the
 * mounted promotion route runs against this run's real D1 and real
 * KraterOutboxDrainer DO. It is never the deployed entrypoint — `apps/wire/src/
 * index.ts` is — and the fall-through is gated on the local-only capability.
 */
const productionApp = createApp();

const S2_LOCAL_HARNESS_CAPABILITY = "enabled";
const HARNESS_PATH_PREFIX = "/__s2/";
const HARNESS_TOKEN_HEADER = "x-s2-harness-token";
const HARNESS_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const HARNESS_RUN_ID_PATTERN = /^[a-f0-9]{32}$/;
const HARNESS_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_ABORT_OBSERVATIONS = 64;
const UNSAFE_D1_SEQUENCE_LITERAL = "9007199254740993";
const S2_LATE_OUTBOX_ROLLBACK_TRIGGER = "s2_late_outbox_rollback";
const S2_UNARMED_LATE_OUTBOX_IDENTITY_TRIGGER = "s2_unarmed_late_outbox_identity";
const S2_LATE_OUTBOX_CLEANUP_MISSING_TRIGGER = "s2_late_outbox_cleanup_missing";
const S2_LATE_OUTBOX_ROLLBACK_ERROR = "S2_LATE_OUTBOX_ROLLBACK";
const S2_LOCAL_LATE_OUTBOX_ROLLBACK_CODE = "S2_LOCAL_LATE_OUTBOX_ROLLBACK";
const S2_LOCAL_LATE_OUTBOX_ROLLBACK_CLEANUP_FAILED_CODE =
  "S2_LOCAL_LATE_OUTBOX_ROLLBACK_CLEANUP_FAILED";

interface AbortBeforeCommitObservation {
  requestId: string;
  acceptedBeforeCommit: true;
  transactionEntered: false;
}

// This is deliberately process-local and bounded: it is a loopback-only harness witness, not
// a production audit log or a second write path. A test that times out before Worker acceptance
// cannot read an observation and therefore cannot pass the pre-commit abort negative.
const abortBeforeCommitObservations = new Map<string, AbortBeforeCommitObservation>();

function recordAbortBeforeCommitObservation(requestId: string): void {
  abortBeforeCommitObservations.set(requestId, {
    requestId,
    acceptedBeforeCommit: true,
    transactionEntered: false,
  });
  while (abortBeforeCommitObservations.size > MAX_ABORT_OBSERVATIONS) {
    const oldest = abortBeforeCommitObservations.keys().next().value;
    if (oldest === undefined) return;
    abortBeforeCommitObservations.delete(oldest);
  }
}

/**
 * Whether the harness surface exists at all in this environment.
 *
 * Hostname is not a security boundary: it is derived from the client-supplied Host header. The
 * dev server is bound to loopback by the shell harness, which excludes network peers. Every
 * `/__s2/` request also presents a per-run token so readiness and mutations cannot be borrowed
 * from a stale local listener. Same-UID local peers are explicitly outside that token boundary.
 * Deployed configurations omit the static capability entirely.
 */
function harnessEnabled(env: KraterHarnessEnv): boolean {
  return (
    env.S2_LOCAL_HARNESS === S2_LOCAL_HARNESS_CAPABILITY &&
    typeof env.S2_HARNESS_TOKEN === "string" &&
    HARNESS_TOKEN_PATTERN.test(env.S2_HARNESS_TOKEN) &&
    typeof env.S2_HARNESS_RUN_ID === "string" &&
    HARNESS_RUN_ID_PATTERN.test(env.S2_HARNESS_RUN_ID)
  );
}

function harnessRequestAuthorized(request: Request, env: KraterHarnessEnv): boolean {
  return harnessEnabled(env) && request.headers.get(HARNESS_TOKEN_HEADER) === env.S2_HARNESS_TOKEN;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function contractProblem(
  status: number,
  code: string,
  rule: string,
  detail: string,
  fixHint: string,
  example: Record<string, unknown>,
): Response {
  return new Response(
    JSON.stringify({
      type: `https://a.asimposium.org/problems/${code.toLowerCase()}`,
      title: "Krater contract error",
      status,
      detail,
      code,
      rule,
      fix_hint: fixHint,
      schema: "krater.v0.read",
      example,
    }),
    {
      status,
      headers: {
        "content-type": "application/problem+json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new KraterValidationError("request body must be an object.");
  return body;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new KraterValidationError(`${key} must be a string.`);
  return value;
}

function harnessRequestId(body: Record<string, unknown>): string {
  const value = requiredString(body, "s2_harness_request_id");
  if (!HARNESS_REQUEST_ID_PATTERN.test(value)) {
    throw new KraterValidationError("s2_harness_request_id must be a bounded harness identifier.");
  }
  return value;
}

function requiredNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new KraterValidationError(`${key} must be a finite number.`);
  }
  return value;
}

function competingWriteInput(body: Record<string, unknown>): KraterWriteInput | null {
  const candidate = body.s2_after_head_competing_write;
  if (candidate === undefined) return null;
  if (!isRecord(candidate)) {
    throw new KraterValidationError("s2_after_head_competing_write must be a Krater write object.");
  }
  return writeInput(candidate);
}

/**
 * LOCAL-ONLY HARNESS SURFACE — never mounted in `src/app.ts`, never reachable from a
 * deployed route, and refused outright unless the request arrived on loopback.
 *
 * S-2's bounded integrity replay refuses a legacy problem larger than
 * MAX_INTEGRITY_BACKFILL_EVENTS, and nothing could exercise that boundary: a legacy problem
 * is one whose events carry NULL digests, and after 0004 the `events_chain_head_before_insert`
 * trigger aborts exactly that insert — correctly, because production must never create one.
 * The only honest way to test the upgrade path is therefore to reconstruct, in a local
 * database, the state 0004 itself describes: 0001-shaped rows plus the `required` backfill
 * row that 0004's own INSERT creates for every pre-existing problem.
 *
 * The trigger is dropped and recreated **inside one D1 batch**, so either the whole legacy
 * fixture lands and the trigger is restored, or nothing changes. The recreated body is
 * copied verbatim from `db/migrations/0004_krater_integrity_v1.sql`; `s2-client.ts` asserts
 * afterwards that an ordinary write still succeeds, which fails loudly if the two ever drift.
 */
const LEGACY_PLANT_MAX_EVENTS = 2_048;
const LEGACY_PLANT_CHUNK_ROWS = 10;

const CHAIN_HEAD_TRIGGER = "events_chain_head_before_insert";

/**
 * The trigger's own definition, read back from the schema rather than copied.
 *
 * A hardcoded copy of 0004's trigger body would be a second source of truth: it would drift
 * the first time the migration changed, and the fixture would quietly restore a *different*
 * guard than the one production runs. Reading `sqlite_master` means the exact text that was
 * dropped is the exact text restored, and a missing trigger is a loud failure rather than a
 * silently weakened schema.
 */
async function chainHeadTriggerSql(db: D1Database): Promise<string> {
  const row = await db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
    .bind(CHAIN_HEAD_TRIGGER)
    .first<{ sql: string | null }>();
  const sql = row?.sql;
  if (typeof sql !== "string" || sql.length === 0) {
    throw new KraterValidationError(
      `${CHAIN_HEAD_TRIGGER} is absent; refusing to plant legacy state into an unguarded schema.`,
    );
  }
  return sql;
}

/**
 * Plant an exact legacy-0001 problem: `eventCount` contiguous claim envelopes with NULL
 * digests, a problem head at that cursor with no chain digest, and the `required` backfill
 * row. Deterministic: the same problem id and count always produce the same payload digests.
 */
async function plantLegacyProblemForHarness(
  db: D1Database,
  problemId: string,
  eventCount: number,
  createdAt: string,
  /**
   * Append undigested envelopes to a problem that already exists instead of creating one.
   *
   * This builds the case that separates a correct completeness check from a lazy one: a
   * problem whose log is *mostly* digested with an undigested envelope at the end. An
   * exhaustive `.every()` and a `LIMIT 1` existence probe must agree there, and only a
   * mixed log can tell them apart from an all-digested or all-NULL one.
   */
  append = false,
): Promise<{ planted: number; statements: number }> {
  if (!Number.isSafeInteger(eventCount) || eventCount < 1 || eventCount > LEGACY_PLANT_MAX_EVENTS) {
    throw new KraterValidationError(`event_count must be 1 through ${LEGACY_PLANT_MAX_EVENTS}.`);
  }

  // Read before dropping: the restore below uses the schema's own text, never a copy.
  const triggerSql = await chainHeadTriggerSql(db);

  // Appending starts after the log that is already there, so seq stays contiguous.
  let base = 0;
  if (append) {
    const head = await db
      .prepare("SELECT public_seq FROM problems WHERE id = ?")
      .bind(problemId)
      .first<{ public_seq: number }>();
    if (head === null) {
      throw new KraterValidationError(
        "cannot append legacy envelopes to a problem that is absent.",
      );
    }
    if (
      !Number.isSafeInteger(head.public_seq) ||
      head.public_seq < 0 ||
      head.public_seq > Number.MAX_SAFE_INTEGER - eventCount
    ) {
      throw new KraterValidationError(
        "legacy append refuses an inexact or exhausted persisted cursor.",
      );
    }
    base = head.public_seq;
  }

  const statements: D1PreparedStatement[] = [db.prepare(`DROP TRIGGER ${CHAIN_HEAD_TRIGGER}`)];
  statements.push(
    append
      ? db
          .prepare("UPDATE problems SET public_seq = ?, updated_at = ? WHERE id = ?")
          .bind(base + eventCount, createdAt, problemId)
      : db
          .prepare(
            `INSERT INTO problems (id, public_seq, created_at, updated_at)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(problemId, eventCount, createdAt, createdAt),
  );

  for (let start = 1; start <= eventCount; start += LEGACY_PLANT_CHUNK_ROWS) {
    const end = Math.min(start + LEGACY_PLANT_CHUNK_ROWS - 1, eventCount);
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (let offset = start; offset <= end; offset += 1) {
      const seq = base + offset;
      // A legacy row: every 0001 column present, both 0004 digest columns left NULL.
      tuples.push("(?, ?, ?, 'claim.created', 'claim', ?, 1, ?, ?)");
      values.push(
        `E-${problemId}-${String(seq).padStart(5, "0")}`,
        problemId,
        seq,
        `C-${problemId}-${String(seq).padStart(5, "0")}`,
        // Deterministic 64-hex stand-in for a payload digest the legacy writer stored.
        `${String(seq).padStart(4, "0")}`.repeat(16),
        createdAt,
      );
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO events
             (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256, created_at)
           VALUES ${tuples.join(", ")}`,
        )
        .bind(...values),
    );
  }

  statements.push(
    db
      .prepare(
        // Appending leaves the existing row untouched: the point of that mode is a problem
        // still marked complete whose log has stopped being fully digested.
        `INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at)
         VALUES (?, 'required', ?, NULL)
         ON CONFLICT(problem_id) DO NOTHING`,
      )
      .bind(problemId, base + eventCount),
    db.prepare(triggerSql),
  );

  await db.batch(statements);

  // The guard must be back before this route answers: a fixture that leaves the schema
  // unprotected would make every later scenario in the run meaningless.
  await chainHeadTriggerSql(db);
  return { planted: eventCount, statements: statements.length };
}

function writeInput(body: Record<string, unknown>): KraterWriteInput {
  return {
    problemId: requiredString(body, "problem_id"),
    claimId: requiredString(body, "claim_id"),
    eventId: requiredString(body, "event_id"),
    idempotencyKey: requiredString(body, "idempotency_key"),
    statement: requiredString(body, "statement"),
    createdAt: requiredString(body, "created_at"),
  };
}

function errorResponse(error: unknown, surface: "read" | "write"): Response {
  if (error instanceof KraterProblemNotFoundError) return response({ code: error.code }, 404);
  if (error instanceof KraterIdempotencyConflictError) return response({ code: error.code }, 409);
  if (error instanceof KraterReplayError) return response({ code: error.code }, 409);
  if (error instanceof KraterSequenceExhaustedError) return response({ code: error.code }, 409);
  if (error instanceof KraterIntegrityBackfillRequiredError) {
    return contractProblem(
      409,
      error.code,
      "K-S2-INTEGRITY",
      "Legacy event envelopes require bounded cryptographic replay before integrity-protected reads or writes.",
      "Run the bounded integrity backfill for this problem, or use the future range-aware operator path.",
      { route: "/__s2/integrity/backfill", problem_id: "P-example" },
    );
  }
  if (error instanceof KraterOutboxBindingError) {
    return contractProblem(
      503,
      error.code,
      "K-S2-OUTBOX",
      "The Worker has no mounted Krater outbox binding.",
      "Mount the exported class and bind KRATER_OUTBOX before enabling outbox draining.",
      { binding: "KRATER_OUTBOX", class_name: "KraterOutboxDrainer" },
    );
  }
  if (error instanceof KraterReadError || surface === "read") {
    return contractProblem(
      400,
      "KRATER_READ_INVALID",
      "K-S2-READ",
      "The read request could not be interpreted without exposing storage details.",
      "Use bounded cursor values and plain FTS terms or valid FTS5 operators.",
      { route: "/__s2/search", query: "synthetic", limit: 10 },
    );
  }
  if (error instanceof KraterValidationError) return response({ code: error.code }, 400);
  return response({ code: "KRATER_WRITE_FAILED" }, 409);
}

function queryInteger(url: URL, key: string, fallback: number): number {
  const value = url.searchParams.get(key);
  if (value === null) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new KraterValidationError(`${key} must be a canonical nonnegative integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new KraterValidationError(`${key} must be a safe integer.`);
  }
  return parsed;
}

function queryString(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (value === null) throw new KraterValidationError(`${key} is required.`);
  return value;
}

function queryOptionalString(url: URL, key: string): string | undefined {
  return url.searchParams.get(key) ?? undefined;
}

function replayProjection(projection: ClaimProjection): Record<string, unknown> {
  return {
    claim_id: projection.claimId,
    source_seq: projection.sourceSeq,
    build_digest: projection.buildDigest,
    stale: projection.stale,
  };
}

function harnessDelay(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 500) {
    throw new KraterValidationError(`${key} must be an integer through 500.`);
  }
  return value as number;
}

function harnessBoolean(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new KraterValidationError(`${key} must be a boolean.`);
  return value;
}

/**
 * This is deliberately narrower than the generic D1 face. The fixed marker is
 * emitted only by the local trigger below; a coincidental longer token must
 * not certify the late-outbox fault.
 */
function isLateOutboxRollbackFailure(error: unknown): boolean {
  return error instanceof Error && /\bS2_LATE_OUTBOX_ROLLBACK\b/.test(error.message);
}

/**
 * The local harness must never let a cleanup error escape a `finally` and replace a
 * classified write failure. For the causal cleanup plant, the first DROP is deliberately
 * aimed at a missing local name; the following target DROP proves the real trigger is
 * still removed. No database error text crosses this local response boundary.
 */
async function cleanupHarnessTrigger(
  db: D1Database,
  triggerName: string,
  plantDropFailure = false,
): Promise<boolean> {
  let cleanupFailed = false;
  if (plantDropFailure) {
    try {
      await db.prepare(`DROP TRIGGER ${S2_LATE_OUTBOX_CLEANUP_MISSING_TRIGGER}`).run();
    } catch (_error) {
      cleanupFailed = true;
    }
  }
  try {
    await db.prepare(`DROP TRIGGER ${triggerName}`).run();
  } catch (_error) {
    cleanupFailed = true;
    try {
      await db.prepare(`DROP TRIGGER IF EXISTS ${triggerName}`).run();
    } catch (_recoveryError) {
      // The caller refuses the local success witness below. Its next ordinary write
      // is the causal residue probe, without exposing the engine's error text.
    }
  }
  return cleanupFailed;
}

function harnessSeedSequence(body: Record<string, unknown>): number | "unsafe-persisted" | null {
  const value = body.s2_seed_public_seq;
  const unsafePersisted = body.s2_seed_unsafe_persisted_sequence;
  if (unsafePersisted !== undefined && unsafePersisted !== true) {
    throw new KraterValidationError("s2_seed_unsafe_persisted_sequence must be true when present.");
  }
  if (value === undefined) return unsafePersisted === true ? "unsafe-persisted" : null;
  if (unsafePersisted === true || value !== Number.MAX_SAFE_INTEGER) {
    throw new KraterValidationError("s2_seed_public_seq may only plant Number.MAX_SAFE_INTEGER.");
  }
  return value;
}

/** Local-only malformed-row fixture: SQL, not a rounded JavaScript binding, persists 2^53 + 1. */
async function seedUnsafePersistedSequenceForHarness(
  db: D1Database,
  problemId: string,
  createdAt: string,
): Promise<void> {
  const eventId = `E-${problemId}-unsafe-sequence`;
  const claimId = `C-${problemId}-unsafe-sequence`;
  const chainDigest = "f".repeat(64);
  const results = await db.batch([
    db
      .prepare(
        `UPDATE problems SET public_seq = ${UNSAFE_D1_SEQUENCE_LITERAL}, chain_digest = ? WHERE id = ?`,
      )
      .bind(chainDigest, problemId),
    db
      .prepare(
        `INSERT INTO events
           (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256,
            row_digest, chain_digest, created_at)
         SELECT ?, p.id, p.public_seq, 'claim.created', 'claim', ?, 1, ?, ?, ?, ?
         FROM problems p WHERE p.id = ?`,
      )
      .bind(eventId, claimId, "e".repeat(64), "d".repeat(64), chainDigest, createdAt, problemId),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    throw new KraterValidationError("unsafe sequence fixture could not persist its exact D1 rows.");
  }
}

function outboxFaultMode(body: Record<string, unknown>): OutboxFaultMode {
  const value = body.fault_mode;
  if (value === undefined || value === "none") return "none";
  if (value === "fail-once" || value === "hold-before-ack") return value;
  throw new KraterValidationError("fault_mode must be none, fail-once, or hold-before-ack.");
}

async function forwardedOutboxResponse(
  env: KraterHarnessEnv,
  pathname: "/nudge" | "/drain-now" | "/status",
  faultMode: OutboxFaultMode = "none",
): Promise<Response> {
  const upstream = await requestKraterOutbox(env, pathname, { faultMode });
  return response(await upstream.json(), upstream.status);
}

function waitForHarnessDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function redactionReason(body: Record<string, unknown>): string {
  return requiredString(body, "reason");
}

/**
 * A local-only S-2 harness entrypoint. It is not wired into Stoa's production
 * router; scripts/e2e-s2-krater.sh starts this file directly under Wrangler so
 * the same `D1Database` implementation that backs Workers executes Krater.
 *
 * The static local capability is necessary but insufficient. Every route also requires the
 * correlation token supplied when this specific Worker starts. This check occurs before body
 * parsing and before D1 access; an absent or wrong token is intentionally indistinguishable
 * from an absent capability. This is a run-attribution guard, not authority over same-UID peers.
 */
async function handleHarnessRequest(
  request: Request,
  env: KraterHarnessEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  // Before parsing, before touching D1: without both the local capability and this worker's
  // per-run token the harness surface is not merely refused, it is absent. 404 rather than 403
  // so a deployed environment does not confirm that these paths mean anything.
  if (url.pathname.startsWith(HARNESS_PATH_PREFIX) && !harnessRequestAuthorized(request, env)) {
    return response({ code: "KRATER_HARNESS_DISABLED" }, 404);
  }
  let surface: "read" | "write" = "read";
  try {
    if (request.method === "GET" && url.pathname === "/__s2/ready") {
      // `harnessRequestAuthorized` above also established the validated run id. It is public
      // correlation data, not the bearer token: the shell compares it to its freshly generated
      // expected value to prove readiness belongs to this process rather than a stale listener.
      return response({ status: "ready", run_id: env.S2_HARNESS_RUN_ID });
    }

    if (request.method === "GET" && url.pathname === "/__s2/abort-observation") {
      const requestId = queryString(url, "request_id");
      if (!HARNESS_REQUEST_ID_PATTERN.test(requestId)) {
        throw new KraterValidationError("request_id must be a bounded harness identifier.");
      }
      const observation = abortBeforeCommitObservations.get(requestId);
      if (observation === undefined)
        return response({ code: "S2_ABORT_OBSERVATION_NOT_FOUND" }, 404);
      return response({
        request_id: observation.requestId,
        accepted_before_commit: observation.acceptedBeforeCommit,
        transaction_entered: observation.transactionEntered,
      });
    }

    // Token-gated. Reports the engine's chosen plan for the completeness probe that runs on
    // every write. The caller supplies a problem id and nothing else — the statement text
    // lives in krater.ts and is the same constant the probe itself executes, so this cannot
    // drift from the query it describes and offers no surface for caller-supplied SQL.
    if (request.method === "GET" && url.pathname === "/__s2/integrity/probe-plan") {
      const plan = await explainUndigestedEventProbe(env.DB, queryString(url, "problem_id"));
      return response(plan);
    }

    // Token-gated fixture route; see plantLegacyProblemForHarness.
    if (request.method === "POST" && url.pathname === "/__s2/legacy/plant") {
      surface = "write";
      const body = await readBody(request);
      const planted = await plantLegacyProblemForHarness(
        env.DB,
        requiredString(body, "problem_id"),
        requiredNumber(body, "event_count"),
        requiredString(body, "created_at"),
        body.append === true,
      );
      return response({ status: "planted", ...planted }, 201);
    }

    if (request.method === "POST" && url.pathname === "/__s2/seed") {
      surface = "write";
      const body = await readBody(request);
      const seededSequence = harnessSeedSequence(body);
      const problemId = requiredString(body, "problem_id");
      const createdAt = requiredString(body, "created_at");
      await ensureProblem(env.DB, problemId, createdAt);
      if (seededSequence === "unsafe-persisted") {
        await seedUnsafePersistedSequenceForHarness(env.DB, problemId, createdAt);
      } else if (seededSequence !== null) {
        await env.DB.prepare("UPDATE problems SET public_seq = ? WHERE id = ?")
          .bind(seededSequence, problemId)
          .run();
      }
      return response({ status: "seeded" }, 201);
    }

    // Token-gated, local-only. Produces the minimal real state a genuine
    // production promotion needs -- an authenticatable Fellow bearer, an
    // approved authority graph, and a seeded problem -- by driving the SAME
    // production EnrollmentService issuance the unit fixture uses
    // (mint -> claim -> approve -> poll), so D1 writes the exact
    // enrollment_records/proposals/grants/fellow_tokens graph
    // `authenticateCredential` requires. No enrollment SQL is hand-written here.
    // The caller then opens a session, pushes a workshop, and promotes through
    // the mounted production routes with the returned bearer, exercising the
    // real committed-promotion -> waitUntil nudge -> DO path.
    if (request.method === "POST" && url.pathname === "/__s2/seed-promotable") {
      surface = "write";
      const body = await readBody(request);
      const problemId = requiredString(body, "problem_id");
      const createdAt = requiredString(body, "created_at");
      // enrollment_fellows.name is COLLATE NOCASE UNIQUE (migration 0002), so a
      // hard-coded name would make the second mounted seed answer NAME_TAKEN. The
      // caller supplies a per-scenario name; validate it through the shared
      // FellowNameSchema (contracts-before-endpoints) so an out-of-policy name is
      // refused here rather than deep in issuance. The value is a public handle,
      // not a credential.
      const parsedFellowName = FellowNameSchema.safeParse(requiredString(body, "name"));
      if (!parsedFellowName.success) {
        throw new KraterValidationError("seed-promotable requires a schema-valid Fellow name.");
      }
      const fellowName = parsedFellowName.data;
      if (typeof env.ENROLLMENT_REPLAY_KEY !== "string") {
        throw new KraterValidationError(
          "seed-promotable requires the per-run ENROLLMENT_REPLAY_KEY --var.",
        );
      }
      const service = new EnrollmentService({
        stoaOrigin: "https://a.asimposium.org",
        agoraOrigin: "https://asimposium.org",
        store: new D1EnrollmentStore(env.DB),
        replayProtector: enrollmentReplayProtectorFromBase64Url(env.ENROLLMENT_REPLAY_KEY),
      });
      const enrollmentRouter = createEnrollmentRouter({ service });
      const sponsor = { type: "sponsor", sponsorId: "usr_s2harnesssponsor1" } as const;
      const minted = await service.mint(sponsor, {
        requested_scopes: ["promote", "review"],
        problem_binding: problemId,
      });
      const registration = await enrollmentRouter.fetch(
        new Request("https://a.asimposium.org/v1/fellows", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `s2-seed-claim-${minted.enrollmentId}`,
          },
          body: JSON.stringify({
            enrollment_id: minted.enrollmentId,
            secret: minted.secret,
            name: fellowName,
            model: "test-model",
            harness: "test-harness",
          }),
        }),
      );
      // Proof-hardening: a false-positive harness is worse than none. Do not
      // accept field presence alone -- require the exact issuance status codes,
      // then parse each response with the SHARED strict enrollment contracts
      // (contracts-before-endpoints), which also validate hello_url and
      // suggested_next. A wrong status or a shape the contract rejects is
      // refused. Errors are generic: the secret-shaped values are never
      // reflected (Fable §14.3 never-log).
      if (registration.status !== 202) {
        throw new KraterValidationError(
          `seed-promotable claim returned ${registration.status}, expected 202.`,
        );
      }
      const parsedClaim = EnrollmentClaimResponseSchema.safeParse(await registration.json());
      if (!parsedClaim.success) {
        throw new KraterValidationError(
          "seed-promotable claim response did not match the enrollment claim contract.",
        );
      }
      const flowHandle = parsedClaim.data.flow_handle;
      await service.decide(sponsor, minted.enrollmentId, {
        enrollment_id: minted.enrollmentId,
        decision: "approve",
        step_up_authenticated_at: Math.floor(Date.now() / 1_000),
      });
      const issued = await enrollmentRouter.fetch(
        new Request("https://a.asimposium.org/v1/device-token", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `s2-seed-token-${minted.enrollmentId}`,
          },
          body: JSON.stringify({ flow_handle: flowHandle }),
        }),
      );
      if (issued.status !== 200) {
        throw new KraterValidationError(
          `seed-promotable issuance returned ${issued.status}, expected 200.`,
        );
      }
      const parsedApproved = EnrollmentApprovedResponseSchema.safeParse(await issued.json());
      if (!parsedApproved.success) {
        throw new KraterValidationError(
          "seed-promotable issuance response did not match the approved-token contract.",
        );
      }
      const bearer = parsedApproved.data.token;
      // Problem integrity prerequisites for a real promote (chain head + backfill
      // complete) come from the same helper every harness write already uses.
      await ensureProblem(env.DB, problemId, createdAt);
      // Return only the bearer plus the seeded problem: the shell drives mounted
      // production POST /v1/sessions -> workshop -> promote with the bearer, so no
      // session/workshop invariant is duplicated here. The bearer is a transient
      // credential the caller consumes into shell memory; it must never be written
      // to retained evidence, and neither must the replay key.
      return response({ status: "seeded-promotable", problem_id: problemId, bearer }, 201);
    }

    if (request.method === "POST" && url.pathname === "/__s2/write") {
      surface = "write";
      const body = await readBody(request);
      const preCommitDelayMs = harnessDelay(body, "s2_pre_commit_delay_ms");
      const postCommitDelayMs = harnessDelay(body, "s2_post_commit_delay_ms");
      const abortBeforeCommit = harnessBoolean(body, "s2_abort_before_commit");
      const deferOutboxNudge = harnessBoolean(body, "s2_defer_outbox_nudge");
      const failOutboxNudge = harnessBoolean(body, "s2_fail_outbox_nudge");
      const forceLateOutboxRollback = harnessBoolean(body, "s2_force_late_outbox_rollback");
      const plantUnarmedLateOutboxIdentity = harnessBoolean(
        body,
        "s2_plant_unarmed_late_outbox_identity",
      );
      const plantArmedNonLateOutboxFailure = harnessBoolean(
        body,
        "s2_plant_armed_nonlate_outbox_failure",
      );
      const plantLateOutboxCleanupFailure = harnessBoolean(
        body,
        "s2_plant_late_outbox_cleanup_failure",
      );
      const competingInput = competingWriteInput(body);
      if (abortBeforeCommit) recordAbortBeforeCommitObservation(harnessRequestId(body));
      if (preCommitDelayMs > 0) await waitForHarnessDelay(preCommitDelayMs);
      if (abortBeforeCommit || request.signal.aborted) {
        return contractProblem(
          499,
          "KRATER_REQUEST_ABORTED",
          "K-S2-IDEMPOTENCY",
          "The local harness did not enter its write transaction after the pre-commit abort boundary.",
          "Retry the same idempotency key after reconnecting.",
          { idempotency_key: "IK-example" },
        );
      }
      const input = writeInput(body);
      if (plantUnarmedLateOutboxIdentity && forceLateOutboxRollback) {
        throw new KraterValidationError(
          "s2_plant_unarmed_late_outbox_identity cannot also force the late-outbox trigger.",
        );
      }
      if (plantArmedNonLateOutboxFailure && !forceLateOutboxRollback) {
        throw new KraterValidationError(
          "s2_plant_armed_nonlate_outbox_failure requires s2_force_late_outbox_rollback.",
        );
      }
      if (plantLateOutboxCleanupFailure && !forceLateOutboxRollback) {
        throw new KraterValidationError(
          "s2_plant_late_outbox_cleanup_failure requires s2_force_late_outbox_rollback.",
        );
      }
      if (competingInput !== null && competingInput.problemId !== input.problemId) {
        throw new KraterValidationError(
          "s2_after_head_competing_write must target the same problem as the outer write.",
        );
      }
      let competingWriteCompleted = false;
      let lateOutboxRollbackArmed = false;
      let unarmedLateOutboxIdentityArmed = false;
      let classifiedLateOutboxRollback = false;
      let writeFailed = false;
      let writeFailure: unknown;
      let cleanupFailed = false;
      // This D1 trigger is a local-only fault injection. It aborts at the outbox
      // statement, after event_content has been attempted in the same canonical
      // batch. FTS is intentionally asynchronous and is populated only when the
      // outbox drainer handles that row. The finally block removes only the trigger
      // this request created, so a failed transaction cannot contaminate later cases.
      let result: Awaited<ReturnType<typeof writeClaim>> | null = null;
      try {
        result = await writeClaim(
          env.DB,
          input,
          !forceLateOutboxRollback && !plantUnarmedLateOutboxIdentity && competingInput === null
            ? undefined
            : {
                afterReadHead: async () => {
                  if (!competingWriteCompleted && competingInput !== null) {
                    competingWriteCompleted = true;
                    await writeClaim(env.DB, competingInput);
                  }
                  if (plantUnarmedLateOutboxIdentity && !unarmedLateOutboxIdentityArmed) {
                    // Causal classifier negative: this is a real D1 abort with the
                    // expected marker, but the late-outbox trigger itself was never
                    // created. It must retain the generic failure face.
                    await env.DB.prepare(
                      `CREATE TRIGGER ${S2_UNARMED_LATE_OUTBOX_IDENTITY_TRIGGER}
                         BEFORE INSERT ON events
                         BEGIN SELECT RAISE(ABORT, '${S2_LATE_OUTBOX_ROLLBACK_ERROR}'); END`,
                    ).run();
                    unarmedLateOutboxIdentityArmed = true;
                  }
                  if (forceLateOutboxRollback && !lateOutboxRollbackArmed) {
                    const abortMessage = plantArmedNonLateOutboxFailure
                      ? "S2_UNRELATED_OUTBOX_ABORT"
                      : S2_LATE_OUTBOX_ROLLBACK_ERROR;
                    await env.DB.prepare(
                      `CREATE TRIGGER ${S2_LATE_OUTBOX_ROLLBACK_TRIGGER}
                         BEFORE INSERT ON outbox
                         BEGIN SELECT RAISE(ABORT, '${abortMessage}'); END`,
                    ).run();
                    lateOutboxRollbackArmed = true;
                  }
                },
              },
        );
      } catch (error) {
        // This fixed response is a local harness witness, not a public D1 error
        // mapping. Both facts are required: the exact outbox trigger completed
        // creation, and D1 returned that trigger's fixed abort marker. The two
        // causal plants below prove neither side may be broadened.
        if (lateOutboxRollbackArmed && isLateOutboxRollbackFailure(error)) {
          classifiedLateOutboxRollback = true;
        } else {
          writeFailed = true;
          writeFailure = error;
        }
      } finally {
        if (lateOutboxRollbackArmed) {
          cleanupFailed =
            (await cleanupHarnessTrigger(
              env.DB,
              S2_LATE_OUTBOX_ROLLBACK_TRIGGER,
              plantLateOutboxCleanupFailure,
            )) || cleanupFailed;
        }
        if (unarmedLateOutboxIdentityArmed) {
          cleanupFailed =
            (await cleanupHarnessTrigger(env.DB, S2_UNARMED_LATE_OUTBOX_IDENTITY_TRIGGER)) ||
            cleanupFailed;
        }
      }
      if (classifiedLateOutboxRollback) {
        if (cleanupFailed) {
          return response({ code: S2_LOCAL_LATE_OUTBOX_ROLLBACK_CLEANUP_FAILED_CODE }, 409);
        }
        return response({ code: S2_LOCAL_LATE_OUTBOX_ROLLBACK_CODE }, 409);
      }
      if (writeFailed) throw writeFailure;
      if (result === null) {
        throw new KraterValidationError("local S2 write completed without a result.");
      }
      let outboxHandoff: "armed" | "deferred" | "unavailable" = "deferred";
      if (!deferOutboxNudge) {
        if (failOutboxNudge) {
          outboxHandoff = "unavailable";
        } else {
          try {
            const handoff = await requestKraterOutbox(env, "/nudge");
            outboxHandoff = handoff.ok ? "armed" : "unavailable";
          } catch (_error) {
            // The D1 outbox row is durable; the scheduled reconcile can recover
            // this post-commit handoff without rerunning the canonical write.
            outboxHandoff = "unavailable";
          }
        }
      }
      if (postCommitDelayMs > 0) await waitForHarnessDelay(postCommitDelayMs);
      return response({
        event_id: result.eventId,
        seq: result.seq,
        idempotent: result.idempotent,
        pre_cursor: result.preCursor,
        post_cursor: result.postCursor,
        payload_sha256: result.payloadSha256,
        row_digest: result.rowDigest,
        build_digest: result.buildDigest,
        chain_digest: result.chainDigest,
        checkpoint_digest: result.checkpointDigest,
        write_phase_ms: result.writePhaseMs,
        // D1 exposes metadata only for the settled batch result. Rejected retry attempts have
        // no result/meta and are deliberately excluded from these successful-batch subtotals.
        successful_batch_rows_read: result.successfulBatchRowsRead,
        successful_batch_rows_written: result.successfulBatchRowsWritten,
        successful_batch_sql_ms: result.successfulBatchSqlMs,
        successful_batch_metric_scope: "settled-db.batch-only",
        failed_retry_batch_metrics: "excluded-d1-error-has-no-meta",
        // The completeness preflight runs before the write phase. Its own measured subtotal
        // keeps the bounded partial-index probe separate from the batch receipt.
        preflight_rows_read: result.preflight.rows_read,
        preflight_rows_written: result.preflight.rows_written,
        preflight_sql_ms: result.preflight.sql_ms,
        preflight_wall_ms: result.preflight.wall_ms,
        preflight_statements: result.preflight.statements,
        preflight_fast_path: result.preflight.upgraded_fast_path,
        write_claim_wall_ms: result.writeClaimWallMs,
        write_claim_wall_scope: "writeClaim-entry-to-return",
        lock_wait_ms: result.lockWaitMs,
        retry_count: result.retryCount,
        outbox_handoff: outboxHandoff,
        checkpoint_mode: "unsigned-v0",
      });
    }

    if (request.method === "GET" && url.pathname === "/__s2/cursor") {
      return response({ cursor: await readCursor(env.DB, queryString(url, "problem_id")) });
    }

    if (request.method === "GET" && url.pathname === "/__s2/events") {
      const afterSeq = queryInteger(url, "since", 0);
      const limit = queryInteger(url, "limit", 200);
      const events = await readEvents(env.DB, queryString(url, "problem_id"), afterSeq, limit);
      return response({
        events,
        next_cursor: events[events.length - 1]?.seq ?? afterSeq,
        has_more: events.length === limit,
      });
    }

    if (request.method === "GET" && url.pathname === "/__s2/projections") {
      const projections = await readClaimProjections(env.DB, queryString(url, "problem_id"));
      return response({ projections: projections.map(replayProjection) });
    }

    if (request.method === "POST" && url.pathname === "/__s2/replay") {
      const problemId = requiredString(await readBody(request), "problem_id");
      const [events, projections, cursor] = await Promise.all([
        readAllEvents(env.DB, problemId),
        readClaimProjections(env.DB, problemId),
        readCursor(env.DB, problemId),
      ]);
      return response({
        matches:
          projectionReplayMatches(events, projections) &&
          cursorMatchesEvents(cursor, events) &&
          (await eventChainMatches(events)),
        cursor,
        event_count: events.length,
      });
    }

    if (request.method === "POST" && url.pathname === "/__s2/integrity/backfill") {
      surface = "write";
      const body = await readBody(request);
      const backfill = await backfillKraterIntegrity(
        env.DB,
        requiredString(body, "problem_id"),
        requiredString(body, "completed_at"),
      );
      return response({
        status: "complete",
        checkpoint_mode: "unsigned-v0",
        backfill_rows_read: backfill.rows_read,
        backfill_rows_written: backfill.rows_written,
        backfill_sql_ms: backfill.sql_ms,
        backfill_wall_ms: backfill.wall_ms,
        backfill_statements: backfill.statements,
        backfill_fast_path: backfill.upgraded_fast_path,
      });
    }

    if (request.method === "GET" && url.pathname === "/__s2/search") {
      const matches = await searchPublicClaims(
        env.DB,
        queryString(url, "q"),
        queryInteger(url, "limit", 10),
      );
      return response({ matches });
    }

    if (request.method === "POST" && url.pathname === "/__s2/rebuild-fts") {
      surface = "write";
      await rebuildPublicClaimFts(env.DB, requiredString(await readBody(request), "problem_id"));
      return response({ status: "rebuilt" });
    }

    if (request.method === "POST" && url.pathname === "/__s2/redact-content") {
      surface = "write";
      const body = await readBody(request);
      await redactEventContent(
        env.DB,
        requiredString(body, "event_id"),
        redactionReason(body),
        requiredString(body, "redacted_at"),
      );
      return response({ status: "redacted" });
    }

    if (request.method === "POST" && url.pathname === "/__s2/tamper-envelope") {
      surface = "write";
      const body = await readBody(request);
      const operation = requiredString(body, "operation");
      if (operation !== "update" && operation !== "delete") {
        throw new KraterValidationError("operation must be update or delete.");
      }
      try {
        await attemptEnvelopeTamper(env.DB, requiredString(body, "event_id"), operation);
      } catch (_error) {
        return contractProblem(
          409,
          "EVENT_ENVELOPE_IMMUTABLE",
          "K-S2-APPEND-ONLY",
          "The local D1 trigger refused an event envelope mutation.",
          "Publish a superseding event; use the separate content-redaction lane only when authorized.",
          { route: "/__s2/write", idempotency_key: "IK-superseding-example" },
        );
      }
      return response({ code: "KRATER_TAMPER_UNEXPECTEDLY_SUCCEEDED" }, 500);
    }

    if (request.method === "POST" && url.pathname === "/__s2/outbox/nudge") {
      surface = "write";
      return forwardedOutboxResponse(env, "/nudge", outboxFaultMode(await readBody(request)));
    }

    if (request.method === "POST" && url.pathname === "/__s2/outbox/drain") {
      surface = "write";
      return forwardedOutboxResponse(env, "/drain-now", outboxFaultMode(await readBody(request)));
    }

    if (request.method === "GET" && url.pathname === "/__s2/outbox/status") {
      return forwardedOutboxResponse(env, "/status");
    }

    if (request.method === "POST" && url.pathname === "/__s2/outbox/plant-malformed") {
      surface = "write";
      const body = await readBody(request);
      await plantMalformedOutboxForHarness(env.DB, requiredString(body, "event_id"));
      return response({ status: "planted" }, 201);
    }

    if (request.method === "POST" && url.pathname === "/__s2/outbox/plant-stale-wrap") {
      surface = "write";
      const body = await readBody(request);
      const upstream = await plantKraterOutboxStaleWrapForHarness(
        env,
        requiredNumber(body, "scan_after_id"),
        requiredNumber(body, "scan_wrap_through_id"),
      );
      return response(await upstream.json(), upstream.status);
    }

    if (request.method === "GET" && url.pathname === "/__s2/state") {
      const problemId = queryString(url, "problem_id");
      const eventId = queryOptionalString(url, "event_id");
      const [cursor, counts, integrity, eventContentForEvent] = await Promise.all([
        readCursor(env.DB, problemId),
        inspectProblem(env.DB, problemId),
        readIntegrityState(env.DB, problemId),
        eventId === undefined
          ? Promise.resolve(undefined)
          : inspectEventContentByEventId(env.DB, eventId),
      ]);
      return response({
        cursor,
        counts,
        chain_digest: integrity.chainDigest,
        checkpoint_digest: integrity.checkpointDigest,
        checkpoint_mode: "unsigned-v0",
        ...(eventContentForEvent === undefined
          ? {}
          : { event_content_for_event: eventContentForEvent }),
      });
    }

    // Local-only production fall-through. Under the S-2 harness capability the
    // real Stoa app runs against this run's D1 and KRATER_OUTBOX DO, and the
    // outer ExecutionContext is forwarded so the mounted promotion route's
    // committed-write waitUntil nudge detaches for real (the very seam this
    // bead proves). Deployed configurations never set the capability, and
    // worker.ts is not the deployed entrypoint, so this is unreachable in
    // production. The env carries the exact bindings the session path reads --
    // DB, KRATER_OUTBOX, ENROLLMENT_REPLAY_KEY -- and nothing fabricates R2.
    if (!url.pathname.startsWith(HARNESS_PATH_PREFIX) && harnessEnabled(env)) {
      // Local-only, token-authenticated nudge-failure injection. Pre-setting a DO
      // fault mode cannot work: the production /nudge sends fault_mode:none and
      // overwrites any stored mode. Instead, for this one delegated request only,
      // run createApp with a KRATER_OUTBOX whose handle construction throws, so
      // the committed promotion's post-commit nudge fails while the real D1 write
      // still commits and returns 2xx. The stored DO state is never touched, so a
      // subsequent ordinary /__s2/outbox manual reconcile drains the pending row
      // through the real, untouched DO. This proves INJECTED-BINDING failure plus
      // real-D1/real-DO recovery -- not a real-DO nudge failure -- and the normal
      // leg below still delegates the untouched env so its nudge hits the real DO.
      if (
        harnessRequestAuthorized(request, env) &&
        request.headers.get("x-s2-nudge-binding-fail") === "1"
      ) {
        const brokenOutboxEnv = {
          ...env,
          KRATER_OUTBOX: {
            idFromName() {
              throw new Error("S2_INJECTED_NUDGE_BINDING_FAILURE");
            },
            get() {
              throw new Error("S2_INJECTED_NUDGE_BINDING_FAILURE");
            },
          },
        } as unknown as Env;
        return productionApp.fetch(request, brokenOutboxEnv, ctx);
      }
      return productionApp.fetch(request, env as unknown as Env, ctx);
    }
    return response({ code: "KRATER_HARNESS_ROUTE_NOT_FOUND" }, 404);
  } catch (error) {
    return errorResponse(error, surface);
  }
}

async function handleScheduledOutboxReconcile(
  _controller: unknown,
  env: KraterHarnessEnv,
  _context: ExecutionContext,
): Promise<void> {
  if (!harnessEnabled(env)) return;
  const result = await requestKraterOutbox(env, "/nudge");
  if (!result.ok) throw new Error("KRATER_OUTBOX_SCHEDULED_RECONCILE_FAILED");
}

export { KraterOutboxDrainer } from "./outbox-do";
export default { fetch: handleHarnessRequest, scheduled: handleScheduledOutboxReconcile };
