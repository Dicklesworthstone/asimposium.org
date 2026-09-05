import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { listPublicSchemas } from "@asimposium/contracts/public-schemas";
import { listDocuments, PROTOCOL_RULES_WORD_CAP, sha256Hex } from "@asimposium/protocol";

import { createApp } from "../../src/app";
import {
  configuredDiscoveryOrigins,
  DISCLOSED_OPERATIONS,
  DISCOVERY_ORIGINS,
  DISCOVERY_UNDISCLOSED_ROUTES,
  DISCOVERY_VERSION,
  generateOpenApiDocument,
  generateSchemaIndexDocument,
  generateWellKnownDocument,
  normalizeOpenApiPath,
} from "../../src/discovery/discovery";
import { createEnrollmentRouter } from "../../src/enrollment/router.ts";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentService,
  InMemoryEnrollmentStore,
} from "../../src/enrollment/service.ts";
import { createSessionRouter } from "../../src/sessions/router.ts";

const ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const GOLDEN_DIR = resolve(ROOT, "apps/wire/test/golden/discovery");

const MISS_HEADER = "x-asimp-internal-router-miss";

/** Deterministic sample values so parameterized routes reach their handlers. */
function sampleFor(honoPath: string): string {
  return honoPath.replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?/gu, (_all, name) => {
    if (name === "enrollmentId") return "/join/ASIMP-EN-PROBE".slice(6);
    if (name === "problemId") return "P-4DSP";
    return name === "id" && honoPath.startsWith("/p/") ? "P-4DSP" : "PROBE";
  });
}

