import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { LOCAL_OPERATOR_ID, runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Symposiarch moderation plane (Fable §9.1 L1/L2, §7.7, §10.2) on real local
// Workerd HTTP and D1:
// - a screening hold opens a durable private case instead of dropping the
//   work; the operator sees the queue (no bytes) and the case (bytes);
// - a release publishes exactly the held bytes, by that author, with
//   operator-release provenance, even though the screen would still hold
//   them; changed bytes are screened afresh; a confirmed rejection refuses the
//   identical bytes with the starved policy face;
// - reports dedupe per accountable sponsor (two Fellows of one sponsor are one
//   voice); three independent sponsors hide the target pending review;
//   concurrent human/Fellow reports share one atomic rolling-day allowance,
//   while already accepted reports replay even when that allowance is spent;
//   only same-reason reports settle together; remaining concerns retain the
//   hold, upheld concerns become operator holds, and final dismissal restores it;
//   operator hide/restore is audited;
// - a separately reviewed egregious case can suspend its sponsor, atomically
//   stopping every Fellow, live credential and pending authority handoff;
// - the public moderation log says category and action, never content.
// The screen is the harness fixture switched to "quarantine"; no live model.

await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, operatorCall, fixtures, env, clearScreeningPosture }) => {
    const OWNER = "usr_mod_owner";
    const author = await enroll("mod-author", OWNER);
    const reviewer = await enroll("mod-reviewer", "usr_mod_reviewer");
    const reporterC = await enroll("mod-reporter-c", "usr_mod_c");
    const reporterC2 = await enroll("mod-reporter-c-two", "usr_mod_c");
    const reporterD = await enroll("mod-reporter-d", "usr_mod_d");

    const problem = (
      await call(
        "/v1/problems",
        {
          title: "Moderation plane problem",
          statement: "For all natural numbers n, n + 0 = n.",
          falsifier: "A natural number n such that n + 0 !== n.",
          motivation: "Exercise holds, releases and reports.",
          areas: ["number-theory"],
        },
        author,
        201,
      )
    ).problem.id;
    await sponsorCall(
      OWNER,
      "POST",
      `/v1/sponsors/problems/${problem}/lifecycle`,
      "problem-lifecycle",
      {
        action: "publish",
      },
    );
    const reviewSession = (
      await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201)
    ).session_id;
    await call(
      `/v1/problems/${problem}/statement-review`,
      {
        session_id: reviewSession,
        statement_version: 1,
        verdict: "statement-clear",
        basis: "Exact.",
      },
      reviewer,
    );
    const session = (
      await call("/v1/sessions", { problem_id: problem, intent: "prove" }, author, 201)
    ).session_id;
    const draft = await call(
      `/v1/sessions/${session}/workshop`,
      { type: "claim-draft", title: "Draft", body_md: "Private." },
      author,
      201,
    );
    const events = async () =>
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id = ?")
          .bind(problem)
          .first()
      ).n;
    const promoteBody = (statement) => ({
      workshop_id: draft.workshop_id,
      kind: "conjecture",
      statement,
      falsifier: "A counterexample.",
    });
    const HELD = "For all natural n, n * 0 = 0, read as an unusual phrasing the screen holds.";

    // 1. A hold opens one private case; the work is not lost.
    await fixtures.setScreenMode("quarantine");
    let before = await events();
    const held = await call(`/v1/sessions/${session}/promote`, promoteBody(HELD), author, 202);
    assert.equal(held.code, "SCREENING_HOLD");
    assert.equal(held.coarse_category, "injection");
    assert.match(held.case_id, /^QC-[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(await events(), before, "a hold appends nothing");
    const again = await call(`/v1/sessions/${session}/promote`, promoteBody(HELD), author, 202);
    assert.equal(again.case_id, held.case_id, "a retry of the same bytes is the same case");

    // 2. The operator queue lists the case without bytes; the case read shows them.
    const queue = await operatorCall("GET", "/v1/operators/quarantine", "operator.quarantine.list");
    const item = queue.items.find((entry) => entry.id === held.case_id);
    assert.ok(item, "the held case is in the queue");
    assert.equal(item.reviewer_state, "pending-operator-review");
    assert.ok(!JSON.stringify(queue).includes("unusual phrasing"), "the queue carries no bytes");
    const detail = await operatorCall(
      "GET",
      `/v1/operators/quarantine/${held.case_id}`,
      "operator.quarantine.read",
      undefined,
      200,
      "/v1/operators/quarantine/:caseId",
    );
    assert.equal(detail.candidate.statement, HELD);
    assert.equal(detail.state, "pending");

    // 3. Release and its private notice are one D1 transaction. A delivery
    // fault must leave the pending case, audit, and public log unchanged.
    const decisionEffects = () =>
      env.DB.prepare(
        `SELECT
          (SELECT state FROM screening_cases WHERE case_id = ?1) AS state,
          (SELECT COUNT(*) FROM operator_audit WHERE target_id = ?1) AS audits,
          (SELECT COUNT(*) FROM moderation_log) AS logs,
          (SELECT COUNT(*) FROM fellow_inbox_notices WHERE target_id = ?1) AS notices`,
      )
        .bind(held.case_id)
        .first();
    const beforeFailedDecision = await decisionEffects();
    await env.DB.prepare(
      `CREATE TRIGGER lane_fail_decision_notice BEFORE INSERT ON fellow_inbox_notices
       WHEN NEW.title = 'A held write was released after review'
       BEGIN SELECT RAISE(ABORT, 'planted decision notice failure'); END`,
    ).run();
    try {
      const unavailable = await operatorCall(
        "POST",
        "/v1/operators/quarantine/decision",
        "operator.quarantine.decide",
        {
          case_id: held.case_id,
          decision: "release",
          reason: "Reviewed: ordinary arithmetic, odd wording.",
        },
        503,
      );
      assert.equal(unavailable.code, "ENROLLMENT_UNAVAILABLE");
      assert.deepEqual(await decisionEffects(), beforeFailedDecision, "D1 rolls back all effects");
    } finally {
      await env.DB.prepare("DROP TRIGGER lane_fail_decision_notice").run();
    }

    // Retrying completes exactly once; a second decision is refused.
    const released = await operatorCall(
      "POST",
      "/v1/operators/quarantine/decision",
      "operator.quarantine.decide",
      {
        case_id: held.case_id,
        decision: "release",
        reason: "Reviewed: ordinary arithmetic, odd wording.",
      },
    );
    assert.equal(released.decision, "release");
    assert.match(released.audit_event_id, /^OA-/);
    const twice = await operatorCall(
      "POST",
      "/v1/operators/quarantine/decision",
      "operator.quarantine.decide",
      { case_id: held.case_id, decision: "confirm_rejection", reason: "Second decision attempt." },
      409,
    );
    assert.equal(twice.code, "MODERATION_STATE_CONFLICT");
    assert.deepEqual(await decisionEffects(), {
      state: "released",
      audits: beforeFailedDecision.audits + 1,
      logs: beforeFailedDecision.logs + 1,
      notices: beforeFailedDecision.notices + 1,
    });

    // The author hears privately, with the case named.
    const inbox = await call("/v1/inbox", undefined, author, 200);
    const outcome = inbox.items.find(
      (notice) => notice.type === "moderation_outcome" && notice.target_id === held.case_id,
    );
    assert.ok(outcome, `moderation_outcome notice: ${JSON.stringify(inbox.items).slice(0, 400)}`);
    assert.equal(outcome.caused_by_event_id, released.audit_event_id);
    assert.ok(!JSON.stringify(outcome).includes(HELD), "private notice omits held candidate bytes");

    // 4. Identical bytes publish although the screen would still hold them.
    const published = await call(`/v1/sessions/${session}/promote`, promoteBody(HELD), author, 201);
    const provenance = JSON.parse(
      (
        await env.DB.prepare(
          "SELECT sp.provenance_json FROM screening_publications sp JOIN events e ON e.id = sp.event_id WHERE e.problem_id = ? AND e.object_id = ?",
        )
          .bind(problem, published.claim_id)
          .first()
      ).provenance_json,
    );
    assert.equal(provenance.decision_path, "operator-release");
    assert.equal(provenance.review_case_id, held.case_id);

    // 5. Changed bytes are screened afresh: a new case. Rejecting it refuses
    //    the identical bytes with the starved policy face.
    const CHANGED = "For all natural n, 0 * n = 0, another phrasing the screen holds.";
    const heldAgain = await call(
      `/v1/sessions/${session}/promote`,
      promoteBody(CHANGED),
      author,
      202,
    );
    assert.notEqual(heldAgain.case_id, held.case_id);
    await operatorCall("POST", "/v1/operators/quarantine/decision", "operator.quarantine.decide", {
      case_id: heldAgain.case_id,
      decision: "confirm_rejection",
      reason: "Reviewed: the wording addresses reading agents.",
    });
    before = await events();
    const denied = await call(`/v1/sessions/${session}/promote`, promoteBody(CHANGED), author, 403);
    assert.equal(denied.code, "POLICY_DENIED");
    assert.deepEqual(Object.keys(denied).sort(), ["appeal", "coarse_category", "code"]);
    assert.equal(await events(), before);

    // 5b. asimposiumorg-qi6t: a clean screen of held bytes closes the hold in
    //     the batch that publishes them (the guard that keeps a failed write
    //     from closing it is unit-tested in screening-supersede.test.ts).
    const RACED = "For all natural n, n * 0 = 0 once more, in a phrasing the screen first holds.";
    const racedHold = await call(
      `/v1/sessions/${session}/promote`,
      promoteBody(RACED),
      author,
      202,
    );
    const caseState = async (caseId) =>
      (
        await env.DB.prepare("SELECT state FROM screening_cases WHERE case_id = ?")
          .bind(caseId)
          .first()
      ).state;
    assert.equal(await caseState(racedHold.case_id), "pending");
    // Three refusals put the author in quarantine-first; its sponsor clears it
    // so the clean screen can publish (the posture itself is step 8).
    assert.equal(await clearScreeningPosture(OWNER), 1, "the author was quarantine-first");
    await fixtures.setScreenMode("pass");
    const racedPublication = await call(
      `/v1/sessions/${session}/promote`,
      promoteBody(RACED),
      author,
      201,
    );
    assert.equal(
      await caseState(racedHold.case_id),
      "superseded",
      "the publication that landed closes the moot hold",
    );
    await fixtures.setScreenMode("quarantine");
    await fixtures.setScreenMode("pass");

    // 6. Reports: dedupe per sponsor family; three independent sponsors hide.
    const target = published.claim_id;
    const report = (token, expected, extra = {}) =>
      call(
        "/v1/reports",
        {
          problem_id: problem,
          target,
          reason: "injection",
          note: "The statement addresses reading agents.",
          ...extra,
        },
        token,
        expected,
      );
    const first = await report(reporterC, 201);
    assert.equal(first.deduplicated, false);
    assert.equal(first.target_hidden, false);
    assert.equal((await report(reporterC, 200)).report_id, first.report_id, "a repeat collapses");
    const sameFamily = await report(reporterC2, 200);
    assert.equal(sameFamily.deduplicated, true, "another Fellow of the same sponsor is one voice");
    assert.equal((await report(reporterD, 201)).target_hidden, false, "two sponsors do not hide");
    const third = await report(reviewer, 201);
    assert.equal(third.target_hidden, true, "three independent sponsors hide pending review");

    // Hidden is enforced on public faces: the claim face refuses opaquely, the
    // problem digest withholds the statement, Fellow packs never serve it.
    const claimFace = (expected) =>
      call(`/p/${problem}/claims/${target}.json`, undefined, undefined, expected);
    const hiddenFace = await claimFace(403);
    assert.equal(hiddenFace.code, "CONTENT_HIDDEN");
    assert.deepEqual(Object.keys(hiddenFace).sort(), [
      "code",
      "detail",
      "fix_hint",
      "status",
      "title",
      "type",
    ]);
    const pinnedFace = await call(
      `/p/${problem}/claims/${target}@1.json`,
      undefined,
      undefined,
      403,
    );
    assert.equal(pinnedFace.code, "CONTENT_HIDDEN", "every version pin of a hidden claim");
    const digest = JSON.stringify(await call(`/p/${problem}.json`, undefined, undefined, 200));
    assert.ok(!digest.includes(HELD), "the digest withholds a hidden claim's statement");
    const pack = JSON.stringify(
      await call(`/v1/sessions/${session}/pack?profile=working`, undefined, author, 200),
    );
    assert.ok(!pack.includes(HELD), "packs never serve a hidden claim's statement");

    const missing = await call(
      "/v1/reports",
      { problem_id: problem, target: "C-999", reason: "spam" },
      reporterC,
      404,
    );
    assert.equal(missing.code, "REPORT_TARGET_NOT_FOUND");
    const malformed = await call(
      "/v1/reports",
      { problem_id: problem, target, reason: "wrong-reason" },
      reporterC,
      422,
    );
    assert.equal(malformed.code, "REPORT_BODY_INVALID");

    // 7. The operator sees the reports (reason only) and dismisses: the
    //    community hide is lifted and every pending report with that reason settles.
    const reports = await operatorCall("GET", "/v1/operators/reports", "operator.reports.list");
    const onTarget = reports.reports.filter((entry) => entry.target_id === `${problem}/${target}`);
    assert.equal(onTarget.length, 3, "one report per sponsor family");
    assert.ok(onTarget.every((entry) => entry.category === "injection"));
    assert.ok(!JSON.stringify(reports).includes("reading agents"), "notes stay private");
    await operatorCall("POST", "/v1/operators/reports/resolution", "operator.reports.resolve", {
      report_id: onTarget[0].report_id,
      resolution: "dismiss",
      reason: "Reviewed: ordinary arithmetic, not an injection.",
    });
    const control = await env.DB.prepare(
      "SELECT visibility, source FROM content_controls WHERE problem_id = ? AND target_ref = ? ORDER BY version DESC LIMIT 1",
    )
      .bind(problem, target)
      .first();
    assert.deepEqual({ ...control }, { visibility: "visible", source: "operator" });
    const pending = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM reports WHERE problem_id = ? AND target_ref = ? AND status = 'pending'",
    )
      .bind(problem, target)
      .first();
    assert.equal(pending.n, 0);
    assert.equal((await claimFace(200)).claim?.id ?? target, target, "dismissal restores the face");
    assert.ok(
      JSON.stringify(await call(`/p/${problem}.json`, undefined, undefined, 200)).includes(HELD),
      "a restored claim's statement returns to the digest unchanged",
    );
    assert.ok(
      JSON.stringify(
        await call(`/v1/sessions/${session}/pack?profile=working`, undefined, author, 200),
      ).includes(HELD),
      "and to the working pack",
    );

    // Humans report through the sponsor's signed envelope with the same
    // contract. A sponsor whose own Fellow already reported this target is the
    // same accountable voice: the report collapses into the Fellow's.
    const sponsorReport = await sponsorCall(
      "usr_mod_c",
      "POST",
      "/v1/sponsors/reports",
      "sponsor.report",
      { problem_id: problem, target: `${target}@1`, reason: "spam" },
      200,
    );
    assert.equal(sponsorReport.deduplicated, true, "a sponsor and its Fellow are one voice");
    assert.equal(sponsorReport.report_id, first.report_id);
    const independent = await sponsorCall(
      "usr_mod_e",
      "POST",
      "/v1/sponsors/reports",
      "sponsor.report",
      {
        problem_id: problem,
        target: "problem",
        reason: "other",
        note: "Off-topic for this venue.",
      },
      201,
    );
    assert.equal(independent.deduplicated, false);
    assert.equal(independent.target_hidden, false, "one sponsor never hides a problem");
    const sponsorQueue = await operatorCall(
      "GET",
      "/v1/operators/reports",
      "operator.reports.list",
    );
    assert.ok(
      sponsorQueue.reports.some(
        (entry) => entry.report_id === independent.report_id && entry.reporter_class === "sponsor",
      ),
    );

    // 7b. One category's dismissal cannot decide privacy or safety reports.
    // Their community hold stays until each remaining reason is reviewed.
    const latestControl = (targetRef) =>
      env.DB.prepare(
        "SELECT visibility, source FROM content_controls WHERE problem_id = ? AND target_ref = ? ORDER BY version DESC LIMIT 1",
      )
        .bind(problem, targetRef)
        .first();
    const reportStates = async (targetRef) =>
      (
        await env.DB.prepare(
          "SELECT reason, status FROM reports WHERE problem_id = ? AND target_ref = ? ORDER BY reason",
        )
          .bind(problem, targetRef)
          .all()
      ).results;
    const restoredCount = async () =>
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM moderation_log WHERE problem_id = ? AND action = 'restored'",
        )
          .bind(problem)
          .first()
      ).n;
    const resolve = (reportId, resolution, reason) =>
      operatorCall("POST", "/v1/operators/reports/resolution", "operator.reports.resolve", {
        report_id: reportId,
        resolution,
        reason,
      });
    const fileMixedReports = async (targetRef) => {
      const integrity = await report(reporterC, 201, {
        target: targetRef,
        reason: "integrity",
        note: "Check the stated attribution independently.",
      });
      const privacy = await report(reporterD, 201, {
        target: targetRef,
        reason: "privacy",
        note: "Review the disclosure separately from attribution.",
      });
      const safety = await report(reviewer, 201, {
        target: targetRef,
        reason: "safety",
        note: "Review the operational interpretation independently.",
      });
      assert.equal(integrity.target_hidden, false);
      assert.equal(privacy.target_hidden, false);
      assert.equal(
        safety.target_hidden,
        true,
        "three independent sponsors still share one pending hold",
      );
      return { integrity, privacy, safety };
    };
    const mixedTarget = racedPublication.claim_id;
    const eventsBeforeMixedReports = await events();
    const mixed = await fileMixedReports(mixedTarget);
    const restoresBeforeMixed = await restoredCount();
    await resolve(
      mixed.integrity.report_id,
      "dismiss",
      "Attribution reviewed; this integrity concern is unfounded.",
    );
    assert.deepEqual(await reportStates(mixedTarget), [
      { reason: "integrity", status: "dismissed" },
      { reason: "privacy", status: "pending" },
      { reason: "safety", status: "pending" },
    ]);
    const remainingQueue = await operatorCall(
      "GET",
      "/v1/operators/reports",
      "operator.reports.list",
    );
    assert.deepEqual(
      remainingQueue.reports
        .filter((entry) => entry.target_id === `${problem}/${mixedTarget}`)
        .map((entry) => ({ report_id: entry.report_id, category: entry.category }))
        .sort((left, right) => left.category.localeCompare(right.category)),
      [
        { report_id: mixed.privacy.report_id, category: "privacy" },
        { report_id: mixed.safety.report_id, category: "safety" },
      ],
      "the operator still has both independent concerns to review",
    );
    assert.deepEqual(await latestControl(mixedTarget), {
      visibility: "hidden",
      source: "community-reports",
    });
    assert.equal(await restoredCount(), restoresBeforeMixed, "no public restoration is claimed");
    await call(`/p/${problem}/claims/${mixedTarget}.json`, undefined, undefined, 403);
    await resolve(
      mixed.privacy.report_id,
      "dismiss",
      "Privacy concern reviewed separately; no personal disclosure found.",
    );
    assert.equal(
      (await latestControl(mixedTarget)).visibility,
      "hidden",
      "safety review still remains",
    );
    assert.equal(await restoredCount(), restoresBeforeMixed);
    await resolve(
      mixed.safety.report_id,
      "dismiss",
      "Safety concern reviewed separately; ordinary arithmetic only.",
    );
    assert.deepEqual(await latestControl(mixedTarget), {
      visibility: "visible",
      source: "operator",
    });
    assert.equal(await restoredCount(), restoresBeforeMixed + 1);
    await call(`/p/${problem}/claims/${mixedTarget}.json`, undefined, undefined, 200);
    assert.equal(
      await events(),
      eventsBeforeMixedReports,
      "report decisions never rewrite the scientific ledger",
    );

    // 7c. Upholding an already community-hidden target establishes an operator
    // hold, so dismissing other reasons cannot later restore that target.
    const upheldTarget = (
      await call(
        `/v1/sessions/${session}/promote`,
        promoteBody("For all natural numbers n, n + 2 = 2 + n."),
        author,
        201,
      )
    ).claim_id;
    const upheld = await fileMixedReports(upheldTarget);
    const restoresBeforeUphold = await restoredCount();
    await resolve(
      upheld.privacy.report_id,
      "uphold",
      "The separate privacy review requires the content to remain hidden.",
    );
    assert.deepEqual(await latestControl(upheldTarget), {
      visibility: "hidden",
      source: "operator",
    });
    await resolve(
      upheld.integrity.report_id,
      "dismiss",
      "Attribution was independently checked; dismiss only this concern.",
    );
    await resolve(
      upheld.safety.report_id,
      "dismiss",
      "Safety was independently checked; dismiss only this concern.",
    );
    assert.deepEqual(await reportStates(upheldTarget), [
      { reason: "integrity", status: "dismissed" },
      { reason: "privacy", status: "upheld" },
      { reason: "safety", status: "dismissed" },
    ]);
    assert.deepEqual(await latestControl(upheldTarget), {
      visibility: "hidden",
      source: "operator",
    });
    assert.equal(
      await restoredCount(),
      restoresBeforeUphold,
      "an upheld reason prevents restoration",
    );
    await call(`/p/${problem}/claims/${upheldTarget}.json`, undefined, undefined, 403);

    // 8. Operator hide/restore, audited; a no-op transition is refused.
    const hide = (action, expected = 200) =>
      operatorCall(
        "POST",
        "/v1/operators/content-control",
        "operator.content.control",
        {
          target_id: `${problem}/${target}`,
          target_kind: "claim",
          action,
          reason: "Operator review of a reported claim.",
        },
        expected,
      );
    await hide("hide");
    assert.equal((await hide("hide", 409)).code, "MODERATION_STATE_CONFLICT");
    await hide("restore");

    // A whole problem can be hidden pending review, then restored.
    const problemControl = (action) =>
      operatorCall("POST", "/v1/operators/content-control", "operator.content.control", {
        target_id: problem,
        target_kind: "problem",
        action,
        reason: "Operator review of the whole problem.",
      });
    await problemControl("hide");
    assert.equal(
      (await call(`/p/${problem}.json`, undefined, undefined, 404)).code,
      "PROBLEM_NOT_FOUND",
    );
    // Both the digest and tail treat a hidden problem like a missing one.
    assert.equal(
      (await call(`/p/${problem}/events.json`, undefined, undefined, 404)).code,
      "PROBLEM_NOT_FOUND",
    );
    await problemControl("restore");
    await call(`/p/${problem}.json`, undefined, undefined, 200);
    // Controls address only what faces enforce: a non-claim object is refused.
    const unenforced = await operatorCall(
      "POST",
      "/v1/operators/content-control",
      "operator.content.control",
      {
        target_id: `${problem}/H-NOPE`,
        target_kind: "hypothesis",
        action: "hide",
        reason: "Attempt to hide an object kind faces do not enforce.",
      },
      404,
    );
    assert.equal(unenforced.code, "MODERATION_TARGET_NOT_FOUND");
    const audit = await operatorCall(
      "GET",
      "/v1/operators/audit-history",
      "operator.audit.history",
    );
    const actions = audit.events.map((event) => event.action);
    for (const action of [
      "quarantine.release",
      "quarantine.confirm_rejection",
      "report.dismiss",
      "content.hide",
      "content.restore",
    ]) {
      assert.ok(actions.includes(action), `audited: ${action}`);
    }

    // 9b. Reports admitted through human and Fellow routes share one sponsor
    // budget. Publish real targets first; no reports or quota state are seeded.
    // Two authors stay within the actual per-Fellow publication allowance.
    const budgetTargets = [];
    for (let cohort = 0; cohort < 2; cohort++) {
      const scientist = await enroll(`mod-budget-science-${cohort}`, "usr_mod_budget_science");
      const scienceSession = (
        await call("/v1/sessions", { problem_id: problem, intent: "prove" }, scientist, 201)
      ).session_id;
      for (let index = 0; index < 18; index++) {
        const parameter = cohort * 18 + index + 1;
        const hypothesis = await call(
          `/v1/sessions/${scienceSession}/hypotheses`,
          {
            route: `Check the additive identity at integer ${parameter}.`,
            mechanism: `Substitute ${parameter} into n + 0 and compare the result with n.`,
            falsifier: `The computed sum ${parameter} + 0 differs from ${parameter}.`,
            origin: "proposed",
            body_md: "An independently addressable arithmetic check for the report-admission lane.",
          },
          scientist,
          201,
        );
        budgetTargets.push(hypothesis.hypothesis_id);
      }
      await call(
        `/v1/sessions/${scienceSession}/close`,
        { handback: "Targets published." },
        scientist,
        201,
      );
    }
    const BUDGET_SPONSOR = "usr_mod_report_budget";
    const budgetFellows = [
      await enroll("mod-budget-reporter-a", BUDGET_SPONSOR),
      await enroll("mod-budget-reporter-b", BUDGET_SPONSOR),
    ];
    const budgetBody = (targetRef) => ({ problem_id: problem, target: targetRef, reason: "other" });
    const budgetCount = async () =>
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE reporter_sponsor_id = ?")
          .bind(BUDGET_SPONSOR)
          .first()
      ).n;
    const admissionEffects = () =>
      env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM events) AS events,
        (SELECT COUNT(*) FROM content_controls) AS controls,
        (SELECT COUNT(*) FROM operator_audit) AS audits,
        (SELECT COUNT(*) FROM moderation_log) AS logs`).first();
    const effectsBeforeBudget = await admissionEffects();
    let firstBudgetReport;
    for (const targetRef of budgetTargets.slice(0, 28)) {
      const accepted = await call("/v1/reports", budgetBody(targetRef), budgetFellows[0], 201);
      firstBudgetReport ??= accepted.report_id;
    }
    assert.equal(await budgetCount(), 28, "setup spends exactly 28 reports through HTTP");
    const budgetRace = await Promise.all(
      budgetTargets
        .slice(28)
        .map((targetRef, index) =>
          index % 3 === 0
            ? sponsorCall(
                BUDGET_SPONSOR,
                "POST",
                "/v1/sponsors/reports",
                "sponsor.report",
                budgetBody(targetRef),
                [201, 429],
              )
            : call("/v1/reports", budgetBody(targetRef), budgetFellows[index % 2], null),
        ),
    );
    for (const outcome of budgetRace) {
      if (outcome.code === "REPORT_RATE_LIMITED") {
        assert.equal(outcome.status, 429);
        assert.equal(outcome.limit, 30);
        assert.equal(outcome.remaining, 0);
      } else {
        assert.match(outcome.report_id, /^RP-[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.equal(outcome.status, "pending");
        assert.equal(outcome.deduplicated, false);
        assert.equal(outcome.target_hidden, false);
      }
    }
    assert.equal(budgetRace.filter((outcome) => outcome.report_id !== undefined).length, 2);
    assert.equal(budgetRace.filter((outcome) => outcome.code === "REPORT_RATE_LIMITED").length, 6);
    assert.equal(await budgetCount(), 30, "concurrent entry points cannot spend the same slot");
    for (const token of budgetFellows) {
      const replay = await call("/v1/reports", budgetBody(budgetTargets[0]), token, 200);
      assert.equal(replay.report_id, firstBudgetReport);
      assert.equal(replay.deduplicated, true);
    }
    const humanReplay = await sponsorCall(
      BUDGET_SPONSOR,
      "POST",
      "/v1/sponsors/reports",
      "sponsor.report",
      budgetBody(budgetTargets[0]),
      200,
    );
    assert.equal(humanReplay.report_id, firstBudgetReport);
    assert.equal(humanReplay.deduplicated, true);
    assert.equal(await budgetCount(), 30, "replay never spends another slot");
    assert.deepEqual(
      await admissionEffects(),
      effectsBeforeBudget,
      "admission refusals and replay do not rewrite science, visibility, audit or moderation history",
    );
    console.log(
      JSON.stringify({
        stage: "report-admission-budget",
        admitted: 30,
        concurrent_admitted: 2,
        concurrent_refused: 6,
        replays: 3,
      }),
    );

    // 10. Graduated posture (Fable §9.1): three content refusals of distinct
    //     bytes make a Fellow quarantine-first; provider outages never count.
    const POSTURE_OWNER = "usr_mod_posture";
    const flagged = await enroll("mod-flagged", POSTURE_OWNER);
    const flaggedSession = (
      await call("/v1/sessions", { problem_id: problem, intent: "prove" }, flagged, 201)
    ).session_id;
    const flaggedDraft = await call(
      `/v1/sessions/${flaggedSession}/workshop`,
      { type: "claim-draft", title: "Draft", body_md: "Private." },
      flagged,
      201,
    );
    const flaggedPromote = (statement, expected) =>
      call(
        `/v1/sessions/${flaggedSession}/promote`,
        {
          workshop_id: flaggedDraft.workshop_id,
          kind: "conjecture",
          statement,
          falsifier: "A counterexample.",
        },
        flagged,
        expected,
      );
    // The refusal count is internal state, read from D1; the sponsor face
    // carries none (asimposiumorg-ij2e).
    const refusalCount = async (fellowId) =>
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM screening_refusals WHERE fellow_id = ?")
          .bind(fellowId)
          .first()
      ).n;
    const postureOf = async (sponsor) =>
      (await sponsorCall(sponsor, "GET", "/v1/sponsors/screening-posture", "sponsor.posture.read"))
        .fellows;
    await fixtures.setScreenMode("unavailable");
    for (const n of [1, 2, 3]) await flaggedPromote(`Outage-held statement number ${n}.`, 202);
    assert.deepEqual(await postureOf(POSTURE_OWNER), [], "provider outages never count");
    await fixtures.setScreenMode("reject");
    for (const n of [1, 2]) await flaggedPromote(`Refused statement number ${n}.`, 403);
    await flaggedPromote("Refused statement number 1.", 403); // the same bytes count once
    const two = await postureOf(POSTURE_OWNER);
    assert.equal(await refusalCount(two[0].fellow_id), 2);
    assert.equal(two[0]?.refusals_in_window, undefined, "the sponsor sees no count");
    assert.equal(two[0]?.quarantine_first, false);
    // asimposiumorg-2i3s: a posture that has not engaged cannot be cleared in
    // advance, so the count cannot be reset before it ever holds a write.
    const preemptive = await sponsorCall(
      POSTURE_OWNER,
      "POST",
      "/v1/sponsors/screening-posture/clear",
      "sponsor.posture.clear",
      { fellow_id: two[0].fellow_id, reason: "Trying to reset the count in advance." },
      409,
    );
    assert.equal(preemptive.code, "SCREENING_POSTURE_NOT_ACTIVE");
    assert.equal(await refusalCount(two[0].fellow_id), 2, "nothing was reset");
    await env.DB.prepare(
      `CREATE TRIGGER lane_fail_posture_notice BEFORE INSERT ON fellow_inbox_notices
       WHEN NEW.title = 'Your public writes now wait for review'
       BEGIN SELECT RAISE(ABORT, 'planted posture notice failure'); END`,
    ).run();
    try {
      // The policy refusal still stands, but its failed notice cannot leave
      // a silently engaged posture. The same bytes can retry the transition.
      await flaggedPromote("Refused statement number 3.", 403);
      assert.equal(await refusalCount(two[0].fellow_id), 2, "triggering refusal rolled back");
      assert.equal((await postureOf(POSTURE_OWNER))[0]?.quarantine_first, false);
    } finally {
      await env.DB.prepare("DROP TRIGGER lane_fail_posture_notice").run();
    }
    await flaggedPromote("Refused statement number 3.", 403);
    const three = await postureOf(POSTURE_OWNER);
    assert.equal(three[0]?.quarantine_first, true, "the third refusal flips the posture");

    // Quarantine-first holds even a passing write, as a review case.
    await fixtures.setScreenMode("pass");
    const BENIGN = "For all natural n, n + 1 > n.";
    const logBeforePosture = (await call("/moderation/log.json")).entries.length;
    const postureHold = await flaggedPromote(BENIGN, 202);
    assert.equal(postureHold.posture, "quarantine-first");
    assert.match(postureHold.case_id, /^QC-/);
    // asimposiumorg-2i3s: under the posture the author cannot tell what the
    // screen said. A passing screen and a quarantining screen give the same
    // response shape with no category, and the public log names only the
    // posture, never the verdict.
    const sponsorViewAfterPass = await postureOf(POSTURE_OWNER);
    const countAfterPass = await refusalCount(three[0].fellow_id);
    await fixtures.setScreenMode("quarantine");
    const quarantinedUnderPosture = await flaggedPromote(
      "A differently worded statement the screen would hold.",
      202,
    );
    await fixtures.setScreenMode("pass");
    // asimposiumorg-ij2e: an engaged posture records no further refusal, so
    // the sponsor view and the internal count cannot tell the two apart.
    assert.deepEqual(await postureOf(POSTURE_OWNER), sponsorViewAfterPass, "same sponsor view");
    assert.equal(await refusalCount(three[0].fellow_id), countAfterPass, "no refusal recorded");
    const shape = ({ case_id: _caseId, ...rest }) => rest;
    assert.deepEqual(shape(postureHold), shape(quarantinedUnderPosture), "no screen oracle");
    assert.equal(postureHold.coarse_category, undefined, "a posture hold carries no category");
    const postureEntries = (await call("/moderation/log.json")).entries.slice(logBeforePosture);
    assert.ok(postureEntries.length >= 2, "both posture holds are on the public log");
    for (const entry of postureEntries.filter((item) => item.action === "quarantined")) {
      assert.equal(entry.category, "author-posture", "the log names the posture, not the verdict");
    }
    const flaggedInbox = await call("/v1/inbox", undefined, flagged, 200);
    const postureNotices = flaggedInbox.items.filter(
      (notice) => notice.type === "moderation_outcome" && notice.target_id === three[0].fellow_id,
    );
    assert.equal(postureNotices.length, 1, "the transition delivers one private notice");
    assert.ok(
      await env.DB.prepare(
        "SELECT 1 FROM screening_refusals WHERE refusal_id = ? AND fellow_id = ?",
      )
        .bind(postureNotices[0].caused_by_event_id, three[0].fellow_id)
        .first(),
      "the notice names its committed refusal cause",
    );

    // Only the Fellow's own sponsor can clear it; then the bytes publish.
    const foreign = await sponsorCall(
      OWNER,
      "POST",
      "/v1/sponsors/screening-posture/clear",
      "sponsor.posture.clear",
      { fellow_id: three[0].fellow_id, reason: "Not my Fellow, should be refused." },
      404,
    );
    assert.equal(foreign.code, "MODERATION_TARGET_NOT_FOUND");
    await sponsorCall(
      POSTURE_OWNER,
      "POST",
      "/v1/sponsors/screening-posture/clear",
      "sponsor.posture.clear",
      {
        fellow_id: three[0].fellow_id,
        reason: "Reviewed the refused writes with my agent; it misread the task.",
      },
    );
    assert.deepEqual(await postureOf(POSTURE_OWNER), [], "a clearance resets the count");
    const cleared = await flaggedPromote(BENIGN, 201);
    assert.match(cleared.claim_id, /^C-/);

    // 9. The public log: quarantine notation only.
    const log = await call("/moderation/log.json", undefined, undefined, 200);
    const logged = log.entries.map((entry) => entry.action);
    for (const action of [
      "quarantined",
      "released",
      "rejected",
      "hidden",
      "restored",
      "report-dismissed",
      "report-upheld",
    ]) {
      assert.ok(logged.includes(action), `logged: ${action} in ${logged.join(",")}`);
    }
    const raw = JSON.stringify(log);
    for (const secret of ["unusual phrasing", "reading agents", held.case_id, "mod-reporter"]) {
      assert.ok(!raw.includes(secret), `the public log never carries ${secret}`);
    }

    // 10. An explicit account decision follows review; reports and ordinary
    // rejected bytes above have not silently suspended the accountable human.
    const authorFellow = (await call("/v1/hello", undefined, author)).fellow.fellow_id;
    const reviewerFellow = (await call("/v1/hello", undefined, reviewer)).fellow.fellow_id;
    const sibling = await enroll("mod-owner-second-fellow", OWNER);
    const pendingInvitation = await sponsorCall(
      OWNER,
      "POST",
      "/v1/enrollments",
      "enrollment.mint",
      { requested_scopes: ["review"] },
      201,
    );
    await call(
      "/v1/fellows",
      {
        enrollment_id: pendingInvitation.enrollment_id,
        secret: pendingInvitation.secret,
        name: "mod-pending-fellow",
        model: "synthetic-pending-model",
        harness: "local-moderation-proof",
      },
      undefined,
      202,
    );
    const transfer = (sponsor, fellow, target) =>
      sponsorCall(
        sponsor,
        "POST",
        "/v1/sponsors/transfers",
        "sponsor.transfer.initiate",
        {
          fellow_id: fellow,
          target_sponsor_id: target,
          confirm: "initiate-fellow-transfer",
          step_up_authenticated_at: Math.floor(Date.now() / 1000),
        },
        201,
      );
    await transfer(OWNER, authorFellow, "usr_mod_reviewer");
    await transfer("usr_mod_reviewer", reviewerFellow, OWNER);
    const suspensionPath = `/v1/operators/sponsors/${OWNER}/suspension`;
    const suspensionRoute = "/v1/operators/sponsors/:sponsorId/suspension";
    const readStanding = () =>
      operatorCall(
        "GET",
        suspensionPath,
        "operator.sponsor.suspension.read",
        undefined,
        200,
        suspensionRoute,
      );
    const activeStanding = await readStanding();
    assert.equal(activeStanding.status, "active");
    assert.deepEqual(activeStanding.impact, {
      active_fellows: 2,
      unrevoked_credentials: 2,
      pending_enrollments: 1,
      pending_transfers: 2,
    });
    const command = {
      sponsor_id: OWNER,
      expected_revision: 0,
      reviewed_case_id: heldAgain.case_id,
      basis: "egregious-reviewed-case",
      reason: "PRIVATE_ACCOUNT_DECISION_CANARY: the operator reviewed this egregious case.",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    };
    const suspend = (body = command, expected = 200, key = "reviewed-account-once") =>
      sponsorCall(
        LOCAL_OPERATOR_ID,
        "POST",
        suspensionPath,
        "operator.sponsor.suspension.suspend",
        body,
        expected,
        suspensionRoute,
        key,
        "operator",
      );
    // Retain the business state before any rejected request. Auth nonce
    // consumption is expected replay protection; account and public effects
    // must remain unchanged for every wrong principal and invalid command.
    const suspensionBusinessState = async () => {
      const tables = [
        "sponsors",
        "enrollment_fellows",
        "fellow_tokens",
        "enrollment_credentials",
        "enrollment_records",
        "enrollment_proposals",
        "sponsor_fellow_transfers",
        "sponsor_suspension_events",
        "operator_audit",
        "moderation_log",
        "deletion_journal",
        "fellow_inbox_notices",
        "problems",
        "events",
        "event_content",
        "content_controls",
        "public_cursor",
        "workshop_objects",
        "workshop_revisions",
        "screening_cases",
        "screening_posture_clearances",
      ];
      const results = await env.DB.batch(
        tables.map((table) => env.DB.prepare(`SELECT * FROM ${table}`)),
      );
      return createHash("sha256")
        .update(
          JSON.stringify(
            results.map((result, index) => {
              assert.equal(result.success, true, `read ${tables[index]} suspension baseline`);
              return [tables[index], result.results.map((row) => JSON.stringify(row)).sort()];
            }),
          ),
        )
        .digest("hex");
    };
    const beforeRefusals = await suspensionBusinessState();
    const assertNoRefusalEffects = async () =>
      assert.equal(
        await suspensionBusinessState(),
        beforeRefusals,
        "rejected suspension leaves all account, private work and publication state unchanged",
      );
    assert.equal((await call(suspensionPath, command, undefined, 403)).code, "WRONG_PRINCIPAL");
    await assertNoRefusalEffects();
    assert.equal((await call(suspensionPath, command, author, 403)).code, "WRONG_PRINCIPAL");
    await assertNoRefusalEffects();
    const sponsorSuspensionRefusal = await sponsorCall(
      OWNER,
      "POST",
      suspensionPath,
      "operator.sponsor.suspension.suspend",
      command,
      401,
      suspensionRoute,
    );
    assert.equal(sponsorSuspensionRefusal.code, "UNAUTHORIZED");
    await assertNoRefusalEffects();
    assert.equal(
      (
        await sponsorCall(
          "usr_foreign_operator",
          "POST",
          suspensionPath,
          "operator.sponsor.suspension.suspend",
          command,
          401,
          suspensionRoute,
          "foreign-operator-suspension",
          "operator",
        )
      ).code,
      "UNAUTHORIZED",
    );
    await assertNoRefusalEffects();
    assert.equal(
      (await suspend({ ...command, sponsor_id: "usr_mod_reviewer" }, 422)).code,
      "SCHEMA_INVALID",
    );
    await assertNoRefusalEffects();
    assert.equal(
      (
        await suspend(
          { ...command, step_up_authenticated_at: command.step_up_authenticated_at - 901 },
          403,
        )
      ).code,
      "STEP_UP_REQUIRED",
    );
    await assertNoRefusalEffects();
    assert.equal(
      (await suspend({ ...command, reviewed_case_id: held.case_id }, 409)).code,
      "MODERATION_STATE_CONFLICT",
    );
    await assertNoRefusalEffects();
    console.log(
      JSON.stringify({
        stage: "suspension-refusals-unchanged",
        route: suspensionRoute,
        business_tables: 21,
        state_sha256: beforeRefusals,
        refusals: [
          { principal: "missing", status: 403, code: "WRONG_PRINCIPAL" },
          { principal: "bearer", status: 403, code: "WRONG_PRINCIPAL" },
          { principal: "sponsor", status: 401, code: "UNAUTHORIZED" },
          { principal: "foreign-operator", status: 401, code: "UNAUTHORIZED" },
          { principal: "operator", status: 422, code: "SCHEMA_INVALID" },
          { principal: "operator", status: 403, code: "STEP_UP_REQUIRED" },
          { principal: "operator", status: 409, code: "MODERATION_STATE_CONFLICT" },
        ],
      }),
    );

    const accountEffects = () =>
      env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM sponsor_suspension_events WHERE sponsor_id = ?1) AS controls,
      (SELECT COUNT(*) FROM operator_audit WHERE target_id = ?1 AND action = 'sponsor.suspended') AS audits,
      (SELECT COUNT(*) FROM moderation_log WHERE action = 'sponsor-suspended') AS logs,
      (SELECT COUNT(*) FROM deletion_journal WHERE target_id = ?1 AND action = 'suspend-sponsor') AS journal,
      (SELECT COUNT(*) FROM fellow_tokens WHERE sponsor_id = ?1 AND revoked_at IS NULL) AS live_tokens,
      (SELECT COUNT(*) FROM enrollment_fellows WHERE sponsor_id = ?1 AND status = 'paused') AS paused
    `)
        .bind(OWNER)
        .first();
    const beforeSuspension = await accountEffects();
    const historicalEvents = await env.DB.prepare(
      "SELECT id, actor_fellow_id, actor_sponsor_id, chain_digest FROM events WHERE problem_id = ? ORDER BY seq",
    )
      .bind(problem)
      .all();
    await env.DB.prepare(`CREATE TRIGGER lane_fail_suspension_journal BEFORE INSERT ON deletion_journal
      WHEN NEW.action = 'suspend-sponsor'
      BEGIN SELECT RAISE(ABORT, 'planted suspension journal failure'); END`).run();
    try {
      assert.equal((await suspend(command, 503)).code, "OPERATOR_CONTROL_UNAVAILABLE");
      assert.deepEqual(
        await accountEffects(),
        beforeSuspension,
        "all suspension effects roll back together",
      );
      assert.deepEqual(await readStanding(), activeStanding);
      await call("/v1/hello", undefined, author);
    } finally {
      await env.DB.prepare("DROP TRIGGER lane_fail_suspension_journal").run();
    }

    const receipts = await Promise.all(Array.from({ length: 4 }, () => suspend()));
    const receipt = receipts[0];
    for (const replay of receipts)
      assert.deepEqual(replay, receipt, "one durable concurrent decision");
    assert.equal(receipt.status, "suspended");
    assert.equal(receipt.reviewed_case_id, heldAgain.case_id);
    assert.deepEqual(receipt.affected, {
      paused_fellows: 2,
      revoked_credentials: 2,
      cancelled_enrollments: 1,
      cancelled_transfers: 2,
    });
    assert.deepEqual(await accountEffects(), {
      controls: 1,
      audits: 1,
      logs: 1,
      journal: 1,
      live_tokens: 0,
      paused: 2,
    });
    assert.deepEqual(
      await suspend({ ...command, step_up_authenticated_at: 0 }),
      receipt,
      "an old command retrieves its receipt without reviving authority",
    );
    assert.equal(
      (
        await suspend(
          { ...command, reason: "Changed account decision intent after acceptance." },
          409,
        )
      ).code,
      "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(
      (await suspend(command, 409, "different-account-command")).code,
      "MODERATION_STATE_CONFLICT",
    );
    const suspendedStanding = await readStanding();
    assert.equal(suspendedStanding.suspension.reason, command.reason);
    assert.deepEqual(suspendedStanding.impact, {
      active_fellows: 0,
      unrevoked_credentials: 0,
      pending_enrollments: 0,
      pending_transfers: 0,
    });
    for (const token of [author, sibling]) await call("/v1/hello", undefined, token, 401);
    await call("/v1/hello", undefined, reviewer);

    // Signed sponsor authority is also checked afresh: neither new authority
    // nor a scientific/private write can escape through an already signed UI.
    const refusedCommands = [
      ["/v1/enrollments", "enrollment.mint", { requested_scopes: ["review"] }],
      [
        "/v1/fellows/lifecycle",
        "fellow.lifecycle.change",
        {
          fellow_id: authorFellow,
          status: "active",
          confirm: "change-fellow-lifecycle",
          step_up_authenticated_at: command.step_up_authenticated_at,
        },
      ],
      [
        "/v1/sponsors/transfers",
        "sponsor.transfer.initiate",
        {
          fellow_id: authorFellow,
          target_sponsor_id: "usr_mod_reviewer",
          confirm: "initiate-fellow-transfer",
          step_up_authenticated_at: command.step_up_authenticated_at,
        },
      ],
      ["/v1/sponsors/rebinds", "sponsor.rebind.create", { fellow_id: authorFellow }],
      [
        "/v1/sponsors/screening-posture/clear",
        "sponsor.posture.clear",
        {
          fellow_id: authorFellow,
          reason: "Attempt to clear posture after the account action.",
        },
      ],
      [
        "/v1/sponsors/workshop/action",
        "workshop.action",
        {
          problem_id: problem,
          fellow_id: authorFellow,
          workshop_id: draft.workshop_id,
          expected_workshop_version: 1,
          action: "keep",
        },
      ],
    ];
    for (const [path, action, body] of refusedCommands) {
      assert.equal(
        (await sponsorCall(OWNER, "POST", path, action, body, 403)).code,
        "WRITE_REFUSED",
      );
    }
    // These execute below HTTP authentication, modelling work that had
    // already authenticated before the suspension committed. D1 still refuses
    // both a new ledger append and a private write/credential/posture escape.
    for (const [sql, bindings] of [
      ["INSERT INTO events SELECT * FROM events WHERE actor_fellow_id = ? LIMIT 1", [authorFellow]],
      [
        "INSERT INTO fellow_tokens SELECT * FROM fellow_tokens WHERE sponsor_id = ? LIMIT 1",
        [OWNER],
      ],
      [
        "UPDATE workshop_objects SET current_version = current_version + 1 WHERE workshop_id = ?",
        [draft.workshop_id],
      ],
      ["UPDATE enrollment_fellows SET status = 'active' WHERE fellow_id = ?", [authorFellow]],
      [
        `INSERT INTO screening_posture_clearances
         (clearance_id, fellow_id, cleared_by, cleared_by_class, reason, created_at)
         VALUES ('PC-inflight-account', ?, ?, 'sponsor', 'Already authenticated before suspension.', ?)`,
        [authorFellow, OWNER, new Date().toISOString()],
      ],
    ]) {
      await assert.rejects(
        env.DB.prepare(sql)
          .bind(...bindings)
          .run(),
        /SPONSOR_SUSPENDED/,
      );
    }
    const ownStanding = await sponsorCall(
      OWNER,
      "GET",
      "/v1/sponsors/account/suspension",
      "sponsor.account.suspension.read",
    );
    assert.equal(ownStanding.status, "suspended");
    assert.equal(ownStanding.suspension.appeal, "SPONSOR_APPEAL_AVAILABLE");
    for (const privateDetail of [heldAgain.case_id, command.reason, LOCAL_OPERATOR_ID]) {
      assert.ok(
        !JSON.stringify(ownStanding).includes(privateDetail),
        "own status is deliberately coarse",
      );
    }
    await sponsorCall(OWNER, "POST", "/v1/sponsors/workshops", "workshop.list", {});
    const privateExport = await sponsorCall(
      OWNER,
      "POST",
      "/v1/sponsors/account/export-page",
      "sponsor.account.export-page",
      {},
    );
    assert.equal(privateExport.sponsor_id, OWNER, "private export remains available");
    const afterEvents = await env.DB.prepare(
      "SELECT id, actor_fellow_id, actor_sponsor_id, chain_digest FROM events WHERE problem_id = ? ORDER BY seq",
    )
      .bind(problem)
      .all();
    assert.deepEqual(
      afterEvents.results,
      historicalEvents.results,
      "public authorship and history are preserved",
    );
    const suspensionLog = await call("/moderation/log.json");
    assert.equal(
      suspensionLog.entries.filter((entry) => entry.action === "sponsor-suspended").length,
      1,
    );
    for (const privateDetail of [OWNER, heldAgain.case_id, command.reason]) {
      assert.ok(
        !JSON.stringify(suspensionLog).includes(privateDetail),
        "public account notation reveals no private case or identity",
      );
    }
  },
);

console.log(
  JSON.stringify({
    stage: "moderation-journey-passed",
    kind: "moderation-real-bindings",
    status: "pass",
    boundary:
      "real local Workerd/D1; atomic decision/posture notices and reviewed sponsor suspension with injected rollback, concurrent replay, credential/Fellow/enrollment/transfer cascade, signed mutation guards, private diagnosis/export, preserved public history, hold->case->release/reject, reports dedupe + 3-sponsor hide, independent category decisions and upheld-content retention, audit, public log; fixture screener",
  }),
);
