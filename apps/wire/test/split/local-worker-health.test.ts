import { describe, expect, test } from "bun:test";

import { ContextualScreeningInputError } from "../../src/screening/index.ts";
import {
  assertLocalS4PublicActionRows,
  assertLocalS4ReceiptSafe,
  type LocalPromotionReceiptInput,
  LocalS3PublicShapeError,
  LocalS4ReceiptContractError,
  localHarnessPublicReadinessNonce,
  localPromotionReceiptContract,
  type PublicScreeningActionRow,
  type ScreeningDecisionReceiptRow,
} from "../../src/split/local-worker.ts";

const AUTHORITY = "a".repeat(64);
const READINESS = `s3-ready-${"b".repeat(32)}`;

describe("the local Workerd readiness face never becomes authority", () => {
  test("returns only a separately shaped public nonce for a usable harness", () => {
    expect(
      localHarnessPublicReadinessNonce({
        S3_RUN_TOKEN: AUTHORITY,
        S3_READINESS_NONCE: READINESS,
      }),
    ).toBe(READINESS);
  });

  test("fails closed for absent, malformed, or authority-shaped bindings", () => {
    const invalidBindings = [
      {},
      { S3_RUN_TOKEN: AUTHORITY },
      { S3_READINESS_NONCE: READINESS },
      { S3_RUN_TOKEN: "short", S3_READINESS_NONCE: READINESS },
      { S3_RUN_TOKEN: AUTHORITY, S3_READINESS_NONCE: "s3-ready-short" },
      { S3_RUN_TOKEN: AUTHORITY, S3_READINESS_NONCE: AUTHORITY },
    ] as const;

    for (const bindings of invalidBindings) {
      expect(localHarnessPublicReadinessNonce(bindings)).toBeUndefined();
    }
  });
});

/**
 * S-4 G0 contract-drift closure: the local promotion-receipt write boundary.
 *
 * `localPromotionReceiptContract` parses every receipt through the contract
 * package's own `ScreeningPromotionDecisionProvenanceSchema` before its D1 batch
 * is prepared, so what this harness can persist is the contract's 44 matched
 * `{public_action, operator_receipt}` families rather than whatever it happened
 * to assemble. These are provenance records: not canonical ledger events, not a
 * public claim, and reachable only from the local workerd harness.
 */
