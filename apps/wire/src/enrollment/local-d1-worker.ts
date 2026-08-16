import {
  EnrollmentFlowHandleSchema,
  EnrollmentHelloResponseSchema,
  PENDING_PROPOSAL_TTL_MS,
} from "@asimposium/contracts";
import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";

import { createApp } from "../app.ts";
import { D1EnrollmentStore } from "./d1-store.ts";
import { createEnrollmentRouter } from "./router.ts";
import {
  DEVICE_CODE_TTL_MS,
  EnrollmentError,
  EnrollmentPersistenceError,
  EnrollmentReplayConfigurationError,
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "./service.ts";

interface LocalEnrollmentEnv {
  DB: D1Database;
  ENROLLMENT_REPLAY_KEY: string;
  /**
   * Trusted deployment binding for every URL emitted by the enrollment service.
   * Optional at this boundary so an absent local binding reaches the same
   * fail-closed operational response as a malformed one.
   */
  STOA_ORIGIN?: string;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * The service is resolved once per isolate and cached against every binding
 * identity that influences it. A rotated replay key, replaced D1 binding, or
 * changed trusted origin therefore rebuilds it; unchanged bindings do not
 * re-derive a key on every request. Bindings are only readable inside `fetch`,
 * so "once" is first-request-lazy rather than module-load.
 */
let cached:
  | {
      readonly db: D1Database;
      readonly key: string;
      readonly stoaOrigin: string | undefined;
      readonly service: EnrollmentService;
    }
  | undefined;
let localClockOffsetMs = 0;

/**
 * The exact public texts hello's `next_actions` name. S-1's first safe read has
 * to land on a real successful canonical read, so these two paths are served by
 * the **production** handler in `createApp()` — the same `servePublicText` route
 * table a deployed Worker uses — rather than a fixture body invented here. A
 * fixture would prove only that this harness can return 200.
 *
 * Everything else still goes to the local enrollment router and its adjustable
 * clock: `createApp()` builds its own enrollment stack from bindings this
 * harness does not supply, and routing enrollment through it would silently
 * discard the clock offsets the TTL proofs depend on.
 */
const PUBLIC_TEXT_PROOF_PATHS: readonly string[] = ["/protocol.md", "/skill.md"];

/**
 * Built once per isolate. Construction is binding-free; only the two paths above
 * are ever dispatched to it, and `servePublicText` reads no binding at all —
 * which is why passing this harness's narrower env through is sound rather than
 * merely convenient.
 */
let cachedPublicTextApp: ReturnType<typeof createApp> | undefined;

/**
 * This is deliberately duplicated from the production service's private
 * namespace. The local-only proof must query the exact durable poll-replay
 * row without turning the service's internal replay principal into a product
 * contract or adding an application route for it.
 */
const LOCAL_POLL_TERMINAL_REPLAY_PRINCIPAL_VERSION = "flow-terminal-v1";

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A missing or malformed `ENROLLMENT_REPLAY_KEY` must be a typed, safe refusal —
 * not an exception escaping `fetch` as a raw runtime 500. It is the same class of
 * failure as a replay row that will not decrypt: the service cannot complete the
 * request safely, and the caller must be told to retry with the same key rather
 * than to start a second enrollment.
 */
function resolveService(env: LocalEnrollmentEnv): EnrollmentService | Response {
  if (
    cached !== undefined &&
    cached.db === env.DB &&
    cached.key === env.ENROLLMENT_REPLAY_KEY &&
    cached.stoaOrigin === env.STOA_ORIGIN
  ) {
    return cached.service;
  }
  try {
    const service = new EnrollmentService({
      // No default: an absent binding must fail service construction rather
      // than emit a URL derived from this request or a canonical environment.
      stoaOrigin: env.STOA_ORIGIN ?? "",
      store: new D1EnrollmentStore(env.DB),
      replayProtector: enrollmentReplayProtectorFromBase64Url(env.ENROLLMENT_REPLAY_KEY),
      clock: { now: () => Date.now() + localClockOffsetMs },
    });
    cached = {
      db: env.DB,
      key: env.ENROLLMENT_REPLAY_KEY,
      stoaOrigin: env.STOA_ORIGIN,
      service,
    };
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
 *  - a device-start source limit keeps its production 429;
 *  - `WRONG_PRINCIPAL` and `STEP_UP_REQUIRED` keep 403;
 *  - typed rate limits keep 429, while every other typed enrollment failure
 *    keeps its exact code at 400, which the client asserts for a name collision;
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
    if (
      error.code === "DEVICE_START_RATE_LIMITED" ||
      error.code === "SPONSOR_ENROLLMENT_RATE_LIMITED"
    ) {
      return response({ code: error.code }, 429);
    }
    if (error.code === "WRONG_PRINCIPAL" || error.code === "STEP_UP_REQUIRED") {
      return response({ code: error.code }, 403);
    }
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
 * Local-only expected-value observation for the mounted `/v1/hello` proof.
 * It is bearer-gated and shares the production credential-binding lookup, but
 * it is not mounted by `src/index.ts` and must never be read as a public route.
 */
async function localHelloBinding(service: EnrollmentService, request: Request): Promise<Response> {
  const authorization = request.headers.get("authorization");
  const token = authorization?.match(/^Bearer ([A-Za-z0-9._-]{1,512})$/)?.[1];
  if (token === undefined) return response({ code: "LOCAL_INPUT_INVALID" }, 400);
  try {
    const binding = await service.credentialBinding(token);
    if (binding === undefined) return response({ code: "LOCAL_INPUT_INVALID" }, 400);
    return response(
      EnrollmentHelloResponseSchema.parse({
        fellow: {
          fellow_id: binding.fellowId,
          name: binding.name,
          model: binding.model,
          harness: binding.harness,
        },
        granted_scopes: binding.grantedScopes,
        granted_resources: {
          ...(binding.grantedResources.problemBinding === undefined
            ? {}
            : { problem_binding: binding.grantedResources.problemBinding }),
          ...(binding.grantedResources.firstDirective === undefined
            ? {}
            : { first_directive: binding.grantedResources.firstDirective }),
          ...(binding.grantedResources.eventBudget === undefined
            ? {}
            : { event_budget: binding.grantedResources.eventBudget }),
          ...(binding.grantedResources.artifactBudgetBytes === undefined
            ? {}
            : { artifact_budget_bytes: binding.grantedResources.artifactBudgetBytes }),
          ...(binding.grantedResources.fellowGrantExpiresAt === undefined
            ? {}
            : { fellow_grant_expires_at: binding.grantedResources.fellowGrantExpiresAt }),
        },
        next_actions: [],
      }),
    );
  } catch {
    return unavailable();
  }
}

/**
 * Local-D1-only S-1 harness entrypoint. It is intentionally not imported by
 * `src/index.ts` or the production app. Its local setup and proof routes exist solely to
 * drive a real workerd D1 binding through the mountable enrollment router.
 */
export default {
  async fetch(
    request: Request,
    env: LocalEnrollmentEnv,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Before the enrollment service is even resolved: these reads are free
    // (Rule A5) and must not inherit an enrollment misconfiguration's 503.
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      PUBLIC_TEXT_PROOF_PATHS.includes(url.pathname)
    ) {
      cachedPublicTextApp ??= createApp();
      return cachedPublicTextApp.fetch(request, env as never);
    }

    const resolved = resolveService(env);
    if (resolved instanceof Response) return resolved;
    const service = resolved;

    if (request.method === "GET" && url.pathname === "/__s1/local-only/hello-binding") {
      return localHelloBinding(service, request);
    }

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

    if (request.method === "GET" && url.pathname === "/__s1/device-counts") {
      try {
        const counts = await env.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM enrollment_records WHERE kind = 'device') AS device_records,
             (SELECT COUNT(*) FROM device_start_attempts) AS start_attempts,
             (SELECT COUNT(*) FROM enrollment_idempotency WHERE scope = 'device-start') AS start_replays`,
        ).first<{
          readonly device_records: number;
          readonly start_attempts: number;
          readonly start_replays: number;
        }>();
        if (
          counts === null ||
          !Number.isSafeInteger(counts.device_records) ||
          !Number.isSafeInteger(counts.start_attempts) ||
          !Number.isSafeInteger(counts.start_replays)
        ) {
          return unavailable();
        }
        return response(counts);
      } catch {
        return unavailable();
      }
    }

    if (request.method === "POST" && url.pathname === "/__s1/sponsor-enrollment-counts") {
      const body = await localBody(request);
      if (body === undefined || typeof body.sponsor_id !== "string") {
        return response({ code: "LOCAL_INPUT_INVALID" }, 400);
      }
      try {
        const counts = await env.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM enrollment_records
               WHERE sponsor_id = ? AND kind = 'join-url') AS join_attempts,
             (SELECT COUNT(*) FROM sponsor_device_enrollment_attempts
               WHERE sponsor_id = ?) AS device_attempts`,
        )
          .bind(body.sponsor_id, body.sponsor_id)
          .first<{ readonly join_attempts: number; readonly device_attempts: number }>();
        if (
          counts === null ||
          !Number.isSafeInteger(counts.join_attempts) ||
          !Number.isSafeInteger(counts.device_attempts) ||
          counts.join_attempts < 0 ||
          counts.device_attempts < 0
        ) {
          return unavailable();
        }
        return response(counts);
      } catch {
        return unavailable();
      }
    }

    if (request.method === "POST" && url.pathname === "/__s1/advance-device-ttl") {
      const body = await localBody(request);
      if (body === undefined || Object.keys(body).length !== 0 || localClockOffsetMs !== 0) {
        return response({ code: "LOCAL_INPUT_INVALID" }, 400);
      }
      // Test-only deterministic expiry: move exactly one device-code TTL and
      // disclose neither the wall clock nor any enrollment identifier.
      localClockOffsetMs = DEVICE_CODE_TTL_MS;
      return response({ advanced: true });
    }

    if (request.method === "POST" && url.pathname === "/__s1/advance-proposal-ttl") {
      const body = await localBody(request);
      if (
        body === undefined ||
        Object.keys(body).length !== 0 ||
        localClockOffsetMs !== DEVICE_CODE_TTL_MS
      ) {
        return response({ code: "LOCAL_INPUT_INVALID" }, 400);
      }
      // The second and final clock transition proves that the device mapping's
      // short expiry did not rewrite the pending proposal's 24-hour lifetime.
      // The endpoint exposes no time, enrollment, handle, or database state.
      localClockOffsetMs = PENDING_PROPOSAL_TTL_MS;
      return response({ advanced: true });
    }

    if (request.method === "POST" && url.pathname === "/__s1/local-only/poll-terminal-proof") {
      const body = await localBody(request);
      const flowHandle = EnrollmentFlowHandleSchema.safeParse(body?.flow_handle);
      if (
        body === undefined ||
        !flowHandle.success ||
        typeof body.idempotency_key !== "string" ||
        body.idempotency_key.length < 1 ||
        body.idempotency_key.length > 128 ||
        Object.keys(body).length !== 2
      ) {
        return response({ code: "LOCAL_INPUT_INVALID" }, 400);
      }
      // The opaque flow handle is the capability gate: this narrow, local-only
      // direct-state observation accepts no enrollment/proposal id and exposes
      // neither replay ciphertext nor request material. It exists only to
      // establish the otherwise-unobservable D1 postcondition of the mounted
      // poll; it is not a public or product endpoint.
      try {
        const flowHandleHash = await sha256Hex(flowHandle.data);
        const proof = await env.DB.prepare(
          `SELECT p.status AS proposal_status,
                  (SELECT COUNT(*)
                     FROM enrollment_idempotency i
                    WHERE i.scope = 'poll'
                      AND i.principal_scope = ?
                      AND i.idempotency_key = ?) AS terminal_poll_replay_rows
             FROM enrollment_proposals p
            WHERE p.flow_handle_hash = ?`,
        )
          .bind(
            `${LOCAL_POLL_TERMINAL_REPLAY_PRINCIPAL_VERSION}:${flowHandleHash}`,
            body.idempotency_key,
            flowHandleHash,
          )
          .first<{
            readonly proposal_status: string;
            readonly terminal_poll_replay_rows: number;
          }>();
        if (
          proof === null ||
          !["pending", "approved", "reduced", "denied", "expired"].includes(
            proof.proposal_status,
          ) ||
          !Number.isSafeInteger(proof.terminal_poll_replay_rows) ||
          proof.terminal_poll_replay_rows < 0
        ) {
          return unavailable();
        }
        return response(proof);
      } catch {
        return unavailable();
      }
    }

    if (request.method === "POST" && url.pathname === "/__s1/approve") {
      const body = await localBody(request);
      if (
        body === undefined ||
        typeof body.sponsor_id !== "string" ||
        typeof body.enrollment_id !== "string" ||
        typeof body.decision !== "object" ||
        body.decision === null
      ) {
        return response({ code: "LOCAL_INPUT_INVALID" }, 400);
      }
      // The local client plays Agora here and must supply the complete signed
      // command, including its server-stamped step-up evidence. This Worker
      // never invents authentication evidence for a caller.
      const suppliedDecision = body.decision as Record<string, unknown>;
      try {
        await service.decide(
          { type: "sponsor", sponsorId: body.sponsor_id },
          body.enrollment_id,
          {
            enrollment_id: body.enrollment_id,
            ...suppliedDecision,
          } as never,
          { idempotencyKey: request.headers.get("idempotency-key") ?? undefined },
        );
        return response({ acknowledged: true });
      } catch (error) {
        return localFailure(error);
      }
    }

    if (request.method === "POST" && url.pathname === "/__s1/device-lookup") {
      const body = await localBody(request);
      if (
        body === undefined ||
        typeof body.sponsor_id !== "string" ||
        typeof body.user_code !== "string"
      ) {
        return response({ code: "LOCAL_INPUT_INVALID" }, 400);
      }
      try {
        return response({
          card: await service.deviceLookup(
            { type: "sponsor", sponsorId: body.sponsor_id },
            { user_code: body.user_code },
          ),
        });
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

// This alternate Wrangler entrypoint shares infra/wrangler.toml with the
// production Worker. Wrangler validates every configured Durable Object export
// even though the S-1 harness never calls the outbox binding.
export { KraterOutboxDrainer } from "../krater/outbox-do";
