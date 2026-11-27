import { expect, test } from "bun:test";
import { getPublicSchemaSlice } from "@asimposium/contracts/public-schemas";
import { Hono } from "hono";
import {
  narrowSessionRefusalSchema,
  SESSION_REQUEST_SCHEMA_PROPERTIES,
  SESSIONS_SCHEMA_URL,
  sessionRequestSchemaUrl,
} from "../../src/sessions/refusal-schema";

test("every mapped session route resolves to a served slice", () => {
  for (const property of SESSION_REQUEST_SCHEMA_PROPERTIES) {
    expect(getPublicSchemaSlice(`/schemas/sessions.v1/${property}.json`), property).toBeDefined();
  }
  expect(sessionRequestSchemaUrl("POST", "/v1/sessions/S-1/promote")).toBe(
    "https://a.asimposium.org/schemas/sessions.v1/promote_request.json",
  );
  expect(sessionRequestSchemaUrl("POST", "/v1/sessions/S-1/workshop")).toBe(
    "https://a.asimposium.org/schemas/sessions.v1/workshop_push_request.json",
  );
  expect(sessionRequestSchemaUrl("GET", "/v1/sessions/S-1/promote")).toBeUndefined();
  expect(sessionRequestSchemaUrl("POST", "/v1/sessions/S-1/promote/extra")).toBeUndefined();
  for (const route of ["review", "reviews", "evidence"]) {
    expect(sessionRequestSchemaUrl("POST", `/v1/p/P-4DSP/${route}`)).toBe(
      `https://a.asimposium.org/schemas/sessions.v1/${route === "evidence" ? "evidence" : "review"}_request.json`,
    );
    expect(sessionRequestSchemaUrl("GET", `/v1/p/P-4DSP/${route}`)).toBeUndefined();
    expect(sessionRequestSchemaUrl("POST", `/v1/p/P-4DSP/${route}/extra`)).toBeUndefined();
  }
});

function appReturning(
  body: Record<string, unknown>,
  status = 422,
  type = "application/problem+json; charset=utf-8",
) {
  const app = new Hono();
  app.use("/v1/sessions/*", narrowSessionRefusalSchema);
  app.post(
    "/v1/sessions/:id/workshop",
    () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": type, "x-keep": "1" },
      }),
  );
  app.post(
    "/v1/sessions/:id/promote",
    () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": type, "x-keep": "1" },
      }),
  );
  return app;
}

test("a whole-document schema link on a refusal is narrowed and nothing else changes", async () => {
  const refusal = {
    type: "about:blank",
    status: 422,
    code: "X",
    schema: SESSIONS_SCHEMA_URL,
    fix_hint: "f",
  };
  const response = await appReturning(refusal).request("/v1/sessions/S-1/promote", {
    method: "POST",
  });
  expect(response.status).toBe(422);
  expect(response.headers.get("x-keep")).toBe("1");
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toEqual({
    ...refusal,
    schema: "https://a.asimposium.org/schemas/sessions.v1/promote_request.json",
  });
  // No stale length survives the rewrite.
  const length = response.headers.get("content-length");
  expect(length === null || Number(length) === JSON.stringify(body).length).toBe(true);
  // Key order is preserved: schema stays where the refusal put it.
  expect(Object.keys(body)).toEqual(Object.keys(refusal));
});

test("success bodies, other schema links and non-problem responses are untouched", async () => {
  const fragment = `${SESSIONS_SCHEMA_URL}#/properties/promote_request`;
  for (const [body, status, type] of [
    [{ schema: SESSIONS_SCHEMA_URL }, 201, "application/json"],
    [{ schema: fragment }, 422, "application/problem+json"],
    [{ schema: SESSIONS_SCHEMA_URL }, 500, "application/problem+json"],
    [{ schema: SESSIONS_SCHEMA_URL }, 409, "application/problem+json"],
    [{ schema: SESSIONS_SCHEMA_URL }, 404, "application/problem+json"],
    [{ schema: SESSIONS_SCHEMA_URL }, 422, "application/json"],
  ] as const) {
    const response = await appReturning({ ...body }, status, type).request(
      "/v1/sessions/S-1/promote",
      {
        method: "POST",
      },
    );
    expect(((await response.json()) as { schema: string }).schema).toBe(body.schema);
  }
});

test("first-claim and saved-draft recovery refusals link the precise served request shape", async () => {
  for (const [path, example, property] of [
    [
      "/v1/sessions/S-1/workshop",
      { type: "claim-draft", title: "Conjecture", body_md: "A falsifiable claim." },
      "first_claim_draft_request",
    ],
    [
      "/v1/sessions/S-1/promote",
      { workshop_id: "W-123", expected_workshop_version: 1 },
      "promote_saved_draft_request",
    ],
  ] as const) {
    const response = await appReturning({
      status: 422,
      code: "SCHEMA_INVALID",
      schema: SESSIONS_SCHEMA_URL,
      example,
      fix_hint: "Correct the request and retry with the same key.",
    }).request(path, { method: "POST" });
    const problem = (await response.json()) as Record<string, unknown>;
    expect(problem.schema).toBe(`https://a.asimposium.org/schemas/sessions.v1/${property}.json`);
    expect(problem.example).toEqual(example);
    expect(response.headers.get("x-keep")).toBe("1");
  }
});

test("ambiguous or unrelated recovery examples retain the generic route schema", async () => {
  for (const [path, example, property] of [
    ["/v1/sessions/S-1/promote", { kind: "conjecture", statement: "A", workshop_id: "W-1" }, "promote_request"],
    ["/v1/sessions/S-1/promote", { workshop_id: 123 }, "promote_request"],
    ["/v1/sessions/S-1/workshop", { type: "research-note" }, "workshop_push_request"],
    ["/v1/sessions/S-1/workshop", { type: "claim-draft" }, "first_claim_draft_request"],
  ] as const) {
    const response = await appReturning({
      schema: SESSIONS_SCHEMA_URL,
      example,
    }).request(path, { method: "POST" });
    const problem = (await response.json()) as Record<string, unknown>;
    expect(problem.schema).toBe(`https://a.asimposium.org/schemas/sessions.v1/${property}.json`);
  }
});

test("problem-level review and evidence refusals receive route-specific slices", async () => {
  const app = new Hono();
  app.use("/v1/p/*", narrowSessionRefusalSchema);
  app.post("/v1/p/:id/review", () =>
    Response.json(
      { status: 422, code: "SCHEMA_INVALID", schema: SESSIONS_SCHEMA_URL },
      { status: 422, headers: { "content-type": "application/problem+json" } },
    ),
  );
  app.post("/v1/p/:id/evidence", () =>
    Response.json(
      { status: 400, code: "SCHEMA_INVALID", schema: SESSIONS_SCHEMA_URL },
      { status: 400, headers: { "content-type": "application/problem+json" } },
    ),
  );
  for (const [path, shape] of [
    ["/v1/p/P-1/review", "review_request"],
    ["/v1/p/P-1/evidence", "evidence_request"],
  ] as const) {
    const response = await app.request(path, { method: "POST" });
    expect(response.status).toBe(path.endsWith("/review") ? 422 : 400);
    const refusal = (await response.json()) as Record<string, unknown>;
    expect(refusal.schema).toBe(`https://a.asimposium.org/schemas/sessions.v1/${shape}.json`);
    expect(refusal.code).toBe("SCHEMA_INVALID");
  }
});
