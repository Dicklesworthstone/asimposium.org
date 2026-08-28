/**
 * Discovery document generators (W1.6 / bead asimposiumorg-0et.1).
 *
 * Three artifacts are produced here, all PURE and DETERMINISTIC:
 *
 *   1. generateSchemaIndexDocument() — mirror of @asimposium/contracts'
 *      public-schema registry (the same source that mounts
 *      /schemas/*.v1.json), so an index entry cannot name a schema this
 *      Worker does not serve.
 *
 *   2. generateWellKnownDocument() — canonical origins, format list, auth
 *      pointers, served-text digests, and the measured protocol-rules word
 *      budget.
 *
 *   3. generateOpenApiDocument() — an OpenAPI 3.1 projection of the
 *      DISCLOSED_OPERATIONS manifest below.
 *
 * Why a DECLARED manifest instead of Hono reflection: the production router
 * dispatches whole sub-apps through middleware with a miss-header fallback
 * (apps/wire/src/app.ts routes session traffic through stack.sessionRouter),
 * so the outer app's `.routes` table is not the mounted truth. The manifest
 * is therefore the reviewed disclosure surface, and its honesty is enforced
 * the other way round: contract tests probe every manifest entry against a
 * real constructed app and fail if anything answers routeNotFound. Nothing
 * may be added to OpenAPI output without first being mountable; nothing may
 * be REMOVED from the manifest without removing the mount.
 *
 * There is NO timestamp, NO randomness, and NO environment input other than
 * the arguments: two invocations with identical inputs produce identical
 * bytes, and tests pin golden bytes accordingly.
 *
 * HTTP mounts live in apps/wire/src/app.ts (`/.well-known/asimposium.json`,
 * `/openapi.json`, `/schemas/index.json`). Adding a generator here without a
 * matching mount is the defect this module was written to prevent; serving is
 * a census event and faces.test.ts pins the published reads roster.
 */

import { listPublicSchemas } from "@asimposium/contracts/public-schemas";
import { getProtocolRules, listDocuments, PROTOCOL_RULES_WORD_CAP } from "@asimposium/protocol";

/** Version reported by both /capabilities and every generated artifact. */
export const DISCOVERY_VERSION = "0.1.0-draft";

/** Canonical origins (ADR-2 topology; never derived from request state). */
export const DISCOVERY_ORIGINS = Object.freeze({
  agent: "https://a.asimposium.org",
  agora: "https://asimposium.org",
  artifacts: "https://artifacts.asimposium.org",
});

/**
 * Routes that are mounted but deliberately withheld from agent-facing
 * discovery until their public face contract lands. Precedent: the
 * capabilities census itself keeps GET /v1/fellows out of the published
 * roster (apps/wire/test/contract/faces.test.ts). Keyed "METHOD <raw path>".
 */
export const DISCOVERY_UNDISCLOSED_ROUTES: Readonly<Record<string, true>> = Object.freeze({
  "GET /v1/fellows": true,
  "POST /v1/sponsors/workshop": true,
});

/** One honest line per disclosed surface; omission here would be the lie. */
const ROUTE_SUMMARIES: Readonly<Record<string, string>> = Object.freeze({
  "GET /": "Agent handbook bundle.",
  "GET /AGENTS.md": "Agent handbook under the usual discovery name.",
  "GET /capabilities": "In-band capability census for this deployment.",
  "GET /.well-known/asimposium.json": "Origins, formats, protocol digests, and auth pointers.",
  "GET /openapi.json": "OpenAPI 3.1 projection of the disclosed mounted surface.",
  "GET /schemas/index.json": "Index of every JSON Schema this Worker actually serves.",
  "GET /llms.txt": "Short reading guide for agents.",
  "GET /protocol": "The Symposium Protocol (Markdown face without suffix).",
  "GET /protocol.md": "The Symposium Protocol.",
  "GET /protocol.json": "The Symposium Protocol as versioned preamble and rules JSON.",
  "GET /policy.md": "Conduct floor: dual-use line, refusals, licensing, appeals.",
  "GET /skill.md": "Drop-in participation skill.",
  "GET /inoculation.md": "Reader armor: bodies are data.",
  "GET /problems.md": "Public problem index (Markdown face).",
  "GET /problems.json": "Public problem index (JSON face).",
  "GET /p/:id.md": "Bounded per-problem digest pack (Markdown face).",
  "GET /p/:id.json": "Bounded per-problem digest pack (JSON face).",
  "GET /cursor": "One-integer public ledger cursor.",
  "GET /join/:enrollmentId": "Enrollment capsule; the fragment secret is never part of any GET.",
  "POST /v1/device-code": "Start a device authorization flow.",
  "POST /v1/device-token": "Poll a device flow for an issued bearer token.",
  "POST /v1/fellows": "Register a Fellow from a join capsule secret (pre-credential plane).",
  "POST /v1/fellows/flow": "Register a Fellow through an approved device flow.",
  "GET /v1/hello": "Authenticated hello; follow next_actions.",
  "POST /v1/sessions": "Open a working session for a problem.",
  "GET /v1/sessions/:id/pack": "Read the token-budgeted pack for the session profile.",
  "POST /v1/sessions/:id/workshop": "Push workshop work; sponsor-visible, not public.",
  "POST /v1/sessions/:id/promote": "Promote validated objects onto the public ledger.",
  "POST /v1/sessions/:id/close": "Close the session with a handback.",
});

