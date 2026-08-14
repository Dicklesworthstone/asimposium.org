import { expect, test } from "bun:test";

import {
  EnrollmentFlowPollRequestSchema,
  EnrollmentSecretSchema,
  FellowNameSchema,
  FellowRegistrationCredentialFieldsSchema,
  FellowRegistrationRequestSchema,
  MintEnrollmentRequestSchema,
  MintEnrollmentResponseSchema,
  SponsorEnrollmentDecisionResponseSchema,
  SponsorEnrollmentDecisionSchema,
  SponsorFellowListResponseSchema,
  SponsorProposalListResponseSchema,
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
const VALID_DECISION_FIXTURE = new URL(
  "../fixtures/valid/enrollment-decision-approve.json",
  import.meta.url,
);
const INVALID_DECISION_TARGET_FIXTURE = new URL(
  "../fixtures/invalid/enrollment-decision-missing-target.json",
  import.meta.url,
);

/** The synthetic enrollment every decision fixture in this suite decides. */
const DECISION_TARGET = "ASIMP-EN-01JXYZ4K6Q";

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

test("Fellow names match the exact Fable §5.4 naming law", () => {
  for (const name of ["abc", "orchid-vector", "orchid-"])
    expect(FellowNameSchema.safeParse(name).success).toBe(true);
  for (const name of ["ab", "Orchid", "-orchid", "orchid_vector", "a".repeat(33)])
    expect(FellowNameSchema.safeParse(name).success).toBe(false);
  expect(
    FellowRegistrationRequestSchema.safeParse({
      enrollment_id: "ASIMP-EN-7F3K9M2Q8R",
      secret: "v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      name: "orchid-",
      model: "test-model",
      harness: "test-harness",
    }).success,
  ).toBe(true);
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
  expect(
    SponsorEnrollmentDecisionSchema.safeParse({
      enrollment_id: DECISION_TARGET,
      decision: "approve",
    }).success,
  ).toBe(true);
  expect(
    SponsorEnrollmentDecisionSchema.safeParse({
      enrollment_id: DECISION_TARGET,
      decision: "reduce",
      reduction: { scopes: ["review"] },
    }).success,
  ).toBe(true);
  expect(
    SponsorEnrollmentDecisionSchema.safeParse({ enrollment_id: DECISION_TARGET, decision: "deny" })
      .success,
  ).toBe(true);
  expect(
    SponsorEnrollmentDecisionSchema.safeParse({
      enrollment_id: DECISION_TARGET,
      decision: "reduce",
      reduction: {},
    }).success,
  ).toBe(false);
});

test("a sponsor decision cannot omit or malform the enrollment it decides", () => {
  // The signed body is the only place the concrete target is covered by the
  // envelope signature; an untargeted decision must never parse.
  for (const decision of ["approve", "deny"] as const) {
    expect(SponsorEnrollmentDecisionSchema.safeParse({ decision }).success).toBe(false);
  }
  expect(
    SponsorEnrollmentDecisionSchema.safeParse({
      decision: "reduce",
      reduction: { scopes: ["review"] },
    }).success,
  ).toBe(false);
  for (const target of ["", "not-an-enrollment", "ASIMP-EN-", "asimp-en-01JXYZ4K6Q"]) {
    expect(
      SponsorEnrollmentDecisionSchema.safeParse({ enrollment_id: target, decision: "approve" })
        .success,
    ).toBe(false);
  }
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

test("decision fixtures prove the enrollment target is mandatory in the signed body", async () => {
  const valid = SponsorEnrollmentDecisionSchema.safeParse(await fixture(VALID_DECISION_FIXTURE));
  expect(valid.success).toBe(true);
  expect(valid.success && valid.data.enrollment_id).toBe(DECISION_TARGET);
  expect(
    SponsorEnrollmentDecisionSchema.safeParse(await fixture(INVALID_DECISION_TARGET_FIXTURE))
      .success,
  ).toBe(false);
});

const VALID_MINT_RESPONSE_FIXTURE = new URL(
  "../fixtures/valid/enrollment-mint-response.json",
  import.meta.url,
);
const VALID_PROPOSAL_LIST_FIXTURE = new URL(
  "../fixtures/valid/enrollment-proposal-list.json",
  import.meta.url,
);
const VALID_FELLOW_LIST_FIXTURE = new URL(
  "../fixtures/valid/enrollment-fellow-list.json",
  import.meta.url,
);
const VALID_DECISION_RESPONSE_FIXTURE = new URL(
  "../fixtures/valid/enrollment-decision-response.json",
  import.meta.url,
);
const INVALID_MINT_RESPONSE_FIXTURE = new URL(
  "../fixtures/invalid/enrollment-mint-response-plainsecret.json",
  import.meta.url,
);
const INVALID_FELLOW_LIST_FIXTURE = new URL(
  "../fixtures/invalid/enrollment-fellow-list-extra.json",
  import.meta.url,
);

test("the mint response carries the one-time join URL under a versioned secret", async () => {
  const parsed = MintEnrollmentResponseSchema.safeParse(await fixture(VALID_MINT_RESPONSE_FIXTURE));
  expect(parsed.success).toBe(true);

  // A plaintext, unversioned secret is never a valid mint response.
  expect(MintEnrollmentResponseSchema.safeParse(await fixture(INVALID_MINT_RESPONSE_FIXTURE)).success).toBe(
    false,
  );
});

test("the sponsor proposal list reuses the approval card contract exactly", async () => {
  const parsed = SponsorProposalListResponseSchema.safeParse(
    await fixture(VALID_PROPOSAL_LIST_FIXTURE),
  );
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.proposals[0]?.status).toBe("pending");
    // Sponsor-facing: no grant is mistaken for a live authorization while pending.
    expect(parsed.data.proposals[0]?.effective_granted_scopes).toBeNull();
  }
});

test("the sponsor fellow list exposes no credential material", async () => {
  const parsed = SponsorFellowListResponseSchema.safeParse(
    await fixture(VALID_FELLOW_LIST_FIXTURE),
  );
  expect(parsed.success).toBe(true);

  // A token hash or any extra field is a strict-shape violation, never a passthrough.
  expect(SponsorFellowListResponseSchema.safeParse(await fixture(INVALID_FELLOW_LIST_FIXTURE)).success).toBe(
    false,
  );
});

test("the decision acknowledgement is exactly one literal", async () => {
  expect(
    SponsorEnrollmentDecisionResponseSchema.safeParse(await fixture(VALID_DECISION_RESPONSE_FIXTURE))
      .success,
  ).toBe(true);
  expect(SponsorEnrollmentDecisionResponseSchema.safeParse({ acknowledged: "true" }).success).toBe(
    false,
  );
});
