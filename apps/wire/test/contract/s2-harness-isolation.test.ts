import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { listPublicSchemas } from "@asimposium/contracts/public-schemas";
import { createApp } from "../../src/app";
import { REQUIRED_BINDINGS } from "../../src/env";
import { boundEnv, executionContext } from "../support/bindings";

/**
 * Krater S2 harness deployment isolation contract test (bead asimposiumorg-wy8r).
 *
 * Freezes the invariant that the destructive S2 local harness mutation routes
 * (`/__s2/*` in `apps/wire/src/krater/worker.ts`), its capability binding
 * (`S2_LOCAL_HARNESS`), and its local problem dialect (`krater.v0.read`)
 * remain strictly isolated to developer/test harnesses and are never mounted
 * by Stoa's production entrypoint, configured in production bindings, or
 * leaked into public contracts.
 */

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const INFRA_WRANGLER_PATH = resolve(REPO_ROOT, "infra/wrangler.toml");
const PRODUCTION_INDEX_PATH = resolve(import.meta.dir, "../../src/index.ts");
const PRODUCTION_APP_PATH = resolve(import.meta.dir, "../../src/app.ts");
const HARNESS_WORKER_PATH = resolve(import.meta.dir, "../../src/krater/worker.ts");

const S2_HARNESS_PATHS = [
  "/__s2/ready",
  "/__s2/abort-observation",
  "/__s2/integrity/probe-plan",
  "/__s2/legacy/plant",
  "/__s2/seed",
  "/__s2/seed-promotable",
  "/__s2/tamper-envelope",
  "/__s2/plant-malformed-outbox",
] as const;

describe("Krater S2 harness local-only deployment isolation (wy8r)", () => {
  test("production entrypoint and app source do not import or mount the S2 harness worker", () => {
    const indexSource = readFileSync(PRODUCTION_INDEX_PATH, "utf8");
    const appSource = readFileSync(PRODUCTION_APP_PATH, "utf8");

    expect(indexSource).not.toContain("krater/worker");
    expect(indexSource).not.toContain("handleHarnessRequest");
    expect(indexSource).not.toContain("S2_LOCAL_HARNESS");
    expect(indexSource).not.toContain("/__s2");

    expect(appSource).not.toContain("krater/worker");
    expect(appSource).not.toContain("handleHarnessRequest");
    expect(appSource).not.toContain("S2_LOCAL_HARNESS");
    expect(appSource).not.toContain("/__s2");
  });

  test("REQUIRED_BINDINGS and base infra/wrangler.toml omit S2 harness capabilities", () => {
    expect(REQUIRED_BINDINGS as readonly string[]).not.toContain("S2_LOCAL_HARNESS");
    expect(REQUIRED_BINDINGS as readonly string[]).not.toContain("S2_HARNESS_TOKEN");
    expect(REQUIRED_BINDINGS as readonly string[]).not.toContain("S2_HARNESS_RUN_ID");

    const toml = readFileSync(INFRA_WRANGLER_PATH, "utf8");
    expect(toml).not.toContain("S2_LOCAL_HARNESS");
    expect(toml).not.toContain("S2_HARNESS_TOKEN");
    expect(toml).not.toContain("S2_HARNESS_RUN_ID");
    expect(toml).not.toContain("krater/worker.ts");
  });

  test("production app returns 404 ROUTE_NOT_FOUND on every S2 harness route even with loopback authority", async () => {
    const app = createApp();
    const env = boundEnv();
    const ctx = executionContext() as unknown as Parameters<typeof app.fetch>[2];

    for (const pathname of S2_HARNESS_PATHS) {
      const getResponse = await app.fetch(
        new Request(`https://a.asimposium.org${pathname}`, {
          method: "GET",
          headers: {
            host: "127.0.0.1:8787",
            authorization: "Bearer s2-harness-synthetic-probe-token",
          },
        }),
        env,
        ctx,
      );
      expect(getResponse.status).toBe(404);
      const getBody = (await getResponse.json()) as { code?: string };
      expect(getBody.code).toBe("ROUTE_NOT_FOUND");

      const postResponse = await app.fetch(
        new Request(`https://a.asimposium.org${pathname}`, {
          method: "POST",
          headers: {
            host: "127.0.0.1:8787",
            "content-type": "application/json",
            authorization: "Bearer s2-harness-synthetic-probe-token",
          },
          body: JSON.stringify({ problem_id: "P-PROBE", created_at: "2026-09-03T00:00:00Z" }),
        }),
        env,
        ctx,
      );
      expect(postResponse.status).toBe(404);
      const postBody = (await postResponse.json()) as { code?: string };
      expect(postBody.code).toBe("ROUTE_NOT_FOUND");
    }
  });

  test("public schema registry never registers the local krater.v0.read problem dialect", () => {
    const publicSchemas = listPublicSchemas();
    const schemaIds = publicSchemas.map((schema) => schema.id);
    const schemaPaths = publicSchemas.map((schema) => schema.served_at);

    expect(schemaIds).not.toContain("krater.v0.read");
    expect(schemaIds).not.toContain("internal.krater");
    expect(schemaPaths).not.toContain("/schemas/krater.v0.read.json");

    for (const schema of publicSchemas) {
      expect(schema.body).not.toContain("KRATER_HARNESS_DISABLED");
      expect(schema.body).not.toContain("krater.v0.read");
    }
  });

  test("the harness worker source keeps its own fail-closed capability check before request handling", () => {
    const harnessSource = readFileSync(HARNESS_WORKER_PATH, "utf8");
    expect(harnessSource).toContain(
      "if (url.pathname.startsWith(HARNESS_PATH_PREFIX) && !harnessRequestAuthorized(request, env))",
    );
    expect(harnessSource).toContain('return response({ code: "KRATER_HARNESS_DISABLED" }, 404);');
  });
});
