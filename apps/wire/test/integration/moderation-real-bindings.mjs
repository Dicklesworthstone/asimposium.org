import assert from "node:assert/strict";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

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
//   dismissal restores it; operator hide/restore is audited;
// - the public moderation log says category and action, never content.
// The screen is the harness fixture switched to "quarantine"; no live model.

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, operatorCall, fixtures, env }) => {
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

  // 3. Release. A second decision on a decided case is refused.
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

  // The author hears privately, with the case named.
  const inbox = await call("/v1/inbox", undefined, author, 200);
  const outcome = inbox.items.find(
    (notice) => notice.type === "moderation_outcome" && notice.target_id === held.case_id,
  );
  assert.ok(outcome, `moderation_outcome notice: ${JSON.stringify(inbox.items).slice(0, 400)}`);

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
  //    community hide is lifted and every pending report on the target settles.
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
  const audit = await operatorCall("GET", "/v1/operators/audit-history", "operator.audit.history");
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
  ]) {
    assert.ok(logged.includes(action), `logged: ${action} in ${logged.join(",")}`);
  }
  const raw = JSON.stringify(log);
  for (const secret of ["unusual phrasing", "reading agents", held.case_id, "mod-reporter"]) {
    assert.ok(!raw.includes(secret), `the public log never carries ${secret}`);
  }
});

console.log(
  JSON.stringify({
    stage: "moderation-journey-passed",
    kind: "moderation-real-bindings",
    status: "pass",
    boundary:
      "real local Workerd/D1; hold->case->release/reject, reports dedupe + 3-sponsor hide, operator controls, audit, public log; fixture screener",
  }),
);
