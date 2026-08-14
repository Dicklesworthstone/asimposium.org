import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";
import type { ClaimProjection, KraterWriteInput } from "./krater";
import {
  ensureProblem,
  inspectProblem,
  KraterIdempotencyConflictError,
  KraterProblemNotFoundError,
  KraterReplayError,
  KraterValidationError,
  projectionReplayMatches,
  readClaimProjections,
  readCursor,
  readEvents,
  rebuildPublicClaimFts,
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

function errorResponse(error: unknown): Response {
  if (error instanceof KraterValidationError) return response({ code: error.code }, 400);
  if (error instanceof KraterProblemNotFoundError) return response({ code: error.code }, 404);
  if (error instanceof KraterIdempotencyConflictError) return response({ code: error.code }, 409);
  if (error instanceof KraterReplayError) return response({ code: error.code }, 409);
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

/**
 * A local-only S-2 harness entrypoint. It is not wired into Stoa's production
 * router; scripts/e2e-s2-krater.sh starts this file directly under Wrangler so
 * the same `D1Database` implementation that backs Workers executes Krater.
 */
export default {
  async fetch(request: Request, env: KraterHarnessEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/__s2/seed") {
        const body = await readBody(request);
        await ensureProblem(
          env.DB,
          requiredString(body, "problem_id"),
          requiredString(body, "created_at"),
        );
        return response({ status: "seeded" }, 201);
      }

      if (request.method === "POST" && url.pathname === "/__s2/write") {
        const result = await writeClaim(env.DB, writeInput(await readBody(request)));
        return response({
          event_id: result.eventId,
          seq: result.seq,
          idempotent: result.idempotent,
          payload_sha256: result.payloadSha256,
          transaction_ms: result.transactionMs,
          d1_rows_read: result.d1RowsRead,
          d1_rows_written: result.d1RowsWritten,
          d1_sql_ms: result.d1SqlMs,
          lock_wait_ms: result.lockWaitMs,
        });
      }

      if (request.method === "GET" && url.pathname === "/__s2/cursor") {
        return response({ cursor: await readCursor(env.DB, queryString(url, "problem_id")) });
      }

      if (request.method === "GET" && url.pathname === "/__s2/events") {
        const events = await readEvents(
          env.DB,
          queryString(url, "problem_id"),
          queryInteger(url, "since", 0),
          queryInteger(url, "limit", 200),
        );
        return response({ events });
      }

      if (request.method === "GET" && url.pathname === "/__s2/projections") {
        const projections = await readClaimProjections(env.DB, queryString(url, "problem_id"));
        return response({ projections: projections.map(replayProjection) });
      }

      if (request.method === "POST" && url.pathname === "/__s2/replay") {
        const problemId = requiredString(await readBody(request), "problem_id");
        const events = await readEvents(env.DB, problemId, 0, 200);
        const projections = await readClaimProjections(env.DB, problemId);
        return response({
          matches: projectionReplayMatches(events, projections),
          cursor: await readCursor(env.DB, problemId),
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
        await rebuildPublicClaimFts(env.DB, requiredString(await readBody(request), "problem_id"));
        return response({ status: "rebuilt" });
      }

      if (request.method === "GET" && url.pathname === "/__s2/state") {
        const problemId = queryString(url, "problem_id");
        return response({
          cursor: await readCursor(env.DB, problemId),
          counts: await inspectProblem(env.DB, problemId),
        });
      }

      return response({ code: "KRATER_HARNESS_ROUTE_NOT_FOUND" }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  },
};
