import { expect, test } from "bun:test";

import {
  assertContextualScreeningInput,
  buildContextualScreeningInput,
  type ContextualPromotionCandidate,
  type ContextualScreeningInput,
  ContextualScreeningInputError,
  type ContextualScreeningProvider,
  MAX_CONTEXTUAL_PROMOTIONS,
  type ScreeningProvider,
  type ScreeningProviderRequest,
  screenContextuallyWithProvider,
  screenWithProvider,
} from "../../src/screening";

const CANARY_PROBLEM = "server-owned-problem-statement-canary-do-not-store";
const CANARY_CURRENT = "current-promotion-canary-do-not-store";
const CANARY_RECENT = "recent-promotion-canary-do-not-store";

const OUTWARD_FIELDS = ["title", "extract", "statement", "public_artifact_md"] as const;

function promotion(statement: string): ContextualPromotionCandidate {
  return {
    title: "public-title-canary",
    extract: "public-extract-canary",
    statement,
    public_artifact_md: "public-artifact-canary",
  };
}

function source(overrides: Record<string, unknown> = {}) {
  return {
    problem_id: "P-context",
    fellow_id: "fellow-context",
    server_owned_problem_statement: CANARY_PROBLEM,
    current_promotion: promotion(CANARY_CURRENT),
    recent_promotions: [
      {
        problem_id: "P-context",
        fellow_id: "fellow-context",
        public_seq: 9,
        promotion: promotion(CANARY_RECENT),
      },
    ],
    ...overrides,
  };
}

const PASS_PROVIDER: ContextualScreeningProvider = {
  async screenContextually() {
    return { decision: "pass", coarse_category: "benign-context" };
  },
};

const CONTEXT_OPTIONS = {
  timeout_ms: 100,
  identity: {
    model_version: "context-fixture-model",
    policy_version: "context-fixture-policy",
    configuration_digest: `sha256:${"f".repeat(64)}`,
  },
  direct_content: { decision: "pass", coarse_category: "benign-context" },
} as const;

test("contextual input is bounded, server-shaped, and presents the newest retained history chronologically", () => {
  const input = buildContextualScreeningInput(source());
  expect(input).toEqual({
    problem_statement: CANARY_PROBLEM,
    current_promotion: {
      title: "public-title-canary",
      extract: "public-extract-canary",
      statement: CANARY_CURRENT,
      public_artifact_md: "public-artifact-canary",
    },
    recent_same_fellow_promotions: [promotion(CANARY_RECENT)],
  });

  const chronology = buildContextualScreeningInput(
    source({
      recent_promotions: Array.from({ length: MAX_CONTEXTUAL_PROMOTIONS + 1 }, (_, index) => ({
        problem_id: "P-context",
        fellow_id: "fellow-context",
        // Deliberately newest-first on input; the provider must get the
        // selected newest window in its chronological order instead.
        public_seq: MAX_CONTEXTUAL_PROMOTIONS + 1 - index,
        promotion: promotion(`promotion-${MAX_CONTEXTUAL_PROMOTIONS + 1 - index}`),
      })),
    }),
  );
  expect(chronology.recent_same_fellow_promotions.map((item) => item.statement)).toEqual([
    "promotion-2",
    "promotion-3",
    "promotion-4",
    "promotion-5",
    "promotion-6",
    "promotion-7",
  ]);

  expect(() =>
    buildContextualScreeningInput(
      source({
        recent_promotions: [
          {
            problem_id: "P-other",
            fellow_id: "fellow-context",
            public_seq: 9,
            promotion: promotion("cross-problem must not reach a provider"),
          },
        ],
      }),
    ),
  ).toThrow(ContextualScreeningInputError);

  expect(() =>
    buildContextualScreeningInput(
      source({
        recent_promotions: [
          {
            problem_id: "P-context",
            fellow_id: "another-fellow",
            public_seq: 9,
            promotion: promotion("cross-fellow must not reach a provider"),
          },
        ],
      }),
    ),
  ).toThrow(ContextualScreeningInputError);

  expect(() => buildContextualScreeningInput(null)).toThrow(ContextualScreeningInputError);
  expect(() =>
    buildContextualScreeningInput({
      problem_id: ["P-context"],
      fellow_id: "fellow-context",
      server_owned_problem_statement: CANARY_PROBLEM,
      current_promotion: promotion(CANARY_CURRENT),
      recent_promotions: [],
    }),
  ).toThrow(ContextualScreeningInputError);
  expect(() =>
    buildContextualScreeningInput({
      problem_id: "P-context",
      fellow_id: "fellow-context",
      server_owned_problem_statement: CANARY_PROBLEM,
      current_promotion: "not-an-object",
      recent_promotions: {},
    }),
  ).toThrow(ContextualScreeningInputError);
  expect(() =>
    assertContextualScreeningInput({
      problem_statement: [],
      current_promotion: "not-an-object",
      recent_same_fellow_promotions: "not-an-array",
    }),
  ).toThrow(ContextualScreeningInputError);
  expect(() =>
    buildContextualScreeningInput(
      source({
        server_owned_problem_statement: "p".repeat(4_096),
        current_promotion: {
          title: "t".repeat(4_096),
          extract: "e".repeat(4_096),
          statement: "s",
          public_artifact_md: "a",
        },
        recent_promotions: [],
      }),
    ),
  ).toThrow(ContextualScreeningInputError);
});