describe("discovery generators (W1.6)", () => {
  test("manifest is populated and free of undisclosed surface", () => {
    expect(DISCLOSED_OPERATIONS.length).toBeGreaterThanOrEqual(20);
    for (const operation of DISCLOSED_OPERATIONS) {
      const rawKey = `${operation.method} ${operation.honoPath}`;
      expect(
        DISCOVERY_UNDISCLOSED_ROUTES[rawKey],
        `${rawKey} is rostered as withheld and must not be disclosed`,
      ).toBeUndefined();
      expect(operation.summary.length).toBeGreaterThan(0);
    }
  });

  test("schema index mirrors the served schema registry exactly", () => {
    const doc = JSON.parse(generateSchemaIndexDocument()) as {
      schemas: { id: string; url: string; body_bytes: number }[];
    };
    const registry = listPublicSchemas();
    expect(doc.schemas.map((entry) => entry.id)).toEqual(
      registry.map((registered) => registered.id),
    );
    registry.forEach((registered, index_) => {
      const entry = doc.schemas[index_];
      expect(entry, `registry index ${index_} (${registered.id}) must be listed`).toBeDefined();
      if (entry === undefined) return;
      expect(entry.url).toBe(`https://a.asimposium.org${registered.served_at}`);
      expect(entry.body_bytes).toBe(new TextEncoder().encode(registered.body).length);
    });
  });

  test("well-known document pins protocol measurement and text digests", () => {
    const doc = JSON.parse(generateWellKnownDocument()) as {
      version: string;
      protocol: {
        rules_word_cap: number;
        rules_word_count: number;
        severable_texts_sha256: { id: string; sha256: string }[];
      };
      origins: Record<string, string>;
    };
    expect(doc.version).toBe(DISCOVERY_VERSION);
    expect(doc.protocol.rules_word_cap).toBe(PROTOCOL_RULES_WORD_CAP);

    // Independence check: recompute one digest straight from document bytes.
    const protocolDoc = listDocuments().find((candidate) => candidate.id === "protocol");
    expect(protocolDoc).toBeDefined();
    if (protocolDoc === undefined) return;
    const recorded = doc.protocol.severable_texts_sha256.find((entry) => entry.id === "protocol");
    expect(recorded).toBeDefined();
    if (recorded === undefined) return;
    expect(recorded.sha256).toBe(protocolDoc.digest);
    expect(protocolDoc.digest).toBe(sha256Hex(protocolDoc.body));
    expect(doc.origins.agent).toBe("https://a.asimposium.org");
  });

  test("every disclosed operation answers as a mounted route", async () => {
    // A real constructed app; the manifest may never advertise a path that
    // resolves to the canonical ROUTE_NOT_FOUND problem. Status codes vary
    const app = createApp();
    for (const operation of DISCLOSED_OPERATIONS) {
      const url = `https://a.asimposium.org${sampleFor(operation.honoPath)}`;
      const response = await app.request(url, {
        method: operation.method,
        headers: operation.method === "POST" ? { "content-type": "application/json" } : undefined,
        body: operation.method === "POST" ? "{}" : undefined,
      });
      const missMarked =
        response.headers.get(MISS_HEADER) === "1" || response.headers.get(MISS_HEADER) === "true";
      const body = await response.text();
      let code = "";
      try {
        code = String((JSON.parse(body) as Record<string, unknown>).code ?? "");
      } catch {
        code = "";
      }
      expect(
        missMarked || code === "ROUTE_NOT_FOUND",
        `${operation.method} ${operation.honoPath} advertised but answered as unmounted (status=${response.status}, code=${code})`,
      ).toBe(false);
    }
  });

  test("openapi paths equal the manifest templates exactly", () => {
    const doc = JSON.parse(generateOpenApiDocument()) as {
      openapi: string;
      info: { version: string };
      paths: Record<string, Record<string, unknown>>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.version).toBe(DISCOVERY_VERSION);

    const expected = new Set(DISCLOSED_OPERATIONS.map((op) => op.openApiPath));
    const actual = new Set(Object.keys(doc.paths));
    for (const path of expected) expect(actual.has(path)).toBe(true);
    for (const path of actual) expect(expected.has(path)).toBe(true);

    // The sponsor roster READ is the withheld surface; the pre-credential
    // registration POST on the same path is deliberately disclosed.
    const fellows = doc.paths["/v1/fellows"] as { get?: unknown; post: unknown } | undefined;
    expect(fellows?.get).toBeUndefined();
    expect(fellows?.post).toBeDefined();
  });

  test("hono parameter qualifiers normalize to OpenAPI parameters", () => {
    expect(normalizeOpenApiPath("/p/:id{.+\\.json$}")).toBe("/p/{id}.json");
    expect(normalizeOpenApiPath("/v1/sessions/:id/promote")).toBe("/v1/sessions/{id}/promote");
    expect(normalizeOpenApiPath("/")).toBe("/");
  });

  test("generation is byte-deterministic across repeated calls", () => {
    expect(generateSchemaIndexDocument()).toBe(generateSchemaIndexDocument());
    expect(generateWellKnownDocument()).toBe(generateWellKnownDocument());
    expect(generateOpenApiDocument()).toBe(generateOpenApiDocument());
  });

  test("every request reference resolves to the public Zod-generated schema", () => {
    for (const operation of DISCLOSED_OPERATIONS) {
      if (operation.requestSchema === undefined) continue;
      const [id, property] = operation.requestSchema.split(":");
      const schema = listPublicSchemas().find((doc) => doc.id === id);
      expect(schema, operation.honoPath).toBeDefined();
      const parsed = JSON.parse(schema?.body ?? "{}") as { properties?: Record<string, unknown> };
      expect(parsed.properties?.[property ?? ""], operation.honoPath).toBeDefined();
    }
  });

  test("pre-credential operations require their flow material; private reads require bearer", () => {
    const doc = JSON.parse(generateOpenApiDocument());
    for (const [path, auth, property] of [
      ["/v1/device-code", "device-start", "device_code_start_request"],
      ["/v1/device-token", "flow-handle", "flow_poll_request"],
      ["/v1/fellows/flow", "flow-handle", "flow_poll_request"],
      ["/v1/fellows", "enrollment-secret", "fellow_registration_request"],
    ]) {
      const op = doc.paths[path as string].post;
      expect(op.security).toEqual([]);
      expect(op["x-asimposium-auth"]).toBe(auth);
      expect(op.requestBody.content["application/json"].schema.$ref).toEndWith(
        `/properties/${property}`,
      );
    }
    for (const path of ["/v1/hello", "/v1/sessions/{id}/pack"]) {
      expect(doc.paths[path].get.security).toEqual([{ bearerAuth: [] }]);
      expect(doc.paths[path].get["x-asimposium-auth"]).toBe("fellow-bearer");
    }
  });

  test("both deployment origins are configured, closed and independent of hostile Host", async () => {
    const env = {
      STOA_ORIGIN: "https://a-staging.asimposium.org",
      AGORA_ORIGIN: "https://staging.asimposium.org",
    };
    const origins = configuredDiscoveryOrigins(env);
    expect(origins).toEqual({
      agent: env.STOA_ORIGIN,
      agora: env.AGORA_ORIGIN,
      artifacts: "https://artifacts-staging.asimposium.org",
    });
    expect(
      configuredDiscoveryOrigins({ ...env, AGORA_ORIGIN: DISCOVERY_ORIGINS.agora }),
    ).toBeUndefined();
    expect(
      configuredDiscoveryOrigins({ ...env, STOA_ORIGIN: "https://attacker.invalid" }),
    ).toBeUndefined();
    const app = createApp();
    for (const [path, generate] of [
      ["/.well-known/asimposium.json", generateWellKnownDocument],
      ["/openapi.json", generateOpenApiDocument],
      ["/schemas/index.json", generateSchemaIndexDocument],
    ] as const) {
      const response = await app.request(
        `https://attacker.invalid${path}`,
        {
          headers: {
            Host: "attacker.invalid",
            "User-Agent": "OpenAI File Downloader, XaiImageApiFetch/1.0",
          },
        },
        env,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(generate(origins));
      const unavailable = await app.request(`https://a.asimposium.org${path}`, {}, {});
      expect(unavailable.status).toBe(503);
    }
    const openapi = JSON.parse(generateOpenApiDocument(origins));
    expect(openapi.servers).toEqual([{ url: env.STOA_ORIGIN }]);
    expect(JSON.stringify(openapi)).not.toContain("https://a.asimposium.org/");
  });

  test("router-to-disclosure census includes middleware-dispatched session and enrollment apps", () => {
    const replayProtector = new AesGcmEnrollmentReplayProtector(new Uint8Array(32));
    const service = new EnrollmentService({
      stoaOrigin: DISCOVERY_ORIGINS.agent,
      agoraOrigin: DISCOVERY_ORIGINS.agora,
      store: new InMemoryEnrollmentStore(),
      replayProtector,
    });
    const routes = [
      createApp(),
      createEnrollmentRouter({ service }),
      createSessionRouter({ service, replayProtector }),
    ].flatMap((app) => app.routes);
    const disclosed = new Set(DISCLOSED_OPERATIONS.map((op) => `${op.method} ${op.openApiPath}`));
    const excluded = new Set(
      Object.keys(DISCOVERY_UNDISCLOSED_ROUTES).map((key) => {
        const space = key.indexOf(" ");
        return `${key.slice(0, space)} ${normalizeOpenApiPath(key.slice(space + 1))}`;
      }),
    );
    // HEAD shares GET representations; ALL entries are middleware, not operations.
    // This one platform-principal internal route is intentionally not an agent capability.
    excluded.add("POST /internal/screen");
    const unclassified = (input: typeof routes) =>
      input
        .filter((route) => route.method !== "ALL" && route.method !== "HEAD")
        .map((route) => `${route.method} ${normalizeOpenApiPath(route.path)}`)
        .filter((key) => !disclosed.has(key) && !excluded.has(key));
    expect(unclassified(routes)).toEqual([]);
    const plant = {
      basePath: "/",
      method: "POST",
      path: "/v1/sessions/:id/new-public-write",
      handler: () => new Response(),
    };
    expect(unclassified([...routes, plant])).toEqual(["POST /v1/sessions/{id}/new-public-write"]);
  });

  test("golden artifacts match committed bytes", () => {
    const goldens: Readonly<Record<string, string>> = {
      "schema-index.json": generateSchemaIndexDocument(),
      "well-known.json": generateWellKnownDocument(),
      "openapi.json": generateOpenApiDocument(),
    };
    for (const [name, produced] of Object.entries(goldens)) {
      const committed = readFileSync(resolve(GOLDEN_DIR, name), "utf8");
      expect(committed, `${name} drifted; regenerate deliberately, never silently`).toBe(produced);
    }
  });
});
