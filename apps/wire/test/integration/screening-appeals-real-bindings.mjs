import assert from "node:assert/strict";
import { LOCAL_OPERATOR_ID, runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

const APPELLATE = "usr_local_appeal_operator";
await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, operatorCall, fixtures, env, worker, origin }) => {
    const owner = "usr_appeal_owner",
      author = await enroll("appeal-author", owner);
    const reviewer = await enroll("appeal-reviewer", "usr_appeal_reviewer");
    const problem = (
      await call(
        "/v1/problems",
        {
          title: "Human appeals exact-candidate journey",
          statement: "For every natural number n, n + 0 = n.",
          falsifier: "A natural number where the equality fails.",
          motivation: "Exercise independent human review without changing the scientific record.",
          areas: ["number-theory"],
        },
        author,
        201,
      )
    ).problem.id;
    await sponsorCall(
      owner,
      "POST",
      `/v1/sponsors/problems/${problem}/lifecycle`,
      "problem-lifecycle",
      { action: "publish" },
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
        basis: "The domain and falsifier are precise.",
      },
      reviewer,
    );
    const session = (
      await call("/v1/sessions", { problem_id: problem, intent: "prove" }, author, 201)
    ).session_id;
    const draft = await call(
      `/v1/sessions/${session}/workshop`,
      { type: "claim-draft", title: "Appealable claim", body_md: "Private working notes." },
      author,
      201,
    );
    const path = `/v1/sessions/${session}/promote`;
    const candidate = {
      workshop_id: draft.workshop_id,
      kind: "conjecture",
      statement: "For all natural n, n * 0 = 0. This exact phrasing receives a review hold.",
      falsifier: "A counterexample.",
    };
    const events = async () =>
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id=?")
          .bind(problem)
          .first()
      ).n;
    const ownCases = (id) =>
      sponsorCall(
        owner,
        "GET",
        `/v1/sponsors/screening-cases${id ? `/${id}` : ""}`,
        id ? "sponsor.screening-cases.read" : "sponsor.screening-cases.list",
        undefined,
        200,
        id ? "/v1/sponsors/screening-cases/:caseId" : "/v1/sponsors/screening-cases",
      );
    const submit = (
      caseId,
      key,
      statement = "PRIVATE_APPEAL_STATEMENT_CANARY: please reconsider the precise mathematical scope.",
      expected = 200,
    ) =>
      sponsorCall(
        owner,
        "POST",
        "/v1/sponsors/screening-appeals",
        "sponsor.screening-appeals.submit",
        { case_id: caseId, statement },
        expected,
        "/v1/sponsors/screening-appeals",
        key,
      );
    const decide = (
      appealId,
      outcome = "release",
      key = "appeal-decision-once",
      expected = 200,
      operator = APPELLATE,
      overrides = {},
    ) =>
      sponsorCall(
        operator,
        "POST",
        "/v1/operators/screening-appeals/decision",
        "operator.screening-appeals.decide",
        {
          appeal_id: appealId,
          decision: outcome,
          reason:
            "PRIVATE_APPEAL_REASON_CANARY: independently reviewed the exact held candidate and context.",
          step_up_authenticated_at: Math.floor(Date.now() / 1000),
          ...overrides,
        },
        expected,
        "/v1/operators/screening-appeals/decision",
        key,
        "operator",
      );
    const reject = (caseId) =>
      operatorCall("POST", "/v1/operators/quarantine/decision", "operator.quarantine.decide", {
        case_id: caseId,
        decision: "confirm_rejection",
        reason: "Original operator reviewed and rejected the held candidate.",
      });
    await fixtures.setScreenMode("quarantine");
    const before = await events(),
      held = await call(path, candidate, author, 202);
    assert.equal((await ownCases(held.case_id)).cases[0].state, "pending");
    await submit(held.case_id, "not-yet-reviewed", undefined, 404);
    await reject(held.case_id);
    const current = (await ownCases(held.case_id)).cases[0];
    assert.equal(current.state, "rejected");
    for (const hidden of [
      "category",
      "candidate",
      "decision_reason",
      "context_digest",
      "model_version",
    ])
      assert.ok(!(hidden in current));
    const foreign = await sponsorCall(
      "usr_appeal_reviewer",
      "GET",
      `/v1/sponsors/screening-cases/${held.case_id}`,
      "sponsor.screening-cases.read",
      undefined,
      200,
      "/v1/sponsors/screening-cases/:caseId",
    );
    assert.deepEqual(foreign.cases, []);
    await call(
      "/v1/sponsors/screening-appeals",
      { case_id: held.case_id, statement: "A Fellow cannot submit this human appeal." },
      author,
      403,
    );
    const [a, replay] = await Promise.all([
      submit(held.case_id, "appeal-once"),
      submit(held.case_id, "appeal-once"),
    ]);
    assert.deepEqual(a, replay);
    assert.equal(a.state, "pending");
    await submit(
      held.case_id,
      "appeal-once",
      "A changed explanation cannot replace the original appeal intent.",
      409,
    );
    const queue = await operatorCall(
      "GET",
      "/v1/operators/screening-appeals",
      "operator.screening-appeals.list",
    );
    assert.equal(queue.appeals[0].appeal_id, a.appeal_id);
    const detail = await operatorCall(
      "GET",
      `/v1/operators/quarantine/${held.case_id}`,
      "operator.quarantine.read",
      undefined,
      200,
      "/v1/operators/quarantine/:caseId",
    );
    assert.equal(detail.candidate.statement, candidate.statement);
    assert.equal(detail.state, "rejected");
    await decide(a.appeal_id, "release", "original-reviewer", 403, LOCAL_OPERATOR_ID);
    await decide(a.appeal_id, "release", "old-auth", 403, APPELLATE, {
      step_up_authenticated_at: 0,
    });
    await decide(a.appeal_id, "release", "scientific-override", 422, APPELLATE, {
      disposition: "strongly-supported",
    });
    await decide(a.appeal_id, "release", "nonoperator", 401, owner);
    const [released, releasedReplay] = await Promise.all([
      decide(a.appeal_id),
      decide(a.appeal_id),
    ]);
    assert.deepEqual(released, releasedReplay);
    assert.equal(released.state, "released");
    assert.equal(await events(), before, "appellate review never publishes scientific content");
    assert.equal(
      (
        await env.DB.prepare("SELECT state FROM screening_cases WHERE case_id=?")
          .bind(held.case_id)
          .first()
      ).state,
      "rejected",
    );
    assert.equal(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM operator_audit WHERE target_id=?")
          .bind(a.appeal_id)
          .first()
      ).n,
      1,
    );
    assert.equal((await ownCases(held.case_id)).cases[0].appeal.state, "released");
    const completed = await operatorCall(
      "GET",
      `/v1/operators/screening-appeals/${a.appeal_id}`,
      "operator.screening-appeals.read",
      undefined,
      200,
      "/v1/operators/screening-appeals/:appealId",
    );
    assert.equal(completed.appeals[0].state, "released");
    await decide(a.appeal_id, "uphold", "contradictory-decision", 409);
    const published = await call(path, candidate, author, 201, "explicit-appealed-publication");
    const publicationReplay = await call(
      path,
      candidate,
      author,
      200,
      "explicit-appealed-publication",
    );
    assert.equal(publicationReplay.claim_id, published.claim_id);
    assert.equal(await events(), before + 1);
    const provenance = JSON.parse(
      (
        await env.DB.prepare(`SELECT sp.provenance_json FROM screening_publications sp
    JOIN events e ON e.id=sp.event_id WHERE e.problem_id=? AND e.object_id=?`)
          .bind(problem, published.claim_id)
          .first()
      ).provenance_json,
    );
    assert.equal(provenance.decision_path, "operator-release");
    assert.equal(provenance.review_case_id, held.case_id);

    // Changed bytes require a new held case. The sponsor can appeal its reviewed
    // rejection even after a separate account suspension blocks all Fellow work.
    const secondCandidate = {
      ...candidate,
      statement: `${candidate.statement} A second, changed candidate.`,
    };
    const second = await call(path, secondCandidate, author, 202);
    assert.notEqual(second.case_id, held.case_id);
    await reject(second.case_id);
    await operatorCall(
      "POST",
      `/v1/operators/sponsors/${owner}/suspension`,
      "operator.sponsor.suspension.suspend",
      {
        sponsor_id: owner,
        expected_revision: 0,
        reviewed_case_id: second.case_id,
        basis: "egregious-reviewed-case",
        reason:
          "Reviewed held conduct establishes the separate account suspension in this fixture.",
        step_up_authenticated_at: Math.floor(Date.now() / 1000),
      },
      200,
      "/v1/operators/sponsors/:sponsorId/suspension",
    );
    const secondAppeal = await submit(second.case_id, "appeal-while-suspended");
    assert.equal(secondAppeal.state, "pending");
    assert.equal(
      (await decide(secondAppeal.appeal_id, "uphold", "independent-uphold")).state,
      "upheld",
    );
    assert.equal(await events(), before + 1);
    const log = await call("/moderation/log.json");
    for (const privateText of [
      "PRIVATE_APPEAL_STATEMENT_CANARY",
      "PRIVATE_APPEAL_REASON_CANARY",
      candidate.statement,
    ])
      assert.ok(!JSON.stringify(log).includes(privateText));
    const anonymous = await worker.fetch(`${origin}/v1/operators/screening-appeals`);
    assert.equal(anonymous.status, 403);
    await anonymous.arrayBuffer();
    console.log(
      JSON.stringify({
        kind: "screening-appeals-real-bindings",
        status: "pass",
        coverage:
          "real signed human ingress; independent operator decisions, concurrent replay, immutable rejection, exact resubmission, suspended sponsor access, private/public separation",
      }),
    );
  },
  { operatorPrincipalIds: [LOCAL_OPERATOR_ID, APPELLATE] },
);
