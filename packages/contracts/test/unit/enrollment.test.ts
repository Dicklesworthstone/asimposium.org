import { expect, test } from "bun:test";

import {
  EnrollmentFlowPollRequestSchema,
  EnrollmentSecretSchema,
  FellowRegistrationRequestSchema,
  SponsorEnrollmentDecisionSchema,
} from "../../src/enrollment.ts";

const VALID_FIXTURE = new URL("../fixtures/valid/enrollment.json", import.meta.url);
const INVALID_FIXTURE = new URL(
  "../fixtures/invalid/enrollment-invalid-secret.json",
  import.meta.url,
);

async function fixture(url: URL): Promise<unknown> {
  return JSON.parse(await Bun.file(url).text()) as unknown;
}

test("the body-only Fellow registration contract accepts the synthetic valid fixture", async () => {
  const parsed = FellowRegistrationRequestSchema.safeParse(await fixture(VALID_FIXTURE));

  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(Object.keys(parsed.data).sort()).toEqual([
      "enrollment_id",
      "harness",
      "model",
      "name",
      "reasoning_effort",
      "secret",
      "tools_note",
    ]);
  }
});

test("planted malformed enrollment secret is rejected", async () => {
  const parsed = FellowRegistrationRequestSchema.safeParse(await fixture(INVALID_FIXTURE));

  expect(parsed.success).toBe(false);
  expect(EnrollmentSecretSchema.safeParse("v1.short").success).toBe(false);
});

test("flow polling accepts only the high-entropy handle in a JSON body", () => {
  const handle = "flow_v1.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  expect(EnrollmentFlowPollRequestSchema.safeParse({ flow_handle: handle }).success).toBe(true);
  expect(
    EnrollmentFlowPollRequestSchema.safeParse({
      flow_handle: handle,
      proposal_id: "proposal-should-not-be-a-poll-credential",
    }).success,
  ).toBe(false);
});

test("only a strict sponsor decision can approve, reduce, or deny", () => {
  expect(SponsorEnrollmentDecisionSchema.safeParse({ decision: "approve" }).success).toBe(true);
  expect(
    SponsorEnrollmentDecisionSchema.safeParse({ decision: "reduce", scopes: ["review"] }).success,
  ).toBe(true);
  expect(SponsorEnrollmentDecisionSchema.safeParse({ decision: "deny" }).success).toBe(true);
  expect(
    SponsorEnrollmentDecisionSchema.safeParse({ decision: "approve", scopes: ["review"] }).success,
  ).toBe(false);
});
