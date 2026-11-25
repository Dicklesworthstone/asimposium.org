/**
 * W9.3c Scientific-Integrity Cases, Neutral Notices, Minimization, and
 * Immutable Correction Linkage Test Suite (`asimposiumorg-bum`).
 */

import { describe, expect, test } from "bun:test";
import {
  assertNoDirectDispositionMutation,
  assertRestrictedIntegrityHeaders,
  buildPublicIntegrityNotice,
  classifyIntegrityIntake,
  INTEGRITY_POLICY_DIGEST,
  IntegrityCaseLedger,
  type IntegrityIntakeInput,
  type OrdinaryScienceSignal,
} from "../../src/moderation/integrity-cases.ts";

function baseMisconductInput(overrides: Partial<IntegrityIntakeInput> = {}): IntegrityIntakeInput {
  return {
    problem_id: "P-INT-1",
    target_ref: "C-1@1",
    affected_fellow_id: "F-01INTFELLOW000000000000001",
    affected_sponsor_id: "usr_int_sponsor_a",
    intake_source: "report",
    reporter_sponsor_id: "usr_int_reporter_b",
    proposed_class: "fabricated-citation",
    ordinary_science_signal: null,
    deception_indicators: [
      "Cited DOI resolves to unrelated 1998 biology article while fabricated theorem quote was invented.",
    ],
    evidence_anchor: "L-4@1 / sha256:abcdef0123456789",
    restricted_evidence_body:
      "RESTRICTED_ALLEGATION_CANARY_991: Bearer asimp_ag_01SECRET000000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA sponsor@example.org",
    initial_action: "neutral-notice",
    ...overrides,
  };
}

