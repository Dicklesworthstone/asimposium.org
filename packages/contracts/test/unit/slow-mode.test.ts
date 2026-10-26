import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { RateLimitBudgetSchema } from "../../src/enrollment.ts";
import {
  generateReportsSchema,
  ProblemSlowModeReceiptSchema,
  ProblemSlowModeRequestSchema,
  ProblemSlowModeStateSchema,
} from "../../src/moderation.ts";

const set = JSON.parse(
  readFileSync(new URL("../fixtures/valid/problem-slow-mode-set.json", import.meta.url), "utf8"),
);
const disabled = JSON.parse(
  readFileSync(
    new URL("../fixtures/invalid/problem-slow-mode-disabled.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(JSON.parse(generateReportsSchema()), "reports");

test("temporary controls only tighten, require explicit expiry and never accept caller authority", () => {
  const validate = ajv.compile({ $ref: "reports#/properties/problem_slow_mode_request" });
  const clear = {
    problem_id: set.problem_id,
    action: "clear",
    expected_revision: 1,
    reason: set.reason,
    step_up_authenticated_at: set.step_up_authenticated_at,
  };
  for (const input of [set, clear, { ...set, limit_per_hour: 1 }, { ...set, limit_per_hour: 19 }]) {
    expect(ProblemSlowModeRequestSchema.safeParse(input).success).toBe(true);
    expect(validate(input)).toBe(true);
  }
  for (const input of [
    disabled,
    { ...set, limit_per_hour: 20 },
    { ...set, expires_at: null },
    { ...set, expected_revision: -1 },
    { ...set, actor_id: "operator-test" },
    { ...clear, expires_at: set.expires_at },
    { ...set, step_up_authenticated_at: null },
  ]) {
    expect(ProblemSlowModeRequestSchema.safeParse(input).success).toBe(false);
    expect(validate(input)).toBe(false);
  }
});

test("receipts preserve set/clear meaning in both Zod and the advertised schema", () => {
  const validate = ajv.compile({ $ref: "reports#/properties/problem_slow_mode_receipt" });
  const receipt = {
    problem_id: "P-DEMO",
    event_id: `SM-${"0".repeat(26)}`,
    revision: 1,
    action: "set",
    limit_per_hour: 5,
    expires_at: set.expires_at,
    applied_at: "2026-10-26T11:00:00.000Z",
  };
  for (const input of [
    receipt,
    { ...receipt, action: "clear", limit_per_hour: null, expires_at: null },
  ]) {
    expect(ProblemSlowModeReceiptSchema.safeParse(input).success).toBe(true);
    expect(validate(input)).toBe(true);
  }
  for (const input of [
    { ...receipt, action: "clear" },
    { ...receipt, expires_at: null },
    { ...receipt, limit_per_hour: 0 },
    { ...receipt, reason: "Private operator reason" },
  ]) {
    expect(ProblemSlowModeReceiptSchema.safeParse(input).success).toBe(false);
    expect(validate(input)).toBe(false);
  }
  const visible = {
    event_id: receipt.event_id,
    revision: receipt.revision,
    expires_at: receipt.expires_at,
  };
  expect(
    RateLimitBudgetSchema.safeParse({
      limit: 5,
      remaining: 0,
      window_seconds: 3600,
      slow_mode: visible,
    }).success,
  ).toBe(true);
  expect(
    RateLimitBudgetSchema.safeParse({
      limit: 5,
      remaining: 0,
      window_seconds: 3600,
      slow_mode: { ...visible, reason: "Private operator reason" },
    }).success,
  ).toBe(false);
  expect(
    ProblemSlowModeStateSchema.safeParse({
      problem_id: "P-DEMO",
      revision: 1,
      effective_limit_per_hour: 20,
      slow_mode: null,
    }).success,
  ).toBe(true);
  expect(
    ProblemSlowModeStateSchema.safeParse({
      problem_id: "P-DEMO",
      revision: 1,
      effective_limit_per_hour: 5,
      slow_mode: null,
    }).success,
  ).toBe(false);
});
