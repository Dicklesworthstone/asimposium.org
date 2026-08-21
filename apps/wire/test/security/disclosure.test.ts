import { describe, expect, test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import { createApp } from "../../src/app";
import type { Env } from "../../src/env";
import {
  boundEnv,
  callWorker,
  d1Shaped,
  executionContext,
  outboxShaped,
  r2Shaped,
} from "../support/bindings";

/**
 * Disclosure discipline for the scaffold's faces.
 *
 * Fable §14.3 keeps a never-log list (tokens, enrollment secrets, raw bodies)
 * and Rule A5 splits refusals into two transparency classes: contract errors
 * teach, everything else starves the oracle. These tests hold the scaffold to
 * the narrow part of that which it can already be held to — a face must never
 * echo binding values, environment values, thrown error text, or filesystem
 * paths.
 */

const CANARY_TOKEN = "asimp_ag_canary000000000000000000";
const CANARY_SECRET = "canary-google-client-secret";
const REPLAY_KEY = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const ENROLLMENT_ID = "ASIMP-EN-01JXYZ4K6Q";
const TRUSTED_STOA_ORIGIN = "https://a.asimposium.org";
const TRUSTED_AGORA_ORIGIN = "https://asimposium.org";

const leakyEnv = (): unknown => ({
  ...boundEnv(),
  GOOGLE_CLIENT_SECRET: CANARY_SECRET,
  ASIMP_SERVICE_TOKEN: CANARY_TOKEN,
  D1_DATABASE_ID: "canary-0000-1111-2222-333333333333",
});

const forbidden = (text: string): void => {
  expect(text).not.toContain(CANARY_TOKEN);
  expect(text).not.toContain(CANARY_SECRET);
  expect(text).not.toContain("canary-0000");
  expect(text).not.toContain("asimp_ag_");
  // No local filesystem disclosure on any face.
  expect(text).not.toContain("/Users/");
  expect(text).not.toContain("/home/");
  expect(text).not.toMatch(/node_modules/);
};

describe("faces disclose no environment or binding values", () => {
  test("the healthy face names bindings, never their values", async () => {
    const res = await callWorker("/internal/health", leakyEnv());

    expect(res.status).toBe(200);
    forbidden(res.bodyText);
    // It says which bindings exist, and nothing more about them.
    expect(res.bodyText).toContain('"DB":"bound"');
  });

  test("the BINDING_MISSING refusal names bindings, never their values", async () => {
    const res = await callWorker("/internal/health", {
      ARTIFACTS: r2Shaped(),
      PUBLIC_ARTIFACTS: r2Shaped(),
      KRATER_OUTBOX: outboxShaped(),
      GOOGLE_CLIENT_SECRET: CANARY_SECRET,
      ASIMP_SERVICE_TOKEN: CANARY_TOKEN,
    });

    expect(res.status).toBe(503);
    forbidden(res.bodyText);
    expect(res.bodyText).toContain('"missing":["DB"]');
  });

  test("a malformed public artifact binding is a typed refusal that withholds its value", async () => {
    const res = await callWorker("/internal/health", {
      DB: d1Shaped(),
      ARTIFACTS: r2Shaped(),
      PUBLIC_ARTIFACTS: { bucket_name: CANARY_SECRET },
      KRATER_OUTBOX: outboxShaped(),
    });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: "BINDING_MISSING",
      missing: ["PUBLIC_ARTIFACTS"],
    });
    forbidden(res.bodyText);
  });

  test("the UNKNOWN_FORMAT refusal does not echo the rejected value back", async () => {
    const res = await callWorker(
      `/internal/health?format=${encodeURIComponent(CANARY_TOKEN)}`,
      leakyEnv(),
    );

    expect(res.status).toBe(400);
    forbidden(res.bodyText);
  });

  test("an unknown /v1 path is a typed 404 before enrollment configuration", async () => {
    const res = await callWorker(`/v1/${CANARY_TOKEN}`, leakyEnv());

    expect(res.status).toBe(404);
    expect(res.contentType).toBe("application/problem+json; charset=utf-8");
    expect(res.body).toMatchObject({ code: "ROUTE_NOT_FOUND", status: 404 });
    expect(res.bodyText).not.toContain(CANARY_TOKEN);
  });

  test("a wrong method on a real Propylon path gets the canonical 404 face", async () => {
    const app = createApp();
    const response = await app.fetch(
      new Request("https://a.asimposium.org/v1/hello", { method: "POST" }),
      boundEnv({
        ENROLLMENT_REPLAY_KEY: REPLAY_KEY,
        STOA_ORIGIN: TRUSTED_STOA_ORIGIN,
        AGORA_ORIGIN: TRUSTED_AGORA_ORIGIN,
      }),
      executionContext() as unknown as Parameters<typeof app.fetch>[2],
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
    expect(response.headers.get("x-asimp-internal-router-miss")).toBeNull();
    expect(await response.json()).toMatchObject({
      code: "ROUTE_NOT_FOUND",
      status: 404,
      title: "Method is not served on this path",
      detail: "This Worker serves /v1/hello, but not with POST.",
    });
  });

  test("an intentional typed route 404 is not mistaken for a dispatch miss", async () => {
    const app = createApp();
    const response = await app.fetch(
      new Request("https://a.asimposium.org/join/not-an-enrollment-id"),
      boundEnv({
        ENROLLMENT_REPLAY_KEY: REPLAY_KEY,
        STOA_ORIGIN: TRUSTED_STOA_ORIGIN,
        AGORA_ORIGIN: TRUSTED_AGORA_ORIGIN,
      }),
      executionContext() as unknown as Parameters<typeof app.fetch>[2],
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("x-asimp-internal-router-miss")).toBeNull();
    expect(await response.json()).toMatchObject({ code: "CAPSULE_UNAVAILABLE", status: 404 });
  });
});

