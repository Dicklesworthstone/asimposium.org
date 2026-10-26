import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  ProblemAccessActionReceiptSchema,
  SponsorProblemGovernanceQuerySchema,
  SponsorProblemGovernanceResponseSchema,
} from "../../src/problems.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/valid/problems-governance.json", import.meta.url), "utf8"),
);
const artifacts = JSON.parse(
  readFileSync(new URL("../../generated/problems.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ strict: true });
addFormats(ajv);

test("the governance contract bounds membership pages and discloses current authority without private runtime material", () => {
  const published = ajv.compile(artifacts.properties.governance_response);
  expect(SponsorProblemGovernanceResponseSchema.safeParse(fixture).success).toBe(true);
  expect(published(fixture)).toBe(true);
  expect(SponsorProblemGovernanceQuerySchema.safeParse({ after: "F-ACCESS" }).success).toBe(true);
  expect(SponsorProblemGovernanceQuerySchema.safeParse({ after: "" }).success).toBe(false);
  expect(SponsorProblemGovernanceQuerySchema.safeParse({ sponsor_id: "usr_other" }).success).toBe(
    false,
  );
  for (const patch of [
    { has_more: true, next_after: null },
    { member_counts: { total: 2, observer: 1, contributor: 0, steward: 0 } },
    { authority: { owner: false, steward: false, can_edit_access: true } },
    { members: [...fixture.members, ...fixture.members] },
    { members: [{ ...fixture.members[0], token: "private-credential" }] },
  ])
    expect(SponsorProblemGovernanceResponseSchema.safeParse({ ...fixture, ...patch }).success).toBe(
      false,
    );
  const excessive = {
    ...fixture,
    members: Array.from({ length: 101 }, (_, index) => ({
      ...fixture.members[0],
      fellow_id: `F-${index}`,
    })),
  };
  expect(SponsorProblemGovernanceResponseSchema.safeParse(excessive).success).toBe(false);
  expect(published(excessive)).toBe(false);
});

test("access receipts bind exact modes or member actions without granting a steward role", () => {
  const published = ajv.compile(artifacts.properties.access_action_receipt);
  const base = {
    problem_id: "P-ACCESS",
    acting_sponsor_id: "usr_steward",
    updated_at: "2026-10-26T12:00:00.000Z",
    event_id: null,
  };
  for (const action of [
    { action: "set-admission-mode", mode: "invite-only" },
    {
      action: "manage-member",
      operation: "set-role",
      target_fellow_id: "F-ACCESS",
      role: "observer",
    },
    { action: "manage-member", operation: "remove", target_fellow_id: "F-ACCESS", role: null },
  ]) {
    expect(ProblemAccessActionReceiptSchema.safeParse({ ...base, ...action }).success).toBe(true);
    expect(published({ ...base, ...action })).toBe(true);
  }
  const invalid = JSON.parse(
    readFileSync(
      new URL("../fixtures/invalid/problems-access-receipt.json", import.meta.url),
      "utf8",
    ),
  );
  expect(ProblemAccessActionReceiptSchema.safeParse(invalid).success).toBe(false);
  expect(published(invalid)).toBe(false);
  expect(
    ProblemAccessActionReceiptSchema.safeParse({
      ...invalid,
      operation: "remove",
      role: "observer",
    }).success,
  ).toBe(false);
});
