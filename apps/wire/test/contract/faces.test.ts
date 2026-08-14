import { describe, expect, test } from "bun:test";
import { ProblemDocumentSchema } from "@asimposium/contracts";
import { createApp } from "../../src/app";
import type { Env } from "../../src/env";
import { boundEnv, callWorker, executionContext, r2Shaped } from "../support/bindings";

/**
 * SCOPE OF THIS SUITE (read before citing it).
 *
 * These are byte-exact goldens for the wire format of the faces this scaffold
 * actually serves. Their job is drift detection: an envelope key renamed, a
 * status code changed, an error code silently reworded, or a field added to a
 * response without anyone deciding to add it, all fail here.
 *
 * The expectations are written by hand and there is deliberately no script that
 * regenerates them, because a regenerable golden is a golden that gets
 * regenerated to make a red build green.
 *
 * This suite is NOT the Fable §16.2 golden corpus. That corpus covers every
 * object kind valid/invalid and every error code, is generated from
 * `@asimposium/contracts` (W1.1, asimposiumorg-phg), and must agree byte for
 * byte with `asimp validate`. None of that exists yet, and nothing here may be
 * cited as evidence that it does.
 */

const HEALTH_OK =
  '{"schema":"https://a.asimposium.org/schemas/internal.health.v1.json","ok":true,' +
  '"data":{"service":"wire","role":"stoa","format":"json",' +
  '"bindings":{"DB":"bound","ARTIFACTS":"bound"}},"degraded":[],"next_actions":[]}';

const UNKNOWN_FORMAT =
  '{"type":"https://asimposium.org/errors/UNKNOWN_FORMAT",' +
  '"title":"Unsupported response format","status":400,"code":"UNKNOWN_FORMAT",' +
  '"detail":"The ?format= value is not one this route serves.",' +
  '"fix_hint":"Drop ?format= or use one of the values in `allowed`.","allowed":["json"]}';

const BINDING_MISSING =
  '{"type":"https://asimposium.org/errors/BINDING_MISSING",' +
  '"title":"Required Worker bindings are not configured","status":503,"code":"BINDING_MISSING",' +
  '"detail":"Missing or wrong-shaped bindings: DB.",' +
  '"fix_hint":"Bind every name in `missing` in the Worker configuration for this environment, ' +
  'then redeploy.","missing":["DB"],"bindings":{"DB":"missing","ARTIFACTS":"bound"}}';

const ENROLLMENT_UNAVAILABLE =
  '{"type":"https://asimposium.org/errors/ENROLLMENT_UNAVAILABLE",' +
  '"title":"Enrollment is not configured on this Worker","status":503,"code":"ENROLLMENT_UNAVAILABLE",' +
  '"detail":"The enrollment replay binding is missing or malformed.",' +
  '"fix_hint":"Set the enrollment replay key for this environment and retry."}';

const ROUTE_NOT_FOUND =
  '{"type":"https://asimposium.org/errors/ROUTE_NOT_FOUND","title":"No such route","status":404,' +
  '"code":"ROUTE_NOT_FOUND","detail":"This Worker serves no route at /nope.",' +
  '"fix_hint":"GET /internal/health, the join capsule at /join/<id>, and the /v1 enrollment surface ' +
  'exist; the wider agent surface lands with the session and ledger workstreams."}';

const INTERNAL_ERROR =
  '{"type":"https://asimposium.org/errors/INTERNAL_ERROR",' +
  '"title":"The Worker failed to handle this request","status":500,"code":"INTERNAL_ERROR",' +
  '"detail":"An unexpected error occurred. Its details are not disclosed on this face.",' +
  '"fix_hint":"Retry the request. If it persists, report the route and the time of the attempt."}';

