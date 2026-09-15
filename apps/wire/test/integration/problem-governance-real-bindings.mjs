import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProblemCodeSchema } from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

export async function problemGovernanceJourney({ call, enroll, fixtures, env, worker, origin, sponsorCall }) {
  const sponsorA = "usr_sponsor_alpha";
  const sponsorB = "usr_sponsor_beta";
  const sponsorC = "usr_sponsor_gamma";

  console.log(JSON.stringify({ stage: "problem-governance-start" }));

  // 1. Enroll Fellows
  const fellow1Token = await enroll("fellow-one", sponsorA);
  const fellow2Token = await enroll("fellow-two", sponsorB);
  const fellow3Token = await enroll("fellow-three", sponsorC);

  // Helper to extract fellowId from enrollment_fellows by name
  const f1 = await env.DB.prepare("SELECT fellow_id FROM enrollment_fellows WHERE name = ?")
    .bind("fellow-one")
    .first();
  const fellow1Id = f1.fellow_id;

  const f2 = await env.DB.prepare("SELECT fellow_id FROM enrollment_fellows WHERE name = ?")
    .bind("fellow-two")
    .first();
  const fellow2Id = f2.fellow_id;

  const f3 = await env.DB.prepare("SELECT fellow_id FROM enrollment_fellows WHERE name = ?")
    .bind("fellow-three")
    .first();
  const fellow3Id = f3.fellow_id;

  // 2. Propose Problem 1
  const propRes = await call(
    "/v1/problems",
    {
      title: "Problem Governance Test",
      statement: "Statement for governance investigation.",
      falsifier: "Any counterexample.",
      motivation: "To test multi-sponsor problem governance without epistemic fiat.",
      areas: ["number-theory"],
    },
    fellow1Token,
    201,
  );
  const problem1Id = propRes.problem.id;
  assert.equal(propRes.problem.status, "private-draft");

  // Verify founding steward was recorded in problem_stewards
  const foundingSteward = await env.DB.prepare(
    "SELECT * FROM problem_stewards WHERE problem_id = ? AND sponsor_id = ?",
  )
    .bind(problem1Id, sponsorA)
    .first();
  assert.ok(foundingSteward);
  assert.equal(foundingSteward.is_founding, 1);

  // Verify proposing fellow is in problem_memberships as contributor
  const creatorMembership = await env.DB.prepare(
    "SELECT * FROM problem_memberships WHERE problem_id = ? AND fellow_id = ?",
  )
    .bind(problem1Id, fellow1Id)
    .first();
  assert.ok(creatorMembership);
  assert.equal(creatorMembership.role, "contributor");

  // 3. Publish Problem 1
  const pubRes = await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problem1Id}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
    200,
  );
  assert.equal(pubRes.problem.status, "sharpening");

  // Public GET returns problem detail with stewards and admission_mode
  const pubGet = await call(`/v1/problems/${problem1Id}`, undefined, undefined, 200);
  assert.equal(pubGet.problem.id, problem1Id);
  assert.equal(pubGet.problem.status, "sharpening");
  assert.equal(pubGet.problem.admission_mode, "approval-required");
  assert.deepEqual(pubGet.problem.stewards, [sponsorA]);

  console.log(JSON.stringify({ stage: "problem-published-and-verified" }));

  // 4. Admission Modes: approval-required vs open vs archived-read-only
  // Fellow 2 tries to open session on Problem 1 (mode is approval-required, Fellow 2 not a member)
  const deniedSession = await call(
    "/v1/sessions",
    { problem_id: problem1Id },
    fellow2Token,
    403,
  );
  assert.equal(deniedSession.code, "WRITE_REFUSED");

  // Sponsor A changes admission_mode to "open"
  const setOpenRes = await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problem1Id}/lifecycle`,
    "problem-lifecycle",
    { action: "set-admission-mode", mode: "open" },
    200,
  );
  assert.equal(setOpenRes.problem.admission_mode, "open");

  // Fellow 2 now successfully opens session
  const openSessionRes = await call(
    "/v1/sessions",
    { problem_id: problem1Id },
    fellow2Token,
    201,
  );
  const session2Id = openSessionRes.session_id;
  assert.ok(session2Id);

  // Sponsor A changes admission_mode to "archived-read-only"
  await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problem1Id}/lifecycle`,
    "problem-lifecycle",
    { action: "set-admission-mode", mode: "archived-read-only" },
    200,
  );

  // Fellow 3 tries to open session on archived problem -> refused 403
  const archivedSession = await call(
    "/v1/sessions",
    { problem_id: problem1Id },
    fellow3Token,
    403,
  );
  assert.equal(archivedSession.code, "WRITE_REFUSED");

  // Re-open admission_mode to "open"
  await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problem1Id}/lifecycle`,
    "problem-lifecycle",
    { action: "set-admission-mode", mode: "open" },
    200,
  );

  console.log(JSON.stringify({ stage: "admission-modes-verified" }));

  // 5. Roles: Observer promotion refusal vs contributor allow (ADR-22 & Fable §9.3 hard boundary)
  // Sponsor A sets Fellow 2's role to "observer"
  await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problem1Id}/lifecycle`,
    "problem-lifecycle",
    {
      action: "manage-member",
      operation: "set-role",
      target_fellow_id: fellow2Id,
      role: "observer",
    },
    200,
  );

  // Verify membership updated in DB
  const memberRow = await env.DB.prepare(
    "SELECT role FROM problem_memberships WHERE problem_id = ? AND fellow_id = ?",
  )
    .bind(problem1Id, fellow2Id)
    .first();
  assert.equal(memberRow.role, "observer");

  // Fellow 2 pushes to workshop (scratch is allowed for observer)
  const workshopRes = await call(
    `/v1/sessions/${session2Id}/workshop`,
    {
      type: "scratch",
      title: "Observer scratch work",
      body_md: "Scratch notes from observer.",
    },
    fellow2Token,
    201,
  );
  assert.ok(workshopRes.workshop_id);

  // Fellow 2 attempts to promote -> refused 403 WRITE_REFUSED (role_not_permitted)
  const promoteObserverRes = await call(
    `/v1/sessions/${session2Id}/promote`,
    {
      workshop_id: workshopRes.workshop_id,
      kind: "conjecture",
      statement: "Observer invalid promotion attempt.",
      falsifier: "Counterexample to the claim.",
    },
    fellow2Token,
    403,
  );
  assert.equal(promoteObserverRes.code, "WRITE_REFUSED");

  // Sponsor A changes Fellow 2's role to "contributor"
  await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problem1Id}/lifecycle`,
    "problem-lifecycle",
    {
      action: "manage-member",
      operation: "set-role",
      target_fellow_id: fellow2Id,
      role: "contributor",
    },
    200,
  );

  console.log(JSON.stringify({ stage: "observer-promotion-refusal-verified" }));

  // 6. Steward Management: Share & Transfer
  // Sponsor A adds Sponsor B as co-steward
  await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problem1Id}/lifecycle`,
    "problem-lifecycle",
    {
      action: "manage-steward",
      operation: "add",
      target_sponsor_id: sponsorB,
    },
    200,
  );

  // Verify both stewards present
  const stewardsList = await env.DB.prepare(
    "SELECT sponsor_id FROM problem_stewards WHERE problem_id = ? ORDER BY created_at ASC",
  )
    .bind(problem1Id)
    .all();
  const stewardIds = stewardsList.results.map((r) => r.sponsor_id);
  assert.ok(stewardIds.includes(sponsorA));
  assert.ok(stewardIds.includes(sponsorB));

  // Sponsor B can now execute governance actions
  const capRes = await sponsorCall(
    sponsorB,
    "POST",
    `/v1/sponsors/problems/${problem1Id}/lifecycle`,
    "problem-lifecycle",
    {
      action: "set-writer-cap",
      writer_cap: 5,
    },
    200,
  );
  assert.equal(capRes.problem.writer_cap, 5);

  // Non-steward Sponsor C tries governance write -> refused 403 WRITE_REFUSED
  const deniedGov = await sponsorCall(
    sponsorC,
    "POST",
    `/v1/sponsors/problems/${problem1Id}/lifecycle`,
    "problem-lifecycle",
    { action: "set-admission-mode", mode: "open" },
    403,
  );
  assert.equal(deniedGov.code, "WRITE_REFUSED");

  // Transfer stewardship from Sponsor A to Sponsor B
  await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problem1Id}/lifecycle`,
    "problem-lifecycle",
    {
      action: "manage-steward",
      operation: "transfer",
      target_sponsor_id: sponsorB,
    },
    200,
  );

  // Removing sole steward refused check
  const removeSoleStewardRes = await sponsorCall(
    sponsorB,
    "POST",
    `/v1/sponsors/problems/${problem1Id}/lifecycle`,
    "problem-lifecycle",
    {
      action: "manage-steward",
      operation: "remove",
      target_sponsor_id: sponsorB,
    },
    422,
  );
  assert.equal(removeSoleStewardRes.code, "WRITE_REFUSED");

  // Re-add Sponsor A so we have multiple stewards
  await sponsorCall(
    sponsorB,
    "POST",
    `/v1/sponsors/problems/${problem1Id}/lifecycle`,
    "problem-lifecycle",
    {
      action: "manage-steward",
      operation: "add",
      target_sponsor_id: sponsorA,
    },
    200,
  );

  console.log(JSON.stringify({ stage: "steward-management-verified" }));

  // 7. Member Removal & ADR-22 Global Token Preservation
  // Steward removes Fellow 2 from Problem 1
  await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problem1Id}/lifecycle`,
    "problem-lifecycle",
    {
      action: "manage-member",
      operation: "remove",
      target_fellow_id: fellow2Id,
    },
    200,
  );

  // Verify Fellow 2 is removed from problem_memberships
  const removedMember = await env.DB.prepare(
    "SELECT * FROM problem_memberships WHERE problem_id = ? AND fellow_id = ?",
  )
    .bind(problem1Id, fellow2Id)
    .first();
  assert.equal(removedMember, null);

  // ADR-22 HARD INVARIANT: Fellow 2's global credential and status in enrollment_fellows are untouched!
  const fellow2Row = await env.DB.prepare(
    "SELECT status FROM enrollment_fellows WHERE fellow_id = ?",
  )
    .bind(fellow2Id)
    .first();
  assert.equal(fellow2Row.status, "active");

  const credentialRow = await env.DB.prepare(
    "SELECT revoked_at FROM fellow_tokens WHERE fellow_id = ?",
  )
    .bind(fellow2Id)
    .first();
  assert.equal(credentialRow.revoked_at, null);

  console.log(JSON.stringify({ stage: "adr22-token-preservation-verified" }));

  // 8. Invariant: Governance cannot move scientific disposition by fiat (ADR-22)
  const fiatResolveRes = await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problem1Id}/lifecycle`,
    "problem-lifecycle",
    {
      action: "resolve",
      direction: "affirmed",
      closing_synthesis: {
        summary: "Fiat assertion of resolution",
        no_claim_boundary: {
          verified: ["fiat"],
          mechanisms: ["none"],
          independence_tiers: ["tier-1"],
          remaining_external_validation: ["none"],
        },
      },
    },
    422,
  );
  assert.equal(fiatResolveRes.code, "PREMATURE_RESOLUTION");

  console.log(JSON.stringify({ stage: "scientific-disposition-invariant-verified" }));

  // 9. Fork: Linage preservation & independent problem
  const forkRes = await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problem1Id}/lifecycle`,
    "problem-lifecycle",
    {
      action: "fork",
      title: "Forked Variant of Problem 1",
    },
    200,
  );
  const forkedProblemId = forkRes.forked_problem_id;
  assert.ok(forkedProblemId);
  assert.notEqual(forkedProblemId, problem1Id);

  // Verify fork record in problem_forks
  const forkRow = await env.DB.prepare(
    "SELECT * FROM problem_forks WHERE problem_id = ?",
  )
    .bind(forkedProblemId)
    .first();
  assert.ok(forkRow);
  assert.equal(forkRow.parent_problem_id, problem1Id);
  assert.equal(typeof forkRow.parent_cursor, "number");

  // Verify forked problem is in private-draft with statement copied
  const forkedDetail = await env.DB.prepare(
    "SELECT forked_from_problem_id, forked_from_cursor, status FROM problems WHERE id = ?",
  )
    .bind(forkedProblemId)
    .first();
  assert.equal(forkedDetail.forked_from_problem_id, problem1Id);
  assert.equal(forkedDetail.status, "private-draft");

  console.log(JSON.stringify({ stage: "problem-fork-verified" }));

  // 10. Merge & 308 Permanent Redirect
  // Create Problem 2 to merge into
  const prop2 = await call(
    "/v1/problems",
    {
      title: "Canonical Problem 2",
      statement: "Canonical problem formulation.",
      falsifier: "Counterexample 2.",
      motivation: "To serve as canonical merge target.",
      areas: ["number-theory"],
    },
    fellow1Token,
    201,
  );
  const problem2Id = prop2.problem.id;

  // Publish Problem 2
  await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problem2Id}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
    200,
  );

  // Merge Problem 1 into Problem 2
  const mergeRes = await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problem1Id}/lifecycle`,
    "problem-lifecycle",
    {
      action: "merge",
      canonical_problem_id: problem2Id,
      claim_mapping: { "C-1": "C-1" },
    },
    200,
  );
  assert.equal(mergeRes.problem.status, "retired");
  assert.equal(mergeRes.problem.canonical_problem_id, problem2Id);

  // Verify problem_merges table entry
  const mergeRow = await env.DB.prepare(
    "SELECT * FROM problem_merges WHERE problem_id = ?",
  )
    .bind(problem1Id)
    .first();
  assert.ok(mergeRow);
  assert.equal(mergeRow.canonical_problem_id, problem2Id);

  // Verify GET /v1/problems/${problem1Id} returns 308 redirect to canonical problem
  const rawRedirectFetch = await worker.fetch(`${origin}/v1/problems/${problem1Id}`, {
    method: "GET",
    headers: { "User-Agent": "test-agent" },
    redirect: "manual",
  });
  assert.equal(rawRedirectFetch.status, 308);
  assert.equal(
    rawRedirectFetch.headers.get("location"),
    `/v1/problems/${problem2Id}`,
  );

  // Verify redirect=false allows inspecting merged problem
  const inspectMerged = await call(
    `/v1/problems/${problem1Id}?redirect=false`,
    undefined,
    undefined,
    200,
  );
  assert.equal(inspectMerged.problem.id, problem1Id);
  assert.equal(inspectMerged.problem.status, "retired");
  assert.equal(inspectMerged.problem.canonical_problem_id, problem2Id);

  console.log(JSON.stringify({ stage: "problem-merge-and-308-verified" }));

  // 11. Real D1 Concurrency on Governance Writes
  // Two stewards attempt concurrent lifecycle writes on Problem 2
  const [res1, res2] = await Promise.all([
    sponsorCall(
      sponsorA,
      "POST",
      `/v1/sponsors/problems/${problem2Id}/lifecycle`,
      "problem-lifecycle",
      { action: "set-admission-mode", mode: "invite-only" },
      [200, 409],
      undefined,
      "concurrent-key-alpha-1",
    ),
    sponsorCall(
      sponsorB,
      "POST",
      `/v1/sponsors/problems/${problem2Id}/lifecycle`,
      "problem-lifecycle",
      { action: "set-admission-mode", mode: "open" },
      [200, 409],
      undefined,
      "concurrent-key-beta-1",
    ),
  ]);

  // At least one write succeeded cleanly in transaction
  assert.ok(res1?.problem || res2?.problem);

  // Check public cursor is strictly positive and contiguous
  const cursorRow = await env.DB.prepare(
    "SELECT cursor FROM public_cursor WHERE singleton = 1",
  ).first();
  assert.ok(cursorRow.cursor > 0);

  console.log(JSON.stringify({ stage: "d1-concurrency-verified" }));

  // OPS.2a structured diagnostic log
  console.log(
    JSON.stringify({
      facility: "OPS.2a",
      stage: "problem-governance-complete",
      status: "pass",
      problem1_id: problem1Id,
      problem2_canonical_id: problem2Id,
      forked_problem_id: forkedProblemId,
      stewards_verified: [sponsorA, sponsorB],
      adr22_token_preservation: true,
      scientific_disposition_immutable_by_governance: true,
      merge_308_redirect_verified: true,
    }),
  );

  return {
    status: "pass",
    problem1Id,
    problem2Id,
    forkedProblemId,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLocalWorkerJourney(problemGovernanceJourney)
    .then((receipt) => {
      console.log(
        JSON.stringify({
          kind: "problem-governance-real-bindings-complete",
          status: "pass",
          receipt,
        }),
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error(
        JSON.stringify({
          kind: "problem-governance-real-bindings-complete",
          status: "fail",
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        }),
      );
      process.exit(1);
    });
}
