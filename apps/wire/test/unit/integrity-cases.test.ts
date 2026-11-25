/**
 * W9.3c Scientific-Integrity Cases, Neutral Notices, Minimization, and
 * Immutable Correction Linkage Test Suite (`asimposiumorg-bum`).
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
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
import { queryIntegrityCases, readIntegrityCase } from "../../src/moderation/integrity-read.ts";
import {
  openIntegrityCase,
  resolveIntegrityCase,
  respondToIntegrityCase,
} from "../../src/moderation/integrity-store.ts";
import { readOperatorReportDetail } from "../../src/moderation/report-detail.ts";
import {
  currentContentControl,
  listPendingReports,
  resolveReport,
} from "../../src/moderation/store.ts";
import {
  INTEGRITY_APPEAL_OPERATOR,
  INTEGRITY_OPERATOR,
  INTEGRITY_RATIONALE,
  INTEGRITY_REPORTER,
  INTEGRITY_RESPONSE,
  INTEGRITY_SUMMARY,
  integrityCaseFixture,
  openRequest,
  PROBLEM,
  resolveRequest,
  SPONSOR,
} from "../support/integrity-cases.ts";

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

type Fixture = Awaited<ReturnType<typeof integrityCaseFixture>>;
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});
async function setup() {
  const f = await integrityCaseFixture();
  fixtures.push(f);
  await f.publish();
  const report = await f.report();
  return { ...f, reportId: report.report_id };
}
function count(
  f: Fixture,
  table:
    | "integrity_cases"
    | "integrity_case_actions"
    | "integrity_command_receipts"
    | "operator_audit"
    | "content_controls"
    | "fellow_inbox_notices",
) {
  return (f.sql.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
function reportState(f: Fixture, reportId: string) {
  return (
    f.sql.query("SELECT status FROM reports WHERE report_id = ?").get(reportId) as {
      status: string;
    }
  ).status;
}
function beforeBatch(db: D1Database, hook: () => Promise<void>): D1Database {
  let pending = true;
  return {
    prepare: db.prepare.bind(db),
    async batch(statements: D1PreparedStatement[]) {
      if (pending) {
        pending = false;
        await hook();
      }
      return db.batch(statements);
    },
  } as D1Database;
}

test("integrity review pins the original source, records a sponsor response and one independent appeal without changing science", async () => {
  const f = await setup();
  const originalSource = (await readOperatorReportDetail(f.db, f.reportId))!.source;
  const correction = await f.publish("C-1", 2);
  const publicState = f.state();
  const request = openRequest(f.reportId);
  const opened = await openIntegrityCase(f.db, INTEGRITY_OPERATOR, request, "open-one");
  expect(await openIntegrityCase(f.db, INTEGRITY_OPERATOR, request, "open-one")).toEqual(opened);
  expect(opened).toMatchObject({ revision: 1, state: "open", appeals_used: 0 });
  expect(count(f, "integrity_cases")).toBe(1);
  expect((await listPendingReports(f.db)).totalPending).toBe(0);
  const own = await queryIntegrityCases(f.db, { limit: 20 }, SPONSOR);
  expect(own.cases.map((item) => item.case_id)).toEqual([opened.case_id]);
  expect((await queryIntegrityCases(f.db, { limit: 20 }, "usr_integrity_other")).cases).toEqual([]);
  const read = { case_id: opened.case_id, after_revision: 0, limit: 20 };
  const detail = await readIntegrityCase(f.db, read, SPONSOR);
  expect(detail.case.source.target_ref).toBe("C-1@1");
  if (originalSource.state !== "available") throw new Error("Expected retained source");
  expect(detail.case.source.event_id).toBe(originalSource.event_id);
  expect(JSON.stringify(detail)).not.toContain("PRIVATE_REPORTER_NOTE");
  expect(JSON.stringify(detail)).not.toContain(INTEGRITY_REPORTER);
  expect("report_id" in detail).toBe(false);
  expect(await readIntegrityCase(f.db, read)).toMatchObject({ report_id: f.reportId });
  await expect(readIntegrityCase(f.db, read, "usr_integrity_other")).rejects.toThrow("NOT_FOUND");

  const response = { case_id: opened.case_id, expected_revision: 1, response: INTEGRITY_RESPONSE };
  const responded = await respondToIntegrityCase(f.db, SPONSOR, response, "response-one");
  expect(responded.revision).toBe(2);
  expect(await respondToIntegrityCase(f.db, SPONSOR, response, "response-one")).toEqual(responded);
  await expect(
    respondToIntegrityCase(
      f.db,
      SPONSOR,
      {
        ...response,
        response: "A changed statement must not reuse the original command key.",
      },
      "response-one",
    ),
  ).rejects.toThrow("IDEMPOTENCY");

  const decision = {
    ...resolveRequest(opened.case_id, 2),
    correction_refs: [{ problem_id: PROBLEM, target_ref: "C-1@2" }],
  };
  const resolved = await resolveIntegrityCase(f.db, INTEGRITY_OPERATOR, decision, "resolve-one");
  expect(resolved).toMatchObject({ revision: 3, state: "resolved", appeals_used: 0 });
  expect(reportState(f, f.reportId)).toBe("dismissed");
  await f.publish("C-1", 3);
  const corrected = await readIntegrityCase(f.db, read, SPONSOR);
  expect(corrected.case.corrections).toMatchObject([
    {
      target_ref: "C-1@2",
      event_id: correction.eventId,
    },
  ]);
  const scienceAfterNewVersion = f.state();

  const appeal = await respondToIntegrityCase(
    f.db,
    SPONSOR,
    {
      case_id: opened.case_id,
      expected_revision: 3,
      response: "Please independently reconsider the interpretation of the source.",
    },
    "appeal-one",
  );
  expect(appeal).toMatchObject({ revision: 4, state: "open", action: "appealed", appeals_used: 1 });
  expect(reportState(f, f.reportId)).toBe("pending");
  const reopened = await readIntegrityCase(f.db, read, SPONSOR);
  expect(reopened.case).toMatchObject({ outcome: null, rationale: null, corrections: [] });
  await expect(
    resolveIntegrityCase(
      f.db,
      INTEGRITY_OPERATOR,
      resolveRequest(opened.case_id, 4),
      "same-reviewer",
    ),
  ).rejects.toThrow("REVIEWER");
  const final = await resolveIntegrityCase(
    f.db,
    INTEGRITY_APPEAL_OPERATOR,
    {
      ...resolveRequest(opened.case_id, 4),
      outcome: "confirmed",
    },
    "appeal-outcome",
  );
  expect(final).toMatchObject({ revision: 5, state: "resolved", appeals_used: 1 });
  expect(reportState(f, f.reportId)).toBe("upheld");
  await expect(
    respondToIntegrityCase(
      f.db,
      SPONSOR,
      {
        case_id: opened.case_id,
        expected_revision: 5,
        response: INTEGRITY_RESPONSE,
      },
      "second-appeal",
    ),
  ).rejects.toThrow("CONFLICT");
  expect(f.state()).toEqual(scienceAfterNewVersion);
  expect(publicState.events).toHaveLength(2);
  expect(count(f, "content_controls")).toBe(0);
  const all = await readIntegrityCase(f.db, read, SPONSOR);
  expect(all.actions.map((item) => item.kind)).toEqual([
    "opened",
    "response",
    "resolved",
    "appealed",
    "resolved",
  ]);
  expect(count(f, "integrity_case_actions")).toBe(5);
  expect(count(f, "integrity_command_receipts")).toBe(5);
  const firstPage = await readIntegrityCase(f.db, { ...read, limit: 2 }, SPONSOR);
  expect(firstPage).toMatchObject({ has_more: true, next_after_revision: 2 });
  const secondPage = await readIntegrityCase(f.db, { ...read, after_revision: 2 }, SPONSOR);
  expect(secondPage.actions.map((item) => item.revision)).toEqual([3, 4, 5]);
  const auditAndNotices = JSON.stringify({
    audit: f.sql.query("SELECT reason FROM operator_audit").all(),
    notices: f.sql.query("SELECT title,detail FROM fellow_inbox_notices").all(),
  });
  for (const privateText of [INTEGRITY_SUMMARY, INTEGRITY_RESPONSE, INTEGRITY_RATIONALE])
    expect(auditAndNotices).not.toContain(privateText);
});

test("known subject, reporter and correction-author conflicts cannot be waived by a declaration", async () => {
  const f = await setup();
  for (const operator of [SPONSOR, INTEGRITY_REPORTER]) {
    await expect(
      openIntegrityCase(f.db, operator, openRequest(f.reportId), `conflict-${operator}`),
    ).rejects.toThrow("REVIEWER");
  }
  await expect(
    openIntegrityCase(
      f.db,
      INTEGRITY_OPERATOR,
      {
        ...openRequest(f.reportId),
        auth_issued_at: 0,
      },
      "stale-auth",
    ),
  ).rejects.toThrow("STEP_UP");
  expect(count(f, "integrity_cases")).toBe(0);
  const opened = await openIntegrityCase(
    f.db,
    INTEGRITY_OPERATOR,
    openRequest(f.reportId),
    "eligible",
  );
  const correctionFellow = "F-INTEGRITY-CORRECTION";
  f.sql
    .query(`INSERT INTO enrollment_fellows
    (fellow_id,sponsor_id,name,model,harness,created_at) VALUES(?,?,?,?,?,?)`)
    .run(
      correctionFellow,
      INTEGRITY_APPEAL_OPERATOR,
      "correction-author",
      "model",
      "harness",
      Date.now(),
    );
  await f.publish("C-2", 1, { sponsor: INTEGRITY_APPEAL_OPERATOR, fellow: correctionFellow });
  await expect(
    resolveIntegrityCase(
      f.db,
      INTEGRITY_APPEAL_OPERATOR,
      {
        ...resolveRequest(opened.case_id, 1),
        correction_refs: [{ problem_id: PROBLEM, target_ref: "C-2@1" }],
      },
      "own-correction",
    ),
  ).rejects.toThrow("REVIEWER");
  await expect(
    resolveIntegrityCase(
      f.db,
      INTEGRITY_OPERATOR,
      {
        ...resolveRequest(opened.case_id, 1),
        correction_refs: [{ problem_id: PROBLEM, target_ref: "C-1@1" }],
      },
      "source-as-correction",
    ),
  ).rejects.toThrow("SOURCE_UNAVAILABLE");
  expect(
    (await readIntegrityCase(f.db, { case_id: opened.case_id, after_revision: 0, limit: 20 })).case
      .revision,
  ).toBe(1);
});

test("three integrity allegations do not hide a public claim; generic uphold cannot bypass a case", async () => {
  const f = await setup();
  await f.report("C-1@1", "usr_integrity_other");
  await f.report("C-1@1", INTEGRITY_APPEAL_OPERATOR);
  expect(await currentContentControl(f.db, PROBLEM, "C-1")).toBeUndefined();
  expect(
    await resolveReport(f.db, INTEGRITY_OPERATOR, {
      reportId: f.reportId,
      resolution: "uphold",
      reason: "A generic path cannot decide scientific integrity.",
    }),
  ).toMatchObject({ ok: false, reason: "integrity-case-required" });
  const opened = await openIntegrityCase(f.db, INTEGRITY_OPERATOR, openRequest(f.reportId), "case");
  expect(
    await resolveReport(f.db, INTEGRITY_OPERATOR, {
      reportId: f.reportId,
      resolution: "dismiss",
      reason: "A linked case owns this report's outcome.",
    }),
  ).toMatchObject({ ok: false, reason: "integrity-case-owned" });
  expect(
    (await readIntegrityCase(f.db, { case_id: opened.case_id, after_revision: 0, limit: 20 })).case
      .state,
  ).toBe("open");
  expect(count(f, "content_controls")).toBe(0);
});

test("a case and generic dismissal cannot both win a stale report snapshot", async () => {
  for (const first of ["case", "dismiss"] as const) {
    const f = await setup();
    const publicState = f.state();
    if (first === "case") {
      const raced = beforeBatch(f.db, async () => {
        await openIntegrityCase(f.db, INTEGRITY_OPERATOR, openRequest(f.reportId), "case-wins");
      });
      expect(
        await resolveReport(raced, INTEGRITY_OPERATOR, {
          reportId: f.reportId,
          resolution: "dismiss",
          reason: "A stale generic dismissal must lose.",
        }),
      ).toMatchObject({ ok: false });
      expect(reportState(f, f.reportId)).toBe("pending");
      expect(count(f, "integrity_cases")).toBe(1);
    } else {
      const raced = beforeBatch(f.db, async () => {
        expect(
          (
            await resolveReport(f.db, INTEGRITY_OPERATOR, {
              reportId: f.reportId,
              resolution: "dismiss",
              reason: "Unsupported report dismissed before investigation.",
            })
          ).ok,
        ).toBe(true);
      });
      await expect(
        openIntegrityCase(raced, INTEGRITY_OPERATOR, openRequest(f.reportId), "dismiss-wins"),
      ).rejects.toThrow("CONFLICT");
      expect(reportState(f, f.reportId)).toBe("dismissed");
      expect(count(f, "integrity_cases")).toBe(0);
    }
    expect(f.state()).toEqual(publicState);
  }
});

test("case history, audit, notification and receipt commit atomically and replay once", async () => {
  const f = await setup();
  f.sql.exec(`CREATE TRIGGER fail_integrity_notice BEFORE INSERT ON fellow_inbox_notices
    BEGIN SELECT RAISE(ABORT, 'planted integrity notice failure'); END`);
  await expect(
    openIntegrityCase(f.db, INTEGRITY_OPERATOR, openRequest(f.reportId), "atomic"),
  ).rejects.toThrow("planted integrity notice failure");
  for (const table of [
    "integrity_cases",
    "integrity_case_actions",
    "integrity_command_receipts",
    "operator_audit",
  ] as const)
    expect(count(f, table)).toBe(0);
  f.sql.exec("DROP TRIGGER fail_integrity_notice");
  const request = openRequest(f.reportId);
  const opened = await openIntegrityCase(f.db, INTEGRITY_OPERATOR, request, "atomic");
  const outcomes = await Promise.all(
    Array.from({ length: 4 }, () => openIntegrityCase(f.db, INTEGRITY_OPERATOR, request, "atomic")),
  );
  for (const receipt of outcomes) expect(receipt).toEqual(opened);
  expect(count(f, "integrity_case_actions")).toBe(1);
  expect(count(f, "fellow_inbox_notices")).toBe(1);
  expect(() =>
    f.sql
      .query("UPDATE integrity_case_actions SET body_json = '{}' WHERE case_id = ?")
      .run(opened.case_id),
  ).toThrow("IMMUTABLE");
});
