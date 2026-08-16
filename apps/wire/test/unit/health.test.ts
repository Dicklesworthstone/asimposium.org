import { describe, expect, test } from "bun:test";
import { HEALTH_SCHEMA } from "../../src/http/health";
import { boundEnv, callWorker, d1Shaped, outboxShaped, r2Shaped } from "../support/bindings";

describe("GET /internal/health", () => {
  test("serves the success envelope when every binding is present", async () => {
    const res = await callWorker("/internal/health");

    expect(res.status).toBe(200);
    expect(res.contentType).toBe("application/json; charset=utf-8");
    expect(res.body).toEqual({
      schema: HEALTH_SCHEMA,
      ok: true,
      data: {
        service: "wire",
        role: "stoa",
        format: "json",
        bindings: {
          DB: "bound",
          ARTIFACTS: "bound",
          PUBLIC_ARTIFACTS: "bound",
          KRATER_OUTBOX: "bound",
        },
      },
      degraded: [],
      next_actions: [],
    });
  });

  test("is byte-deterministic: same env, same bytes", async () => {
    const first = await callWorker("/internal/health", boundEnv());
    const second = await callWorker("/internal/health", boundEnv());

    expect(first.bodyText).toBe(second.bodyText);
    // Guard against a future timestamp/nonce creeping into the body.
    expect(first.bodyText).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test("accepts the one format it serves", async () => {
    const res = await callWorker("/internal/health?format=json");

    expect(res.status).toBe(200);
    expect((res.body as { data: { format: string } }).data.format).toBe("json");
  });

  // PLANTED NEGATIVE 1 — malformed input must fail closed with a stable code.
  test("refuses an unknown ?format= with UNKNOWN_FORMAT and the allowed list", async () => {
    const res = await callWorker("/internal/health?format=yaml");

    expect(res.status).toBe(400);
    expect(res.contentType).toBe("application/problem+json; charset=utf-8");
    expect(res.body).toMatchObject({
      type: "https://asimposium.org/errors/UNKNOWN_FORMAT",
      status: 400,
      code: "UNKNOWN_FORMAT",
      rule: "A5",
      schema: "https://a.asimposium.org/schemas/problem.v1.json",
      example: { method: "GET", path: "/internal/health?format=json" },
      allowed: ["json"],
    });
    expect((res.body as { fix_hint: string }).fix_hint.length).toBeGreaterThan(0);
    // Never silent-fail: it must not quietly serve the default instead.
    expect(res.bodyText).not.toContain('"ok":true');
  });

  // PLANTED NEGATIVE 2 — an absent binding must fail closed, not report healthy.
  test("reports 503 BINDING_MISSING when D1 is not bound", async () => {
    const res = await callWorker("/internal/health", {
      ARTIFACTS: r2Shaped(),
      PUBLIC_ARTIFACTS: r2Shaped(),
      KRATER_OUTBOX: outboxShaped(),
    });

    expect(res.status).toBe(503);
    expect(res.contentType).toBe("application/problem+json; charset=utf-8");
    expect(res.body).toMatchObject({
      code: "BINDING_MISSING",
      missing: ["DB"],
      bindings: {
        DB: "missing",
        ARTIFACTS: "bound",
        PUBLIC_ARTIFACTS: "bound",
        KRATER_OUTBOX: "bound",
      },
    });
  });

  // PLANTED NEGATIVE 3 — present-but-wrong-shaped is the failure mode a null
  // check would miss: a stale config or a var shadowing a binding name.
  test("reports 503 BINDING_MISSING when a binding is present but not a handle", async () => {
    const res = await callWorker("/internal/health", {
      DB: d1Shaped(),
      ARTIFACTS: { name: "asimp-cas" },
      PUBLIC_ARTIFACTS: r2Shaped(),
      KRATER_OUTBOX: outboxShaped(),
    });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: "BINDING_MISSING",
      missing: ["ARTIFACTS"],
      bindings: {
        DB: "bound",
        ARTIFACTS: "missing",
        PUBLIC_ARTIFACTS: "bound",
        KRATER_OUTBOX: "bound",
      },
    });
  });

  // PLANTED NEGATIVE 4 — the public delivery bucket is independently
  // required, and its value must never be reflected by the coarse face.
  test("refuses a missing PUBLIC_ARTIFACTS binding without disclosing a bucket value", async () => {
    const res = await callWorker("/internal/health", {
      DB: d1Shaped(),
      ARTIFACTS: r2Shaped(),
      KRATER_OUTBOX: outboxShaped(),
    });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: "BINDING_MISSING",
      missing: ["PUBLIC_ARTIFACTS"],
      bindings: {
        DB: "bound",
        ARTIFACTS: "bound",
        PUBLIC_ARTIFACTS: "missing",
        KRATER_OUTBOX: "bound",
      },
    });
  });

  test("refuses a wrong-shaped PUBLIC_ARTIFACTS binding without echoing it", async () => {
    const bucketValue = "asimposium-public-untrusted-handle";
    const res = await callWorker("/internal/health", {
      DB: d1Shaped(),
      ARTIFACTS: r2Shaped(),
      PUBLIC_ARTIFACTS: { bucket_name: bucketValue },
      KRATER_OUTBOX: outboxShaped(),
    });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: "BINDING_MISSING",
      missing: ["PUBLIC_ARTIFACTS"],
    });
    expect(res.bodyText).not.toContain(bucketValue);
  });

  test("reports every missing binding at once, in declaration order", async () => {
    const res = await callWorker("/internal/health", {});

    expect(res.status).toBe(503);
    expect((res.body as { missing: string[] }).missing).toEqual([
      "DB",
      "ARTIFACTS",
      "PUBLIC_ARTIFACTS",
      "KRATER_OUTBOX",
    ]);
  });

  test("validates format before bindings, so a bad request is a 400 not a 503", async () => {
    const res = await callWorker("/internal/health?format=yaml", {});

    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("UNKNOWN_FORMAT");
  });
});

describe("routing", () => {
  test("an unknown path is a problem+json 404 that names the route that exists", async () => {
    const res = await callWorker("/not-a-route");

    expect(res.status).toBe(404);
    expect(res.contentType).toBe("application/problem+json; charset=utf-8");
    expect(res.body).toMatchObject({ code: "ROUTE_NOT_FOUND", status: 404 });
    expect((res.body as { detail: string }).detail).toContain("/not-a-route");
    expect((res.body as { fix_hint: string }).fix_hint).toContain("/internal/health");
  });
});
