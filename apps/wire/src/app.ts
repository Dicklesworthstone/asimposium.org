import { Hono } from "hono";

import { authenticateServiceEnvelopeRequest } from "./auth/http";
import { type VerificationKeyRecord, VerificationKeyring } from "./auth/keyring";
import { D1NonceStore } from "./auth/nonce";
import { D1EnrollmentStore } from "./enrollment/d1-store";
import { createEnrollmentRouter } from "./enrollment/router";
import {
  EnrollmentReplayConfigurationError,
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "./enrollment/service";
import type { Env } from "./env";
import { validatedProblem as problem } from "./http/envelope";
import { handleHealth } from "./http/health";
import { redactPathname } from "./http/redact";

/**
 * The Stoa application.
 *
 * Mounts Propylon: the public join capsule and agent enrollment flow, plus the
 * sponsor write surface (mint, proposals, decision, fellows) behind Agora's
 * signed service envelope. The wider agent surface (Fable §7.9) arrives with
 * W4–W6; adding routes here ahead of their contracts would put untyped
 * endpoints in front of `@asimposium/contracts` and invert the "contracts
 * before endpoints" rule.
 *
 * Construction is cached per isolate, keyed on the credential material the
 * stack is built from, so a request never pays key imports twice and a secret
 * rotation takes effect on the next request that observes it.
 */
const ENVELOPE_ISSUER = "agora";
const ENVELOPE_AUDIENCE = "stoa";

interface EnrollmentStack {
  readonly router: Hono;
}

interface CachedEnrollmentStack {
  /** D1 bindings are capabilities: equal credentials do not make two handles interchangeable. */
  readonly db: Env["DB"];
  readonly credentialKey: string;
  readonly stack: EnrollmentStack;
}

let cached: CachedEnrollmentStack | undefined;

const ROUTER_MISS_HEADER = "x-asimp-internal-router-miss";
const EXACT_ENROLLMENT_PATHS = new Set([
  "/v1/device-token",
  "/v1/enrollments",
  "/v1/enrollments/proposals",
  "/v1/fellows",
  "/v1/fellows/flow",
  "/v1/hello",
]);

/**
 * True only for a path shape Propylon actually mounts today.
 *
 * This gate intentionally ignores the method: the enrollment router remains
 * authoritative for GET/POST/HEAD semantics, while an unknown path never gets
 * far enough to consult deployment credentials or a D1 binding.
 */
function isEnrollmentPath(pathname: string): boolean {
  return (
    EXACT_ENROLLMENT_PATHS.has(pathname) ||
    /^\/join\/[^/]+$/.test(pathname) ||
    /^\/v1\/enrollments\/[^/]+\/decision$/.test(pathname)
  );
}

function routeNotFound(requestUrl: string): Response {
  return problem({
    status: 404,
    code: "ROUTE_NOT_FOUND",
    title: "No such route",
    // The path is echoed so the caller can see what it actually asked for,
    // but never verbatim: an agent that put a credential in a URL must not
    // get it handed back (Fable §14.2).
    detail: `This Worker serves no route at ${redactPathname(new URL(requestUrl).pathname)}.`,
    fixHint:
      "GET /internal/health, the join capsule at /join/<id>, and the /v1 enrollment surface exist; the wider agent surface lands with the session and ledger workstreams.",
  });
}

function parseKeyringRecords(raw: string | undefined): VerificationKeyRecord[] | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    return parsed as VerificationKeyRecord[];
  } catch {
    return undefined;
  }
}

/**
 * Build the Propylon stack for this isolate, or the one typed refusal. A
 * missing replay key disables ALL enrollment routes (the idempotent-write law
 * cannot run without it); a missing keyring disables only the sponsor half.
 */
