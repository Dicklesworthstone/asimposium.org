import { describe, expect, test } from "bun:test";
import { ProblemDocumentSchema } from "@asimposium/contracts";
import { listPublicSchemas } from "@asimposium/contracts/public-schemas";
import { getDocument, sha256Hex } from "@asimposium/protocol";
import { createApp } from "../../src/app";
import type { Env } from "../../src/env";
import {
  boundEnv,
  callWorker,
  executionContext,
  outboxShaped,
  r2Shaped,
} from "../support/bindings";

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
  '"bindings":{"DB":"bound","ARTIFACTS":"bound","KRATER_OUTBOX":"bound"}},' +
  '"degraded":[],"next_actions":[]}';

const UNKNOWN_FORMAT =
  '{"type":"https://asimposium.org/errors/UNKNOWN_FORMAT",' +
  '"title":"Unsupported response format","status":400,"code":"UNKNOWN_FORMAT",' +
  '"detail":"The ?format= value is not one this route serves.",' +
  '"fix_hint":"Drop ?format= or use one of the values in `allowed`.","rule":"A5",' +
  '"schema":"https://a.asimposium.org/schemas/problem.v1.json",' +
  '"example":{"method":"GET","path":"/internal/health?format=json"},"allowed":["json"]}';

const BINDING_MISSING =
  '{"type":"https://asimposium.org/errors/BINDING_MISSING",' +
  '"title":"Required Worker bindings are not configured","status":503,"code":"BINDING_MISSING",' +
  '"detail":"Missing or wrong-shaped bindings: DB.",' +
  '"fix_hint":"Bind every name in `missing` in the Worker configuration for this environment, ' +
  'then redeploy.","missing":["DB"],"bindings":{"DB":"missing","ARTIFACTS":"bound",' +
  '"KRATER_OUTBOX":"bound"}}';

const ENROLLMENT_UNAVAILABLE =
  '{"type":"https://asimposium.org/errors/ENROLLMENT_UNAVAILABLE",' +
  '"title":"Enrollment is not configured on this Worker","status":503,"code":"ENROLLMENT_UNAVAILABLE",' +
  '"detail":"The enrollment replay binding is missing or malformed.",' +
  '"fix_hint":"Set the enrollment replay key for this environment and retry."}';

const STOA_ORIGIN_UNAVAILABLE =
  '{"type":"https://asimposium.org/errors/ENROLLMENT_UNAVAILABLE",' +
  '"title":"Enrollment is not configured on this Worker","status":503,"code":"ENROLLMENT_UNAVAILABLE",' +
  '"detail":"The Stoa origin binding is missing or is not a trusted origin.",' +
  '"fix_hint":"Set the Stoa origin for this environment and retry."}';

const ROUTE_NOT_FOUND =
  '{"type":"https://asimposium.org/errors/ROUTE_NOT_FOUND","title":"No such route","status":404,' +
  '"code":"ROUTE_NOT_FOUND","detail":"This Worker serves no route at /nope.",' +
  '"fix_hint":"GET / for the handbook, /protocol.md for the rules, /internal/health for operations, ' +
  'the join capsule at /join/<id>, or the /v1 enrollment surface."}';

const INTERNAL_ERROR =
  '{"type":"https://asimposium.org/errors/INTERNAL_ERROR",' +
  '"title":"The Worker failed to handle this request","status":500,"code":"INTERNAL_ERROR",' +
  '"detail":"An unexpected error occurred. Its details are not disclosed on this face.",' +
  '"fix_hint":"Retry the request. If it persists, report the route and the time of the attempt."}';

const TRUSTED_STOA_ORIGIN = "https://a.asimposium.org";

function trustedStoaEnv(): Env {
  return boundEnv({ STOA_ORIGIN: TRUSTED_STOA_ORIGIN });
}

