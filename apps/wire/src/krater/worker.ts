import type { D1Database, D1PreparedStatement, ExecutionContext } from "@cloudflare/workers-types";
import type { ClaimProjection, KraterWriteInput } from "./krater";
import {
  attemptEnvelopeTamper,
  backfillKraterIntegrity,
  cursorMatchesEvents,
  ensureProblem,
  eventChainMatches,
  inspectProblem,
  KraterIdempotencyConflictError,
  KraterIntegrityBackfillRequiredError,
  KraterProblemNotFoundError,
  KraterReadError,
  KraterReplayError,
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
  requestKraterOutbox,
} from "./outbox-do";

interface KraterHarnessEnv extends KraterOutboxEnv {
  DB: D1Database;
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

function requiredNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new KraterValidationError(`${key} must be a finite number.`);
  }
  return value;
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

function assertLoopbackOnly(url: URL): void {
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") {
    throw new KraterValidationError("the legacy fixture route is loopback-only.");
  }
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
): Promise<{ planted: number; statements: number }> {
  if (!Number.isSafeInteger(eventCount) || eventCount < 1 || eventCount > LEGACY_PLANT_MAX_EVENTS) {
    throw new KraterValidationError(`event_count must be 1 through ${LEGACY_PLANT_MAX_EVENTS}.`);
  }

  // Read before dropping: the restore below uses the schema's own text, never a copy.
  const triggerSql = await chainHeadTriggerSql(db);

  const statements: D1PreparedStatement[] = [
    db.prepare(`DROP TRIGGER ${CHAIN_HEAD_TRIGGER}`),
    db
      .prepare(
        `INSERT INTO problems (id, public_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(problemId, eventCount, createdAt, createdAt),
  ];

  for (let start = 1; start <= eventCount; start += LEGACY_PLANT_CHUNK_ROWS) {
    const end = Math.min(start + LEGACY_PLANT_CHUNK_ROWS - 1, eventCount);
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (let seq = start; seq <= end; seq += 1) {
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
        `INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at)
         VALUES (?, 'required', ?, NULL)`,
      )
      .bind(problemId, eventCount),
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
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new KraterValidationError(`${key} must be an integer.`);
  return parsed;
}

function queryString(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (value === null) throw new KraterValidationError(`${key} is required.`);
  return value;
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
 */
async function handleHarnessRequest(
  request: Request,
  env: KraterHarnessEnv,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  let surface: "read" | "write" = "read";
  try {
    // Loopback-only fixture route; see plantLegacyProblemForHarness.
    if (request.method === "POST" && url.pathname === "/__s2/legacy/plant") {
      surface = "write";
      assertLoopbackOnly(url);
      const body = await readBody(request);
      const planted = await plantLegacyProblemForHarness(
        env.DB,
        requiredString(body, "problem_id"),
        requiredNumber(body, "event_count"),
        requiredString(body, "created_at"),
      );
      return response({ status: "planted", ...planted }, 201);
    }

    if (request.method === "POST" && url.pathname === "/__s2/seed") {
      surface = "write";
      const body = await readBody(request);
      await ensureProblem(
        env.DB,
        requiredString(body, "problem_id"),
        requiredString(body, "created_at"),
      );
      return response({ status: "seeded" }, 201);
    }

    if (request.method === "POST" && url.pathname === "/__s2/write") {
      surface = "write";
      const body = await readBody(request);
      const preCommitDelayMs = harnessDelay(body, "s2_pre_commit_delay_ms");
      const postCommitDelayMs = harnessDelay(body, "s2_post_commit_delay_ms");
      const abortBeforeCommit = harnessBoolean(body, "s2_abort_before_commit");
      const deferOutboxNudge = harnessBoolean(body, "s2_defer_outbox_nudge");
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
      const result = await writeClaim(env.DB, writeInput(body));
      let outboxHandoff: "armed" | "deferred" | "unavailable" = "deferred";
      if (!deferOutboxNudge) {
        try {
          const handoff = await requestKraterOutbox(env, "/nudge");
          outboxHandoff = handoff.ok ? "armed" : "unavailable";
        } catch (_error) {
          // The D1 outbox row is durable; a later scheduler nudge can recover
          // this post-commit handoff without rerunning the canonical write.
          outboxHandoff = "unavailable";
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
        transaction_ms: result.transactionMs,
        d1_rows_read: result.d1RowsRead,
        d1_rows_written: result.d1RowsWritten,
        d1_sql_ms: result.d1SqlMs,
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
      await backfillKraterIntegrity(
        env.DB,
        requiredString(body, "problem_id"),
        requiredString(body, "completed_at"),
      );
      return response({ status: "complete", checkpoint_mode: "unsigned-v0" });
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

    if (request.method === "GET" && url.pathname === "/__s2/state") {
      const problemId = queryString(url, "problem_id");
      const [cursor, counts, integrity] = await Promise.all([
        readCursor(env.DB, problemId),
        inspectProblem(env.DB, problemId),
        readIntegrityState(env.DB, problemId),
      ]);
      return response({
        cursor,
        counts,
        chain_digest: integrity.chainDigest,
        checkpoint_digest: integrity.checkpointDigest,
        checkpoint_mode: "unsigned-v0",
      });
    }

    return response({ code: "KRATER_HARNESS_ROUTE_NOT_FOUND" }, 404);
  } catch (error) {
    return errorResponse(error, surface);
  }
}

export { KraterOutboxDrainer } from "./outbox-do";
export default { fetch: handleHarnessRequest };
