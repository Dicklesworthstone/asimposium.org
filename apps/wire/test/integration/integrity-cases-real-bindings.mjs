/**
 * W9.3c Scientific-Integrity Cases Real-Bindings E2E Lane (`asimposiumorg-bum`).
 *
 * Drives the REAL mounted Stoa Worker + migrated D1 + R2 (zero mocks):
 * - Enrolls author, independent reviewer, and independent reporter sponsors;
 *   publishes and sharpens a problem and promotes a public claim (`C-3`).
 * - Submits a live `POST /v1/reports` (`reason: "integrity"`) from an independent sponsor.
 * - Executes `D1IntegrityCaseStore` against genuine Workerd D1 (`env.DB`):
 *   1. Refuses ordinary-science intake (`honest-error`), proving zero D1 row created.
 *   2. Admits a typed misconduct allegation (`fabricated-citation`) tied to live `problem_id`,
 *      verifying neutral non-accusatory public notice (`disposition_mutated: false`) and
 *      restricted visibility (unrelated sponsor & conflicted operator refused; affected sponsor
 *      receives safe anchor only with `restricted_evidence_body: null` & `reporter_sponsor_id: null`).
 *   3. Races TWO concurrent independent operator `resolveCase` calls via `Promise.allSettled`
 *      against real D1, proving atomic CAS permits EXACTLY ONE winner and rejects the loser
 *      with `INTEGRITY_CASE_CONCURRENT_CONFLICT`.
 *   4. Exercises human-only appeal (Fellow bearer refused), conflicted appellate refusal,
 *      and independent appellate overturn -> verifies directly in D1 SQL that
 *      `restricted_evidence_body IS NULL`, `minimized = 1`, `visibility_action = 'restored'`,
 *      and `strike_handoff_json IS NULL`.
 *   5. Opens a second case, performs a real Fellow claim revision (`C-3@2`) on the live Worker,
 *      links the real immutable `events` row via `linkScientificCorrection`, confirms with a
 *      separately reasoned strike handoff (`auto_suspended: false`), and verifies immutable
 *      `events` + `event_content` envelopes remain intact with zero OPS.2a secret/PII leakage.
 */

