import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";
import type { ClaimProjection, KraterWriteInput } from "./krater";
import {
  attemptEnvelopeTamper,
  cursorMatchesEvents,
  ensureProblem,
  eventChainMatches,
  inspectProblem,
  KraterIdempotencyConflictError,
  KraterProblemNotFoundError,
  KraterReadError,
  KraterReplayError,
  KraterValidationError,
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

interface KraterHarnessEnv {
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
      });
    }

    return response({ code: "KRATER_HARNESS_ROUTE_NOT_FOUND" }, 404);
  } catch (error) {
    return errorResponse(error, surface);
  }
}

export default { fetch: handleHarnessRequest };
