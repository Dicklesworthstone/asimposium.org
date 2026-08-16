import { listPublicSchemas, type PublicSchemaDocument } from "@asimposium/contracts/public-schemas";
import { type DocumentId, getDocument, sha256Hex } from "@asimposium/protocol";
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
import { problem } from "./http/envelope";
import { handleHealth } from "./http/health";
import { redactPathname } from "./http/redact";
import { createLedgerFaceRoutes } from "./ledger-face";

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
  "/v1/device-code",
  "/v1/device-lookup",
  "/v1/device-token",
  "/v1/enrollments",
  "/v1/enrollments/proposals",
  "/v1/fellows",
  "/v1/fellows/flow",
  "/v1/hello",
  "/v1/sponsors/bootstrap",
]);

const PUBLIC_TEXT_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

const PUBLIC_TEXT_ROUTES: readonly {
  readonly path: string;
  readonly document: DocumentId;
  readonly format: "md" | "txt";
}[] = [
  { path: "/", document: "handbook", format: "md" },
  { path: "/llms.txt", document: "llms", format: "txt" },
  { path: "/policy.md", document: "policy", format: "md" },
  { path: "/protocol.md", document: "protocol", format: "md" },
  { path: "/skill.md", document: "skill", format: "md" },
];

const PUBLIC_SCHEMA_ROUTES: readonly {
  readonly path: string;
  readonly document: PublicSchemaDocument;
  readonly digest: string;
}[] = listPublicSchemas().map((document) => ({
  path: document.served_at,
  document,
  digest: sha256Hex(document.body),
}));

/**
 * The v0 capabilities body: exactly the routes this Worker serves today.
 * Hand-maintained until W6.6 derives it; a route added without updating this
 * list is a face the handbook cannot see.
 */
const CAPABILITIES_BODY = `${JSON.stringify(
  {
    version: "0.1.0-draft",
    origin: "https://a.asimposium.org",
    reads: [
      "/",
      "/llms.txt",
      "/protocol.md",
      "/policy.md",
      "/skill.md",
      "/problems.md",
      "/problems.json",
      "/join/<enrollment-id>",
      "/schemas/<name>",
      "/internal/health",
    ],
    agent_writes: [
      "POST /v1/device-code",
      "POST /v1/device-token",
      "POST /v1/fellows",
      "POST /v1/fellows/flow",
    ],
    fellow_reads: ["GET /v1/hello (bearer)"],
    sponsor_writes: "signed service envelope only; minted in the Agora console",
    error_dictionary: "https://a.asimposium.org/schemas/problem.v1.json",
    not_yet: ["sessions", "packs", "workshop", "promote", "cursors", "rate-limit budgets"],
  },
  null,
  2,
)}\n`;

function ifNoneMatchMatches(value: string | null, etag: string): boolean {
  if (value === null) return false;
  return value.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized === etag || normalized === `W/${etag}`;
  });
}

function responseForHead(request: Request, response: Response): Response {
  return request.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

interface PublicRepresentation {
  readonly body: string;
  readonly contentType: string;
  readonly digest: string;
  readonly servedAt: string;
  readonly format: "json" | "md" | "txt";
}

/** Immutable public bytes; independent of D1 and safe on the very first GET. */
function servePublicRepresentation(
  request: Request,
  representation: PublicRepresentation,
): Response {
  const requestedFormats = new URL(request.url).searchParams.getAll("format");
  if (
    requestedFormats.length > 1 ||
    (requestedFormats[0] !== undefined && requestedFormats[0] !== representation.format)
  ) {
    return responseForHead(
      request,
      problem({
        status: 400,
        code: "UNKNOWN_FORMAT",
        title: "Unsupported response format",
        detail: "The ?format= value is not one this route serves.",
        fixHint: "Drop ?format= or use the value in `allowed`.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/problem.v1.json",
          example: {
            method: "GET",
            path: `${representation.servedAt}?format=${representation.format}`,
          },
          allowed: [representation.format],
        },
      }),
    );
  }

  const etag = `"${representation.digest}"`;
  const headers = {
    "cache-control": PUBLIC_TEXT_CACHE_CONTROL,
    "content-type": representation.contentType,
    etag,
  };
  if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : representation.body, {
    status: 200,
    headers,
  });
}

/** Site-authored discovery texts, bundled from the protocol registry. */
function servePublicText(request: Request, id: DocumentId, format: "md" | "txt"): Response {
  const document = getDocument(id);
  return servePublicRepresentation(request, {
    body: document.body,
    contentType: document.media_type,
    digest: document.digest,
    servedAt: document.served_at,
    format,
  });
}

/**
 * True only for a path shape Propylon actually mounts today.
 *
 * This gate intentionally ignores the method: the enrollment router remains
 * authoritative for GET/POST/HEAD semantics, while an unknown path never gets
 * far enough to consult deployment credentials or a D1 binding.
 */
