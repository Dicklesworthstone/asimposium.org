import { expect, test } from "bun:test";

import {
  EnrollmentFlowPollRequestSchema,
  EnrollmentSecretSchema,
  FellowNameSchema,
  FellowRegistrationCredentialFieldsSchema,
  FellowRegistrationRequestSchema,
  MintEnrollmentRequestSchema,
  SponsorEnrollmentDecisionSchema,
} from "../../src/enrollment.ts";

const VALID_FIXTURE = new URL("../fixtures/valid/enrollment.json", import.meta.url);
const INVALID_FIXTURE = new URL(
  "../fixtures/invalid/enrollment-invalid-secret.json",
  import.meta.url,
);
const VALID_MINT_FIXTURE = new URL("../fixtures/valid/enrollment-mint.json", import.meta.url);
const VALID_REDUCE_FIXTURE = new URL("../fixtures/valid/enrollment-reduce.json", import.meta.url);
const INVALID_MINT_FIXTURE = new URL(
  "../fixtures/invalid/enrollment-mint-invalid-budget.json",
  import.meta.url,
);
const INVALID_REDUCE_FIXTURE = new URL(
  "../fixtures/invalid/enrollment-reduce-empty.json",
  import.meta.url,
);

async function fixture(url: URL): Promise<unknown> {
  try {
    return JSON.parse(await Bun.file(url).text()) as unknown;
  } catch {
    throw new Error("synthetic enrollment fixture is not valid JSON");
  }
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

test("credential fields remain inspectable for teachable names while malformed secrets stay invalid", () => {
  const body = {
    enrollment_id: "ASIMP-EN-7F3K9M2Q8R",
    secret: "v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    name: "codex-lab",
    model: "test-model",
    harness: "test-harness",
  };
  expect(FellowRegistrationCredentialFieldsSchema.safeParse(body).success).toBe(true);
  expect(
    FellowRegistrationCredentialFieldsSchema.safeParse({ ...body, secret: "v1.short" }).success,
  ).toBe(false);
});

test("Fellow names and availability suggestions share no-trailing-hyphen semantics", () => {
  expect(FellowNameSchema.safeParse("orchid-vector").success).toBe(true);
  expect(FellowNameSchema.safeParse("orchid-").success).toBe(false);
  expect(
    FellowRegistrationRequestSchema.safeParse({
      enrollment_id: "ASIMP-EN-7F3K9M2Q8R",
      secret: "v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      name: "orchid-",
      model: "test-model",
      harness: "test-harness",
    }).success,
  ).toBe(false);
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
    SponsorEnrollmentDecisionSchema.safeParse({
      decision: "reduce",
      reduction: { scopes: ["review"] },
    }).success,
  ).toBe(true);
  expect(SponsorEnrollmentDecisionSchema.safeParse({ decision: "deny" }).success).toBe(true);
  expect(
    SponsorEnrollmentDecisionSchema.safeParse({ decision: "reduce", reduction: {} }).success,
  ).toBe(false);
});

test("minting includes bounded optional problem, directive, budget, and expiry grants", () => {
  const valid = MintEnrollmentRequestSchema.safeParse({
    requested_scopes: ["promote", "review"],
    problem_binding: "P-4DSP",
    first_directive: "Test the stated falsifier before promotion.",
    event_budget: 12,
    artifact_budget_bytes: 4_096,
    fellow_grant_expires_in_ms: 86_400_000,
    expires_in_ms: 1_800_000,
  });
  expect(valid.success).toBe(true);

  expect(
    MintEnrollmentRequestSchema.safeParse({
      requested_scopes: ["review"],
      event_budget: 10_001,
    }).success,
  ).toBe(false);
  expect(
    MintEnrollmentRequestSchema.safeParse({
      requested_scopes: ["review"],
      artifact_budget_bytes: -1,
    }).success,
  ).toBe(false);
});

test("resource-grant fixtures prove strict mint and reduce contract boundaries", async () => {
  expect(MintEnrollmentRequestSchema.safeParse(await fixture(VALID_MINT_FIXTURE)).success).toBe(
    true,
  );
  expect(
    SponsorEnrollmentDecisionSchema.safeParse(await fixture(VALID_REDUCE_FIXTURE)).success,
  ).toBe(true);
  expect(MintEnrollmentRequestSchema.safeParse(await fixture(INVALID_MINT_FIXTURE)).success).toBe(
    false,
  );
  expect(
    SponsorEnrollmentDecisionSchema.safeParse(await fixture(INVALID_REDUCE_FIXTURE)).success,
  ).toBe(false);
});
