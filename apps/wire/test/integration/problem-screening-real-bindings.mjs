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
// The famous-problem guardrail crosses the same screen at publish.
//
// Not covered: the real Workers AI classifier (staging, rs5n), persisted
// screening provenance for publish (no session event carries it yet).

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, fixtures }) => {
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
  const lifecycle = (problem, body, expected) =>
    sponsorCall(
      OWNER,
      "POST",
      `/v1/sponsors/problems/${problem}/lifecycle`,
      "problem-lifecycle",
      body,
      expected,
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
  const after = await publicFace(problem);
  assert.ok(!JSON.stringify(after).includes("0..999"), "a refused revision never becomes public");

  // The famous-problem guardrail is proposed text served with the public
  // problem: publish screens it, and a refusal keeps it private.
  const guardrail = {
    canonical_formulation: "Guardrail canonical formulation marker for the parity range.",
    variant_distinctions: "Guardrail variant distinctions marker.",
    authoritative_references: ["Guardrail reference marker."],
    standing_banner: "Guardrail standing banner marker.",
  };
  const guarded = await propose("Screened proposal (guardrail)", {
    famous_guardrail: guardrail,
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
  ]) {
    assert.ok(guardedScreen.includes(text), `publish screens the guardrail: ${text}`);
  }
  assert.ok(
    !JSON.stringify(await call(`/v1/problems/${guarded}`, undefined, undefined, null)).includes(
      "marker",
    ),
    "a refused guardrail is not served",
  );

  console.log(
    JSON.stringify({
      stage: "problem-screening-journey-passed",
      kind: "problem-screening-real-bindings",
      status: "pass",
      boundary: "local Workerd/D1; fixture screening decisions; no Workers AI or provenance row",
    }),
  );
});