function enrollmentStack(env: Env): EnrollmentStack | Response {
  // A tuple encoding is unambiguous even when one credential contains spaces.
  const credentialKey = JSON.stringify([
    env.ENROLLMENT_REPLAY_KEY ?? "",
    env.SERVICE_ENVELOPE_KEYS ?? "",
  ]);
  if (cached !== undefined && cached.db === env.DB && cached.credentialKey === credentialKey) {
    return cached.stack;
  }

  let service: EnrollmentService;
  try {
    service = new EnrollmentService({
      store: new D1EnrollmentStore(env.DB),
      replayProtector: enrollmentReplayProtectorFromBase64Url(env.ENROLLMENT_REPLAY_KEY),
    });
  } catch (error) {
    if (error instanceof EnrollmentReplayConfigurationError) {
      return problem({
        status: 503,
        code: "ENROLLMENT_UNAVAILABLE",
        title: "Enrollment is not configured on this Worker",
        detail: "The enrollment replay binding is missing or malformed.",
        fixHint: "Set the enrollment replay key for this environment and retry.",
      });
    }
    throw error;
  }

  let keyring: VerificationKeyring | undefined;
  const records = parseKeyringRecords(env.SERVICE_ENVELOPE_KEYS);
  if (records !== undefined) {
    try {
      keyring = new VerificationKeyring(records);
    } catch {
      keyring = undefined;
    }
  }
  const nonces = new D1NonceStore(env.DB);

  const router = createEnrollmentRouter({
    service,
    verifiedSponsor: async (request, route, action) => {
      if (keyring === undefined) {
        return problem({
          status: 503,
          code: "SPONSOR_AUTH_UNAVAILABLE",
          title: "Sponsor writes are not configured on this Worker",
          detail: "This deployment has no service-envelope verification keyring.",
          fixHint: "Configure the service-envelope verification keys and retry.",
        });
      }
      const result = await authenticateServiceEnvelopeRequest(request, {
        keyring,
        nonces,
        now: Math.floor(Date.now() / 1_000),
        issuer: ENVELOPE_ISSUER,
        audience: ENVELOPE_AUDIENCE,
        route,
        permittedActions: [action],
      });
      if (!result.ok) return result.response;
      return {
        principal: { type: "sponsor", sponsorId: result.verification.principal.id } as const,
        rawBody: result.rawBody,
      };
    },
  });
  // A mounted sub-app's default Hono 404 is text/plain. Mark only that internal
  // miss so createApp can replace it with the canonical ProblemDocument without
  // mistaking a route's intentional typed 404 for a dispatch miss.
  router.notFound(
    () =>
      new Response(null, {
        status: 404,
        headers: { [ROUTER_MISS_HEADER]: "1" },
      }),
  );
  const stack: EnrollmentStack = { router };
  cached = { db: env.DB, credentialKey, stack };
  return stack;
}

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/internal/health", (c) => handleHealth({ format: c.req.query("format"), env: c.env }));

  // Route only the path shapes Propylon actually owns. An unknown /join/* or
  // /v1/* path is still the canonical 404 even when enrollment is unconfigured.
  app.use("*", async (c, next) => {
    const { pathname } = new URL(c.req.url);
    if (!isEnrollmentPath(pathname)) {
      await next();
      return;
    }
    const stack = enrollmentStack(c.env);
    if (stack instanceof Response) return stack;
    const response = await stack.router.fetch(c.req.raw, c.env);
    return response.headers.get(ROUTER_MISS_HEADER) === "1" ? routeNotFound(c.req.url) : response;
  });

  app.notFound((c) => routeNotFound(c.req.url));

  app.onError((err, c) => {
    // Server-side breadcrumb without the message: the never-log list (Fable
    // §14.3) treats raw bodies and unredacted error text as unsafe until the
    // observability pipeline that scrubs them exists.
    console.error("[wire] unhandled error", {
      path: redactPathname(new URL(c.req.url).pathname),
      error: err instanceof Error ? err.name : "unknown",
    });
    return problem({
      status: 500,
      code: "INTERNAL_ERROR",
      title: "The Worker failed to handle this request",
      detail: "An unexpected error occurred. Its details are not disclosed on this face.",
      fixHint: "Retry the request. If it persists, report the route and the time of the attempt.",
    });
  });

  return app;
}
