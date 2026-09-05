import { expect, test } from "bun:test";

import {
  SCREENING_COARSE_CATEGORIES,
  SCREENING_DECISION_PATHS,
  SCREENING_OUTCOMES,
  SCREENING_PROVIDER_STATUSES,
  SCREENING_PUBLIC_ACTIONS,
  SCREENING_PUBLIC_NOTICES,
  SCREENING_REVIEW_STATES,
  ScreeningContractsSchema,
  ScreeningDecisionPathSchema,
  ScreeningPromotionDecisionProvenanceSchema,
  ScreeningPromotionDeniedResponseSchema,
  ScreeningPromotionHoldResponseSchema,
  ScreeningPromotionPolicyResponseSchema,
  ScreeningProviderStatusSchema,
  ScreeningPublicActionSchema,
  ScreeningPublicationProvenanceSchema,
  ScreeningSchemaDocumentSchema,
} from "../../src/screening.ts";

const VALID_PUBLIC_ACTION = new URL(
  "../fixtures/valid/screening-public-action.json",
  import.meta.url,
);
const VALID_OPERATOR_RECEIPT = new URL(
  "../fixtures/valid/screening-operator-receipt.json",
  import.meta.url,
);
const INVALID_PUBLIC_ACTION_PRIVATE_DETAIL = new URL(
  "../fixtures/invalid/screening-public-action-private-detail.json",
  import.meta.url,
);
const INVALID_OPERATOR_RECEIPT_PRIVATE_DETAIL = new URL(
  "../fixtures/invalid/screening-operator-receipt-private-detail.json",
  import.meta.url,
);
const VALID_PROMOTION_HOLD = new URL(
  "../fixtures/valid/screening-promotion-hold.json",
  import.meta.url,
);
const VALID_PROMOTION_DENIED = new URL(
  "../fixtures/valid/screening-promotion-denied.json",
  import.meta.url,
);
const INVALID_PROMOTION_HOLD_PRIVATE_DETAIL = new URL(
  "../fixtures/invalid/screening-promotion-hold-private-detail.json",
  import.meta.url,
);
const INVALID_PROMOTION_DENIED_BENIGN = new URL(
  "../fixtures/invalid/screening-promotion-denied-benign.json",
  import.meta.url,
);

async function fixture(url: URL): Promise<unknown> {
  try {
    return JSON.parse(await Bun.file(url).text()) as unknown;
  } catch {
    throw new Error("synthetic screening fixture is not valid JSON");
  }
}

test("publication provenance accepts bounded facts and refuses private or invented evidence", async () => {
  const valid = await fixture(
    new URL("../fixtures/valid/screening-publication-provenance.json", import.meta.url),
  );
  const parsed = ScreeningPublicationProvenanceSchema.parse(valid);
  expect(ScreeningSchemaDocumentSchema.safeParse(parsed).success).toBe(true);
  const invalid = await fixture(
    new URL(
      "../fixtures/invalid/screening-publication-provenance-private-detail.json",
      import.meta.url,
    ),
  );
  expect(ScreeningPublicationProvenanceSchema.safeParse(invalid).success).toBe(false);
  for (const patch of [
    { outcome: "quarantine" },
    { provider_status: "timeout" },
    { decision_path: "benign-outage-degraded" },
    { scope: "full-context" },
    { principal: "fellow" },
    { latency_ms: -1 },
    { retry_count: 0.5 },
    { input_digest: "missing" },
    { policy_version: "private\nbody" },
    { public_action: { category: "injection", action: "published", notice: "none" } },
  ]) {
    expect(ScreeningPublicationProvenanceSchema.safeParse({ ...parsed, ...patch }).success).toBe(
      false,
    );
  }
});

function publicAction(
  category: string,
  action: string,
  decisionPath: string,
): Record<string, string> {
  return {
    category,
    action,
    notice:
      action === "published-with-warning"
        ? decisionPath === "benign-outage-degraded"
          ? "screening-degraded"
          : "screening-warning"
        : "none",
  };
}