describe("face wire format", () => {
  test("GET /capabilities names every live agent enrollment write", async () => {
    const res = await callWorker("/capabilities", trustedStoaEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=60");
    const body = JSON.parse(res.bodyText) as { agent_writes: string[] };
    expect(body.agent_writes).toEqual([
      "POST /v1/device-code",
      "POST /v1/device-token",
      "POST /v1/fellows",
      "POST /v1/fellows/flow",
    ]);
  });

  test("GET / is the exact handbook, independent of D1", async () => {
    const document = getDocument("handbook");
    const res = await callWorker("/", {});

    expect(res.status).toBe(200);
    expect(res.contentType).toBe(document.media_type);
    expect(res.headers.get("etag")).toBe(`"${document.digest}"`);
    expect(res.headers.get("cache-control")).toContain("max-age=60");
    expect(res.bodyText).toBe(document.body);
  });

  test.each([
    ["/llms.txt", "llms", "txt"],
    ["/policy.md", "policy", "md"],
    ["/protocol.md", "protocol", "md"],
  ] as const)("GET %s serves its registered bytes", async (path, id, format) => {
    const document = getDocument(id);
    const res = await callWorker(`${path}?format=${format}`, {});
    expect(res.status).toBe(200);
    expect(res.contentType).toBe(document.media_type);
    expect(res.bodyText).toBe(document.body);
  });

  test.each([...listPublicSchemas()])(
    "GET $served_at serves the exact drift-checked $id schema without D1",
    async (document) => {
      const res = await callWorker(`${document.served_at}?format=json`, {});
      expect(res.status).toBe(200);
      expect(res.contentType).toBe(document.media_type);
      expect(res.headers.get("etag")).toBe(`"${sha256Hex(document.body)}"`);
      expect(res.bodyText).toBe(document.body);
    },
  );

  test("public texts honor strong, weak, and wildcard conditional reads", async () => {
    const document = getDocument("handbook");
    for (const value of [`"${document.digest}"`, `W/"${document.digest}"`, "*"]) {
      const app = createApp();
      const response = await app.fetch(
        new Request("https://a.asimposium.org/", { headers: { "if-none-match": value } }),
        {} as Env,
        executionContext() as unknown as Parameters<typeof app.fetch>[2],
      );
      expect(response.status, value).toBe(304);
      expect(response.headers.get("etag"), value).toBe(`"${document.digest}"`);
      expect(await response.text(), value).toBe("");
    }
  });

  test("HEAD returns handbook metadata without body bytes", async () => {
    const app = createApp();
    const response = await app.fetch(
      new Request("https://a.asimposium.org/", { method: "HEAD" }),
      {} as Env,
      executionContext() as unknown as Parameters<typeof app.fetch>[2],
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(getDocument("handbook").media_type);
    expect(await response.text()).toBe("");
  });

  test.each([...listPublicSchemas()])(
    "$served_at honors HEAD and conditional reads without body bytes",
    async (document) => {
      const etag = `"${sha256Hex(document.body)}"`;
      const app = createApp();

      const head = await app.fetch(
        new Request(`https://a.asimposium.org${document.served_at}`, { method: "HEAD" }),
        {} as Env,
        executionContext() as unknown as Parameters<typeof app.fetch>[2],
      );
      expect(head.status).toBe(200);
      expect(head.headers.get("content-type")).toBe(document.media_type);
      expect(head.headers.get("etag")).toBe(etag);
      expect(await head.text()).toBe("");

      const conditional = await app.fetch(
        new Request(`https://a.asimposium.org${document.served_at}`, {
          headers: { "if-none-match": etag },
        }),
        {} as Env,
        executionContext() as unknown as Parameters<typeof app.fetch>[2],
      );
      expect(conditional.status).toBe(304);
      expect(conditional.headers.get("etag")).toBe(etag);
      expect(await conditional.text()).toBe("");
    },
  );

  test("an undeclared schema URL stays a typed route miss", async () => {
    const app = createApp();
    const response = await app.fetch(
      new Request("https://a.asimposium.org/schemas/not-declared.v1.json"),
      {} as Env,
      executionContext() as unknown as Parameters<typeof app.fetch>[2],
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
    expect(await response.json()).toMatchObject({ code: "ROUTE_NOT_FOUND" });
  });

  test("a served-text format typo teaches the only allowed value", async () => {
    const res = await callWorker("/protocol.md?format=json", {});
    expect(res.status).toBe(400);
    expect(res.contentType).toBe("application/problem+json; charset=utf-8");
    expect(res.body).toMatchObject({ code: "UNKNOWN_FORMAT", allowed: ["md"] });
    expect(ProblemDocumentSchema.safeParse(res.body).success).toBe(true);
  });

  test("a schema format typo links to the reachable repair schema", async () => {
    const res = await callWorker("/schemas/enrollment.v1.json?format=markdown", {});
    expect(res.status).toBe(400);
    expect(res.contentType).toBe("application/problem+json; charset=utf-8");
    expect(res.body).toMatchObject({
      code: "UNKNOWN_FORMAT",
      schema: "https://a.asimposium.org/schemas/problem.v1.json",
      example: { method: "GET", path: "/schemas/enrollment.v1.json?format=json" },
      allowed: ["json"],
    });
    expect(ProblemDocumentSchema.safeParse(res.body).success).toBe(true);

    const repair = await callWorker("/schemas/problem.v1.json", {});
    expect(repair.status).toBe(200);
    expect(repair.contentType).toBe("application/schema+json; charset=utf-8");
  });

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
    const res = await callWorker("/internal/health", {
      ARTIFACTS: r2Shaped(),
      KRATER_OUTBOX: outboxShaped(),
    });

    expect(res.status).toBe(503);
    expect(res.contentType).toBe("application/problem+json; charset=utf-8");
    expect(res.bodyText).toBe(BINDING_MISSING);
  });

  test("GET /v1/hello fails closed when the trusted Stoa origin is absent", async () => {
    const res = await callWorker("/v1/hello", boundEnv());

    expect(res.status).toBe(503);
    expect(res.contentType).toBe("application/problem+json; charset=utf-8");
    expect(res.bodyText).toBe(STOA_ORIGIN_UNAVAILABLE);
  });

  test("GET /v1/hello reaches the replay-key configuration check after trusted-origin validation", async () => {
    const res = await callWorker("/v1/hello", trustedStoaEnv());

    expect(res.status).toBe(503);
    expect(res.contentType).toBe("application/problem+json; charset=utf-8");
    expect(res.bodyText).toBe(ENROLLMENT_UNAVAILABLE);
  });

  test("encoded static and malformed dynamic Fellow paths reach the outer enrollment owner", async () => {
    const paths = [
      // Hono 4.13.2 treats this as the mounted POST /v1/fellows/flow route.
      "/v1/fellows/%66low",
      // Runtime-invalid after configuration, but still an owned dynamic shape.
      "/v1/fellows/after/f1.not-a-canonical-cursor",
    ];

    for (const path of paths) {
      const res = await callWorker(path, trustedStoaEnv());
      expect(res.status, path).toBe(503);
      expect(res.body, path).toMatchObject({ code: "ENROLLMENT_UNAVAILABLE", status: 503 });
    }
  });

  test("every mounted Propylon path shape reaches enrollment configuration", async () => {
    const paths = [
      "/join/ASIMP-EN-01JXYZ4K6Q",
      "/v1/device-token",
      "/v1/enrollments",
      "/v1/enrollments/proposals",
      "/v1/enrollments/ASIMP-EN-01JXYZ4K6Q/decision",
      "/v1/fellows",
      "/v1/fellows/after/f1.djF8MTM6MTc4NjgwMDAwMDAwMHwxMzpmZWxsb3ctMDFKWFla",
      // The outer app owns the dynamic shape even when the router will later
      // refuse this runtime-invalid frame before sponsor authentication.
      "/v1/fellows/after/f1.not-a-canonical-cursor",
      "/v1/fellows/credentials/revoke",
      "/v1/fellows/flow",
      // Hono matches decoded static segments; an encoded spelling remains the
      // same owned /flow endpoint rather than falling through the outer app.
      "/v1/fellows/%66low",
      "/v1/fellows/lifecycle",
      "/v1/hello",
      "/v1/sponsors/panic",
      "/v1/%68ello",
      "/join/ASIMP-EN-01JXYZ4K6Q%2Fstill-one-segment",
      "/v1/enrollments/ASIMP-EN-01JXYZ4K6Q%2Fstill-one-segment/decision",
      "/join/%ZZ",
      "/%6aoin/%ZZ",
      "/%6Aoin/%C0",
      "/v1/enrollments/%ZZ/decision",
      "/v1/enrollments/%C0/decision",
      "/v1/fellows/after/%ZZ",
      "/v1/%65nrollments/%ZZ/decision",
      "/%76%31/enrollments/%C0/%64ecision",
    ];

    for (const path of paths) {
      const res = await callWorker(path, trustedStoaEnv());
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
      "/v1/fellows/after/",
      "/v1/fellows/after/f1.cursor/extra",
      "/v1/fellows/%66low/extra",
      "/v1/hello/",
      "/v1/hello%2F",
      "/v1/%2Fhello",
      "/v1/%ZZhello",
    ];

    for (const path of paths) {
      const res = await callWorker(path);
      expect(res.status, path).toBe(404);
      expect(res.contentType, path).toBe("application/problem+json; charset=utf-8");
      expect(res.body, path).toMatchObject({ code: "ROUTE_NOT_FOUND", status: 404 });
    }
  });

  test("an encoded slash cannot manufacture ownership of a static route", async () => {
    const paths = [
      "/v1%2Fhello",
      "/v1/enrollments%2Fproposals",
      "/v1%2fenrollments/proposals",
      "/v1/fellows%2Fflow",
      "/v1/fellows/credentials%2Frevoke",
      "/v1/fellows%2Flifecycle",
      "/v1/fellows/after/f1.cursor%2Ftail",
      "/v1/sponsors%2Fpanic",
    ];

    for (const path of paths) {
      const res = await callWorker(path);
      expect(res.status, path).toBe(404);
      expect(res.body, path).toMatchObject({
        code: "ROUTE_NOT_FOUND",
        title: "No such route",
        detail: `This Worker serves no route at ${path}.`,
      });
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