function capsuleDb(secretExpiresAt: number): {
  readonly db: D1Database;
  readonly prepareCalls: () => number;
} {
  let calls = 0;
  const row = {
    enrollment_id: ENROLLMENT_ID,
    sponsor_id: "usr_cache_regression",
    kind: "join-url",
    secret_hash: "a".repeat(64),
    secret_expires_at: secretExpiresAt,
    requested_scopes_json: JSON.stringify(["review"]),
    requested_resources_json: "{}",
    invalidated: 0,
    secret_consumed_at: null,
    record_created_at: secretExpiresAt - 60_000,
    requested_resource_key_count: 0,
    requested_resource_distinct_key_count: 0,
  };
  const db = {
    prepare() {
      calls += 1;
      return {
        bind() {
          return { first: async () => row };
        },
      };
    },
    batch() {
      throw new Error("capsule cache regression must not execute a batch");
    },
  } as unknown as D1Database;
  return { db, prepareCalls: () => calls };
}

describe("the isolate cache never crosses D1 binding identity", () => {
  test("equal credentials with DB-A then DB-B read DB-B on the second request", async () => {
    const app = createApp();
    const first = capsuleDb(8_000_000_000_001);
    const second = capsuleDb(8_000_000_000_002);
    const request = () =>
      new Request(`https://a.asimposium.org/join/${ENROLLMENT_ID}`, {
        headers: { accept: "application/json" },
      });

    const responseA = await app.fetch(
      request(),
      boundEnv({
        DB: first.db,
        ENROLLMENT_REPLAY_KEY: REPLAY_KEY,
        STOA_ORIGIN: TRUSTED_STOA_ORIGIN,
        AGORA_ORIGIN: TRUSTED_AGORA_ORIGIN,
      }),
      executionContext() as unknown as Parameters<typeof app.fetch>[2],
    );
    const responseB = await app.fetch(
      request(),
      boundEnv({
        DB: second.db,
        ENROLLMENT_REPLAY_KEY: REPLAY_KEY,
        STOA_ORIGIN: TRUSTED_STOA_ORIGIN,
        AGORA_ORIGIN: TRUSTED_AGORA_ORIGIN,
      }),
      executionContext() as unknown as Parameters<typeof app.fetch>[2],
    );

    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);
    expect(await responseA.json()).toMatchObject({ secret_expires_at: 8_000_000_000_001 });
    expect(await responseB.json()).toMatchObject({ secret_expires_at: 8_000_000_000_002 });
    expect(first.prepareCalls()).toBe(1);
    expect(second.prepareCalls()).toBe(1);
  });
});

describe("the error handler does not leak thrown detail", () => {
  test("a thrown error becomes an opaque INTERNAL_ERROR", async () => {
    const app = createApp();
    // A route that only exists inside this test, so the scaffold itself keeps
    // no throwing path: this exercises app.onError, not a shipped endpoint.
    app.get("/test-only/boom", () => {
      throw new Error(`stack-trace-canary ${CANARY_SECRET}`);
    });

    const response = await app.fetch(
      new Request("https://a.asimposium.org/test-only/boom"),
      boundEnv() as Env,
      executionContext() as unknown as Parameters<typeof app.fetch>[2],
    );
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
    expect(JSON.parse(text)).toMatchObject({ code: "INTERNAL_ERROR", status: 500 });
    expect(text).not.toContain("stack-trace-canary");
    expect(text).not.toContain("at ");
    forbidden(text);
  });

  test("a mutable error name cannot reach the server diagnostic", async () => {
    const app = createApp();
    app.get("/test-only/named", () => {
      const error = new Error("ordinary message");
      error.name = CANARY_TOKEN;
      throw error;
    });

    const originalConsoleError = console.error;
    const logged: unknown[][] = [];
    console.error = (...values: unknown[]) => {
      logged.push(values);
    };
    try {
      const response = await app.fetch(
        new Request("https://a.asimposium.org/test-only/named"),
        boundEnv() as Env,
        executionContext() as unknown as Parameters<typeof app.fetch>[2],
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ code: "INTERNAL_ERROR", status: 500 });
    } finally {
      console.error = originalConsoleError;
    }

    expect(logged).toEqual([
      ["[wire] unhandled error", { path: "/test-only/named", error: "unhandled" }],
    ]);
    expect(JSON.stringify(logged)).not.toContain(CANARY_TOKEN);
  });
});

describe("the 404 face teaches without inventing surface", () => {
  test("it advertises only the surface classes this Worker actually mounts", async () => {
    const res = await callWorker("/nope");
    const { detail, fix_hint } = res.body as { detail: string; fix_hint: string };

    expect(res.status).toBe(404);
    // Every path-shaped token is either the caller's path or a surface currently
    // mounted by createApp. A future surface added to the
    // copy before it is mounted fails here.
    const offered = new Set(
      `${detail} ${fix_hint}`.match(/\/(?:[a-z0-9/_:-]+(?:\.[a-z0-9_-]+)?)?/gi) ?? [],
    );
    expect([...offered].sort()).toEqual([
      "/",
      "/internal/health",
      "/join/",
      "/nope",
      "/protocol.md",
      "/v1",
    ]);
  });
});