test("screening exports have an exact source-compatible vocabulary", async () => {
  expect(SCREENING_OUTCOMES).toEqual(["pass", "allow-with-warning", "quarantine", "reject"]);
  expect(SCREENING_COARSE_CATEGORIES).toEqual([
    "benign-context",
    "spam-commercial",
    "injection",
    "dual-use-boundary",
    "operational-harm",
    "harassment",
    "sexual-content",
    "provider-unavailable",
  ]);
  expect(SCREENING_PUBLIC_ACTIONS).toEqual([
    "published",
    "published-with-warning",
    "quarantined",
    "rejected",
  ]);
  expect(SCREENING_PUBLIC_NOTICES).toEqual(["none", "screening-warning", "screening-degraded"]);
  expect(SCREENING_DECISION_PATHS).toEqual([
    "provider",
    "provider-contextual-hold",
    "direct-content-hold",
    "direct-content-reject",
    "direct-content-warning",
    "provider-timeout-fail-closed",
    "provider-error-fail-closed",
    "benign-outage-degraded",
  ]);
  expect(SCREENING_PROVIDER_STATUSES).toEqual(["ok", "timeout", "error"]);
  expect(SCREENING_REVIEW_STATES).toEqual(["not-required", "pending-operator-review"]);

  expect(ScreeningProviderStatusSchema.safeParse("not-invoked").success).toBe(false);
  expect(ScreeningDecisionPathSchema.safeParse("provider-context-notice").success).toBe(false);

  const parsed = ScreeningPromotionDecisionProvenanceSchema.safeParse(
    await fixture(VALID_OPERATOR_RECEIPT),
  );
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;

  const retiredStatus = { ...parsed.data, provider_status: "not-invoked" };
  const retiredPath = { ...parsed.data, decision_path: "provider-context-notice" };
  expect(
    ScreeningContractsSchema.safeParse({
      public_action: retiredStatus.public_action,
      operator_receipt: retiredStatus,
    }).success,
  ).toBe(false);
  expect(
    ScreeningContractsSchema.safeParse({
      public_action: retiredPath.public_action,
      operator_receipt: retiredPath,
    }).success,
  ).toBe(false);
});

test("public screening action is limited to Fable's coarse quarantine notation", async () => {
  const action = await fixture(VALID_PUBLIC_ACTION);
  const parsed = ScreeningPublicActionSchema.safeParse(action);

  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  expect(Object.keys(parsed.data).sort()).toEqual(["action", "category", "notice"]);
  expect(parsed.data).toEqual({ category: "benign-context", action: "published", notice: "none" });
});

test("promotion decision provenance remains narrower than the canonical screening log", async () => {
  const receipt = await fixture(VALID_OPERATOR_RECEIPT);
  const parsed = ScreeningPromotionDecisionProvenanceSchema.safeParse(receipt);

  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  expect(Object.keys(parsed.data).sort()).toEqual([
    "configuration_digest",
    "context_frontier_digest",
    "context_omission_count",
    "decided_at",
    "decision_path",
    "input_digest",
    "model_version",
    "outcome",
    "policy_version",
    "provider_status",
    "public_action",
    "reviewer_state",
    "scope",
    "version",
  ]);
});

test("the combined screening envelope cannot pair a public face with another receipt path", async () => {
  const validPublicAction = await fixture(VALID_PUBLIC_ACTION);
  const operatorReceipt = await fixture(VALID_OPERATOR_RECEIPT);

  expect(
    ScreeningContractsSchema.safeParse({
      public_action: validPublicAction,
      operator_receipt: operatorReceipt,
    }).success,
  ).toBe(true);
  expect(
    ScreeningContractsSchema.safeParse({
      public_action: publicAction("injection", "rejected", "provider"),
      operator_receipt: operatorReceipt,
    }).success,
  ).toBe(false);
});

test("golden private-detail fixtures are rejected from both screening faces", async () => {
  expect(
    ScreeningPublicActionSchema.safeParse(await fixture(INVALID_PUBLIC_ACTION_PRIVATE_DETAIL))
      .success,
  ).toBe(false);
  expect(
    ScreeningPromotionDecisionProvenanceSchema.safeParse(
      await fixture(INVALID_OPERATOR_RECEIPT_PRIVATE_DETAIL),
    ).success,
  ).toBe(false);
});

test("promotion policy responses expose only a coarse category and appeal path", async () => {
  const hold = await fixture(VALID_PROMOTION_HOLD);
  const denied = await fixture(VALID_PROMOTION_DENIED);

  expect(ScreeningPromotionHoldResponseSchema.safeParse(hold).success).toBe(true);
  expect(ScreeningPromotionDeniedResponseSchema.safeParse(denied).success).toBe(true);
  expect(ScreeningPromotionPolicyResponseSchema.safeParse(hold).success).toBe(true);
  expect(ScreeningPromotionPolicyResponseSchema.safeParse(denied).success).toBe(true);
  expect(ScreeningContractsSchema.safeParse(hold).success).toBe(false);
  expect(ScreeningContractsSchema.safeParse(denied).success).toBe(false);
  expect(ScreeningSchemaDocumentSchema.safeParse(hold).success).toBe(true);
  expect(ScreeningSchemaDocumentSchema.safeParse(denied).success).toBe(true);

  expect(
    ScreeningPromotionPolicyResponseSchema.safeParse(
      await fixture(INVALID_PROMOTION_HOLD_PRIVATE_DETAIL),
    ).success,
  ).toBe(false);
  expect(
    ScreeningPromotionPolicyResponseSchema.safeParse(await fixture(INVALID_PROMOTION_DENIED_BENIGN))
      .success,
  ).toBe(false);
});

