import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  problemHideAuthIsRecent,
  SponsorProblemHideReceiptSchema,
  SponsorProblemHideRequestSchema,
} from "../../src/problem-hiding.ts";

const command = {
  problem_id: "P-HIDE",
  reason: "Withdraw this problem from public display.",
  step_up_authenticated_at: 1794398400,
};
const receipt = {
  ok: true,
  problem_id: "P-HIDE",
  action: "hide",
  visibility: "hidden",
  actor_kind: "sponsor",
  control_id: `CC-${"0".repeat(26)}`,
  version: 1,
  applied_at: "2026-11-11T12:00:00.000Z",
};
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(
  JSON.parse(
    readFileSync(new URL("../../generated/problems.schema.json", import.meta.url), "utf8"),
  ),
  "problems",
);

test("the runtime and advertised hide contract reject authority and scientific overrides", () => {
  const validate = ajv.compile({ $ref: "problems#/properties/sponsor_problem_hide_request" });
  expect(SponsorProblemHideRequestSchema.safeParse(command).success).toBe(true);
  expect(validate(command)).toBe(true);
  for (const input of [
    { ...command, reason: "" },
    { ...command, reason: "x".repeat(1001) },
    { ...command, step_up_authenticated_at: -1 },
    { ...command, step_up_authenticated_at: 0.5 },
    { ...command, step_up_authenticated_at: Number.MAX_SAFE_INTEGER + 1 },
    { ...command, problem_id: "../other" },
    { ...command, actor_kind: "operator" },
    { ...command, sponsor_id: "usr_other" },
    { ...command, action: "restore" },
    { ...command, disposition: "proved" },
  ]) {
    expect(SponsorProblemHideRequestSchema.safeParse(input).success).toBe(false);
    expect(validate(input)).toBe(false);
  }
  expect(SponsorProblemHideRequestSchema.safeParse({ ...command, reason: "   " }).success).toBe(
    false,
  );
});

test("strict receipts identify sponsor authority without publishing the private reason", () => {
  const validate = ajv.compile({ $ref: "problems#/properties/sponsor_problem_hide_receipt" });
  expect(SponsorProblemHideReceiptSchema.safeParse(receipt).success).toBe(true);
  expect(validate(receipt)).toBe(true);
  for (const input of [
    { ...receipt, reason: "Private reason" },
    { ...receipt, actor_kind: "operator" },
    { ...receipt, action: "restore" },
    { ...receipt, visibility: "visible" },
    { ...receipt, control_id: "OA-not-a-control" },
    { ...receipt, version: 0 },
  ]) {
    expect(SponsorProblemHideReceiptSchema.safeParse(input).success).toBe(false);
    expect(validate(input)).toBe(false);
  }
});

test("both planes use the same inclusive 15-minute freshness window and 60-second skew", () => {
  const now = 10000;
  for (const issuedAt of [now, now + 60, now - 900, now - 960]) {
    expect(problemHideAuthIsRecent(issuedAt, now)).toBe(true);
  }
  for (const issuedAt of [
    undefined,
    now + 61,
    now - 961,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    expect(problemHideAuthIsRecent(issuedAt, now)).toBe(false);
  }
  expect(problemHideAuthIsRecent(now, Number.NaN)).toBe(false);
  expect(problemHideAuthIsRecent(now, -1)).toBe(false);
});