describe("a local promotion receipt is refused unless the contract admits it", () => {
  const DIGEST = `sha256:${"a".repeat(64)}`;
  const FRONTIER = `sha256:${"b".repeat(64)}`;
  const CONFIG = `sha256:${"c".repeat(64)}`;
  const DECIDED_AT_SECONDS = 1_770_000_000;

  const receipt = (overrides: Partial<LocalPromotionReceiptInput> = {}) =>
    localPromotionReceiptContract({
      decision: "pass",
      coarseCategory: "benign-context",
      providerStatus: "ok",
      decisionPath: "provider",
      statusCode: "SCREENED",
      publicAction: "published",
      publicNotice: "none",
      inputDigest: DIGEST,
      configurationDigest: CONFIG,
      contextFrontierDigest: FRONTIER,
      contextOmissionCount: 0,
      modelVersion: "local-s4-fixture-no-live-provider",
      policyVersion: "local-s4-fixture-policy-v1",
      decidedAtSeconds: DECIDED_AT_SECONDS,
      ...overrides,
    });

  test("accepts every decision shape the local fixture provider can actually produce", () => {
    expect(receipt().outcome).toBe("pass");
    expect(
      receipt({
        decision: "allow-with-warning",
        coarseCategory: "dual-use-boundary",
        publicAction: "published-with-warning",
        publicNotice: "screening-warning",
      }).decision_path,
    ).toBe("provider");
    expect(
      receipt({
        decision: "quarantine",
        coarseCategory: "dual-use-boundary",
        decisionPath: "provider-contextual-hold",
        publicAction: "quarantined",
      }).reviewer_state,
    ).toBe("pending-operator-review");
    expect(
      receipt({
        decision: "reject",
        coarseCategory: "operational-harm",
        decisionPath: "direct-content-reject",
        publicAction: "rejected",
      }).outcome,
    ).toBe("reject");
  });

  test("a provider outage is a fail-closed hold that still records its status", () => {
    for (const providerStatus of ["timeout", "error"] as const) {
      const held = receipt({
        decision: "quarantine",
        coarseCategory: "provider-unavailable",
        providerStatus,
        decisionPath:
          providerStatus === "timeout"
            ? "provider-timeout-fail-closed"
            : "provider-error-fail-closed",
        statusCode:
          providerStatus === "timeout" ? "SCREENING_PROVIDER_TIMEOUT" : "SCREENING_PROVIDER_ERROR",
        publicAction: "quarantined",
      });
      expect(held.provider_status).toBe(providerStatus);
      expect(held.reviewer_state).toBe("pending-operator-review");
      expect(held.public_action.notice).toBe("none");
    }
  });

  test("the fixture-only degraded publish keeps its own visible notice", () => {
    const degraded = receipt({
      decision: "allow-with-warning",
      coarseCategory: "provider-unavailable",
      providerStatus: "timeout",
      decisionPath: "benign-outage-degraded",
      statusCode: "SCREENING_PROVIDER_TIMEOUT",
      publicAction: "published-with-warning",
      publicNotice: "screening-degraded",
    });
    expect(degraded.public_action.notice).toBe("screening-degraded");
    expect(degraded.reviewer_state).toBe("not-required");
  });

  test("reviewer state is derived from the outcome, never supplied alongside it", () => {
    expect(receipt().reviewer_state).toBe("not-required");
    expect(
      receipt({
        decision: "quarantine",
        decisionPath: "direct-content-hold",
        publicAction: "quarantined",
      }).reviewer_state,
    ).toBe("pending-operator-review");
  });

  test("the contract version and promotion scope are stamped, not accepted from the caller", () => {
    const stamped = receipt();
    expect(stamped.version).toBe("screening-promotion-decision-provenance.v1");
    expect(stamped.scope).toBe("promotion");
  });

  test("PLANTED DRIFT: a public action that contradicts its outcome is refused", () => {
    // A published face over a quarantine outcome is the one mismatch that would
    // put held content on a public surface.
    expect(() => receipt({ decision: "quarantine", decisionPath: "direct-content-hold" })).toThrow(
      LocalS4ReceiptContractError,
    );
    expect(() => receipt({ publicAction: "rejected" })).toThrow(LocalS4ReceiptContractError);
    expect(() => receipt({ decision: "reject", publicAction: "published" })).toThrow(
      LocalS4ReceiptContractError,
    );
  });

  test("PLANTED DRIFT: a category the action family excludes is refused", () => {
    // `published` is benign-context only; `published-with-warning` is a hard
    // policy category or the degraded-outage face, never a benign one.
    expect(() => receipt({ coarseCategory: "injection" })).toThrow(LocalS4ReceiptContractError);
    expect(() =>
      receipt({
        decision: "allow-with-warning",
        coarseCategory: "benign-context",
        publicAction: "published-with-warning",
        publicNotice: "screening-warning",
      }),
    ).toThrow(LocalS4ReceiptContractError);
  });

  test("PLANTED DRIFT: a decision path the outcome cannot reach is refused", () => {
    expect(() => receipt({ decisionPath: "provider-contextual-hold" })).toThrow(
      LocalS4ReceiptContractError,
    );
    expect(() => receipt({ decisionPath: "benign-outage-degraded" })).toThrow(
      LocalS4ReceiptContractError,
    );
  });

  test("PLANTED DRIFT: a fail-closed path may not claim the provider answered", () => {
    expect(() =>
      receipt({
        decision: "quarantine",
        coarseCategory: "provider-unavailable",
        providerStatus: "ok",
        decisionPath: "provider-timeout-fail-closed",
        publicAction: "quarantined",
      }),
    ).toThrow(LocalS4ReceiptContractError);
  });

  test("PLANTED DRIFT: a literal outside the contract vocabulary is refused", () => {
    expect(() => receipt({ decision: "published-quietly" })).toThrow(LocalS4ReceiptContractError);
    expect(() => receipt({ coarseCategory: "off-scope" })).toThrow(LocalS4ReceiptContractError);
    expect(() => receipt({ providerStatus: "degraded" })).toThrow(LocalS4ReceiptContractError);
    expect(() => receipt({ publicNotice: "screening-ok" })).toThrow(LocalS4ReceiptContractError);
  });

  test("PLANTED DRIFT: a malformed digest, instant, or omission count is refused", () => {
    expect(() => receipt({ inputDigest: "sha256:not-hex" })).toThrow(LocalS4ReceiptContractError);
    expect(() => receipt({ contextFrontierDigest: "b".repeat(63) })).toThrow(
      LocalS4ReceiptContractError,
    );
    expect(() => receipt({ configurationDigest: "" })).toThrow(LocalS4ReceiptContractError);
    expect(() => receipt({ decidedAtSeconds: Number.NaN })).toThrow(LocalS4ReceiptContractError);
    expect(() => receipt({ decidedAtSeconds: -1 })).toThrow(LocalS4ReceiptContractError);
    expect(() => receipt({ contextOmissionCount: -1 })).toThrow(LocalS4ReceiptContractError);
    expect(() => receipt({ contextOmissionCount: 1.5 })).toThrow(LocalS4ReceiptContractError);
  });

  test("the refusal carries a fixed code and never echoes the offending receipt", () => {
    const secretish = `sha256:${"f".repeat(64)}`;
    let caught: unknown;
    try {
      receipt({ coarseCategory: "off-scope", inputDigest: secretish });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LocalS4ReceiptContractError);
    const serialized = `${String(caught)} ${JSON.stringify(caught, Object.getOwnPropertyNames(caught))}`;
    expect(serialized).toContain("LOCAL_S4_RECEIPT_CONTRACT_VIOLATION");
    expect(serialized).not.toContain("off-scope");
    expect(serialized).not.toContain("f".repeat(64));
  });
});