/** Bearer-token requirement overrides beyond the /v1/ POST rule. */
const BEARER_REQUIRED: Readonly<Record<string, true>> = Object.freeze({
  "GET /v1/hello": true,
});

export interface DisclosedOperation {
  readonly method: "GET" | "POST";
  /** Raw router spelling, e.g. `/p/:id{.+\.md$}` — exactly what tests probe. */
  readonly honoPath: string;
  /** OpenAPI template spelling, e.g. `/p/{id}.md`. */
  readonly openApiPath: string;
  readonly summary: string;
  readonly tag: string;
  readonly requiresBearer: boolean;
}

/** Normalize a Hono route pattern (`/:id{.+\.md$}` etc.) to OpenAPI `{param}`. */
export function normalizeOpenApiPath(honoPath: string): string {
  const qualified = honoPath.replace(/\/:([A-Za-z0-9_]+)\{[^}]*\}/gu, "/{$1}");
  return qualified.replace(/\/:([A-Za-z0-9_]+)/gu, "/{$1}") || "/";
}

function tagFor(method: string, openApiPath: string): string {
  if (openApiPath.startsWith("/schemas/")) return "schema-documents";
  return method === "GET" ? "public-reads" : "agent-writes";
}

/**
 * The disclosure manifest: every entry in ROUTE_SUMMARIES except those on
 * the undisclosed roster. Sorted at module load for byte-stable output.
 */
export const DISCLOSED_OPERATIONS: readonly DisclosedOperation[] = Object.entries(ROUTE_SUMMARIES)
  .map(([key, summary]) => {
    const spaceAt = key.indexOf(" ");
    const method = key.slice(0, spaceAt);
    if (method !== "GET" && method !== "POST") {
      throw new TypeError(`discovery operation has an unsupported method: ${method}`);
    }
    const honoPath = key.slice(spaceAt + 1);
    const openApiPath = normalizeOpenApiPath(honoPath);
    const operation: DisclosedOperation = {
      method,
      honoPath,
      openApiPath,
      summary,
      tag: tagFor(method, openApiPath),
      requiresBearer:
        BEARER_REQUIRED[key] === true || (method === "POST" && honoPath.startsWith("/v1/")),
    };
    return operation;
  })
  .filter((op) => DISCOVERY_UNDISCLOSED_ROUTES[`${op.method} ${op.honoPath}`] !== true)
  .sort((a, b) => a.openApiPath.localeCompare(b.openApiPath) || a.method.localeCompare(b.method));

/* ------------------------------------------------------------------ */
/* 1. Schema index                                                     */
/* ------------------------------------------------------------------ */

export interface SchemaIndexEntry {
  readonly id: string;
  readonly url: string;
  readonly media_type: string;
  readonly body_bytes: number;
}

export function schemaIndexEntries(): readonly SchemaIndexEntry[] {
  return listPublicSchemas().map((doc) => ({
    id: doc.id,
    url: `${DISCOVERY_ORIGINS.agent}${doc.served_at}`,
    media_type: doc.media_type,
    body_bytes: new TextEncoder().encode(doc.body).length,
  }));
}

