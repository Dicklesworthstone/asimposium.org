import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";
import worker from "./worker";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const HARNESS_CAPABILITY = "a".repeat(64);
const HARNESS_RUN_ID = "b".repeat(32);
const NON_MATCHING_VALUE = "malformed";

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

interface HarnessEnvOptions {
  capability?: string;
  token?: string;
  runId?: string;
}

function harnessEnv(options: HarnessEnvOptions = {}): Parameters<typeof worker.fetch>[1] {
  const env: Parameters<typeof worker.fetch>[1] = { DB: databaseThatMustNotBeTouched() };
  if (options.capability !== undefined) env.S2_LOCAL_HARNESS = options.capability;
  if (options.token !== undefined) env.S2_HARNESS_TOKEN = options.token;
  if (options.runId !== undefined) env.S2_HARNESS_RUN_ID = options.runId;
  return env;
}

function harnessRequest(
  pathname: string,
  token: string | null = HARNESS_CAPABILITY,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  if (token !== null) headers.set("x-s2-harness-token", token);
  return new Request(`https://public.example${pathname}`, { ...init, headers });
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
    const env = harnessEnv({ token: HARNESS_CAPABILITY, runId: HARNESS_RUN_ID });
    expect("S2_LOCAL_HARNESS" in env).toBe(false);
    const response = await worker.fetch(
      harnessRequest("/__s2/write", HARNESS_CAPABILITY, {
        method: "POST",
        body: "not-json",
      }),
      env,
      context(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "KRATER_HARNESS_DISABLED" });
  });

  test("enabled harness rejects a wrong token before body parsing or D1", async () => {
    const response = await worker.fetch(
      harnessRequest("/__s2/write", "c".repeat(64), {
        method: "POST",
        body: "not-json",
      }),
      harnessEnv({ capability: "enabled", token: HARNESS_CAPABILITY, runId: HARNESS_RUN_ID }),
      context(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "KRATER_HARNESS_DISABLED" });
  });

  test("enabled harness rejects a missing per-worker token before body parsing or D1", async () => {
    const response = await worker.fetch(
      harnessRequest("/__s2/write", null, { method: "POST", body: "not-json" }),
      harnessEnv({ capability: "enabled", token: HARNESS_CAPABILITY, runId: HARNESS_RUN_ID }),
      context(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "KRATER_HARNESS_DISABLED" });
  });

  test("a static capability with a truly absent token binding is still absent before D1", async () => {
    const env = harnessEnv({ capability: "enabled", runId: HARNESS_RUN_ID });
    expect("S2_HARNESS_TOKEN" in env).toBe(false);
    const response = await worker.fetch(
      harnessRequest("/__s2/write", HARNESS_CAPABILITY, { method: "POST", body: "not-json" }),
      env,
      context(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "KRATER_HARNESS_DISABLED" });
  });

  test("a malformed token binding keeps the harness absent before D1", async () => {
    const response = await worker.fetch(
      harnessRequest("/__s2/write", NON_MATCHING_VALUE, { method: "POST", body: "not-json" }),
      harnessEnv({ capability: "enabled", token: NON_MATCHING_VALUE, runId: HARNESS_RUN_ID }),
      context(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "KRATER_HARNESS_DISABLED" });
  });

  test("a missing run-id binding keeps the harness absent before D1", async () => {
    const env = harnessEnv({ capability: "enabled", token: HARNESS_CAPABILITY });
    expect("S2_HARNESS_RUN_ID" in env).toBe(false);
    const response = await worker.fetch(harnessRequest("/__s2/ready"), env, context());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "KRATER_HARNESS_DISABLED" });
  });

  test("a malformed run-id binding keeps the harness absent before D1", async () => {
    const response = await worker.fetch(
      harnessRequest("/__s2/ready"),
      harnessEnv({ capability: "enabled", token: HARNESS_CAPABILITY, runId: "not-a-run-id" }),
      context(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "KRATER_HARNESS_DISABLED" });
  });

  test("an empty run-id binding keeps the harness absent before D1", async () => {
    const response = await worker.fetch(
      harnessRequest("/__s2/ready"),
      harnessEnv({ capability: "enabled", token: HARNESS_CAPABILITY, runId: "" }),
      context(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "KRATER_HARNESS_DISABLED" });
  });

  test("a matching token returns this worker's readiness identifier without D1", async () => {
    const response = await worker.fetch(
      harnessRequest("/__s2/ready"),
      harnessEnv({ capability: "enabled", token: HARNESS_CAPABILITY, runId: HARNESS_RUN_ID }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", run_id: HARNESS_RUN_ID });
  });

  test("a matching token reaches the route even when Host is not loopback", async () => {
    const response = await worker.fetch(
      harnessRequest("/__s2/cursor?problem_id=P-example"),
      harnessEnv({ capability: "enabled", token: HARNESS_CAPABILITY, runId: HARNESS_RUN_ID }),
      context(),
    );

    // The proxy throws on D1 access. A 400 proves the request passed the token gate rather than
    // treating a client-controlled Host value as the access-control decision.
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
      "apps/wire/src/krater/wrangler.s2-upgrade.toml",
      "apps/wire/src/krater/wrangler.s2.toml",
    ]);
    for (const config of configs) {
      expect(readFileSync(join(REPOSITORY_ROOT, config), "utf8")).not.toContain("S2_HARNESS_TOKEN");
    }
  });

  test("the local scheduled event independently re-arms the durable outbox", async () => {
    const requests: Request[] = [];
    const env = harnessEnv({
      capability: "enabled",
      token: HARNESS_CAPABILITY,
      runId: HARNESS_RUN_ID,
    });
    Object.assign(env, {
      KRATER_OUTBOX: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (request: Request) => {
            requests.push(request);
            return new Response(JSON.stringify({ accepted: true }), { status: 202 });
          },
        }),
      },
    });

    await worker.scheduled({}, env, context());

    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]?.url ?? "https://invalid.example").pathname).toBe("/nudge");
    expect(requests[0]?.method).toBe("POST");
  });

  test("the scheduled recovery authority is absent when the local capability is absent", async () => {
    const env = harnessEnv({ token: HARNESS_CAPABILITY, runId: HARNESS_RUN_ID });
    Object.assign(env, {
      KRATER_OUTBOX: new Proxy(
        {},
        {
          get() {
            throw new Error("S2_TEST_OUTBOX_TOUCHED");
          },
        },
      ),
    });

    await expect(worker.scheduled({}, env, context())).resolves.toBeUndefined();
  });
});
