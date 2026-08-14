import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { Env } from "../../src/env";
import { boundEnv, callWorker, executionContext, r2Shaped } from "../support/bindings";

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
      GOOGLE_CLIENT_SECRET: CANARY_SECRET,
      ASIMP_SERVICE_TOKEN: CANARY_TOKEN,
    });

    expect(res.status).toBe(503);
    forbidden(res.bodyText);
    expect(res.bodyText).toContain('"missing":["DB"]');
  });

  test("the UNKNOWN_FORMAT refusal does not echo the rejected value back", async () => {
    const res = await callWorker(
      `/internal/health?format=${encodeURIComponent(CANARY_TOKEN)}`,
      leakyEnv(),
    );

    expect(res.status).toBe(400);
    forbidden(res.bodyText);
  });

  test("the mounted /v1 failure does not echo a secret-shaped path segment", async () => {
    const res = await callWorker(`/v1/${CANARY_TOKEN}`, leakyEnv());

    // Propylon owns the whole /v1 namespace. With enrollment replay
    // deliberately unconfigured in this fixture, the request reaches that
    // mounted stack and fails closed before route dispatch.
    expect(res.status).toBe(503);
    expect(res.bodyText).not.toContain(CANARY_TOKEN);
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
});

describe("the 404 face teaches without inventing surface", () => {
  test("it advertises only the surface classes this Worker actually mounts", async () => {
    const res = await callWorker("/nope");
    const { detail, fix_hint } = res.body as { detail: string; fix_hint: string };

    expect(res.status).toBe(404);
    // Every path-shaped token is either the caller's path or one of the three
    // namespaces currently mounted by createApp. A future surface added to the
    // copy before it is mounted fails here.
    const offered = new Set(`${detail} ${fix_hint}`.match(/\/[a-z0-9/_:-]+/gi) ?? []);
    expect([...offered].sort()).toEqual(["/internal/health", "/join/", "/nope", "/v1"]);
  });
});