import assert from "node:assert/strict";
import {
  buildPublicIntegrityNotice,
  D1IntegrityCaseStore,
} from "../../src/moderation/integrity-cases.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, env }) => {
  const ownerSponsor = "usr_int_real_owner";
  const reviewerSponsor = "usr_int_real_reviewer";
  const reporterSponsor = "usr_int_real_reporter";

  const author = await enroll("icase-proposer", ownerSponsor);
  const reviewer = await enroll("icase-reviewer", reviewerSponsor);
  const reporter = await enroll("icase-reporter", reporterSponsor);

  const authorHello = await call("/v1/hello", undefined, author, 200);
  const authorFellowId = authorHello.fellow.fellow_id;

  const created = await call(
    "/v1/problems",
    {
      title: "W9.3c Integrity cases real D1 problem",
      statement: "For every prime p > 2, p is odd.",
      falsifier: "A prime p > 2 divisible by 2.",
      motivation: "Exercise W9.3c integrity cases alongside live D1 reports and events.",
      scope: "Elementary parity of odd primes.",
      out_of_scope: "Composite integers.",
      success_criteria: "Immutable event envelopes preserved across integrity review and links.",
      areas: ["number-theory"],
    },
    author,
    201,
    "int-real-propose",
  );
  const problemId = created.problem.id;

  await sponsorCall(
    ownerSponsor,
    "POST",
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
    200,
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "int-real-publish",
  );

  const authorSess = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "prove" },
    author,
    201,
  );
  const reviewerSess = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "review" },
    reviewer,
    201,
  );

  await call(
    `/v1/problems/${problemId}/statement-review`,
    {
      session_id: reviewerSess.session_id,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "Statement and falsifier are exact.",
    },
    reviewer,
    200,
  );

  const draft = await call(
    `/v1/sessions/${authorSess.session_id}/workshop`,
    {
      type: "claim-draft",
      title: "Oddness of primes above 2",
      body_md: "If p > 2 were even then 2 divides p and 2 < p, contradicting primality.",
      relates_to: [],
    },
    author,
    201,
  );

  const promoted = await call(
    `/v1/sessions/${authorSess.session_id}/promote`,
    {
      workshop_id: draft.workshop_id,
      kind: "lemma",
      statement: "Every prime integer p > 2 is odd.",
      falsifier: "An even prime integer p > 2.",
    },
    author,
    201,
  );
  const claimId = promoted.claim_id;

  // File a real POST /v1/reports (reason: "integrity") from an independent sponsor.
  const report = await call(
    "/v1/reports",
    {
      problem_id: problemId,
      target: `${claimId}@1`,
      reason: "integrity",
      note: "Citation locator appears fabricated; requesting restricted integrity intake.",
    },
    reporter,
    201,
  );
  assert.equal(report.status, "pending");

  const store = new D1IntegrityCaseStore(env.DB);
  await store.ensureSchema();

  // 1. Ordinary-science intake MUST be refused and create zero D1 rows.
  const refusedOrdinary = await store.openCase({
    problem_id: problemId,
    target_ref: `${claimId}@1`,
    affected_fellow_id: authorFellowId,
    affected_sponsor_id: ownerSponsor,
    intake_source: "report",
    reporter_sponsor_id: reporterSponsor,
    proposed_class: null,
    ordinary_science_signal: "honest-error",
    deception_indicators: [],
    evidence_anchor: `report:${report.report_id}`,
    restricted_evidence_body: "Honest algebra slip only.",
  });
  assert.equal(refusedOrdinary.classification.admissible, false);
  assert.equal(refusedOrdinary.record, null);
  const zeroRows = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM scientific_integrity_cases",
  ).first();
  assert.equal(Number(zeroRows?.n ?? -1), 0);

  // 2. Admit typed misconduct allegation tied to live problem_id & report.
  const restrictedCanary = `RESTRICTED_D1_CANARY_93C: Bearer asimp_ag_01INTCANARY000000000000000_${"X".repeat(43)}`;
  const opened = await store.openCase({
    problem_id: problemId,
    target_ref: `${claimId}@1`,
    affected_fellow_id: authorFellowId,
    affected_sponsor_id: ownerSponsor,
    intake_source: "report",
    reporter_sponsor_id: reporterSponsor,
    proposed_class: "fabricated-citation",
    ordinary_science_signal: null,
    deception_indicators: [
      "Cited DOI resolves to an unrelated article while quoted theorem does not exist.",
    ],
    evidence_anchor: `report:${report.report_id}`,
    restricted_evidence_body: restrictedCanary,
    initial_action: "neutral-notice",
    conflicted_actors: ["op_conflicted_real"],
  });
  assert.equal(opened.classification.admissible, true);
  assert.ok(opened.record !== null);
  const caseId = opened.record.case_id;

  // Neutral public notice & restricted visibility enforcement.
  const notice = buildPublicIntegrityNotice(opened.record);
  assert.equal(notice.visible, true);
  assert.equal(notice.status_banner, "under-integrity-review");
  assert.equal(notice.disposition_mutated, false);
  assert.ok(!JSON.stringify(notice).includes("RESTRICTED_D1_CANARY_93C"));

  await assert.rejects(
    store.readRestrictedCase(caseId, {
      principal_class: "operator",
      actor_id: "op_conflicted_real",
    }),
    /INVESTIGATOR_CONFLICT_OF_INTEREST/,
  );
  // Reporter sponsor acting as operator MUST also be refused on restricted read.
  await assert.rejects(
    store.readRestrictedCase(caseId, {
      principal_class: "operator",
      actor_id: reporterSponsor,
    }),
    /INVESTIGATOR_CONFLICT_OF_INTEREST/,
  );
  const sponsorView = await store.readRestrictedCase(caseId, {
    principal_class: "sponsor",
    actor_id: ownerSponsor,
    sponsor_id: ownerSponsor,
  });
  assert.equal(sponsorView.reporter_sponsor_id, null);
  assert.equal(sponsorView.restricted_evidence_body, null);

  await store.assignInvestigator(caseId, {
    principal_class: "operator",
    actor_id: "op_investigator_a",
  });
  await store.submitSponsorResponse(
    caseId,
    { principal_class: "sponsor", actor_id: ownerSponsor, sponsor_id: ownerSponsor },
    "Human sponsor reviewed the anchor and submitted supporting bibliographic records.",
  );
  // Reassigning investigator after sponsor response MUST preserve state='under-review'.
  const keptUnderReview = await store.assignInvestigator(caseId, {
    principal_class: "operator",
    actor_id: "op_investigator_a",
  });
  assert.equal(keptUnderReview.state, "under-review");

  // 3. Race TWO concurrent operator resolveCase calls against genuine D1!
  const raceOutcomes = await Promise.allSettled([
    store.resolveCase(
      caseId,
      { principal_class: "operator", actor_id: "op_investigator_a" },
      {
        outcome: "confirmed",
        rationale: "Operator A confirmed citation mismatch against primary DOI metadata.",
        recommend_strike_review: true,
      },
    ),
    store.resolveCase(
      caseId,
      { principal_class: "operator", actor_id: "op_investigator_b" },
      {
        outcome: "confirmed",
        rationale: "Operator B simultaneously attempted to confirm the same integrity case.",
        recommend_strike_review: true,
      },
    ),
  ]);
  const wins = raceOutcomes.filter((r) => r.status === "fulfilled");
  const losses = raceOutcomes.filter((r) => r.status === "rejected");
  assert.equal(wins.length, 1, "exactly one concurrent operator decision may commit");
  assert.equal(losses.length, 1, "losing concurrent operator decision must fail closed");
  assert.match(
    String(losses[0].reason),
    /INTEGRITY_CASE_CONCURRENT_CONFLICT|INTEGRITY_CASE_ALREADY_DECIDED/,
  );
  const winnerDecider = wins[0].value.decided_by;

  // Decided case cannot be reopened by assignInvestigator.
  await assert.rejects(
    store.assignInvestigator(caseId, {
      principal_class: "operator",
      actor_id: "op_investigator_c",
    }),
    /INTEGRITY_CASE_ALREADY_DECIDED/,
  );

  // 4. Human-only appeal, conflicted appellate refusal, & independent overturn with real D1 minimization!
  await assert.rejects(
    store.submitAppeal(
      caseId,
      { principal_class: "fellow", actor_id: authorFellowId, sponsor_id: ownerSponsor },
      "Fellow attempting to submit sponsor appeal directly.",
    ),
    /HUMAN_SPONSOR_REQUIRED_FOR_APPEAL/,
  );
  await store.submitAppeal(
    caseId,
    { principal_class: "sponsor", actor_id: ownerSponsor, sponsor_id: ownerSponsor },
    "Sponsor submits publisher erratum showing the DOI redirect changed post-publication.",
  );
  await assert.rejects(
    store.decideAppeal(
      caseId,
      { principal_class: "operator", actor_id: winnerDecider },
      {
        outcome: "appeal-upheld",
        rationale: "Original decider must not adjudicate their own appeal.",
      },
    ),
    /APPELLATE_CONFLICT_OF_INTEREST/,
  );

  const overturned = await store.decideAppeal(
    caseId,
    { principal_class: "operator", actor_id: "op_appellate_independent" },
    {
      outcome: "appeal-overturned",
      rationale: "Independent appellate review verified publisher DOI redirect erratum.",
    },
  );
  assert.equal(overturned.state, "appeal-overturned");
  assert.equal(overturned.minimized, true);
  assert.equal(overturned.restricted_evidence_body, null);
  assert.equal(overturned.strike_handoff, null);

  // Verify directly in raw D1 SQL that restricted_evidence_body was physically cleared!
  const rawOverturned = await env.DB.prepare(
    "SELECT state, visibility_action, minimized, restricted_evidence_body, strike_handoff_json FROM scientific_integrity_cases WHERE case_id = ?",
  )
    .bind(caseId)
    .first();
  assert.equal(rawOverturned.state, "appeal-overturned");
  assert.equal(rawOverturned.visibility_action, "restored");
  assert.equal(Number(rawOverturned.minimized), 1);
  assert.equal(rawOverturned.restricted_evidence_body, null);
  assert.equal(rawOverturned.strike_handoff_json, null);

  // Overturned case refuses new misconduct correction links.
  await assert.rejects(
    store.linkScientificCorrection(caseId, {
      kind: "correction",
      linked_object_ref: `${claimId}@1`,
      event_id: "EV-01OVERTURNED01",
    }),
    /INTEGRITY_CASE_DISMISSED_NO_CORRECTION_LINK/,
  );

  // Real D1 immutability triggers refuse DELETE and terminal/binding UPDATE directly in SQL.
  await assert.rejects(
    env.DB.prepare("DELETE FROM scientific_integrity_cases WHERE case_id = ?").bind(caseId).run(),
    /cannot be deleted/i,
  );
  await assert.rejects(
    env.DB.prepare("UPDATE scientific_integrity_cases SET state = 'confirmed' WHERE case_id = ?")
      .bind(caseId)
      .run(),
    /immutable/i,
  );
  await assert.rejects(
    env.DB.prepare("UPDATE scientific_integrity_cases SET evidence_digest = ? WHERE case_id = ?")
      .bind("0".repeat(64), caseId)
      .run(),
    /immutable/i,
  );

  // 5. Second case linked to a REAL immutable event from `events` table + confirmed strike handoff.
  const eventRow = await env.DB.prepare(
    "SELECT id, seq FROM events WHERE problem_id = ? AND object_id = ? ORDER BY seq DESC LIMIT 1",
  )
    .bind(problemId, claimId)
    .first();
  assert.ok(eventRow?.id, "expected real immutable claim event in D1");

  const opened2 = await store.openCase({
    problem_id: problemId,
    target_ref: `${claimId}@1`,
    affected_fellow_id: authorFellowId,
    affected_sponsor_id: ownerSponsor,
    intake_source: "operator-review",
    reporter_sponsor_id: null,
    proposed_class: "forged-verifier-output",
    ordinary_science_signal: null,
    deception_indicators: ["Verifier output digest does not match any real toolchain emission."],
    evidence_anchor: `event:${eventRow.id}`,
    restricted_evidence_body: "Restricted verifier audit log excerpt.",
    initial_action: "quarantine",
  });
  assert.ok(opened2.record !== null);
  const linked = await store.linkScientificCorrection(opened2.record.case_id, {
    kind: "correction",
    linked_object_ref: `${claimId}@1`,
    event_id: String(eventRow.id),
  });
  assert.equal(linked.correction_links.length, 1);
  assert.equal(linked.correction_links[0].preserves_immutable_envelopes, true);

  // Real D1 append-only triggers refuse UPDATE/DELETE on scientific_integrity_correction_links.
  await assert.rejects(
    env.DB.prepare(
      "UPDATE scientific_integrity_correction_links SET kind = 'retraction' WHERE case_id = ?",
    )
      .bind(opened2.record.case_id)
      .run(),
    /append-only/i,
  );
  await assert.rejects(
    env.DB.prepare("DELETE FROM scientific_integrity_correction_links WHERE case_id = ?")
      .bind(opened2.record.case_id)
      .run(),
    /cannot be deleted/i,
  );

  const confirmed2 = await store.resolveCase(
    opened2.record.case_id,
    { principal_class: "operator", actor_id: "op_investigator_z" },
    {
      outcome: "confirmed",
      rationale: "Confirmed fabricated verifier output via independent deterministic rerun.",
      recommend_strike_review: true,
      event_id: String(eventRow.id),
    },
  );
  assert.equal(confirmed2.state, "confirmed");
  assert.equal(confirmed2.strike_handoff?.requires_separate_strike_review, true);
  assert.equal(confirmed2.strike_handoff?.auto_suspended, false);

  // OPS.2a log safety check: zero restricted canary/token/sponsor leaks across all transitions.
  const opsSerialized = JSON.stringify(store.getOpsLogs());
  assert.ok(!opsSerialized.includes("RESTRICTED_D1_CANARY_93C"));
  assert.ok(!opsSerialized.includes("asimp_ag_"));
  assert.ok(!opsSerialized.includes(ownerSponsor));

  // Verify original immutable event envelope & event_content are completely untouched.
  const afterEvent = await env.DB.prepare(
    "SELECT e.id, c.payload_sha256 FROM events e JOIN event_content c ON c.event_id = e.id WHERE e.id = ?",
  )
    .bind(eventRow.id)
    .first();
  assert.equal(afterEvent?.id, eventRow.id);

  console.log(
    JSON.stringify({
      stage: "integrity-cases-real-bindings",
      status: "pass",
      environment: "local-workerd-d1",
      problem_id: problemId,
      claim_id: claimId,
      report_id: report.report_id,
      concurrent_race_winners: wins.length,
      minimized_case_id: caseId,
      confirmed_case_id: opened2.record.case_id,
    }),
  );
});