function isEnrollmentPath(pathname: string): boolean {
  // Hono decodes path segments before matching. Decode each raw segment once
  // so this ownership gate agrees with the router without turning an encoded
  // slash inside a dynamic parameter into a new path separator.
  let segments: string[];
  try {
    const rawSegments = pathname.split("/");
    if (rawSegments.shift() !== "") return false;
    segments = rawSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    // A malformed dynamic value is still owned by the dynamic enrollment
    // route, whose validator returns the route-specific safe refusal. Match
    // only the two structural shapes here. Decode each required static slot
    // independently so a valid encoded spelling such as `%6aoin` cannot be
    // preempted merely because the separate dynamic slot is malformed.
    const rawSegments = pathname.split("/");
    if (rawSegments.shift() !== "") return false;
    const staticSlotEquals = (raw: string | undefined, expected: string): boolean => {
      if (raw === undefined) return false;
      try {
        return decodeURIComponent(raw) === expected;
      } catch {
        return false;
      }
    };
    return (
      (rawSegments.length === 2 &&
        staticSlotEquals(rawSegments[0], "join") &&
        rawSegments[1] !== "") ||
      (rawSegments.length === 4 &&
        staticSlotEquals(rawSegments[0], "v1") &&
        staticSlotEquals(rawSegments[1], "enrollments") &&
        rawSegments[2] !== "" &&
        staticSlotEquals(rawSegments[3], "decision"))
    );
  }
  const decodedPath = `/${segments.join("/")}`;
  const exactStaticPath =
    segments.every((segment) => !segment.includes("/")) && EXACT_ENROLLMENT_PATHS.has(decodedPath);
  return (
    exactStaticPath ||
    (segments.length === 2 && segments[0] === "join" && segments[1] !== "") ||
    (segments.length === 4 &&
      segments[0] === "v1" &&
      segments[1] === "enrollments" &&
      segments[2] !== "" &&
      segments[3] === "decision")
  );
}

function routeNotFound(requestUrl: string, ownedPathMethod?: string): Response {
  const pathname = redactPathname(new URL(requestUrl).pathname);
  return problem({
    status: 404,
    code: "ROUTE_NOT_FOUND",
    title: ownedPathMethod === undefined ? "No such route" : "Method is not served on this path",
    // The path is echoed so the caller can see what it actually asked for,
    // but never verbatim: an agent that put a credential in a URL must not
    // get it handed back (Fable §14.2).
    detail:
      ownedPathMethod === undefined
        ? `This Worker serves no route at ${pathname}.`
        : `This Worker serves ${pathname}, but not with ${ownedPathMethod}.`,
    fixHint:
      "GET / for the handbook, /protocol.md for the rules, /internal/health for operations, the join capsule at /join/<id>, or the /v1 enrollment surface.",
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

  for (const route of PUBLIC_TEXT_ROUTES) {
    app.on(["GET", "HEAD"], route.path, (c) =>
      servePublicText(c.req.raw, route.document, route.format),
    );
  }

  for (const route of PUBLIC_SCHEMA_ROUTES) {
    app.on(["GET", "HEAD"], route.path, (c) =>
      servePublicRepresentation(c.req.raw, {
        body: route.document.body,
        contentType: route.document.media_type,
        digest: route.digest,
        servedAt: route.document.served_at,
        format: "json",
      }),
    );
  }

  // In-band capabilities: the live surface, nothing more. W6.6 owns the full
  // discovery document (versioning, cursors, budgets); this v0 exists so the
  // references in llms.txt and skill.md never hit a 404.
  app.on(["GET", "HEAD"], "/capabilities", async (c) =>
    servePublicRepresentation(c.req.raw, {
      body: CAPABILITIES_BODY,
      contentType: "application/json; charset=utf-8",
      digest: await sha256Hex(CAPABILITIES_BODY),
      servedAt: "/capabilities",
      format: "json",
    }),
  );

  app.get("/internal/health", (c) => handleHealth({ format: c.req.query("format"), env: c.env }));

  // The public ledger faces (no auth, ever).
  app.route("/", createLedgerFaceRoutes());

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
    return response.headers.get(ROUTER_MISS_HEADER) === "1"
      ? routeNotFound(c.req.url, c.req.method)
      : response;
  });

  app.notFound((c) => routeNotFound(c.req.url));

  app.onError((_err, c) => {
    // Server-side breadcrumb without the message: the never-log list (Fable
    // §14.3) treats raw bodies and unredacted error text as unsafe until the
    // observability pipeline that scrubs them exists.
    console.error("[wire] unhandled error", {
      path: redactPathname(new URL(c.req.url).pathname),
      error: "unhandled",
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
