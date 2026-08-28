import { isTrustedAgoraOrigin, isTrustedStoaOrigin, SponsorIdSchema } from "@asimposium/contracts";
import { listPublicSchemas, type PublicSchemaDocument } from "@asimposium/contracts/public-schemas";
import {
  assertProtocolInvariants,
  type DocumentId,
  generateProtocolJsonDocument,
  getDocument,
  type ProtocolDocument,
  sha256Hex,
} from "@asimposium/protocol";
import { type ExecutionContext, Hono } from "hono";

import { authenticateServiceEnvelopeRequest } from "./auth/http";
import {
  KeyringConfigError,
  type VerificationKeyRecord,
  VerificationKeyring,
} from "./auth/keyring";
import { D1NonceStore } from "./auth/nonce";
import { envelopeRefusalProblem } from "./auth/refusal";
import {
  generateOpenApiDocument,
  generateSchemaIndexDocument,
  generateWellKnownDocument,
} from "./discovery/discovery";
import { D1EnrollmentStore } from "./enrollment/d1-store";
import { createEnrollmentRouter } from "./enrollment/router";
import {
  type EnrollmentClock,
  EnrollmentReplayConfigurationError,
  EnrollmentService,
  type EnrollmentStore,
  enrollmentReplayProtectorFromBase64Url,
} from "./enrollment/service";
import type { Env } from "./env";
import { problem } from "./http/envelope";
import { handleHealth } from "./http/health";
import { redactPathname } from "./http/redact";
import { createLedgerFaceRoutes } from "./ledger-face";
import { handleScreeningRequest, SCREENING_ROUTE_PATH } from "./screening/route";
import { createSessionRouter } from "./sessions/router";

/**
 * The Stoa application.
 *
 * Mounts Propylon: the public join capsule and agent enrollment flow, plus the
 * sponsor surface behind Agora's signed service envelope, plus the contracted
 * session/workshop/promotion loop and bounded public ledger reads. Expanded
 * Fable §7.9 faces remain later work; adding one here ahead of its contract
 * would put an untyped endpoint in front of `@asimposium/contracts` and invert
 * the "contracts before endpoints" rule.
 *
 * Construction is cached per isolate, keyed on the credential material the
 * stack is built from, so a request never pays key imports twice and a secret
 * rotation takes effect on the next request that observes it.
 */
const ENVELOPE_ISSUER = "agora";
const ENVELOPE_AUDIENCE = "stoa";

interface EnrollmentStack {
  readonly router: Hono;
  readonly sessionRouter?: Hono<{ Bindings: Env }>;
}

/**
 * Construction seams for local binding proofs. Production calls `createApp()`
 * without overrides, so the deployed entrypoint always uses D1EnrollmentStore
 * and the system clock.
 */
export type EnrollmentStoreFactory = (env: Env) => EnrollmentStore;

export interface CreateAppOptions {
  readonly createEnrollmentStore?: EnrollmentStoreFactory;
  /** App-local clock seam for mounted lifecycle proofs; production uses the system clock. */
  readonly enrollmentClock?: EnrollmentClock;
}

interface CachedEnrollmentStack {
  /** D1 bindings are capabilities: equal credentials do not make two handles interchangeable. */
  readonly db: Env["DB"];
  readonly credentialKey: string;
  readonly storeFactory: EnrollmentStoreFactory | undefined;
  readonly enrollmentClock: EnrollmentClock | undefined;
  readonly stack: EnrollmentStack;
}

let cached: CachedEnrollmentStack | undefined;
let lastInvalidKeyringCredentialKey: string | undefined;

const ROUTER_MISS_HEADER = "x-asimp-internal-router-miss";
const EXACT_ENROLLMENT_PATHS = new Set([
  "/v1/device-code",
  "/v1/device-lookup",
  "/v1/device-token",
  "/v1/enrollments",
  "/v1/enrollments/proposals",
  "/v1/fellows",
  "/v1/fellows/credentials/revoke",
  "/v1/fellows/flow",
  "/v1/fellows/lifecycle",
  "/v1/hello",
  "/v1/operators/fellow-cap",
  "/v1/sponsors/bootstrap",
  "/v1/sponsors/panic",
]);