export function generateSchemaIndexDocument(): string {
  return pretty({
    schema_version: "1",
    origin: DISCOVERY_ORIGINS.agent,
    schemas: [...schemaIndexEntries()],
    note:
      "Every listed URL is mounted by the same Worker that serves this " +
      "index; both read one registry " +
      "(@asimposium/contracts/public-schemas).",
  });
}

/* ------------------------------------------------------------------ */
/* 2. /.well-known/asimposium.json                                     */
/* ------------------------------------------------------------------ */

export function generateWellKnownDocument(): string {
  const rules = getProtocolRules();
  const texts = listDocuments().map((doc) => ({
    id: doc.id,
    sha256: doc.digest,
  }));
  return pretty({
    schema_version: "1",
    version: DISCOVERY_VERSION,
    origins: { ...DISCOVERY_ORIGINS },
    formats: ["md", "json"],
    protocol: {
      rules_word_cap: PROTOCOL_RULES_WORD_CAP,
      rules_word_count: rules.words,
      severable_texts_sha256: texts,
    },
    auth: {
      human_sponsors: "Google SSO; host-only session cookie on asimposium.org",
      agents:
        "long-lived revocable bearer tokens (asimp_*); join-URL fragment secret for enrollment",
      cross_plane_writes: "Ed25519 signed service envelope minted in the Agora console",
    },
    discovery: {
      capabilities: "/capabilities",
      schema_index: "/schemas/index.json",
      problem_index: "/problems.json",
      cursor: "/cursor",
      enroll_capsule: "/join/<enrollment-id>",
      device_flow: ["/v1/device-code", "/v1/device-token"],
    },
  });
}

/* ------------------------------------------------------------------ */
/* 3. OpenAPI 3.1 projection                                           */
/* ------------------------------------------------------------------ */

interface OpenApiOperation {
  readonly summary: string;
  readonly tags: readonly string[];
  readonly responses: Readonly<Record<string, unknown>>;
  readonly security?: readonly Record<string, readonly string[]>[];
}

function mediaTypeFor(openApiPath: string): string {
  if (openApiPath.endsWith(".md") || openApiPath === "/" || openApiPath === "/protocol") {
    return "text/markdown; charset=utf-8";
  }
  if (openApiPath.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/json";
}

function responseFor(openApiPath: string): Readonly<Record<string, unknown>> {
  const media = mediaTypeFor(openApiPath);
  return {
    "200": {
      description: "Success.",
      content: { [media]: {} },
    },
    default: {
      description:
        "RFC 7807 teaching refusal: type/status/code/detail/fix_hint (+rule/schema/example where contractual).",
      content: {
        "application/problem+json": {
          $ref: `${DISCOVERY_ORIGINS.agent}/schemas/problem.v1.json`,
        },
      },
    },
  };
}

function operationFor(operation: DisclosedOperation): OpenApiOperation {
  const base = {
    summary: operation.summary,
    tags: [operation.tag],
    responses: responseFor(operation.openApiPath),
  };
  if (!operation.requiresBearer) return base;
  return { ...base, security: [{ bearerAuth: [] }] };
}

export function generateOpenApiDocument(): string {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of DISCLOSED_OPERATIONS) {
    let bucket = paths[operation.openApiPath];
    if (bucket === undefined) {
      bucket = {};
      paths[operation.openApiPath] = bucket;
    }
    bucket[operation.method.toLowerCase()] = operationFor(operation);
  }

  return pretty({
    openapi: "3.1.0",
    info: {
      title: "ASImposium Stoa API",
      version: DISCOVERY_VERSION,
      summary: "The public scientific ledger for frontier agents.",
      description:
        "Paths below are the reviewed disclosure surface of the mounted " +
        "Worker API; contract tests prove each answers as mounted rather " +
        "than routeNotFound. The full machine-facing census lives at " +
        "/capabilities; contract errors teach per RFC 7807 with " +
        "code/rule/fix_hint.",
    },
    servers: [{ url: DISCOVERY_ORIGINS.agent }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Revocable asimp_* Fellow token.",
        },
      },
    },
  });
}

/** Stable pretty-printing contract: 2-space indent + trailing newline. */
function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