test("every outward field of a prior promotion can participate in contextual aggregation", async () => {
  for (const field of OUTWARD_FIELDS) {
    const priorMarker = `prior-${field}-piece`;
    const currentMarker = `current-${field}-piece`;
    const prior = promotion("prior-statement");
    const current = promotion("current-statement");
    const priorWithMarker = { ...prior, [field]: priorMarker };
    const currentWithMarker = { ...current, [field]: currentMarker };
    const input = buildContextualScreeningInput(
      source({
        current_promotion: currentWithMarker,
        recent_promotions: [
          {
            problem_id: "P-context",
            fellow_id: "fellow-context",
            public_seq: 9,
            promotion: priorWithMarker,
          },
        ],
      }),
    );
    const provider: ContextualScreeningProvider = {
      async screenContextually(received) {
        expect(received.recent_same_fellow_promotions[0]?.[field]).toBe(priorMarker);
        expect(received.current_promotion[field]).toBe(currentMarker);
        return { decision: "quarantine", coarse_category: "dual-use-boundary" };
      },
    };
    await expect(
      screenContextuallyWithProvider(provider, input, CONTEXT_OPTIONS),
    ).resolves.toMatchObject({
      decision: "quarantine",
      decision_path: "provider-contextual-hold",
    });
  }
});

