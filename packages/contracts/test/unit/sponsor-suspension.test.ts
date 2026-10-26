import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  AdminSponsorSuspensionReceiptSchema,
  AdminSponsorSuspensionRequestSchema,
  AdminSponsorSuspensionStateSchema,
  generateSponsorSuspensionsSchema,
  SponsorSuspensionStatusSchema,
} from "../../src/admin.ts";

const command = JSON.parse(
  readFileSync(new URL("../fixtures/valid/sponsor-suspension.json", import.meta.url), "utf8"),
);
const automatic = JSON.parse(
  readFileSync(
    new URL("../fixtures/invalid/sponsor-suspension-automatic.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(JSON.parse(generateSponsorSuspensionsSchema()), "suspension");

test("only an explicit reviewed-case decision may request suspension; caller authority is rejected", () => {
  const validate = ajv.compile({ $ref: "suspension#/properties/request" });
  expect(AdminSponsorSuspensionRequestSchema.safeParse(command).success).toBe(true);
  expect(validate(command)).toBe(true);
  for (const invalid of [
    automatic,
    { ...command, sponsor_id: "not-a-sponsor" },
    { ...command, expected_revision: 1 },
    { ...command, step_up_authenticated_at: null },
    { ...command, reviewed_case_id: "RP-unreviewed" },
    { ...command, reason: "short" },
    { ...command, operator_id: "usr_forged" },
    { ...command, action: "reinstate" },
  ]) {
    expect(AdminSponsorSuspensionRequestSchema.safeParse(invalid).success).toBe(false);
    expect(validate(invalid)).toBe(false);
  }
});

const receipt = {
  sponsor_id: command.sponsor_id,
  event_id: `SS-${"0".repeat(26)}`,
  audit_event_id: `OA-${"0".repeat(26)}`,
  revision: 1,
  status: "suspended",
  reviewed_case_id: command.reviewed_case_id,
  basis: command.basis,
  applied_at: "2026-10-26T11:00:00.000Z",
  affected: {
    paused_fellows: 3,
    revoked_credentials: 5,
    cancelled_enrollments: 2,
    cancelled_transfers: 1,
  },
};

test("receipts and current state preserve exact target, case, effects and revision", () => {
  const validate = ajv.compile({ $ref: "suspension#/properties/receipt" });
  expect(AdminSponsorSuspensionReceiptSchema.safeParse(receipt).success).toBe(true);
  expect(validate(receipt)).toBe(true);
  for (const value of [
    { ...receipt, reason: "Private rationale" },
    { ...receipt, revision: 0 },
    { ...receipt, status: "active" },
    { ...receipt, affected: { ...receipt.affected, revoked_credentials: -1 } },
  ]) {
    expect(AdminSponsorSuspensionReceiptSchema.safeParse(value).success).toBe(false);
    expect(validate(value)).toBe(false);
  }
  const impact = {
    active_fellows: 0,
    unrevoked_credentials: 0,
    pending_enrollments: 0,
    pending_transfers: 0,
  };
  const state = {
    sponsor_id: command.sponsor_id,
    status: "active",
    revision: 0,
    suspension: null,
    impact,
  };
  const check = ajv.compile({ $ref: "suspension#/properties/state" });
  expect(AdminSponsorSuspensionStateSchema.safeParse(state).success).toBe(true);
  expect(check(state)).toBe(true);
  expect(
    AdminSponsorSuspensionStateSchema.safeParse({ ...state, status: "suspended" }).success,
  ).toBe(false);
  expect(check({ ...state, status: "suspended" })).toBe(false);
});

test("affected sponsors get coarse diagnosis and an appeal affordance without operator evidence", () => {
  const status = {
    sponsor_id: command.sponsor_id,
    status: "suspended",
    suspension: {
      event_id: receipt.event_id,
      audit_event_id: receipt.audit_event_id,
      applied_at: receipt.applied_at,
      appeal: "SPONSOR_APPEAL_AVAILABLE",
    },
  };
  const validate = ajv.compile({ $ref: "suspension#/properties/sponsor_status" });
  expect(SponsorSuspensionStatusSchema.safeParse(status).success).toBe(true);
  expect(validate(status)).toBe(true);
  for (const field of ["reason", "reviewed_case_id", "candidate", "operator_id"]) {
    const leaked = { ...status, suspension: { ...status.suspension, [field]: "private" } };
    expect(SponsorSuspensionStatusSchema.safeParse(leaked).success).toBe(false);
    expect(validate(leaked)).toBe(false);
  }
});
