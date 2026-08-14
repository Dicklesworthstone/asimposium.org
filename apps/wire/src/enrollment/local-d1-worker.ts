import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";

import { D1EnrollmentStore } from "./d1-store.ts";
import { createEnrollmentRouter } from "./router.ts";
import {
  EnrollmentError,
  EnrollmentPersistenceError,
  EnrollmentReplayConfigurationError,
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "./service.ts";

interface LocalEnrollmentEnv {
  DB: D1Database;
  ENROLLMENT_REPLAY_KEY: string;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * The replay key is resolved once per isolate and cached against the binding
 * value, so a rotated binding rebuilds and an unchanged one does not re-derive a
 * key on every request. Bindings are only readable inside `fetch`, so "once" is
 * first-request-lazy rather than module-load.
 */
let cached: { readonly key: string; readonly service: EnrollmentService } | undefined;

/**
 * A missing or malformed `ENROLLMENT_REPLAY_KEY` must be a typed, safe refusal —
 * not an exception escaping `fetch` as a raw runtime 500. It is the same class of
 * failure as a replay row that will not decrypt: the service cannot complete the
 * request safely, and the caller must be told to retry with the same key rather
 * than to start a second enrollment.
 */
function resolveService(env: LocalEnrollmentEnv): EnrollmentService | Response {
  if (cached !== undefined && cached.key === env.ENROLLMENT_REPLAY_KEY) return cached.service;
  try {
    const service = new EnrollmentService({
      store: new D1EnrollmentStore(env.DB),
      replayProtector: enrollmentReplayProtectorFromBase64Url(env.ENROLLMENT_REPLAY_KEY),
    });
    cached = { key: env.ENROLLMENT_REPLAY_KEY, service };
    return service;
  } catch {
    // Deliberately swallows the cause: nothing about the key material, not even
    // its length or which check failed, belongs in a response body.
    return unavailable();
  }
}

/** The one operational refusal this harness emits. Carries no key and no ciphertext. */
function unavailable(): Response {
  return response({ code: "ENROLLMENT_UNAVAILABLE" }, 503);
}

/**
 * Map a thrown enrollment failure to a local status, preserving the codes the
 * S-1 contract depends on:
 *
 *  - a decrypt/JSON/config failure is operational — 503, never a 4xx that blames
 *    the client for a key the operator misconfigured;
 *  - a same-key/different-digest collision keeps its 409 and its exact code;
 *  - `WRONG_PRINCIPAL` keeps 403;
 *  - every other typed enrollment failure keeps its exact code at 400, which is
 *    what the local-D1 client asserts for a name collision;
 *  - an untyped throw is operational, not a client error.
 *
 * Only `code` is ever emitted. No ciphertext, no key, no digest, no raw message.
 */
function localFailure(error: unknown): Response {
  if (
    error instanceof EnrollmentReplayConfigurationError ||
    error instanceof EnrollmentPersistenceError
  ) {
    return unavailable();
  }
  if (error instanceof EnrollmentError) {
    if (error.code === "IDEMPOTENCY_CONFLICT") return response({ code: error.code }, 409);
    if (error.code === "WRONG_PRINCIPAL") return response({ code: error.code }, 403);
    return response({ code: error.code }, 400);
  }
  return unavailable();
}

async function localBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Local-D1-only S-1 harness entrypoint. It is intentionally not imported by
 * `src/index.ts` or the production app. Its two setup routes exist solely to
 * drive a real workerd D1 binding through the mountable enrollment router.
 */
export default {
  async fetch(
    request: Request,
    env: LocalEnrollmentEnv,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const resolved = resolveService(env);
    if (resolved instanceof Response) return resolved;
    const service = resolved;
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/__s1/mint") {
      const body = await localBody(request);
      if (body === undefined || typeof body.sponsor_id !== "string" || body.request === undefined) {
        return response({ code: "LOCAL_INPUT_INVALID" }, 400);
      }
      try {
        const minted = await service.mint(
          { type: "sponsor", sponsorId: body.sponsor_id },
          body.request as never,
          { idempotencyKey: request.headers.get("idempotency-key") ?? undefined },
        );
        return response(minted, 201);
      } catch (error) {
        return localFailure(error);
      }
    }

    if (request.method === "POST" && url.pathname === "/__s1/approve") {
      const body = await localBody(request);
      if (
        body === undefined ||
        typeof body.sponsor_id !== "string" ||
        typeof body.enrollment_id !== "string" ||
        (body.decision !== undefined &&
          (typeof body.decision !== "object" || body.decision === null))
      ) {
        return response({ code: "LOCAL_INPUT_INVALID" }, 400);
      }
      try {
        await service.decide(
          { type: "sponsor", sponsorId: body.sponsor_id },
          body.enrollment_id,
          (body.decision ?? { decision: "approve" }) as never,
          { idempotencyKey: request.headers.get("idempotency-key") ?? undefined },
        );
        return response({ status: "approved" });
      } catch (error) {
        return localFailure(error);
      }
    }

    if (request.method === "POST" && url.pathname === "/__s1/card") {
      const body = await localBody(request);
      if (
        body === undefined ||
        typeof body.sponsor_id !== "string" ||
        typeof body.enrollment_id !== "string"
      ) {
        return response({ code: "LOCAL_INPUT_INVALID" }, 400);
      }
      try {
        return response({
          card: await service.approvalCard(
            { type: "sponsor", sponsorId: body.sponsor_id },
            body.enrollment_id,
          ),
        });
      } catch (error) {
        return localFailure(error);
      }
    }

    return createEnrollmentRouter({ service }).fetch(request);
  },
};