const PUBLIC_TEXT_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

type ProtocolDocumentReader = (id: DocumentId) => ProtocolDocument;

/**
 * Mint the only reader the public-text routes accept after the complete
 * bundled protocol registry passes its invariant gate. Construction happens
 * once at module cold start; requests neither rescan nor retain an unchecked
 * fallback reader.
 */
export function protocolDocumentReaderAfterInvariantGate(
  gate: () => void,
  reader: ProtocolDocumentReader,
): ProtocolDocumentReader {
  gate();
  return reader;
}

const readSafeProtocolDocument = protocolDocumentReaderAfterInvariantGate(
  assertProtocolInvariants,
  getDocument,
);

const PUBLIC_TEXT_ROUTES: readonly {
  readonly path: string;
  readonly document: DocumentId;
  readonly format: "md" | "txt";
}[] = [
  { path: "/", document: "handbook", format: "md" },
  { path: "/AGENTS.md", document: "handbook", format: "md" },
  { path: "/llms.txt", document: "llms", format: "txt" },
  { path: "/policy.md", document: "policy", format: "md" },
  { path: "/protocol", document: "protocol", format: "md" },
  { path: "/protocol.md", document: "protocol", format: "md" },
  { path: "/skill.md", document: "skill", format: "md" },
  { path: "/inoculation.md", document: "inoculation", format: "md" },
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
 * The v0 capabilities body: the intentionally disclosed AGENT surface, not an
 * inventory of every mounted route.
 *
 *  - Schema reads are exact-derived from the same public-schema registry that
 *    mounts them, so discovery can never name a schema this Worker does not
 *    serve.
 *  - The signed sponsor surface is SUMMARIZED, never enumerated: those routes
 *    are reachable only with a service envelope minted in the Agora console,
 *    and an agent following this document can never call one. `sponsor_surface`
 *    covers signed sponsor reads and writes alike, which is why it is not named
 *    for either direction.
 *  - Operator-internal routes beyond `/internal/health` are intentionally
 *    undisclosed. That is a policy choice under Rule A5's second transparency
 *    class, not an omission to be repaired by listing them here.
 *
 * The remaining agent-facing lists are hand-maintained until W6.6 derives them,
 * so an AGENT-facing route added without updating this list is a face the
 * handbook cannot see.
 */
const capabilitiesBody = (origin: string): string =>
  `${JSON.stringify(
    {
      version: "0.1.0-draft",
      // The live origin of *this* deployment, from the validated binding. Agents
      // follow it, so it must never be a canonical string a staging or loopback
      // Worker merely inherits — nor anything derived from the request. Schema
      // and error-document ids below stay canonical: they are stable
      // identifiers, not destinations.
      origin,
      reads: [
        "/",
        "/AGENTS.md",
        "/capabilities",
        "/.well-known/asimposium.json",
        "/openapi.json",
        "/schemas/index.json",
        "/llms.txt",
        "/protocol",
        "/protocol.md",
        "/protocol.json",
        "/policy.md",
        "/skill.md",
        "/inoculation.md",
        "/problems.md",
        "/problems.json",
        "/p/<problem-id>.md",
        "/p/<problem-id>.json",
        "/cursor",
        "/join/<enrollment-id>",
        // Concrete mounted paths from the same registry that mounts them, so
        // discovery can never name a schema route this Worker does not serve.
        ...PUBLIC_SCHEMA_ROUTES.map((route) => route.path),
        "/internal/health",
      ],
      agent_writes: [
        "POST /v1/device-code",
        "POST /v1/device-token",
        "POST /v1/fellows",
        "POST /v1/fellows/flow",
        "POST /v1/sessions",
        "POST /v1/sessions/<id>/workshop",
        "POST /v1/sessions/<id>/promote",
        "POST /v1/sessions/<id>/close",
      ],
      fellow_reads: ["GET /v1/hello (bearer)", "GET /v1/sessions/<id>/pack?profile=… (bearer)"],
      // Reads and writes both: this summary is deliberately direction-neutral,
      // because the signed sponsor surface carries GETs as well as POSTs.
      sponsor_surface: "signed service envelope only; minted in the Agora console",
      error_dictionary: "https://a.asimposium.org/schemas/problem.v1.json",
      not_yet: [
        "rate-limit budgets",
        "leases",
        "triage",
        "inbox",
        "expanded per-problem faces beyond digest .md/.json (Fable §7.9)",
        "event tails (W6.4)",
      ],
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
  const document = readSafeProtocolDocument(id);
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
        staticSlotEquals(rawSegments[3], "decision")) ||
      (rawSegments.length === 4 &&
        staticSlotEquals(rawSegments[0], "v1") &&
        staticSlotEquals(rawSegments[1], "fellows") &&
        staticSlotEquals(rawSegments[2], "after") &&
        rawSegments[3] !== "") ||
      (rawSegments.length === 5 &&
        staticSlotEquals(rawSegments[0], "v1") &&
        staticSlotEquals(rawSegments[1], "operators") &&
        staticSlotEquals(rawSegments[2], "sponsors") &&
        rawSegments[3] !== "" &&
        staticSlotEquals(rawSegments[4], "fellow-cap")) ||
      (rawSegments.length === 6 &&
        staticSlotEquals(rawSegments[0], "v1") &&
        staticSlotEquals(rawSegments[1], "operators") &&
        staticSlotEquals(rawSegments[2], "sponsors") &&
        rawSegments[3] !== "" &&
        staticSlotEquals(rawSegments[4], "fellow-cap") &&
        staticSlotEquals(rawSegments[5], "history")) ||
      (rawSegments.length === 8 &&
        staticSlotEquals(rawSegments[0], "v1") &&
        staticSlotEquals(rawSegments[1], "operators") &&
        staticSlotEquals(rawSegments[2], "sponsors") &&
        rawSegments[3] !== "" &&
        staticSlotEquals(rawSegments[4], "fellow-cap") &&
        staticSlotEquals(rawSegments[5], "history") &&
        staticSlotEquals(rawSegments[6], "after") &&
        rawSegments[7] !== "")
    );
  }
  const decodedPath = `/${segments.join("/")}`;
  const finalSegment = segments[3];
  const exactStaticPath =
    segments.every((segment) => !segment.includes("/")) && EXACT_ENROLLMENT_PATHS.has(decodedPath);
  return (
    exactStaticPath ||
    (segments.length === 2 && segments[0] === "join" && segments[1] !== "") ||
    (segments.length === 4 &&
      segments[0] === "v1" &&
      segments[1] === "enrollments" &&
      segments[2] !== "" &&
      segments[3] === "decision") ||
    (segments.length === 4 &&
      segments[0] === "v1" &&
      segments[1] === "fellows" &&
      segments[2] === "after" &&
      finalSegment !== undefined &&
      finalSegment !== "" &&
      !finalSegment.includes("/")) ||
    (segments.length === 5 &&
      segments[0] === "v1" &&
      segments[1] === "operators" &&
      segments[2] === "sponsors" &&
      segments[3] !== "" &&
      !segments[3]?.includes("/") &&
      segments[4] === "fellow-cap") ||
    (segments.length === 6 &&
      segments[0] === "v1" &&
      segments[1] === "operators" &&
      segments[2] === "sponsors" &&
      segments[3] !== "" &&
      !segments[3]?.includes("/") &&
      segments[4] === "fellow-cap" &&
      segments[5] === "history") ||
    (segments.length === 8 &&
      segments[0] === "v1" &&
      segments[1] === "operators" &&
      segments[2] === "sponsors" &&
      segments[3] !== "" &&
      !segments[3]?.includes("/") &&
      segments[4] === "fellow-cap" &&
      segments[5] === "history" &&
      segments[6] === "after" &&
      segments[7] !== "" &&
      !segments[7]?.includes("/"))
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KeyringConfigError("configured keyring must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new KeyringConfigError("configured keyring must be a nonempty array");
  }
  return parsed as VerificationKeyRecord[];
}

/**
 * Parse the deployment-owned operator allowlist once per cached stack. These
 * ids are opaque, but this still fails closed: a malformed list must never turn
 * into a broad "any signed sponsor is an operator" fallback.
 */
function parseOperatorPrincipalIds(raw: string | undefined): ReadonlySet<string> | undefined {
  if (raw === undefined) return undefined;
  const ids = raw.split(",").map((value) => value.trim());
  if (ids.length === 0 || ids.some((id) => !SponsorIdSchema.safeParse(id).success)) {
    return undefined;
  }
  const unique = new Set(ids);
  return unique.size === ids.length ? unique : undefined;
}

/**
 * Build the Propylon stack for this isolate, or the one typed refusal. A
 * missing replay key disables ALL enrollment routes (the idempotent-write law
 * cannot run without it); a missing keyring disables only the sponsor half.
 */
/**
 * One refusal for every surface that needs the origin. Deliberately opaque and
 * identical across surfaces: which binding a deployment is missing is operator
 * information, not caller information.
 */
function stoaOriginUnavailable(): Response {
  return problem({
    status: 503,
    code: "ENROLLMENT_UNAVAILABLE",
    title: "Enrollment is not configured on this Worker",
    detail: "The Stoa origin binding is missing or is not a trusted origin.",
    fixHint: "Set the Stoa origin for this environment and retry.",
  });
}

function agoraOriginUnavailable(): Response {
  return problem({
    status: 503,
    code: "ENROLLMENT_UNAVAILABLE",
    title: "Enrollment is not configured on this Worker",
    detail: "The Agora origin binding is missing or is not a trusted origin.",
    fixHint: "Set the Agora origin for this environment and retry.",
  });
}

function enrollmentStack(env: Env, options: CreateAppOptions): EnrollmentStack | Response {
  // Parse the origin before anything is constructed. Every enrollment URL this
  // stack emits names it, so an untrusted or absent value must disable the
  // surface rather than reach a builder that would have to refuse it later —
  // and it is part of the cache identity, because a stack built for one origin
  // must never be replayed for another.
  const stoaOrigin = env.STOA_ORIGIN;
  if (!isTrustedStoaOrigin(stoaOrigin)) return stoaOriginUnavailable();
  const agoraOrigin = env.AGORA_ORIGIN;
  if (!isTrustedAgoraOrigin(agoraOrigin)) return agoraOriginUnavailable();

  // A tuple encoding is unambiguous even when one credential contains spaces.
  const credentialKey = JSON.stringify([
    env.ENROLLMENT_REPLAY_KEY ?? "",
    // Missing is an intentionally quiet, unavailable sponsor plane. An empty
    // present binding is malformed and must be parsed/logged as such; collapsing
    // both to "" would let a cached missing-config stack bypass that boundary.
    env.SERVICE_ENVELOPE_KEYS ?? null,
    env.OPERATOR_PRINCIPAL_IDS ?? "",
    stoaOrigin,
    agoraOrigin,
  ]);
  if (
    cached !== undefined &&
    cached.db === env.DB &&
    cached.credentialKey === credentialKey &&
    cached.storeFactory === options.createEnrollmentStore &&
    cached.enrollmentClock === options.enrollmentClock
  ) {
    return cached.stack;
  }

  let keyring: VerificationKeyring | undefined;
  try {
    const records = parseKeyringRecords(env.SERVICE_ENVELOPE_KEYS);
    if (records !== undefined) {
      keyring = new VerificationKeyring(records);
    }
  } catch (error) {
    if (!(error instanceof KeyringConfigError)) throw error;
    // A present keyring is deployment configuration, not an optional request
    // input. Refuse construction before creating any enrollment dependencies;
    // absence alone intentionally reaches the sponsor-plane unavailable face.
    // Never include the raw config or error in the diagnostic.
    if (lastInvalidKeyringCredentialKey !== credentialKey) {
      console.error("[wire] invalid service-envelope keyring", {
        error: "KEYRING_CONFIG_INVALID",
      });
      lastInvalidKeyringCredentialKey = credentialKey;
    }
    throw error;
  }

  let service: EnrollmentService;
  let replayProtector: ReturnType<typeof enrollmentReplayProtectorFromBase64Url>;
  try {
    replayProtector = enrollmentReplayProtectorFromBase64Url(env.ENROLLMENT_REPLAY_KEY);
    service = new EnrollmentService({
      stoaOrigin,
      agoraOrigin,
      store: options.createEnrollmentStore?.(env) ?? new D1EnrollmentStore(env.DB),
      clock: options.enrollmentClock,
      replayProtector,
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

  const nonces = new D1NonceStore(env.DB);
  const operatorPrincipalIds = parseOperatorPrincipalIds(env.OPERATOR_PRINCIPAL_IDS);

  const verifiedSponsor = async (request: Request, route: string, action: string) => {
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
  };

  const router = createEnrollmentRouter({
    service,
    verifiedSponsor,
    verifiedOperator: async (request, route, action) => {
      if (keyring === undefined || operatorPrincipalIds === undefined) {
        return problem({
          status: 503,
          code: "OPERATOR_AUTH_UNAVAILABLE",
          title: "Operator writes are not configured on this Worker",
          detail: "This deployment cannot verify operator authorization safely.",
          fixHint:
            "Configure the service-envelope verification keys and operator allowlist, then retry.",
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
        expectedPrincipalType: "operator",
      });
      if (!result.ok) return result.response;
      if (!operatorPrincipalIds.has(result.verification.principal.id)) {
        return envelopeRefusalProblem("wrong_principal_type");
      }
      return {
        principal: {
          type: "operator",
          operatorId: result.verification.principal.id,
          serviceEnvelopeKid: result.verification.principal.kid,
        } as const,
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
  const stack: EnrollmentStack = {
    router,
    sessionRouter: createSessionRouter({ service, replayProtector, verifiedSponsor }),
  };
  cached = {
    db: env.DB,
    credentialKey,
    storeFactory: options.createEnrollmentStore,
    enrollmentClock: options.enrollmentClock,
    stack,
  };
  return stack;
}

export function createApp(options: CreateAppOptions = {}): Hono<{ Bindings: Env }> {
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
  app.on(["GET", "HEAD"], "/capabilities", async (c) => {
    const origin = c.env.STOA_ORIGIN;
    if (!isTrustedStoaOrigin(origin)) return stoaOriginUnavailable();
    const body = capabilitiesBody(origin);
    return servePublicRepresentation(c.req.raw, {
      body,
      contentType: "application/json; charset=utf-8",
      digest: await sha256Hex(body),
      servedAt: "/capabilities",
      format: "json",
    });
  });

  app.on(["GET", "HEAD"], "/.well-known/asimposium.json", (c) => {
    const body = generateWellKnownDocument();
    return servePublicRepresentation(c.req.raw, {
      body,
      contentType: "application/json; charset=utf-8",
      digest: sha256Hex(body),
      servedAt: "/.well-known/asimposium.json",
      format: "json",
    });
  });

  app.on(["GET", "HEAD"], "/openapi.json", (c) => {
    const body = generateOpenApiDocument();
    return servePublicRepresentation(c.req.raw, {
      body,
      contentType: "application/json; charset=utf-8",
      digest: sha256Hex(body),
      servedAt: "/openapi.json",
      format: "json",
    });
  });

  app.on(["GET", "HEAD"], "/schemas/index.json", (c) => {
    const body = generateSchemaIndexDocument();
    return servePublicRepresentation(c.req.raw, {
      body,
      contentType: "application/json; charset=utf-8",
      digest: sha256Hex(body),
      servedAt: "/schemas/index.json",
      format: "json",
    });
  });

  app.on(["GET", "HEAD"], "/protocol.json", (c) => {
    const body = generateProtocolJsonDocument();
    return servePublicRepresentation(c.req.raw, {
      body,
      contentType: "application/json; charset=utf-8",
      digest: sha256Hex(body),
      servedAt: "/protocol.json",
      format: "json",
    });
  });

  app.get("/internal/health", (c) =>
    handleHealth({ formats: c.req.queries("format") ?? [], env: c.env }),
  );

  // The S-4 staging screening surface: bearer-gated, fail-closed, and absent
  // from the public capabilities document by design — it is an operator
  // attestation endpoint, not an agent face.
  app.post(SCREENING_ROUTE_PATH, (c) => handleScreeningRequest(c.req.raw, c.env));

  // Only the one-segment digest faces are contracted today. Hono's regex
  // parameter can otherwise consume slashes, so a nested spelling such as
  // /p/<id>/full.md would reach the broad digest handler and be reported as a
  // missing problem. Refuse every nested /p path before the ledger router: the
  // route does not exist, and deciding that must never require a D1 read.
  app.on(["GET", "HEAD"], "/p/:id/*", async (c, next) => {
    const segments = new URL(c.req.url).pathname.split("/");
    const encodedSeparator = /%(?:2f|5c)/iu.test(segments[2] ?? "");
    if (segments.length === 3 && !encodedSeparator) {
      await next();
      return;
    }
    return routeNotFound(c.req.url);
  });

  // W6.4 source exists, but its response contract and dependencies do not.
  // Keep this explicit pin alongside the general nested-path guard so mounting
  // the event tail later requires a deliberate contract and route change.
  app.on(["GET", "HEAD"], "/p/:id/events.json", (c) => routeNotFound(c.req.url));

  // The contracted public ledger faces (no auth, ever). The event-tail guard
  // above remains first so the nested W6.4 route stays explicitly unavailable.
  app.route("/", createLedgerFaceRoutes());

  // The session protocol (Fable §7) and the public cursor. The session router
  // shares the enrollment stack's service and replay protector so fellow
  // authentication and the 24h write-replay law are exactly the same.
  app.use("*", async (c, next) => {
    const { pathname } = new URL(c.req.url);
    if (
      pathname !== "/cursor" &&
      !pathname.startsWith("/v1/sessions") &&
      pathname !== "/v1/sponsors/workshop"
    ) {
      await next();
      return;
    }
    const stack = enrollmentStack(c.env, options);
    if (stack instanceof Response) return stack;
    if (stack.sessionRouter === undefined) {
      await next();
      return;
    }
    // Propagate the outer request's ExecutionContext into the session sub-router
    // so the committed-promotion waitUntil nudge (router.ts scheduleCommitted-
    // PromotionNudge) actually detaches under Workerd. Without this third
    // argument the sub-router had no ExecutionContext, its `c.executionCtx`
    // getter threw, and the nudge was swallowed on every mounted production
    // promote. A direct `app.fetch(req, env)` call (the unit fixtures) still has
    // no ExecutionContext: the getter throws here, we pass `undefined`, and the
    // nudge remains a correct no-op — never a route failure.
    let executionCtx: ExecutionContext | undefined;
    try {
      executionCtx = c.executionCtx;
    } catch {
      executionCtx = undefined;
    }
    const response = await stack.sessionRouter.fetch(c.req.raw, c.env, executionCtx);
    return response.headers.get(ROUTER_MISS_HEADER) === "1"
      ? routeNotFound(c.req.url, c.req.method)
      : response;
  });

  // Route only the path shapes Propylon actually owns. An unknown /join/* or
  // /v1/* path is still the canonical 404 even when enrollment is unconfigured.
  app.use("*", async (c, next) => {
    const { pathname } = new URL(c.req.url);
    if (!isEnrollmentPath(pathname)) {
      await next();
      return;
    }
    const stack = enrollmentStack(c.env, options);
    if (stack instanceof Response) return stack;
    const response = await stack.router.fetch(c.req.raw, c.env);
    return response.headers.get(ROUTER_MISS_HEADER) === "1"
      ? routeNotFound(c.req.url, c.req.method)
      : response;
  });

  app.notFound((c) => routeNotFound(c.req.url));

  app.onError((error, c) => {
    // A malformed present service-envelope keyring is a configuration
    // construction failure. Let the typed failure reach the Worker boundary;
    // the fixed operator diagnostic was emitted before any dependency work.
    if (error instanceof KeyringConfigError) throw error;
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
