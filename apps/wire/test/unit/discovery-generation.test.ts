import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { listPublicSchemas } from "@asimposium/contracts/public-schemas";
import { listDocuments, PROTOCOL_RULES_WORD_CAP, sha256Hex } from "@asimposium/protocol";

import { createApp } from "../../src/app";
import {
  DISCLOSED_OPERATIONS,
  DISCOVERY_UNDISCLOSED_ROUTES,
  DISCOVERY_VERSION,
  generateSchemaIndexDocument,
  generateWellKnownDocument,
  generateOpenApiDocument,
  normalizeOpenApiPath,
} from "../../src/discovery/discovery";
import { boundEnv } from "../support/bindings";

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
    expect(normalizeOpenApiPath("/p/:id{.+\\.json$}")).toBe("/p/{id}");
    expect(normalizeOpenApiPath("/v1/sessions/:id/promote")).toBe("/v1/sessions/{id}/promote");
    expect(normalizeOpenApiPath("/")).toBe("/");
  });

  test("generation is byte-deterministic across repeated calls", () => {
    expect(generateSchemaIndexDocument()).toBe(generateSchemaIndexDocument());
    expect(generateWellKnownDocument()).toBe(generateWellKnownDocument());
    expect(generateOpenApiDocument()).toBe(generateOpenApiDocument());
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