describe("W9.3c Scientific-integrity cases, neutral notices, minimization, and correction linkage (asimposiumorg-bum)", () => {
  test("CLASSIFICATION MATRIX: separates ordinary scientific errors/weakness/self-correction from misconduct allegations", () => {
    const nonMisconductCases: readonly OrdinaryScienceSignal[] = [
      "honest-error",
      "weak-science",
      "unavailable-source",
      "citation-mistake",
      "lawful-quotation",
      "false-plagiarism-match",
      "honest-failed-reproduction",
      "self-correction",
      "statement-defect",
      "changed-conclusion",
    ];
    for (const signal of nonMisconductCases) {
      const res = classifyIntegrityIntake(
        baseMisconductInput({
          proposed_class: null,
          ordinary_science_signal: signal,
        }),
      );
      expect(res.admissible, `${signal} must NOT enter misconduct track`).toBe(false);
      expect(res.code).toBe("ORDINARY_SCIENCE_NOT_MISCONDUCT");
      expect(res.recommended_scientific_path).toBeTruthy();
    }

    // Bare disagreement without deception indicators fails intake cleanly.
    const bareDisagreement = classifyIntegrityIntake(
      baseMisconductInput({ deception_indicators: [] }),
    );
    expect(bareDisagreement.admissible).toBe(false);
    expect(bareDisagreement.code).toBe("INSUFFICIENT_DECEPTION_SIGNAL");

    // All 5 typed misconduct classes admit when corroborated deception evidence exists.
    for (const allegation of [
      "fabricated-citation",
      "forged-verifier-output",
      "plagiarism",
      "identity-model-misrepresentation",
      "coordinated-review-manipulation",
    ] as const) {
      const admitted = classifyIntegrityIntake(baseMisconductInput({ proposed_class: allegation }));
      expect(admitted.admissible).toBe(true);
      expect(admitted.allegation_class).toBe(allegation);
    }
  });

  test("NEUTRAL NOTICE, RESTRICTED VISIBILITY, CONFLICT GUARDS, AND HUMAN-ONLY SPONSOR RESPONSE/APPEAL", () => {
    const ledger = new IntegrityCaseLedger();
    const { classification, record } = ledger.openCase(
      baseMisconductInput({
        proposed_class: "forged-verifier-output",
        conflicted_actors: ["op_conflicted_1"],
      }),
    );
    expect(classification.admissible).toBe(true);
    expect(record).not.toBeNull();
    if (!record) throw new Error("expected record");

    // 1. Public notice is neutral and non-accusatory; never mutates scientific disposition.
    const openNotice = buildPublicIntegrityNotice(record);
    expect(openNotice.visible).toBe(true);
    expect(openNotice.status_banner).toBe("under-integrity-review");
    expect(openNotice.disposition_mutated).toBe(false);
    expect(openNotice.text).toContain("not a finding of misconduct");
    expect(openNotice.text).not.toMatch(/\b(fraud|guilty|forged|fabricated|plagiarized)\b/i);

    // 2. Restricted file authorization & cache/noindex header policy.
    expect(() =>
      ledger.readRestrictedCase(record.case_id, {
        principal_class: "sponsor",
        actor_id: "usr_unrelated",
        sponsor_id: "usr_unrelated",
      }),
    ).toThrow(/INTEGRITY_CASE_RESTRICTED_FORBIDDEN/);

    // Affected sponsor can inspect case without reporter identity OR raw restricted evidence body leak.
    const sponsorView = ledger.readRestrictedCase(record.case_id, {
      principal_class: "sponsor",
      actor_id: "usr_int_sponsor_a",
      sponsor_id: "usr_int_sponsor_a",
    });
    expect(sponsorView.reporter_sponsor_id).toBeNull();
    expect(sponsorView.restricted_evidence_body).toBeNull();
    expect(sponsorView.evidence_anchor).toBe(record.evidence_anchor);

    // Conflicted operator cannot inspect restricted case either!
    expect(() =>
      ledger.readRestrictedCase(record.case_id, {
        principal_class: "operator",
        actor_id: "op_conflicted_1",
      }),
    ).toThrow(/INVESTIGATOR_CONFLICT_OF_INTEREST/);

    expect(
      assertRestrictedIntegrityHeaders({
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
      }).ok,
    ).toBe(true);
    const badHeaders = assertRestrictedIntegrityHeaders({
      "Cache-Control": "public, s-maxage=60",
    });
    expect(badHeaders.ok).toBe(false);
    expect(badHeaders.violations).toContain("RESTRICTED_CASE_MISSING_PRIVATE_NO_STORE");
    expect(badHeaders.violations).toContain("RESTRICTED_CASE_MISSING_NOINDEX");

    // 3. Investigator conflicts fail closed (affected sponsor, reporter, or declared conflict).
    for (const conflictedId of ["usr_int_sponsor_a", "usr_int_reporter_b", "op_conflicted_1"]) {
      expect(() =>
        ledger.assignInvestigator(record.case_id, {
          principal_class: "operator",
          actor_id: conflictedId,
        }),
      ).toThrow(/INVESTIGATOR_CONFLICT_OF_INTEREST/);
    }
    const assigned = ledger.assignInvestigator(record.case_id, {
      principal_class: "operator",
      actor_id: "op_independent_1",
    });
    expect(assigned.state).toBe("awaiting-response");

    // 4. Fellow bearer cannot submit sponsor response; accountable human sponsor can.
    expect(() =>
      ledger.submitSponsorResponse(
        record.case_id,
        {
          principal_class: "fellow",
          actor_id: "F-01INTFELLOW000000000000001",
          sponsor_id: "usr_int_sponsor_a",
        },
        "Agent attempting to submit sponsor response directly.",
      ),
    ).toThrow(/HUMAN_SPONSOR_REQUIRED_FOR_RESPONSE/);

    const responded = ledger.submitSponsorResponse(
      record.case_id,
      {
        principal_class: "sponsor",
        actor_id: "usr_int_sponsor_a",
        sponsor_id: "usr_int_sponsor_a",
      },
      "Human sponsor reviewed the verifier transcript and is attaching a corrective retraction.",
    );
    expect(responded.state).toBe("under-review");
    expect(responded.sponsor_response_digest).toMatch(/^[a-f0-9]{64}$/);

    // 5. Direct scientific disposition mutation is structurally impossible (top-level and nested).
    expect(() => assertNoDirectDispositionMutation({ override_disposition: "refuted" })).toThrow(
      /DIRECT_DISPOSITION_MUTATION_FORBIDDEN/,
    );
    expect(() =>
      assertNoDirectDispositionMutation({ nested: [{ mint_disposition: "strongly-supported" }] }),
    ).toThrow(/DIRECT_DISPOSITION_MUTATION_FORBIDDEN/);

    // 6. Link immutable correction/retraction without erasing ledger envelopes (and reject duplicate event links).
    const linked = ledger.linkScientificCorrection(record.case_id, {
      kind: "retraction",
      linked_object_ref: "R-01CORRECTED0000000000000001",
      event_id: "EV-01INTLINK0000000000000001",
    });
    expect(linked.correction_links).toHaveLength(1);
    expect(linked.correction_links[0]?.preserves_immutable_envelopes).toBe(true);
    expect(() =>
      ledger.linkScientificCorrection(record.case_id, {
        kind: "retraction",
        linked_object_ref: "R-01CORRECTED0000000000000001",
        event_id: "EV-01INTLINK0000000000000001",
      }),
    ).toThrow(/DUPLICATE_CORRECTION_LINK_EVENT/);

    // 7. Confirm case -> emits separately reasoned strike handoff (NEVER auto-suspends).
    const confirmed = ledger.resolveCase(
      record.case_id,
      { principal_class: "operator", actor_id: "op_independent_1" },
      {
        outcome: "confirmed",
        rationale:
          "Independent log verification confirmed synthetic verifier stdout did not match any real run.",
        recommend_strike_review: true,
        event_id: "EV-01INTDEC0000000000000001",
      },
    );
    expect(confirmed.state).toBe("confirmed");
    expect(confirmed.strike_handoff?.requires_separate_strike_review).toBe(true);
    expect(confirmed.strike_handoff?.auto_suspended).toBe(false);
    const resolvedNotice = buildPublicIntegrityNotice(confirmed);
    expect(resolvedNotice.status_banner).toBe("resolved-correction-linked");
    expect(resolvedNotice.linked_corrections).toHaveLength(1);

    // 8. Appeal requires human sponsor + independent appellate reviewer (not original decider).
    expect(() =>
      ledger.submitAppeal(
        record.case_id,
        { principal_class: "fellow", actor_id: "F-01INTFELLOW000000000000001" },
        "Fellow cannot file human appeal.",
      ),
    ).toThrow(/HUMAN_SPONSOR_REQUIRED_FOR_APPEAL/);

    const appealed = ledger.submitAppeal(
      record.case_id,
      {
        principal_class: "sponsor",
        actor_id: "usr_int_sponsor_a",
        sponsor_id: "usr_int_sponsor_a",
      },
      "Contesting attribution of verifier truncation under full build logs.",
    );
    expect(appealed.state).toBe("appealed");

    expect(() =>
      ledger.decideAppeal(
        record.case_id,
        { principal_class: "operator", actor_id: "op_independent_1" },
        {
          outcome: "appeal-upheld",
          rationale: "Same operator cannot adjudicate their own appeal.",
        },
      ),
    ).toThrow(/APPELLATE_CONFLICT_OF_INTEREST/);

    const overturned = ledger.decideAppeal(
      record.case_id,
      { principal_class: "operator", actor_id: "op_appellate_2" },
      {
        outcome: "appeal-overturned",
        rationale:
          "Appellate review confirmed truncation came from deterministic wrapper buffering, not deception.",
      },
    );
    expect(overturned.state).toBe("appeal-overturned");
    expect(overturned.visibility_action).toBe("restored");
    expect(overturned.minimized).toBe(true);
    expect(overturned.restricted_evidence_body).toBeNull();
    expect(overturned.strike_handoff).toBeNull();
    expect(buildPublicIntegrityNotice(overturned).visible).toBe(false);

    // 9. OPS.2a telemetry logs contain case/action/class/policy_digest and ZERO restricted bodies/secrets/PII.
    const serializedLogs = JSON.stringify(ledger.getOpsLogs());
    expect(serializedLogs).toContain(INTEGRITY_POLICY_DIGEST);
    expect(serializedLogs).toContain(record.case_id);
    expect(serializedLogs).not.toContain("RESTRICTED_ALLEGATION_CANARY_991");
    expect(serializedLogs).not.toContain("asimp_ag_");
    expect(serializedLogs).not.toContain("sponsor@example.org");
    expect(serializedLogs).not.toContain("usr_int_sponsor_a");
  });

  test("UNSUBSTANTIATED DISMISSAL: restores content and minimizes restricted evidence to audit digest only", () => {
    const ledger = new IntegrityCaseLedger();
    const { record } = ledger.openCase(
      baseMisconductInput({
        proposed_class: "coordinated-review-manipulation",
        initial_action: "quarantine",
      }),
    );
    if (!record) throw new Error("expected record");

    const dismissed = ledger.resolveCase(
      record.case_id,
      { principal_class: "operator", actor_id: "op_independent_3" },
      {
        outcome: "dismissed-unsubstantiated",
        rationale:
          "Independent sponsor review records showed genuine independent derivations without coordination.",
      },
    );
    expect(dismissed.state).toBe("dismissed-unsubstantiated");
    expect(dismissed.visibility_action).toBe("restored");
    expect(dismissed.minimized).toBe(true);
    expect(dismissed.restricted_evidence_body).toBeNull();
    expect(dismissed.evidence_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(dismissed.strike_handoff).toBeNull();
    expect(buildPublicIntegrityNotice(dismissed).visible).toBe(false);

    // Fresh-eyes Pass 2 regressions:
    // 1. Decided case cannot be reopened by assignInvestigator.
    expect(() =>
      ledger.assignInvestigator(record.case_id, {
        principal_class: "operator",
        actor_id: "op_independent_4",
      }),
    ).toThrow(/INTEGRITY_CASE_ALREADY_DECIDED/);

    // 2. Invalid correction object ref or invalid timestamp fails closed.
    expect(() =>
      ledger.linkScientificCorrection(record.case_id, {
        kind: "correction",
        linked_object_ref: "asimp_ag_leaked_not_an_object_id",
        event_id: "EV-01BAD00001",
      }),
    ).toThrow(/INVALID_CORRECTION_LINK/);
    // Valid correction ref on a dismissed-unsubstantiated case fails closed.
    expect(() =>
      ledger.linkScientificCorrection(record.case_id, {
        kind: "correction",
        linked_object_ref: "C-1@2",
        event_id: "EV-01DISMISSED1",
      }),
    ).toThrow(/INTEGRITY_CASE_DISMISSED_NO_CORRECTION_LINK/);
    expect(() => ledger.openCase(baseMisconductInput(), "not-a-valid-date")).toThrow(
      /INVALID_INTEGRITY_TIMESTAMP/,
    );
  });

  test("REGRESSION (Pass 3 fresh-eyes): reporter-operator refused on readRestrictedCase and reassigning investigator after sponsor response preserves under-review", () => {
    const ledger = new IntegrityCaseLedger();
    const { record } = ledger.openCase(baseMisconductInput());
    if (!record) throw new Error("expected record");

    // Reporter sponsor acting as operator MUST be refused from reading restricted details too.
    expect(() =>
      ledger.readRestrictedCase(record.case_id, {
        principal_class: "operator",
        actor_id: "usr_int_reporter_b",
      }),
    ).toThrow(/INVESTIGATOR_CONFLICT_OF_INTEREST/);

    // Sponsor responds -> state transitions to under-review.
    const responded = ledger.submitSponsorResponse(
      record.case_id,
      {
        principal_class: "sponsor",
        actor_id: "usr_int_sponsor_a",
        sponsor_id: "usr_int_sponsor_a",
      },
      "Detailed human sponsor response with verifiable archive hashes.",
    );
    expect(responded.state).toBe("under-review");

    // Assigning or reassigning an investigator after sponsor response MUST keep state under-review.
    const reassigned = ledger.assignInvestigator(record.case_id, {
      principal_class: "operator",
      actor_id: "op_independent_9",
    });
    expect(reassigned.investigator_id).toBe("op_independent_9");
    expect(reassigned.state).toBe("under-review");
  });
});