describe("face wire format", () => {
  test("GET /internal/health, fully bound", async () => {
    const res = await callWorker("/internal/health");

    expect(res.status).toBe(200);
    expect(res.contentType).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.bodyText).toBe(HEALTH_OK);
  });

  test("GET /internal/health?format=<unknown>", async () => {
    const res = await callWorker("/internal/health?format=yaml");

    expect(res.status).toBe(400);
    expect(res.contentType).toBe("application/problem+json; charset=utf-8");
    expect(res.bodyText).toBe(UNKNOWN_FORMAT);
  });

  test("GET /internal/health with D1 unbound", async () => {
    const res = await callWorker("/internal/health", { ARTIFACTS: r2Shaped() });

    expect(res.status).toBe(503);
    expect(res.contentType).toBe("application/problem+json; charset=utf-8");
    expect(res.bodyText).toBe(BINDING_MISSING);
  });

  test("GET /v1/hello reaches the mounted enrollment service", async () => {
    const res = await callWorker("/v1/hello");

    expect(res.status).toBe(503);
    expect(res.contentType).toBe("application/problem+json; charset=utf-8");
    expect(res.bodyText).toBe(ENROLLMENT_UNAVAILABLE);
  });

  test("every mounted Propylon path shape reaches enrollment configuration", async () => {
    const paths = [
      "/join/ASIMP-EN-01JXYZ4K6Q",
      "/v1/device-token",
      "/v1/enrollments",
      "/v1/enrollments/proposals",
      "/v1/enrollments/ASIMP-EN-01JXYZ4K6Q/decision",
      "/v1/fellows",
      "/v1/fellows/flow",
      "/v1/hello",
    ];

    for (const path of paths) {
      const res = await callWorker(path);
      expect(res.status, path).toBe(503);
      expect(res.bodyText, path).toBe(ENROLLMENT_UNAVAILABLE);
    }
  });

  test("near-miss Propylon paths are canonical 404s before configuration", async () => {
    const paths = [
      "/join/",
      "/join/ASIMP-EN-01JXYZ4K6Q/extra",
      "/v1/enrollment",
      "/v1/enrollments/ASIMP-EN-01JXYZ4K6Q",
      "/v1/enrollments/ASIMP-EN-01JXYZ4K6Q/decision/extra",
      "/v1/hello/",
      "/v1/hello%2F",
    ];

    for (const path of paths) {
      const res = await callWorker(path);
      expect(res.status, path).toBe(404);
      expect(res.contentType, path).toBe("application/problem+json; charset=utf-8");
      expect(res.body, path).toMatchObject({ code: "ROUTE_NOT_FOUND", status: 404 });
    }
  });

  test("GET a genuine unknown route", async () => {
    const res = await callWorker("/nope");

    expect(res.status).toBe(404);
    expect(res.contentType).toBe("application/problem+json; charset=utf-8");
    expect(res.bodyText).toBe(ROUTE_NOT_FOUND);
    expect(ProblemDocumentSchema.safeParse(res.body).success).toBe(true);
  });

  test("a maximally redacted unknown path remains inside the problem contract", async () => {
    const segment = "private-path-segment".repeat(12);
    const res = await callWorker(`/${Array.from({ length: 12 }, () => segment).join("/")}`);

    expect(res.status).toBe(404);
    expect(ProblemDocumentSchema.safeParse(res.body).success).toBe(true);
    expect(res.bodyText).not.toContain(segment);
  });

  test("an unhandled throw", async () => {
    const app = createApp();
    app.get("/test-only/boom", () => {
      throw new Error("boom");
    });

    const response = await app.fetch(
      new Request("https://a.asimposium.org/test-only/boom"),
      boundEnv() as Env,
      executionContext() as unknown as Parameters<typeof app.fetch>[2],
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
    const bodyText = await response.text();
    expect(bodyText).toBe(INTERNAL_ERROR);
    expect(ProblemDocumentSchema.safeParse(JSON.parse(bodyText)).success).toBe(true);
  });
});

describe("envelope invariants across every face", () => {
  const faces = [
    { label: "health-ok", path: "/internal/health", env: boundEnv() as unknown },
    { label: "unknown-format", path: "/internal/health?format=yaml", env: boundEnv() as unknown },
    { label: "binding-missing", path: "/internal/health", env: {} as unknown },
    { label: "not-found", path: "/nope", env: boundEnv() as unknown },
  ];

  test.each(faces)("$label is valid JSON with no trailing whitespace", async ({ path, env }) => {
    const res = await callWorker(path, env);

    expect(() => JSON.parse(res.bodyText)).not.toThrow();
    expect(res.bodyText).toBe(res.bodyText.trim());
  });

  test.each(faces)("$label declares a charset on its content type", async ({ path, env }) => {
    const res = await callWorker(path, env);

    expect(res.contentType).toContain("charset=utf-8");
  });

  test.each(faces)("$label carries no timestamp, nonce or host detail", async ({ path, env }) => {
    const res = await callWorker(path, env);

    // Determinism is a contract, not a nicety: a cached face that changes when
    // nothing changed defeats the ETag discipline the plan builds on.
    expect(res.bodyText).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    expect(res.bodyText).not.toMatch(/"(timestamp|now|generated_at|request_id|nonce)"/);
  });

  test("every problem face carries type, code, status, detail and fix_hint", async () => {
    for (const path of ["/internal/health?format=yaml", "/nope"]) {
      const res = await callWorker(path, boundEnv());
      const body = res.body as Record<string, unknown>;

      expect(typeof body.type).toBe("string");
      expect(typeof body.code).toBe("string");
      expect(body.status).toBe(res.status);
      expect(typeof body.detail).toBe("string");
      expect((body.fix_hint as string).length).toBeGreaterThan(0);
      // The RFC 7807 `type` URI is derived from the code, so an agent that
      // matches on either sees the same thing.
      expect(body.type).toBe(`https://asimposium.org/errors/${body.code as string}`);
    }
  });
});