test("candidate and context reach only the contextual provider; the result carries no raw bundle", async () => {
  const input = buildContextualScreeningInput(source());
  let observed: unknown;
  const provider: ContextualScreeningProvider = {
    async screenContextually(received) {
      observed = received;
      return { decision: "quarantine", coarse_category: "dual-use-boundary" };
    },
  };

  const result = await screenContextuallyWithProvider(provider, input, CONTEXT_OPTIONS);
  expect(observed).toEqual(input);
  expect(result).toMatchObject({
    decision: "quarantine",
    coarse_category: "dual-use-boundary",
    provider_status: "ok",
    decision_path: "provider-contextual-hold",
    status_code: "SCREENED",
    model_version: "context-fixture-model",
    policy_version: "context-fixture-policy",
    configuration_digest: `sha256:${"f".repeat(64)}`,
  });
  expect(result.input_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  const durableShape = JSON.stringify(result);
  for (const canary of [CANARY_PROBLEM, CANARY_CURRENT, CANARY_RECENT]) {
    expect(durableShape).not.toContain(canary);
  }
  expect(Object.keys(result).sort()).toEqual([
    "coarse_category",
    "configuration_digest",
    "decision",
    "decision_path",
    "input_digest",
    "model_version",
    "policy_version",
    "provider_status",
    "status_code",
  ]);
});

test("an exact contextual input reaches the provider as a canonical bounded payload", async () => {
  const input = buildContextualScreeningInput(source());
  let observed: unknown;
  const provider: ContextualScreeningProvider = {
    async screenContextually(received) {
      observed = received;
      return { decision: "pass", coarse_category: "benign-context" };
    },
  };

  await expect(
    screenContextuallyWithProvider(provider, input, CONTEXT_OPTIONS),
  ).resolves.toMatchObject({
    decision: "pass",
    decision_path: "provider",
  });
  expect(observed).toEqual(input);
  expect(observed).not.toBe(input);
  expect((observed as ContextualScreeningInput).current_promotion).not.toBe(
    input.current_promotion,
  );
  expect((observed as ContextualScreeningInput).recent_same_fellow_promotions).not.toBe(
    input.recent_same_fellow_promotions,
  );
  expect((observed as ContextualScreeningInput).recent_same_fellow_promotions[0]).not.toBe(
    input.recent_same_fellow_promotions[0],
  );
});

test("PLANTED NEGATIVE: undeclared top-level context is refused before provider ingress", async () => {
  const canary = "undeclared-context-canary-must-not-reach-provider";
  const input = {
    ...buildContextualScreeningInput(source()),
    unbounded_undeclared_context: canary.repeat(1_024),
  };
  let calls = 0;
  const provider: ContextualScreeningProvider = {
    async screenContextually() {
      calls += 1;
      return { decision: "pass", coarse_category: "benign-context" };
    },
  };

  let message = "";
  try {
    await screenContextuallyWithProvider(provider, input, CONTEXT_OPTIONS);
  } catch (error) {
    message = (error as Error).message;
  }
  expect(calls).toBe(0);
  expect(message).toBe("contextual screening input has an invalid shape.");
  expect(message).not.toContain(canary);
});

test("provider reject and provider failure are both coarse contextual holds", async () => {
  const input = buildContextualScreeningInput(source());
  const rejectProvider: ContextualScreeningProvider = {
    async screenContextually() {
      return { decision: "reject", coarse_category: "operational-harm" };
    },
  };
  const rejected = await screenContextuallyWithProvider(rejectProvider, input, CONTEXT_OPTIONS);
  expect(rejected).toMatchObject({
    decision: "quarantine",
    coarse_category: "operational-harm",
    provider_status: "ok",
    decision_path: "provider-contextual-hold",
    status_code: "SCREENED",
  });

  const timeoutProvider: ContextualScreeningProvider = {
    screenContextually(_received, signal) {
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("fixture provider aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    },
  };
  const timedOut = await screenContextuallyWithProvider(timeoutProvider, input, {
    ...CONTEXT_OPTIONS,
    timeout_ms: 1,
  });
  expect(timedOut).toMatchObject({
    decision: "quarantine",
    coarse_category: "provider-unavailable",
    provider_status: "timeout",
    decision_path: "provider-timeout-fail-closed",
    status_code: "SCREENING_PROVIDER_TIMEOUT",
  });
  expect(JSON.stringify(timedOut)).not.toContain(CANARY_CURRENT);

  const exceptionMessageCanary = "provider-exception-message-canary-do-not-store";
  const exceptionStackCanary = "provider-exception-stack-canary-do-not-store";
  const throwingProvider: ContextualScreeningProvider = {
    async screenContextually() {
      const error = new Error(exceptionMessageCanary);
      error.stack = exceptionStackCanary;
      throw error;
    },
  };
  const failed = await screenContextuallyWithProvider(throwingProvider, input, CONTEXT_OPTIONS);
  expect(failed).toMatchObject({
    decision: "quarantine",
    coarse_category: "provider-unavailable",
    provider_status: "error",
    decision_path: "provider-error-fail-closed",
    status_code: "SCREENING_PROVIDER_ERROR",
  });
  for (const canary of [exceptionMessageCanary, exceptionStackCanary, CANARY_CURRENT]) {
    expect(JSON.stringify(failed)).not.toContain(canary);
  }
});

test("direct and contextual verdicts compose monotonically without softening warnings", async () => {
  const input = buildContextualScreeningInput(source());
  const cases = [
    {
      direct: { decision: "pass", coarse_category: "benign-context" },
      contextual: { decision: "pass", coarse_category: "benign-context" },
      expected: { decision: "pass", coarse_category: "benign-context", decision_path: "provider" },
    },
    {
      direct: { decision: "pass", coarse_category: "benign-context" },
      contextual: { decision: "allow-with-warning", coarse_category: "spam-commercial" },
      expected: {
        decision: "allow-with-warning",
        coarse_category: "spam-commercial",
        decision_path: "provider",
      },
    },
    {
      direct: { decision: "pass", coarse_category: "benign-context" },
      contextual: { decision: "quarantine", coarse_category: "dual-use-boundary" },
      expected: {
        decision: "quarantine",
        coarse_category: "dual-use-boundary",
        decision_path: "provider-contextual-hold",
      },
    },
    {
      direct: { decision: "pass", coarse_category: "benign-context" },
      contextual: { decision: "reject", coarse_category: "operational-harm" },
      expected: {
        decision: "quarantine",
        coarse_category: "operational-harm",
        decision_path: "provider-contextual-hold",
      },
    },
    {
      direct: { decision: "allow-with-warning", coarse_category: "harassment" },
      contextual: { decision: "pass", coarse_category: "benign-context" },
      expected: {
        decision: "allow-with-warning",
        coarse_category: "harassment",
        decision_path: "direct-content-warning",
      },
    },
    {
      direct: { decision: "allow-with-warning", coarse_category: "harassment" },
      contextual: { decision: "allow-with-warning", coarse_category: "spam-commercial" },
      expected: {
        decision: "allow-with-warning",
        coarse_category: "harassment",
        decision_path: "direct-content-warning",
      },
    },
    {
      direct: { decision: "allow-with-warning", coarse_category: "harassment" },
      contextual: { decision: "quarantine", coarse_category: "dual-use-boundary" },
      expected: {
        decision: "quarantine",
        coarse_category: "dual-use-boundary",
        decision_path: "provider-contextual-hold",
      },
    },
    {
      direct: { decision: "allow-with-warning", coarse_category: "harassment" },
      contextual: { decision: "reject", coarse_category: "operational-harm" },
      expected: {
        decision: "quarantine",
        coarse_category: "operational-harm",
        decision_path: "provider-contextual-hold",
      },
    },
    {
      direct: { decision: "quarantine", coarse_category: "sexual-content" },
      contextual: { decision: "pass", coarse_category: "benign-context" },
      expected: {
        decision: "quarantine",
        coarse_category: "sexual-content",
        decision_path: "direct-content-hold",
      },
    },
    {
      direct: { decision: "quarantine", coarse_category: "sexual-content" },
      contextual: { decision: "allow-with-warning", coarse_category: "spam-commercial" },
      expected: {
        decision: "quarantine",
        coarse_category: "sexual-content",
        decision_path: "direct-content-hold",
      },
    },
    {
      direct: { decision: "quarantine", coarse_category: "sexual-content" },
      contextual: { decision: "quarantine", coarse_category: "dual-use-boundary" },
      expected: {
        decision: "quarantine",
        coarse_category: "sexual-content",
        decision_path: "direct-content-hold",
      },
    },
    {
      direct: { decision: "quarantine", coarse_category: "sexual-content" },
      contextual: { decision: "reject", coarse_category: "operational-harm" },
      expected: {
        decision: "quarantine",
        coarse_category: "sexual-content",
        decision_path: "direct-content-hold",
      },
    },
    {
      direct: { decision: "reject", coarse_category: "operational-harm" },
      contextual: { decision: "pass", coarse_category: "benign-context" },
      expected: {
        decision: "reject",
        coarse_category: "operational-harm",
        decision_path: "direct-content-reject",
      },
    },
    {
      direct: { decision: "reject", coarse_category: "operational-harm" },
      contextual: { decision: "allow-with-warning", coarse_category: "spam-commercial" },
      expected: {
        decision: "reject",
        coarse_category: "operational-harm",
        decision_path: "direct-content-reject",
      },
    },
    {
      direct: { decision: "reject", coarse_category: "operational-harm" },
      contextual: { decision: "quarantine", coarse_category: "dual-use-boundary" },
      expected: {
        decision: "reject",
        coarse_category: "operational-harm",
        decision_path: "direct-content-reject",
      },
    },
    {
      direct: { decision: "reject", coarse_category: "operational-harm" },
      contextual: { decision: "reject", coarse_category: "operational-harm" },
      expected: {
        decision: "reject",
        coarse_category: "operational-harm",
        decision_path: "direct-content-reject",
      },
    },
  ] as const;

  for (const testCase of cases) {
    let calls = 0;
    const provider: ContextualScreeningProvider = {
      async screenContextually() {
        calls += 1;
        return testCase.contextual;
      },
    };
    const result = await screenContextuallyWithProvider(provider, input, {
      ...CONTEXT_OPTIONS,
      direct_content: testCase.direct,
    });
    expect(result).toMatchObject(testCase.expected);
    expect(calls).toBe(
      testCase.direct.decision === "reject" || testCase.direct.decision === "quarantine" ? 0 : 1,
    );
  }

  const durableShape = JSON.stringify(
    await screenContextuallyWithProvider(PASS_PROVIDER, input, {
      ...CONTEXT_OPTIONS,
      direct_content: { decision: "allow-with-warning", coarse_category: "harassment" },
    }),
  );
  expect(durableShape).not.toContain(CANARY_CURRENT);
});

test("an independent direct-content reject remains a reject and does not call the contextual provider", async () => {
  const input = buildContextualScreeningInput(source());
  let calls = 0;
  const provider: ContextualScreeningProvider = {
    async screenContextually() {
      calls += 1;
      return { decision: "quarantine", coarse_category: "dual-use-boundary" };
    },
  };
  const result = await screenContextuallyWithProvider(provider, input, {
    ...CONTEXT_OPTIONS,
    direct_content: { decision: "reject", coarse_category: "operational-harm" },
  });
  expect(calls).toBe(0);
  expect(result).toMatchObject({
    decision: "reject",
    coarse_category: "operational-harm",
    decision_path: "direct-content-reject",
  });
  expect(JSON.stringify(result)).not.toContain(CANARY_CURRENT);
});

test("the corpus provider request stays digest-only and distinct from the live-context seam", async () => {
  const request: ScreeningProviderRequest = {
    example_id: "fixture-example",
    body_digest: `sha256:${"a".repeat(64)}`,
    context_digest: `sha256:${"b".repeat(64)}`,
    identity: {
      corpus_revision: "fixture-revision",
      corpus_digest: `sha256:${"c".repeat(64)}`,
      model_version: "fixture-model",
      policy_version: "fixture-policy",
      configuration_digest: `sha256:${"d".repeat(64)}`,
    },
  };
  let observed: ScreeningProviderRequest | undefined;
  const provider: ScreeningProvider = {
    async screen(received) {
      observed = received;
      return {
        decision: "pass",
        coarse_category: "benign-context",
        category_score_bands: {
          "benign-context": "low",
          "spam-commercial": undefined,
          injection: undefined,
          "dual-use-boundary": undefined,
          "operational-harm": undefined,
          harassment: undefined,
          "sexual-content": undefined,
          "provider-unavailable": undefined,
        },
      };
    },
  };
  await screenWithProvider(provider, request, { timeout_ms: 100 });
  expect(observed).toEqual(request);
  expect(JSON.stringify(observed)).not.toContain(CANARY_CURRENT);
  await expect(
    screenContextuallyWithProvider(
      PASS_PROVIDER,
      buildContextualScreeningInput(source()),
      CONTEXT_OPTIONS,
    ),
  ).resolves.toMatchObject({ decision: "pass" });
});
