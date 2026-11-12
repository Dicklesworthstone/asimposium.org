import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  SPONSOR_WORKSHOP_CURSOR_MAX_RESPONSE_BYTES,
  SponsorWorkshopCursorRequestSchema,
  SponsorWorkshopCursorResponseSchema,
} from "../../src/sessions.ts";

test("private workshop cursor wire shapes agree in Zod and published JSON Schema", async () => {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const document = await Bun.file(
    new URL("../../generated/sessions.schema.json", import.meta.url),
  ).json();
  ajv.addSchema(document, "sessions");
  const request = { problem_id: "P-4DSP", fellow_id: "fellow-owner" };
  const response = {
    schema: "https://a.asimposium.org/schemas/sessions.v1.json",
    sponsor_id: "usr_owner",
    ...request,
    workshop_cursor: 0,
  };
  for (const [property, schema, valid, invalid] of [
    [
      "sponsor_workshop_cursor_request",
      SponsorWorkshopCursorRequestSchema,
      [request],
      [
        null,
        [],
        {},
        { problem_id: request.problem_id },
        { ...request, problem_id: "../private" },
        { ...request, fellow_id: "" },
        { ...request, fellow_id: "x".repeat(81) },
        { ...request, sponsor_id: "usr_other" },
        { ...request, before_workshop_seq: 4 },
        { ...request, body_md: "private content" },
      ],
    ],
    [
      "sponsor_workshop_cursor_response",
      SponsorWorkshopCursorResponseSchema,
      [response, { ...response, workshop_cursor: Number.MAX_SAFE_INTEGER }],
      [
        { ...response, schema: "https://example.com/private.json" },
        { ...response, sponsor_id: "other" },
        { ...response, workshop_cursor: -1 },
        { ...response, workshop_cursor: 0.5 },
        { ...response, workshop_cursor: Number.MAX_SAFE_INTEGER + 1 },
        { ...response, workshop_cursor: "1" },
        { ...response, objects: [] },
        { ...response, title: "private title" },
        { ...response, body_md: "private body" },
        { ...response, cas_hash: "private digest" },
        { ...response, token: "private bearer" },
      ],
    ],
  ] as const) {
    const validate = ajv.compile({ $ref: `sessions#/properties/${property}` });
    for (const value of valid) {
      expect(schema.safeParse(value).success).toBe(true);
      expect(validate(value)).toBe(true);
    }
    for (const value of invalid) {
      expect(schema.safeParse(value).success).toBe(false);
      expect(validate(value)).toBe(false);
    }
  }

  const bounded = SponsorWorkshopCursorResponseSchema.parse({
    ...response,
    sponsor_id: `usr_${"x".repeat(60)}`,
    fellow_id: "x".repeat(80),
    problem_id: `P-${"A".repeat(31)}`,
    workshop_cursor: Number.MAX_SAFE_INTEGER,
  });
  expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThanOrEqual(
    SPONSOR_WORKSHOP_CURSOR_MAX_RESPONSE_BYTES,
  );
});
