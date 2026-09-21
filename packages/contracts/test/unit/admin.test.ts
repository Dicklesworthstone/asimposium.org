import { describe, expect, test } from "bun:test";
import {
  AdminAreaRenameRequestSchema,
  AdminAuditEventSchema,
  AdminContentControlRequestSchema,
  AdminQuarantineDecisionRequestSchema,
  AdminQuarantineItemSchema,
  AdminReportItemSchema,
  AdminReportResolutionRequestSchema,
  assertNoScientificDispositionOverride,
  ScientificDispositionOverrideProhibitedError,
} from "../../src/admin.ts";

describe("W8.8c Admin Contracts & Protections", () => {
  test("AdminQuarantineItemSchema accepts valid screening provenance without leaks", () => {
    const valid = {
      id: "case-01",
      target_id: "submission-99",
      created_at: "2026-09-21T12:00:00Z",
      coarse_category: "dual-use-boundary",
      decision_path: "provider-contextual-hold",
      provider_status: "ok",
      input_digest: "a".repeat(64),
      context_frontier_digest: "b".repeat(64),
      model_version: "symposiarch-l1-v2",
      policy_version: "policy-v0.1.0",
      configuration_digest: "c".repeat(64),
      reviewer_state: "pending-operator-review",
      appeal_status: "pending",
    };

    const parsed = AdminQuarantineItemSchema.safeParse(valid);
    expect(parsed.success).toBe(true);

    // Rejects if extra uncontracted properties (e.g. raw prompt or score) are passed
    const withLeak = { ...valid, raw_prompt: "canary-prompt", score: 0.99 };
    const leakParsed = AdminQuarantineItemSchema.safeParse(withLeak);
    expect(leakParsed.success).toBe(false);
  });

  test("AdminQuarantineDecisionRequest requires valid decision and min 10-char reason", () => {
    const valid = {
      case_id: "case-01",
      decision: "release",
      reason: "Reviewed by operator: confirmed legitimate mathematical reasoning.",
    };
    expect(AdminQuarantineDecisionRequestSchema.safeParse(valid).success).toBe(true);

    // Refuses empty or short reason
    const shortReason = { ...valid, reason: "Too short" };
    expect(AdminQuarantineDecisionRequestSchema.safeParse(shortReason).success).toBe(false);

    // Refuses invalid decision
    const invalidDecision = { ...valid, decision: "arbitrary_status" };
    expect(AdminQuarantineDecisionRequestSchema.safeParse(invalidDecision).success).toBe(false);
  });

  test("AdminContentControlRequest accepts hide/restore/ban with mandatory reason", () => {
    const validHide = {
      target_id: "P-4DSP",
      target_kind: "problem",
      action: "hide",
      reason: "Spam statement with commercial external links.",
    };
    expect(AdminContentControlRequestSchema.safeParse(validHide).success).toBe(true);

    const validRestore = {
      target_id: "C-123",
      target_kind: "claim",
      action: "restore",
      reason: "Appeal granted: content does not violate floor policy.",
    };
    expect(AdminContentControlRequestSchema.safeParse(validRestore).success).toBe(true);

    const validBan = {
      target_id: "usr_malicious_sponsor_01",
      target_kind: "sponsor",
      action: "ban_sponsor",
      reason: "Persistent terms-of-service abuse and credential sharing.",
    };
    expect(AdminContentControlRequestSchema.safeParse(validBan).success).toBe(true);
  });

  test("assertNoScientificDispositionOverride strictly prohibits disposition tampering", () => {
    // Innocent payload passes
    expect(() =>
      assertNoScientificDispositionOverride({ action: "hide", reason: "Spam notice" }),
    ).not.toThrow();

    // Any attempt to set disposition by fiat throws ScientificDispositionOverrideProhibitedError
    expect(() =>
      assertNoScientificDispositionOverride({
        action: "hide",
        disposition: "strongly-supported",
      }),
    ).toThrow(ScientificDispositionOverrideProhibitedError);

    expect(() =>
      assertNoScientificDispositionOverride({
        scientific_disposition: "falsified",
      }),
    ).toThrow(ScientificDispositionOverrideProhibitedError);

    expect(() =>
      assertNoScientificDispositionOverride({
        claim_disposition: "conclusively-settled",
      }),
    ).toThrow(ScientificDispositionOverrideProhibitedError);

    expect(() =>
      assertNoScientificDispositionOverride({
        status_override: "resolved",
      }),
    ).toThrow(ScientificDispositionOverrideProhibitedError);
  });

  test("AdminReportItemSchema and AdminReportResolutionRequestSchema validate correctly", () => {
    const validReport = {
      report_id: "rep-001",
      target_id: "C-456",
      target_kind: "claim",
      created_at: "2026-09-21T13:00:00Z",
      reporter_class: "fellow",
      category: "injection",
      status: "pending",
    };
    expect(AdminReportItemSchema.safeParse(validReport).success).toBe(true);

    const validResolution = {
      report_id: "rep-001",
      resolution: "dismiss",
      reason: "Prompt injection probe was neutralized by render pipeline; no harm.",
    };
    expect(AdminReportResolutionRequestSchema.safeParse(validResolution).success).toBe(true);
  });

  test("AdminAreaRenameRequestSchema requires valid area ID, title length, and reason", () => {
    const valid = {
      area_id: "area-topology",
      new_title: "Geometric Topology & 4-Manifolds",
      reason: "Clarifying area scope according to community consensus.",
    };
    expect(AdminAreaRenameRequestSchema.safeParse(valid).success).toBe(true);

    const invalid = { ...valid, reason: "short" };
    expect(AdminAreaRenameRequestSchema.safeParse(invalid).success).toBe(false);
  });

  test("AdminAuditEventSchema enforces immutable audit event structure", () => {
    const event = {
      event_id: "audit-evt-100",
      timestamp: "2026-09-21T14:00:00Z",
      operator_id: "usr_operator_trusted_alice",
      action: "quarantine.approve",
      target_id: "case-01",
      reason: "Verified mathematical notation; no dual-use risk present.",
      before_state_digest: "0".repeat(64),
      after_state_digest: "1".repeat(64),
    };
    expect(AdminAuditEventSchema.safeParse(event).success).toBe(true);
  });
});
