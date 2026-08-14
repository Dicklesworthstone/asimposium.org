import { Hono } from "hono";

import { authenticateServiceEnvelopeRequest } from "./auth/http";
import { VerificationKeyring, type VerificationKeyRecord } from "./auth/keyring";
import { D1NonceStore } from "./auth/nonce";
import { D1EnrollmentStore } from "./enrollment/d1-store";
import { createEnrollmentRouter } from "./enrollment/router";
import {
  EnrollmentReplayConfigurationError,
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "./enrollment/service";
import type { Env } from "./env";
import { problem } from "./http/envelope";
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

let cached: { readonly cacheKey: string; readonly stack: EnrollmentStack } | undefined;

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
  const cacheKey = `${env.ENROLLMENT_REPLAY_KEY ?? ""} ${env.SERVICE_ENVELOPE_KEYS ?? ""}`;
  if (cached !== undefined && cached.cacheKey === cacheKey) return cached.stack;

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

  const stack: EnrollmentStack = {
    router: createEnrollmentRouter({
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
    }),
  };
  cached = { cacheKey, stack };
  return stack;
}

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/internal/health", (c) => handleHealth({ format: c.req.query("format"), env: c.env }));

  // Propylon owns /join/* and /v1/*. Everything else falls to the 404 face.
  app.use("*", async (c, next) => {
    const { pathname } = new URL(c.req.url);
    if (!pathname.startsWith("/join/") && !pathname.startsWith("/v1/")) {
      await next();
      return;
    }
    const stack = enrollmentStack(c.env);
    if (stack instanceof Response) return stack;
    return stack.router.fetch(c.req.raw, c.env);
  });

  app.notFound((c) =>
    problem({
      status: 404,
      code: "ROUTE_NOT_FOUND",
      title: "No such route",
      // The path is echoed so the caller can see what it actually asked for,
      // but never verbatim: an agent that put a credential in a URL must not
      // get it handed back (Fable §14.2).
      detail: `This Worker serves no route at ${redactPathname(new URL(c.req.url).pathname)}.`,
      fixHint:
        "GET /internal/health, the join capsule at /join/<id>, and the /v1 enrollment surface exist; the wider agent surface lands with the session and ledger workstreams.",
    }),
  );

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
