import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";
import worker from "./worker";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");

function context(): ExecutionContext {
  return {
    passThroughOnException() {},
    waitUntil() {},
  } as unknown as ExecutionContext;
}

function databaseThatMustNotBeTouched(): D1Database {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("S2_TEST_DATABASE_TOUCHED");
      },
    },
  ) as D1Database;
}

function harnessEnv(capability?: string): Parameters<typeof worker.fetch>[1] {
  return {
    DB: databaseThatMustNotBeTouched(),
    S2_LOCAL_HARNESS: capability,
  };
}

function wranglerConfigs(directory: string): string[] {
  const configs: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const pathname = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") configs.push(...wranglerConfigs(pathname));
      continue;
    }
    if (entry.isFile() && entry.name.includes("wrangler") && entry.name.endsWith(".toml")) {
      configs.push(relative(REPOSITORY_ROOT, pathname));
    }
  }
  return configs;
}

describe("S2 local harness boundary", () => {
  test("capability-absent requests are rejected before body parsing or D1", async () => {
    const response = await worker.fetch(
      new Request("https://public.example/__s2/write", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
      harnessEnv(),
      context(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "KRATER_HARNESS_DISABLED" });
  });

  test("enabled harness rejects a non-loopback write before body parsing or D1", async () => {
    const response = await worker.fetch(
      new Request("https://public.example/__s2/write", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
      harnessEnv("enabled"),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "KRATER_READ_INVALID" });
  });

  test("the harness capability is declared only by local S2 Wrangler configurations", () => {
    const configs = [
      ...wranglerConfigs(join(REPOSITORY_ROOT, "apps", "wire")),
      ...wranglerConfigs(join(REPOSITORY_ROOT, "infra")),
    ].sort();
    const capabilityConfigs = configs.filter((config) =>
      readFileSync(join(REPOSITORY_ROOT, config), "utf8").includes('S2_LOCAL_HARNESS = "enabled"'),
    );

    expect(capabilityConfigs).toEqual([
      "apps/wire/src/krater/wrangler.s2-legacy.toml",
      "apps/wire/src/krater/wrangler.s2.toml",
    ]);
  });
});