/**
 * S-4 strict read-back: cross-field-invalid rows built only from valid members.
 *
 * The read paths already rejected junk. What they did not reject was a row whose
 * every field is a legal enum member but whose combination no contract family
 * admits — the shape a forged or stale row actually takes. Such a row could
 * previously pass replay, negative dedup, diagnostics, and the public action
 * face. Each plant below uses valid literals exclusively, so a failure here is
 * always about co-occurrence and never about a malformed value.
 */
describe("a stored S-4 receipt is re-validated as a whole, not field by field", () => {
  const DIGEST = `sha256:${"a".repeat(64)}`;
  const FRONTIER = `sha256:${"b".repeat(64)}`;
  const CONFIG = `sha256:${"c".repeat(64)}`;

  const row = (overrides: Partial<ScreeningDecisionReceiptRow> = {}): ScreeningDecisionReceiptRow =>
    ({
      receipt_id: "DR-0000000000000000000000000A",
      input_digest: DIGEST,
      model_version: "local-s4-fixture-no-live-provider",
      policy_version: "local-s4-fixture-policy-v1",
      configuration_digest: CONFIG,
      decision: "pass",
      coarse_category: "benign-context",
      provider_status: "ok",
      decision_path: "provider",
      status_code: "SCREENED",
      context_frontier_digest: FRONTIER,
      context_omission_count: 0,
      public_action: "published",
      public_notice: "none",
      deduplicated_from_receipt_id: null,
      created_at: 1_770_000_000,
      ...overrides,
    }) as ScreeningDecisionReceiptRow;

  test("a coherent stored receipt still reads back", () => {
    expect(() => assertLocalS4ReceiptSafe(row())).not.toThrow();
    expect(() =>
      assertLocalS4ReceiptSafe(
        row({
          decision: "quarantine",
          coarse_category: "dual-use-boundary",
          decision_path: "provider-contextual-hold",
          public_action: "quarantined",
        }),
      ),
    ).not.toThrow();
  });

  test("PLANTED FORGERY: the reported combination is refused on read", () => {
    // quarantine + direct-content-hold + ok + published + none. Every member is
    // a valid literal; no contract family pairs a quarantine with a published
    // public face. This is the exact row the independent audit named.
    expect(() =>
      assertLocalS4ReceiptSafe(
        row({
          decision: "quarantine",
          decision_path: "direct-content-hold",
          provider_status: "ok",
          public_action: "published",
          public_notice: "none",
        }),
      ),
    ).toThrow(ContextualScreeningInputError);
  });

  test("PLANTED FORGERY: further impossible combinations of valid members are refused", () => {
    const forged: readonly Partial<ScreeningDecisionReceiptRow>[] = [
      { decision: "reject", public_action: "published", coarse_category: "benign-context" },
      { decision: "pass", coarse_category: "injection", public_action: "published" },
      {
        decision: "quarantine",
        coarse_category: "provider-unavailable",
        provider_status: "ok",
        decision_path: "provider-timeout-fail-closed",
        public_action: "quarantined",
      },
      {
        decision: "allow-with-warning",
        coarse_category: "provider-unavailable",
        provider_status: "ok",
        decision_path: "benign-outage-degraded",
        public_action: "published-with-warning",
        public_notice: "screening-degraded",
      },
      {
        decision: "allow-with-warning",
        coarse_category: "benign-context",
        public_action: "published-with-warning",
        public_notice: "screening-warning",
      },
      {
        decision: "quarantine",
        coarse_category: "dual-use-boundary",
        decision_path: "direct-content-hold",
        public_action: "quarantined",
        public_notice: "screening-warning",
      },
    ];
    for (const overrides of forged) {
      expect(() => assertLocalS4ReceiptSafe(row(overrides))).toThrow(ContextualScreeningInputError);
    }
  });

  test("PLANTED FORGERY: a status code from another outcome is refused", () => {
    // pass · benign-context · ok · provider · published · none — a fully
    // coherent contract receipt — stored with SCREENING_PROVIDER_TIMEOUT. Every
    // member is valid and the contract union alone accepts it, because the
    // status code is this harness's transport field and the union has no
    // opinion about it. It is the receipt an audit found could still pass.
    expect(() =>
      assertLocalS4ReceiptSafe(row({ status_code: "SCREENING_PROVIDER_TIMEOUT" })),
    ).toThrow(ContextualScreeningInputError);
    expect(() =>
      assertLocalS4ReceiptSafe(row({ status_code: "SCREENING_PROVIDER_ERROR" })),
    ).toThrow(ContextualScreeningInputError);
    // And the mirror: a real outage row that claims the clean transport code.
    expect(() =>
      assertLocalS4ReceiptSafe(
        row({
          decision: "quarantine",
          coarse_category: "provider-unavailable",
          provider_status: "timeout",
          decision_path: "provider-timeout-fail-closed",
          public_action: "quarantined",
          status_code: "SCREENED",
        }),
      ),
    ).toThrow(ContextualScreeningInputError);
  });

  test("each provider status admits exactly one transport code", () => {
    expect(() => assertLocalS4ReceiptSafe(row({ status_code: "SCREENED" }))).not.toThrow();
    for (const [providerStatus, decisionPath, statusCode] of [
      ["timeout", "provider-timeout-fail-closed", "SCREENING_PROVIDER_TIMEOUT"],
      ["error", "provider-error-fail-closed", "SCREENING_PROVIDER_ERROR"],
    ] as const) {
      expect(() =>
        assertLocalS4ReceiptSafe(
          row({
            decision: "quarantine",
            coarse_category: "provider-unavailable",
            provider_status: providerStatus,
            decision_path: decisionPath,
            public_action: "quarantined",
            status_code: statusCode,
          }),
        ),
      ).not.toThrow();
    }
  });

  test("PLANTED FORGERY: a stale instant is refused even with a coherent tuple", () => {
    expect(() => assertLocalS4ReceiptSafe(row({ created_at: -1 }))).toThrow(
      ContextualScreeningInputError,
    );
    expect(() => assertLocalS4ReceiptSafe(row({ created_at: 253_402_300_800 }))).toThrow(
      ContextualScreeningInputError,
    );
  });

  test("the read-back refusal is fixed and reflects no part of the offending row", () => {
    let caught: unknown;
    try {
      assertLocalS4ReceiptSafe(
        row({
          decision: "quarantine",
          decision_path: "direct-content-hold",
          public_action: "published",
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ContextualScreeningInputError);
    const serialized = `${String(caught)} ${JSON.stringify(caught, Object.getOwnPropertyNames(caught))}`;
    expect(serialized).toContain("local screening receipt diagnostics are invalid");
    for (const leaked of ["quarantine", "direct-content-hold", "published", DIGEST, CONFIG]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  test("the field-invalid and cross-field-invalid refusals are indistinguishable", () => {
    // A caller must not be able to tell which half rejected the row; that
    // difference would be an oracle for assembling one that passes.
    const refusalFor = (overrides: Partial<ScreeningDecisionReceiptRow>): string => {
      try {
        assertLocalS4ReceiptSafe(row(overrides));
      } catch (error) {
        return String(error);
      }
      return "did-not-throw";
    };
    const fieldInvalid = refusalFor({ input_digest: "sha256:not-hex" });
    const crossFieldInvalid = refusalFor({ decision: "reject", public_action: "published" });
    expect(fieldInvalid).not.toBe("did-not-throw");
    expect(crossFieldInvalid).toBe(fieldInvalid);
  });
});

/**
 * The public action face is the one read path whose output leaves the harness,
 * so its triples are checked against the contract union directly.
 */
describe("the public screening action face refuses impossible triples", () => {
  const action = (
    coarseCategory: string,
    publicAction: string,
    publicNotice: string,
  ): PublicScreeningActionRow =>
    ({
      receipt_id: "DR-0000000000000000000000000A",
      coarse_category: coarseCategory,
      public_action: publicAction,
      public_notice: publicNotice,
    }) as PublicScreeningActionRow;

  test("every triple the contract admits still passes", () => {
    expect(() =>
      assertLocalS4PublicActionRows([
        action("benign-context", "published", "none"),
        action("dual-use-boundary", "published-with-warning", "screening-warning"),
        action("provider-unavailable", "published-with-warning", "screening-degraded"),
        action("provider-unavailable", "quarantined", "none"),
        action("operational-harm", "rejected", "none"),
      ]),
    ).not.toThrow();
  });

  test("PLANTED FORGERY: valid members in an impossible triple never reach the public face", () => {
    const forged: readonly (readonly [string, string, string])[] = [
      ["injection", "published", "none"],
      ["benign-context", "published-with-warning", "screening-warning"],
      ["benign-context", "rejected", "none"],
      ["dual-use-boundary", "published-with-warning", "screening-degraded"],
      ["provider-unavailable", "rejected", "none"],
      ["benign-context", "quarantined", "screening-warning"],
    ];
    for (const [category, act, notice] of forged) {
      expect(() => assertLocalS4PublicActionRows([action(category, act, notice)])).toThrow(
        LocalS3PublicShapeError,
      );
    }
  });

  test("one forged row poisons the whole page rather than being skipped", () => {
    expect(() =>
      assertLocalS4PublicActionRows([
        action("benign-context", "published", "none"),
        action("injection", "published", "none"),
      ]),
    ).toThrow(LocalS3PublicShapeError);
  });
});
