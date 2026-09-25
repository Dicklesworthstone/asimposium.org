import assert from "node:assert/strict";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// P7 on the direct-append routes (beads asimposiumorg-kqz5 / b9y9) on real
// local Workerd HTTP and D1. POST /v1/p/:id/claims and /v1/p/:id/dead-ends
// open an implicit session and reuse the session executors; a rejected
// screening decision must refuse with the coarse policy response and leave
// the public sequence unchanged, and a pass must commit exactly once.
// Fixture screening decisions stand in for Workers AI.
//
// Not directly exercised: /v1/p/:id/{hypotheses,evidence,review,reviews} and
// events:batch, which call the same screened executors.

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, fixtures, env }) => {
  const OWNER = "usr_direct_owner";
  const author = await enroll("direct-author", OWNER);
  const reviewer = await enroll("direct-reviewer", "usr_direct_reviewer");
  const created = await call(
    "/v1/problems",
    {
      title: "Direct append screening",
      statement: "Every integer in 0..45 has a square of the same parity.",
      falsifier: "An integer in 0..45 whose square has the opposite parity.",
      motivation: "Exercise screening on direct-append routes.",
      areas: ["number-theory"],
    },
    author,
    201,
  );
  const problem = created.problem.id;
  await sponsorCall(
    OWNER,
    "POST",
    `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle",
    {
      action: "publish",
    },
  );
  const rs = (await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201))
    .session_id;
  await call(
    `/v1/problems/${problem}/statement-review`,
    { session_id: rs, statement_version: 1, verdict: "statement-clear", basis: "Exact." },
    reviewer,
  );
  const publicSeq = async () =>
    Number(
      (await env.DB.prepare("SELECT public_seq FROM problems WHERE id = ?").bind(problem).first())
        .public_seq,
    );

  const claimBody = {
    kind: "conjecture",
    statement: "Zero squared is even in the direct lane.",
    falsifier: "Zero squared is odd.",
  };
  const deadEndBody = {
    approach: "Tried a parity argument through modular squares.",
    why_it_fails: "It only covers even inputs and silently skips the odd case.",
    retry_predicate: "Retry once odd inputs are handled.",
  };

  await fixtures.setScreenMode("reject");
  const before = await publicSeq();
  const screensBefore = await fixtures.screeningCalls();
  const deniedClaim = await call(`/v1/p/${problem}/claims`, claimBody, author, 403);
  const deniedDeadEnd = await call(`/v1/p/${problem}/dead-ends`, deadEndBody, author, 403);
  await fixtures.setScreenMode("pass");
  for (const denied of [deniedClaim, deniedDeadEnd]) {
    assert.equal(denied.code, "POLICY_DENIED");
    assert.ok(!JSON.stringify(denied).includes("parity"), "no candidate text echoes back");
  }
  assert.equal(await fixtures.screeningCalls(), screensBefore + 2, "both crossed screening");
  assert.equal(await publicSeq(), before, "a refused direct append commits nothing");

  const passed = await call(`/v1/p/${problem}/claims`, claimBody, author, 201);
  assert.ok(typeof passed.claim_id === "string");
  assert.equal(await publicSeq(), before + 1, "a passed direct append commits exactly once");

  console.log(
    JSON.stringify({
      stage: "direct-append-screening-journey-passed",
      kind: "direct-append-screening-real-bindings",
      status: "pass",
      boundary: "local Workerd/D1; fixture screening; claims and dead-ends routes only",
    }),
  );
});