test("the source contract admits only source-supported screening tuple families", async () => {
  const parsed = ScreeningPromotionDecisionProvenanceSchema.safeParse(
    await fixture(VALID_OPERATOR_RECEIPT),
  );
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;

  const cases = [
    ["pass", "published", "benign-context", "ok", "provider", "not-required"],
    ["allow-with-warning", "published-with-warning", "injection", "ok", "provider", "not-required"],
    [
      "allow-with-warning",
      "published-with-warning",
      "injection",
      "ok",
      "direct-content-warning",
      "not-required",
    ],
    [
      "allow-with-warning",
      "published-with-warning",
      "provider-unavailable",
      "timeout",
      "benign-outage-degraded",
      "not-required",
    ],
    [
      "allow-with-warning",
      "published-with-warning",
      "provider-unavailable",
      "error",
      "benign-outage-degraded",
      "not-required",
    ],
    [
      "quarantine",
      "quarantined",
      "dual-use-boundary",
      "ok",
      "provider-contextual-hold",
      "pending-operator-review",
    ],
    [
      "quarantine",
      "quarantined",
      "dual-use-boundary",
      "ok",
      "direct-content-hold",
      "pending-operator-review",
    ],
    [
      "quarantine",
      "quarantined",
      "provider-unavailable",
      "timeout",
      "provider-timeout-fail-closed",
      "pending-operator-review",
    ],
    [
      "quarantine",
      "quarantined",
      "provider-unavailable",
      "error",
      "provider-error-fail-closed",
      "pending-operator-review",
    ],
    ["reject", "rejected", "injection", "ok", "provider", "not-required"],
    ["reject", "rejected", "injection", "ok", "direct-content-reject", "not-required"],
  ] as const;

  expect(SCREENING_OUTCOMES).toEqual(["pass", "allow-with-warning", "quarantine", "reject"]);
  for (const [outcome, action, category, providerStatus, decisionPath, reviewerState] of cases) {
    const receipt = {
      ...parsed.data,
      outcome,
      public_action: publicAction(category, action, decisionPath),
      provider_status: providerStatus,
      decision_path: decisionPath,
      reviewer_state: reviewerState,
    };
    expect(
      ScreeningPromotionDecisionProvenanceSchema.safeParse(receipt).success,
      decisionPath,
    ).toBe(true);
  }
});

test("fail-closed and direct paths retain their source-supported provider status", async () => {
  const parsed = ScreeningPromotionDecisionProvenanceSchema.safeParse(
    await fixture(VALID_OPERATOR_RECEIPT),
  );
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;

  const timeout = {
    ...parsed.data,
    outcome: "quarantine" as const,
    public_action: publicAction(
      "provider-unavailable",
      "quarantined",
      "provider-timeout-fail-closed",
    ),
    provider_status: "timeout" as const,
    decision_path: "provider-timeout-fail-closed" as const,
    reviewer_state: "pending-operator-review" as const,
  };
  expect(ScreeningPromotionDecisionProvenanceSchema.safeParse(timeout).success).toBe(true);
  const failed = {
    ...timeout,
    provider_status: "error" as const,
    decision_path: "provider-error-fail-closed" as const,
  };
  expect(ScreeningPromotionDecisionProvenanceSchema.safeParse(failed).success).toBe(true);
  const directHold = {
    ...parsed.data,
    outcome: "quarantine" as const,
    public_action: publicAction("dual-use-boundary", "quarantined", "direct-content-hold"),
    provider_status: "ok" as const,
    decision_path: "direct-content-hold" as const,
    reviewer_state: "pending-operator-review" as const,
  };
  const directReject = {
    ...parsed.data,
    outcome: "reject" as const,
    public_action: publicAction("injection", "rejected", "direct-content-reject"),
    provider_status: "ok" as const,
    decision_path: "direct-content-reject" as const,
    reviewer_state: "not-required" as const,
  };
  expect(ScreeningPromotionDecisionProvenanceSchema.safeParse(directHold).success).toBe(true);
  expect(ScreeningPromotionDecisionProvenanceSchema.safeParse(directReject).success).toBe(true);
  expect(
    ScreeningPromotionDecisionProvenanceSchema.safeParse({
      ...timeout,
      public_action: publicAction(
        "dual-use-boundary",
        "quarantined",
        "provider-timeout-fail-closed",
      ),
    }).success,
  ).toBe(false);
  expect(
    ScreeningPromotionDecisionProvenanceSchema.safeParse({
      ...timeout,
      provider_status: "ok",
      decision_path: "provider-timeout-fail-closed",
    }).success,
  ).toBe(false);
  expect(
    ScreeningPromotionDecisionProvenanceSchema.safeParse({
      ...directHold,
      provider_status: "timeout",
      decision_path: "direct-content-hold",
    }).success,
  ).toBe(false);
});

