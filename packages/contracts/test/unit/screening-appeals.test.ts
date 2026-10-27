import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  generateScreeningAppealsSchema,
  SCREENING_APPEALS_SCHEMA_ID,
  ScreeningAppealDecisionSchema,
  ScreeningAppealRequestSchema,
  SponsorScreeningCasesResponseSchema,
} from "../../src/appeals.ts";

test("served screening appeal schema and Zod agree on human commands and reject authority overrides", async () => {
  const schema = JSON.parse(generateScreeningAppealsSchema());
  expect(schema.$id).toBe(SCREENING_APPEALS_SCHEMA_ID);
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema(schema, "appeals");
  for (const [property, zod, valid, invalid] of [
    [
      "request",
      ScreeningAppealRequestSchema,
      "screening-appeal-request",
      "screening-appeal-request-identity",
    ],
    [
      "decision",
      ScreeningAppealDecisionSchema,
      "screening-appeal-decision",
      "screening-appeal-decision-override",
    ],
  ] as const) {
    const validate = ajv.compile({ $ref: `appeals#/properties/${property}` });
    for (const [directory, file, expected] of [
      ["valid", valid, true],
      ["invalid", invalid, false],
    ] as const) {
      const value = JSON.parse(
        await Bun.file(new URL(`../fixtures/${directory}/${file}.json`, import.meta.url)).text(),
      );
      expect(zod.safeParse(value).success).toBe(expected);
      expect(validate(value)).toBe(expected);
    }
  }
});

test("sponsor case summaries cannot disclose held bytes, model labels or private rationale", () => {
  const item = {
    case_id: `QC-${"0".repeat(26)}`,
    problem_id: "P-APPEAL",
    fellow_id: "fellow-appeal",
    route: "promote",
    state: "rejected",
    created_at: "2026-10-27T12:00:00.000Z",
    appeal: null,
  };
  expect(
    SponsorScreeningCasesResponseSchema.safeParse({ cases: [item], has_more: false }).success,
  ).toBe(true);
  for (const extra of [
    { candidate: "private candidate" },
    { category: "injection" },
    { decision_reason: "private reason" },
    { model_version: "provider/model" },
    { configuration_digest: "a".repeat(64) },
  ])
    expect(
      SponsorScreeningCasesResponseSchema.safeParse({
        cases: [{ ...item, ...extra }],
        has_more: false,
      }).success,
    ).toBe(false);
});
