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
});

function appReturning(
  body: Record<string, unknown>,
  status = 422,
  type = "application/problem+json; charset=utf-8",
) {
  const app = new Hono();
  app.use("/v1/sessions/*", narrowSessionRefusalSchema);
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