test("provider, direct, and benign-outage warnings use only source-supported tuples", async () => {
  const parsed = ScreeningPromotionDecisionProvenanceSchema.safeParse(
    await fixture(VALID_OPERATOR_RECEIPT),
  );
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;

  const providerWarning = {
    ...parsed.data,
    outcome: "allow-with-warning",
    public_action: publicAction("injection", "published-with-warning", "provider"),
    provider_status: "ok",
    decision_path: "provider",
    reviewer_state: "not-required",
  };
  const directWarning = {
    ...providerWarning,
    decision_path: "direct-content-warning",
  };
  const outageTimeoutWarning = {
    ...providerWarning,
    public_action: publicAction(
      "provider-unavailable",
      "published-with-warning",
      "benign-outage-degraded",
    ),
    provider_status: "timeout",
    decision_path: "benign-outage-degraded",
  };
  const outageErrorWarning = {
    ...outageTimeoutWarning,
    provider_status: "error",
  };

  for (const [label, warning] of [
    ["provider warning", providerWarning],
    ["direct warning", directWarning],
    ["benign outage timeout warning", outageTimeoutWarning],
    ["benign outage error warning", outageErrorWarning],
  ] as const) {
    expect(ScreeningPublicActionSchema.safeParse(warning.public_action).success, label).toBe(true);
    expect(ScreeningPromotionDecisionProvenanceSchema.safeParse(warning).success, label).toBe(true);
    expect(
      ScreeningContractsSchema.safeParse({
        public_action: warning.public_action,
        operator_receipt: warning,
      }).success,
      label,
    ).toBe(true);
  }

  for (const [label, receipt] of [
    [
      "benign warning",
      {
        ...providerWarning,
        public_action: publicAction("benign-context", "published-with-warning", "provider"),
      },
    ],
    [
      "provider warning with an outage category",
      {
        ...providerWarning,
        public_action: publicAction("provider-unavailable", "published-with-warning", "provider"),
      },
    ],
    [
      "warning with a hold path",
      {
        ...providerWarning,
        decision_path: "direct-content-hold",
      },
    ],
    ["direct warning with a timeout status", { ...directWarning, provider_status: "timeout" }],
    ["outage warning with an ok status", { ...outageTimeoutWarning, provider_status: "ok" }],
    [
      "outage warning with a normal notice",
      {
        ...outageTimeoutWarning,
        public_action: publicAction("provider-unavailable", "published-with-warning", "provider"),
      },
    ],
    ["pending warning", { ...providerWarning, reviewer_state: "pending-operator-review" }],
    [
      "plain published warning",
      { ...providerWarning, public_action: publicAction("injection", "published", "provider") },
    ],
  ] as const) {
    expect(ScreeningPromotionDecisionProvenanceSchema.safeParse(receipt).success, label).toBe(
      false,
    );
  }
  expect(
    ScreeningContractsSchema.safeParse({
      public_action: publicAction("dual-use-boundary", "published-with-warning", "provider"),
      operator_receipt: providerWarning,
    }).success,
  ).toBe(false);
});

test("strict receipts reject every excluded source of a screening oracle", async () => {
  const parsed = ScreeningPromotionDecisionProvenanceSchema.safeParse(
    await fixture(VALID_OPERATOR_RECEIPT),
  );
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;

  const forbiddenFields = {
    body: "submitted body",
    raw_scores: { injection: 0.99 },
    private_patterns: ["private-rule-17"],
    detector_prompt: "classify this content",
    credentials: "secret-token",
    hidden_reasoning: "private classifier trace",
    model_response: "unbounded provider output",
  };
  for (const [field, value] of Object.entries(forbiddenFields)) {
    expect(
      ScreeningPromotionDecisionProvenanceSchema.safeParse({ ...parsed.data, [field]: value })
        .success,
      field,
    ).toBe(false);
  }
});
