import { expect, test } from "bun:test";

import {
  DeviceCodeStartRequestSchema,
  DeviceCodeStartResponseSchema,
  DeviceLookupRequestSchema,
  EnrollmentFlowPollRequestSchema,
  EnrollmentSecretSchema,
  encodeSponsorFellowCursor,
  FellowNameSchema,
  FellowRegistrationCredentialFieldsSchema,
  FellowRegistrationRequestSchema,
  MintEnrollmentRequestSchema,
  MintEnrollmentResponseSchema,
  parseSponsorFellowCursor,
  SponsorBootstrapRequestSchema,
  SponsorCredentialRevokeRequestSchema,
  SponsorCredentialRevokeResponseSchema,
  SponsorEnrollmentDecisionCommandSchema,
  SponsorEnrollmentDecisionResponseSchema,
  SponsorEnrollmentDecisionSchema,
  SponsorFellowCursorSchema,
  SponsorFellowLifecycleRequestSchema,
  SponsorFellowLifecycleResponseSchema,
  SponsorFellowListResponseSchema,
  SponsorPanicRequestSchema,
  SponsorPanicResponseSchema,
  SponsorProposalListResponseSchema,
} from "../../src/enrollment.ts";

const VALID_FIXTURE = new URL("../fixtures/valid/enrollment.json", import.meta.url);
const SYNTHETIC_ENROLLMENT_SECRET = `v1.${"A".repeat(43)}`;
const MALFORMED_ENROLLMENT_SECRET = ["v1", "short"].join(".");
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
const VALID_DECISION_COMMAND_FIXTURE = new URL(
  "../fixtures/valid/enrollment-decision-command-approve.json",
  import.meta.url,
);
const INVALID_DECISION_TARGET_FIXTURE = new URL(
  "../fixtures/invalid/enrollment-decision-missing-target.json",
  import.meta.url,
);
const INVALID_DECISION_COMMAND_FIXTURE = new URL(
  "../fixtures/invalid/enrollment-decision-command-fractional-step-up.json",
  import.meta.url,
);
const INVALID_NUL_REGISTRATION_FIXTURE = new URL(
  "../fixtures/invalid/enrollment-nul-persisted-text.json",
  import.meta.url,
);
const VALID_BOOTSTRAP_REQUEST_FIXTURE = new URL(
  "../fixtures/valid/enrollment-bootstrap-request.json",
  import.meta.url,
);
const INVALID_BOOTSTRAP_REQUEST_FIXTURE = new URL(
  "../fixtures/invalid/enrollment-bootstrap-request-extra.json",
  import.meta.url,
);
const GENERATED_ENROLLMENT_SCHEMA = new URL(
  "../../generated/enrollment.schema.json",
  import.meta.url,
);
const VALID_LIFECYCLE_FIXTURE = new URL(
  "../fixtures/valid/enrollment-lifecycle.json",
  import.meta.url,
);
const INVALID_LIFECYCLE_FIXTURE = new URL(
  "../fixtures/invalid/enrollment-lifecycle.json",
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

test("the generated enrollment registry exposes the exact strict sponsor bootstrap body", async () => {
  const generated = (await fixture(GENERATED_ENROLLMENT_SCHEMA)) as {
    readonly required?: readonly string[];
    readonly properties?: Record<string, unknown>;
  };
  expect(generated.required).toContain("sponsor_bootstrap_request");
  expect(generated.properties?.sponsor_bootstrap_request).toEqual({
    type: "object",
    properties: {},
    additionalProperties: false,
  });
});

test("lifecycle request and acknowledgement fixtures stay strict and secret-free", async () => {
  const valid = (await fixture(VALID_LIFECYCLE_FIXTURE)) as Record<string, unknown>;
  const invalid = (await fixture(INVALID_LIFECYCLE_FIXTURE)) as Record<string, unknown>;
  const schemas = {
    credential_revoke_request: SponsorCredentialRevokeRequestSchema,
    credential_revoke_response: SponsorCredentialRevokeResponseSchema,
    fellow_lifecycle_request: SponsorFellowLifecycleRequestSchema,
    fellow_lifecycle_response: SponsorFellowLifecycleResponseSchema,
    sponsor_panic_request: SponsorPanicRequestSchema,
    sponsor_panic_response: SponsorPanicResponseSchema,
  } as const;

  for (const [name, schema] of Object.entries(schemas)) {
    expect(schema.safeParse(valid[name]).success, name).toBe(true);
    expect(schema.safeParse(invalid[name]).success, name).toBe(false);
  }
  expect(JSON.stringify(valid)).not.toContain("token_hash");
  expect(JSON.stringify(valid)).not.toContain("asimp_ag_");
});

test("planted malformed enrollment secret is rejected", async () => {
  const parsed = FellowRegistrationRequestSchema.safeParse(await fixture(INVALID_FIXTURE));

  expect(parsed.success).toBe(false);
  expect(EnrollmentSecretSchema.safeParse(MALFORMED_ENROLLMENT_SECRET).success).toBe(false);
});

test("credential fields remain inspectable for teachable names while malformed secrets stay invalid", () => {
  const body = {
    enrollment_id: "ASIMP-EN-7F3K9M2Q8R",
    secret: SYNTHETIC_ENROLLMENT_SECRET,
    name: "codex-lab",
    model: "test-model",
    harness: "test-harness",
  };
  expect(FellowRegistrationCredentialFieldsSchema.safeParse(body).success).toBe(true);
  expect(
    FellowRegistrationCredentialFieldsSchema.safeParse({
      ...body,
      secret: MALFORMED_ENROLLMENT_SECRET,
    }).success,
  ).toBe(false);
});

test("persisted SQLite-facing text rejects NUL before migration or trigger length checks", async () => {
  expect(
    FellowRegistrationRequestSchema.safeParse(await fixture(INVALID_NUL_REGISTRATION_FIXTURE))
      .success,
  ).toBe(false);
  expect(
    DeviceCodeStartRequestSchema.safeParse({
      name: "nul-device",
      model: "model\u0000suffix",
      harness: "test-harness",
      requested_scopes: ["review"],
    }).success,
  ).toBe(false);
  expect(
    MintEnrollmentRequestSchema.safeParse({
      requested_scopes: ["review"],
      first_directive: `x\u0000${"a".repeat(2_100)}`,
    }).success,
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
      secret: SYNTHETIC_ENROLLMENT_SECRET,
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

test("the signed decision command requires server-stamped step-up evidence without changing intent", async () => {
  const intent = await fixture(VALID_DECISION_FIXTURE);
  const command = await fixture(VALID_DECISION_COMMAND_FIXTURE);
  expect(SponsorEnrollmentDecisionSchema.safeParse(intent).success).toBe(true);
  expect(SponsorEnrollmentDecisionSchema.safeParse(command).success).toBe(false);
  expect(SponsorEnrollmentDecisionCommandSchema.safeParse(intent).success).toBe(false);
  expect(SponsorEnrollmentDecisionCommandSchema.safeParse(command).success).toBe(true);
  expect(
    SponsorEnrollmentDecisionCommandSchema.safeParse(
      await fixture(INVALID_DECISION_COMMAND_FIXTURE),
    ).success,
  ).toBe(false);
  for (const stepUp of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(
      SponsorEnrollmentDecisionCommandSchema.safeParse({
        enrollment_id: DECISION_TARGET,
        decision: "deny",
        step_up_authenticated_at: stepUp,
      }).success,
    ).toBe(false);
  }
  expect(
    SponsorEnrollmentDecisionCommandSchema.safeParse({
      enrollment_id: DECISION_TARGET,
      decision: "approve",
      step_up_authenticated_at: 1_786_800_000,
      browser_claimed_recent_auth: true,
    }).success,
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

test("sponsor bootstrap is the strict empty JSON object", async () => {
  expect(
    SponsorBootstrapRequestSchema.safeParse(await fixture(VALID_BOOTSTRAP_REQUEST_FIXTURE)).success,
  ).toBe(true);
  expect(
    SponsorBootstrapRequestSchema.safeParse(await fixture(INVALID_BOOTSTRAP_REQUEST_FIXTURE))
      .success,
  ).toBe(false);
  expect(SponsorBootstrapRequestSchema.safeParse([]).success).toBe(false);
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
const VALID_FELLOW_LIST_PAGE_FIXTURE = new URL(
  "../fixtures/valid/enrollment-fellow-list-page.json",
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
const INVALID_FELLOW_LIST_CURSOR_FIXTURE = new URL(
  "../fixtures/invalid/enrollment-fellow-list-cursor.json",
  import.meta.url,
);

test("the mint response carries the one-time join URL under a versioned secret", async () => {
  const parsed = MintEnrollmentResponseSchema.safeParse(await fixture(VALID_MINT_RESPONSE_FIXTURE));
  expect(parsed.success).toBe(true);

  // A plaintext, unversioned secret is never a valid mint response.
  expect(
    MintEnrollmentResponseSchema.safeParse(await fixture(INVALID_MINT_RESPONSE_FIXTURE)).success,
  ).toBe(false);
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

test("the sponsor fellow list exposes hygiene metadata but no bearer or token hash", async () => {
  const parsed = SponsorFellowListResponseSchema.safeParse(
    await fixture(VALID_FELLOW_LIST_FIXTURE),
  );
  expect(parsed.success).toBe(true);

  if (parsed.success) {
    expect(parsed.data.fellows[0]?.credentials[0]).toMatchObject({
      profile: "bearer",
      active: true,
    });
    expect(parsed.data.next_cursor).toBeNull();
    const fellow = parsed.data.fellows[0];
    const credential = fellow?.credentials[0];
    expect(fellow).toBeDefined();
    expect(credential).toBeDefined();
    if (fellow !== undefined && credential !== undefined) {
      expect(
        SponsorFellowListResponseSchema.safeParse({
          fellows: [
            {
              ...fellow,
              credentials: Array.from({ length: 4 }, (_, index) => ({
                ...credential,
                credential_id: `credential-over-cap-${index}`,
              })),
            },
          ],
          next_cursor: null,
        }).success,
      ).toBe(false);
    }
  }
  // A token hash or any extra field is a strict-shape violation, never a passthrough.
  expect(
    SponsorFellowListResponseSchema.safeParse(await fixture(INVALID_FELLOW_LIST_FIXTURE)).success,
  ).toBe(false);
  expect(
    SponsorFellowListResponseSchema.safeParse(await fixture(INVALID_FELLOW_LIST_CURSOR_FIXTURE))
      .success,
  ).toBe(false);
});

test("a Fellow cursor is versioned, length-prefixed, and accepts only its canonical spelling", async () => {
  const paged = SponsorFellowListResponseSchema.parse(
    await fixture(VALID_FELLOW_LIST_PAGE_FIXTURE),
  );
  const cursor = paged.next_cursor;
  expect(cursor).not.toBeNull();
  if (cursor === null) return;
  expect(SponsorFellowCursorSchema.safeParse(cursor).success).toBe(true);
  expect(parseSponsorFellowCursor(cursor)).toEqual({
    granted_at: 1_786_800_000_000,
    fellow_id: "fellow-01JXYZ",
  });
  expect(
    encodeSponsorFellowCursor({
      granted_at: 1_786_800_000_000,
      fellow_id: "fellow-01JXYZ",
    }),
  ).toBe(cursor);

  // Padding creates the same decoded bytes but must not become a second cursor spelling.
  expect(SponsorFellowCursorSchema.safeParse(`${cursor}=`).success).toBe(false);
  expect(parseSponsorFellowCursor(`f1.${cursor.slice(3)}A`)).toBeUndefined();
});

test("the generated cursor schema names its runtime-only canonical-frame boundary", async () => {
  const generated = (await fixture(GENERATED_ENROLLMENT_SCHEMA)) as {
    properties?: Record<string, { pattern?: string; description?: string }>;
  };
  const cursor = generated.properties?.sponsor_fellow_cursor;
  expect(cursor).toBeDefined();
  if (cursor === undefined) return;

  // This matches the public transport schema but not the runtime's decoded
  // frame. Freezing that difference prevents a published schema from silently
  // claiming equivalence that Zod's JSON Schema renderer cannot express.
  expect(new RegExp(cursor.pattern ?? "").test("f1.not-a-canonical-cursor")).toBe(true);
  expect(SponsorFellowCursorSchema.safeParse("f1.not-a-canonical-cursor").success).toBe(false);
  expect(cursor.description).toContain("deliberate superset");
  expect(cursor.description).toContain("runtime additionally requires");
});

test("the decision acknowledgement is exactly one literal", async () => {
  expect(
    SponsorEnrollmentDecisionResponseSchema.safeParse(
      await fixture(VALID_DECISION_RESPONSE_FIXTURE),
    ).success,
  ).toBe(true);
  expect(SponsorEnrollmentDecisionResponseSchema.safeParse({ acknowledged: "true" }).success).toBe(
    false,
  );
});

const VALID_DEVICE_START_FIXTURE = new URL(
  "../fixtures/valid/device-code-start.json",
  import.meta.url,
);
const VALID_DEVICE_RESPONSE_FIXTURE = new URL(
  "../fixtures/valid/device-code-start-response.json",
  import.meta.url,
);
const INVALID_DEVICE_LOOKUP_FIXTURE = new URL(
  "../fixtures/invalid/device-lookup-lowercase-code.json",
  import.meta.url,
);

test("device flow contracts pin the start, response, and lookup shapes", async () => {
  expect(
    DeviceCodeStartRequestSchema.safeParse(await fixture(VALID_DEVICE_START_FIXTURE)).success,
  ).toBe(true);

  const response = DeviceCodeStartResponseSchema.safeParse(
    await fixture(VALID_DEVICE_RESPONSE_FIXTURE),
  );
  expect(response.success).toBe(true);

  // Human codes are uppercase by contract; a lowercase code never reaches the lookup.
  expect(
    DeviceLookupRequestSchema.safeParse(await fixture(INVALID_DEVICE_LOOKUP_FIXTURE)).success,
  ).toBe(false);
});

test("the device start schema admits a lowercase name the naming law will screen", () => {
  // The schema admits this shape; the service's naming law refuses "claude"
  // as MODEL_AS_NAME. The contract test pins only the shape boundary.
  expect(
    DeviceCodeStartRequestSchema.safeParse({
      name: "claude",
      model: "anthropic/fable-5",
      harness: "claude-code",
      requested_scopes: ["review"],
    }).success,
  ).toBe(true);
  expect(
    DeviceCodeStartRequestSchema.safeParse({
      name: "x",
      model: "anthropic/fable-5",
      harness: "claude-code",
      requested_scopes: [],
    }).success,
  ).toBe(false);
});
