import assert from "node:assert/strict";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// P7 for problem proposals (beads asimposiumorg-b9y9 / asimposiumorg-kqz5) on
// real local Workerd HTTP and D1. Fellow-proposed problem text becomes public
// only through sponsor publish, and a public statement revision replaces
// public text. Both must cross the screening boundary first:
// - reject: 403 POLICY_DENIED with a coarse category and appeal only;
// - quarantine or provider failure: 202 SCREENING_HOLD;
// in every refused case the problem stays private and unchanged. Pass publishes.
// The screening decisions are local fixtures standing in for Workers AI.
//
// The famous-problem guardrail and named other-* areas cross the same
// screen at publish.
//
// Not covered: the real Workers AI classifier (staging, rs5n) or Google OAuth.

await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, fixtures, env, clearScreeningPosture }) => {
    const OWNER = "usr_problem_screen_owner";
    const author = await enroll("problem-screen-author", OWNER);
    let proposals = 0;
    const propose = async (title, extra = {}) => {
      // Distinct ranges: P11 refuses near-duplicate problems.
      const top = 30 + 7 * ++proposals;
      const created = await call(
        "/v1/problems",
        {
          title,
          statement: `Every integer in 0..${top} has a square of the same parity.`,
          falsifier: `An integer in 0..${top} whose square has the opposite parity.`,
          motivation: "Exercise problem-proposal screening.",
          areas: ["number-theory"],
          ...extra,
        },
        author,
        201,
      );
      return created.problem.id;
    };
    const lifecycle = (problem, body, expected, key) =>
      sponsorCall(
        OWNER,
        "POST",
        `/v1/sponsors/problems/${problem}/lifecycle`,
        "problem-lifecycle",
        body,
        expected,
        `/v1/sponsors/problems/${problem}/lifecycle`,
        key,
      );
    const publicFace = (problem) => call(`/p/${problem}.json`, undefined, undefined, null);

    for (const [mode, status, code] of [
      ["reject", 403, "POLICY_DENIED"],
      ["quarantine", 202, "SCREENING_HOLD"],
      ["unavailable", 202, "SCREENING_HOLD"],
    ]) {
      const problem = await propose(`Screened proposal (${mode})`);
      await fixtures.setScreenMode(mode);
      const refused = await lifecycle(problem, { action: "publish" }, status);
      await fixtures.setScreenMode("pass");
      assert.equal(refused.code, code, `${mode} publish`);
      assert.ok(typeof refused.coarse_category === "string", "only a coarse category is disclosed");
      assert.ok(!JSON.stringify(refused).includes("has a square"), "no candidate text echoes back");
      const face = await publicFace(problem);
      assert.notEqual(face.problem?.status, "active", `${mode}: the problem did not go public`);
    }

    // Pass publishes; a later public revision is screened too.
    const problem = await propose("Screened proposal (pass)");
    const screensBefore = await fixtures.screeningCalls();
    await lifecycle(problem, { action: "publish" }, 200);
    assert.equal(await fixtures.screeningCalls(), screensBefore + 1, "publish crossed screening");
    const published = await publicFace(problem);
    assert.ok(published.problem, "the passed proposal is public");
    const refusalsBeforeRevision = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM screening_refusals",
    ).first();
    await fixtures.setScreenMode("reject");
    const revision = await lifecycle(
      problem,
      {
        action: "revise-statement",
        statement: "Every integer in 0..999 has a square of the same parity.",
        falsifier: "An integer in 0..999 whose square has the opposite parity.",
        motivation: "A widened range.",
      },
      403,
    );
    await fixtures.setScreenMode("pass");
    assert.equal(revision.code, "POLICY_DENIED");
    assert.deepEqual(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM screening_refusals").first(),
      refusalsBeforeRevision,
      "a sponsor's statement revision refusal does not count against its Fellow",
    );
    const after = await publicFace(problem);
    assert.ok(!JSON.stringify(after).includes("0..999"), "a refused revision never becomes public");

    // The famous-problem guardrail and named other-* areas are proposed text
    // served with the public problem: publish screens them, and a refusal keeps
    // them private.
    const guardrail = {
      canonical_formulation: "Guardrail canonical formulation marker for the parity range.",
      variant_distinctions: "Guardrail variant distinctions marker.",
      authoritative_references: ["Guardrail reference marker."],
      standing_banner: "Guardrail standing banner marker.",
    };
    const guarded = await propose("Screened proposal (guardrail)", {
      famous_guardrail: guardrail,
      areas: ["number-theory", "other-proposed-area-marker"],
    });
    await fixtures.setScreenMode("reject");
    const guardedRefusal = await lifecycle(guarded, { action: "publish" }, 403);
    await fixtures.setScreenMode("pass");
    assert.equal(guardedRefusal.code, "POLICY_DENIED");
    assert.ok(!JSON.stringify(guardedRefusal).includes("marker"), "no guardrail text echoes back");
    const guardedScreen = (await fixtures.lastScreening()).statement;
    for (const text of [
      guardrail.canonical_formulation,
      guardrail.variant_distinctions,
      guardrail.authoritative_references[0],
      guardrail.standing_banner,
      "other-proposed-area-marker",
    ]) {
      assert.ok(guardedScreen.includes(text), `publish screens the guardrail: ${text}`);
    }
    assert.ok(
      !JSON.stringify(await call(`/v1/problems/${guarded}`, undefined, undefined, null)).includes(
        "marker",
      ),
      "a refused guardrail is not served",
    );

    // ux6q: sponsor-authored prose is public ledger content too. Exercise
    // otherwise-valid terminal actions, not refusals at an earlier precondition.
    await fixtures.setScreenMode("pass");
    await clearScreeningPosture(OWNER);
    const retiring = await propose("Screened retirement");
    const merging = await propose("Screened merge source");
    const canonical = await propose("Screened merge destination");
    for (const id of [retiring, merging, canonical])
      await lifecycle(id, { action: "publish" }, 200);
    const scientificState = (id) =>
      env.DB.prepare(`SELECT status,public_seq,chain_digest,
    canonical_problem_id,resolution_summary,
    (SELECT COUNT(*) FROM events WHERE problem_id=problems.id) AS events,
    (SELECT COUNT(*) FROM idempotency WHERE problem_id=problems.id) AS receipts,
    (SELECT COUNT(*) FROM problem_merges WHERE problem_id=problems.id) AS merges,
    (SELECT COUNT(*) FROM screening_publications s JOIN events e ON e.id=s.event_id
      WHERE e.problem_id=problems.id) AS screens FROM problems WHERE id=?`)
        .bind(id)
        .first();
    const actions = [
      [retiring, { action: "retire", reason: "Retire only the explored parity formulation." }],
      [
        merging,
        {
          action: "merge",
          canonical_problem_id: canonical,
          claim_mapping: { "source mapping marker": "destination mapping marker" },
        },
      ],
    ];
    const refusalCount = () =>
      env.DB.prepare("SELECT COUNT(*) AS n FROM screening_refusals").first();
    const fellowRefusals = await refusalCount();
    for (const [id, action] of actions) {
      for (const [mode, status, code] of [
        ["reject", 403, "POLICY_DENIED"],
        ["quarantine", 202, "SCREENING_HOLD"],
        ["unavailable", 202, "SCREENING_HOLD"],
        ["allow-with-warning", 202, "SCREENING_HOLD"],
      ]) {
        const before = await scientificState(id);
        const calls = await fixtures.screeningCalls();
        await fixtures.setScreenMode(mode);
        let refused;
        try {
          refused = await lifecycle(id, action, status);
        } catch (error) {
          console.error(
            JSON.stringify({
              stage: "lifecycle-screening-probe-failed",
              action: action.action,
              mode,
              expected_status: status,
              screening_calls_delta: (await fixtures.screeningCalls()) - calls,
              scientific_state_changed:
                JSON.stringify(await scientificState(id)) !== JSON.stringify(before),
            }),
          );
          throw error;
        }
        await fixtures.setScreenMode("pass");
        assert.equal(refused.code, code);
        assert.equal(
          await fixtures.screeningCalls(),
          calls + 1,
          `${action.action}: actual screen reached`,
        );
        assert.deepEqual(
          await scientificState(id),
          before,
          `${mode} ${action.action}: no scientific write`,
        );
        assert.equal(
          (await fixtures.lastScreening()).statement,
          JSON.stringify(action),
          "the entire exact action, including mapping keys and values, is screened",
        );
        assert.ok(!JSON.stringify(refused).includes("mapping marker"));
        assert.ok(!JSON.stringify(refused).includes("explored parity formulation"));
      }
      const calls = await fixtures.screeningCalls();
      const before = await scientificState(id);
      const key = `screened-${action.action}-success`;
      const accepted = await lifecycle(id, action, 200, key);
      const after = await scientificState(id);
      assert.equal(accepted.problem.status, "retired");
      assert.equal(after.public_seq, before.public_seq + 1);
      assert.equal(after.events, before.events + 1);
      assert.equal(after.receipts, before.receipts + 1);
      assert.equal(
        after.screens,
        before.screens + 1,
        "the committed event retains screening provenance",
      );
      assert.equal(await fixtures.screeningCalls(), calls + 1);
      assert.deepEqual(await lifecycle(id, action, 200, key), accepted);
      assert.deepEqual(await scientificState(id), after, "exact replay appends nothing");
      assert.equal(
        await fixtures.screeningCalls(),
        calls + 1,
        "exact replay buys no second screen",
      );
      if (action.action === "retire") assert.equal(after.resolution_summary, action.reason);
      else {
        assert.equal(after.canonical_problem_id, canonical);
        const row = await env.DB.prepare(
          "SELECT claim_mapping_json FROM problem_merges WHERE problem_id=?",
        )
          .bind(id)
          .first();
        assert.deepEqual(JSON.parse(row.claim_mapping_json), action.claim_mapping);
      }
    }
    assert.deepEqual(
      await refusalCount(),
      fellowRefusals,
      "sponsor-authored policy refusals do not change a Fellow's posture",
    );

    console.log(
      JSON.stringify({
        stage: "problem-screening-retire-merge-passed",
        kind: "problem-screening-real-bindings",
        status: "pass",
        boundary:
          "local Workerd/D1; fixture screening decisions; committed provenance checked; no hosted Workers AI",
      }),
    );
  },
);

// An eligible resolution needs earned independent standing and a published
// Fellow closing synthesis. Reuse the complete native scientific journey;
// its terminal block tests the same screening refusals and positive resolve.
await import("./dispositions-real-bindings.mjs");
console.log(
  JSON.stringify({
    stage: "problem-screening-journey-passed",
    kind: "problem-screening-real-bindings",
    status: "pass",
    actions: ["publish", "revise-statement", "retire", "merge", "resolve"],
    boundary:
      "real local Workerd/D1/R2; fixture screening decisions and sponsor identity; no hosted classifier or Google OAuth",
  }),
);
