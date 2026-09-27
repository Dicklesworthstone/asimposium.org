import { expect, test } from "bun:test";
import { ContractProblemSchema } from "@asimposium/contracts";
import { createApp } from "../../src/app";

const ENV = { STOA_ORIGIN: "https://a.asimposium.org", AGORA_ORIGIN: "https://asimposium.org" };
const get = (path: string, method = "GET") =>
  createApp().request(`https://a.asimposium.org${path}`, { method }, ENV);

test("a slice guessed in the wrong document teaches the right slice", async () => {
  const response = await get("/schemas/sessions.v1/protocol_ack_request.json");
  expect(response.status).toBe(404);
  const body = (await response.json()) as Record<string, unknown>;
  expect(ContractProblemSchema.safeParse(body).success).toBe(true);
  expect(body.code).toBe("SCHEMA_SLICE_NOT_FOUND");
  expect(String(body.fix_hint)).toContain("/schemas/enrollment.v1/protocol_ack_request.json");
  expect(body.example).toEqual({
    method: "GET",
    path: "/schemas/enrollment.v1/protocol_ack_request.json",
  });
  // The taught path is served.
  expect((await get("/schemas/enrollment.v1/protocol_ack_request.json")).status).toBe(200);
});

test("an unknown slice name points at the index, never at a whole document", async () => {
  const body = (await (await get("/schemas/sessions.v1/no_such_request.json")).json()) as Record<
    string,
    unknown
  >;
  expect(body.code).toBe("SCHEMA_SLICE_NOT_FOUND");
  expect(String(body.fix_hint)).toContain("/schemas/index.json");
  expect(JSON.stringify(body)).not.toContain("sessions.v1.json");
});

test("HEAD on a missing slice carries no body", async () => {
  const response = await get("/schemas/sessions.v1/no_such_request.json", "HEAD");
  expect(response.status).toBe(404);
  expect((await response.arrayBuffer()).byteLength).toBe(0);
});

test("a near guess in the right document is sent to the real name", async () => {
  for (const [guess, real] of [
    ["workshop_request", "workshop_push_request"],
    ["close_request", "session_close_request"],
  ]) {
    const body = (await (await get(`/schemas/sessions.v1/${guess}.json`)).json()) as Record<
      string,
      unknown
    >;
    expect(body.code).toBe("SCHEMA_SLICE_NOT_FOUND");
    expect(body.example).toEqual({ method: "GET", path: `/schemas/sessions.v1/${real}.json` });
    expect(String(body.fix_hint)).toContain(`/schemas/sessions.v1/${real}.json`);
  }
});
