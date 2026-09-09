import assert from "node:assert/strict";

/**
 * W5.1 Problem Lifecycle & Statement Drift Journey:
 * 1. Sponsor problem brief creation, listing, assignment, and withdrawal.
 * 2. Fellow problem proposal with private-draft isolation (absent from public index/faces).
 * 3. P11 duplicate statement screening (409 POSSIBLE_DUPLICATE without distinct_because).
 * 4. Sponsor publish to public sharpening status.
 * 5. P3 claims board lock while in sharpening (422 CLAIMS_BOARD_LOCKED).
 * 6. Statement review: P1 author self-certification refusal (422 REVIEWER_IS_AUTHOR).
 * 7. Statement review: independent review (statement-clear) unlocks sharpening -> active.
 * 8. Active claims promotion on unlocked board.
 * 9. Problem statement revision (S@1 -> S@2): flags open claims with statement_drift = 1.
 * 10. P9 review refusal on drifted claims (422 STATEMENT_DRIFT).
 * 11. Author claim re-anchor (POST /v1/sessions/:id/reanchor): clears statement_drift to 0.
 * 12. Enter under-result-review and premature resolution refusal.
 * 13. Famous problem guardrail check and problem resolution with closing synthesis.
 * 14. Problem retirement.
 */
export async function problemLifecycleJourney({
  call,
  enroll,
  env,
  worker,
  origin,
  userAgent,
  sponsorCall,
}) {
  const sponsorA = "usr_problem_sponsor_a";
  const sponsorB = "usr_problem_sponsor_b";

  // Enroll Fellows under Sponsor A and Sponsor B
  const fellowA1Token = await enroll("fellow-a1-proposer", sponsorA);
  const fellowB1Token = await enroll("fellow-b1-independent", sponsorB);

  // --- Step 1: Sponsor Problem Briefs ---
  const briefPayload = {
    title: "Collatz 3x+1 Modular Cycles",
    statement: "Every non-trivial cycle in the 3x+1 mapping modulo 2^k has length bounded by k.",
    falsifier: "A cycle modulo 2^k with length strictly exceeding k.",
    motivation: "Bounding modular cycle length constrains non-trivial integer cycles in the Collatz map.",
    areas: ["number-theory", "dynamical-systems"],
  };

  const savedBrief = await sponsorCall(
    sponsorA,
    "POST",
    "/v1/sponsors/problem-briefs",
    "save-problem-brief",
    briefPayload,
    201,
  );
  assert.ok(savedBrief.brief.id.startsWith("brief-"));
  assert.equal(savedBrief.brief.status, "active");

  const briefList = await sponsorCall(
    sponsorA,
    "GET",
    "/v1/sponsors/problem-briefs",
    "list-problem-briefs",
    undefined,
    200,
  );
  assert.ok(briefList.briefs.some((b) => b.id === savedBrief.brief.id));

  // Withdraw an extra brief to test withdrawal
  const withdrawableBrief = await sponsorCall(
    sponsorA,
    "POST",
    "/v1/sponsors/problem-briefs",
    "save-problem-brief",
    { ...briefPayload, title: "Withdrawable Brief" },
    201,
  );
  const withdrawRes = await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problem-briefs/${withdrawableBrief.brief.id}/withdraw`,
    "withdraw-problem-brief",
    {},
    200,
  );
  assert.equal(withdrawRes.withdrawn, true);

  // --- Step 2: Problem Proposal & Private Draft ---
  const proposalPayload = {
    brief_id: savedBrief.brief.id,
    title: "Collatz Modular Cycle Bounds",
    statement: "Every non-trivial cycle in the 3x+1 mapping modulo 2^k has length bounded by k.",
    falsifier: "A cycle modulo 2^k with length strictly exceeding k.",
    motivation: "Constrains possible non-trivial integer cycles.",
    areas: ["number-theory"],
    famous_guardrail: {
      canonical_formulation:
        "Collatz 3x+1 conjecture: all positive integer orbits under the Collatz map reach 1.",
      variant_distinctions:
        "Restricted to modular cycles mod 2^k, which bounds periodic orbits without resolving integer divergence.",
      authoritative_references: ["Lagarias (1985) The 3x+1 problem and its generalizations"],
      standing_banner:
        "This problem investigates a modular cycle variant and does not prove the full Collatz conjecture.",
    },
  };

  // Cross-sponsor fellow cannot adopt Sponsor A's brief
  const unassignedRefusal = await call(
    "/v1/problems",
    proposalPayload,
    fellowB1Token,
    403,
  );
  assert.equal(unassignedRefusal.code, "BRIEF_NOT_ASSIGNED");

  // Authorized Fellow A1 adopts the brief and proposes the problem
  const proposed = await call(
    "/v1/problems",
    proposalPayload,
    fellowA1Token,
    201,
  );
  const problemId = proposed.problem.id;
  assert.ok(problemId.startsWith("P-COLLATZ"));
  assert.equal(proposed.problem.status, "private-draft");
  assert.equal(proposed.problem.current_statement_version, 1);

  // P11 duplicate screening: identical statement refuses without distinct_because
  const dupRefusal = await call(
    "/v1/problems",
    {
      title: "Duplicate Collatz Problem",
      statement: "Every non-trivial cycle in the 3x+1 mapping modulo 2^k has length bounded by k.",
      falsifier: "A cycle modulo 2^k with length strictly exceeding k.",
      motivation: "Constrains possible non-trivial integer cycles.",
      areas: ["number-theory"],
    },
    fellowA1Token,
    409,
  );
  assert.equal(dupRefusal.code, "POSSIBLE_DUPLICATE");
  assert.equal(dupRefusal.rule, "P11");

  // Private-draft visibility: invisible on public faces
  const publicIndexJson = await call("/problems.json", undefined, undefined, 200);
  assert.ok(!publicIndexJson.problems.some((p) => p.id === problemId));

  const publicProblemFace = await worker.fetch(`${origin}/p/${problemId}.json`, {
    headers: { "user-agent": userAgent },
  });
  assert.equal(publicProblemFace.status, 404, "Private draft must 404 on public /p/:id.json face");

  // Fellow B1 cannot read private draft
  const hiddenDraft = await call(`/v1/problems/${problemId}`, undefined, fellowB1Token, 404);
  assert.equal(hiddenDraft.code, "PROBLEM_NOT_FOUND");

  // Fellow A1 (creator) can read private draft
  const visibleDraft = await call(`/v1/problems/${problemId}`, undefined, fellowA1Token, 200);
  assert.equal(visibleDraft.problem.id, problemId);
  assert.equal(visibleDraft.problem.status, "private-draft");

  // --- Step 3: Sponsor Publishes to Sharpening ---
  const publishRes = await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
    200,
  );
  assert.equal(publishRes.problem.status, "sharpening");

  // Now visible on public problems index!
  const publicIndexAfterPublish = await call("/problems.json", undefined, undefined, 200);
  assert.ok(publicIndexAfterPublish.problems.some((p) => p.id === problemId));

  // --- Step 4: P3 Claims Board Gate (Locked in Sharpening) ---
  const sessionA1 = await call("/v1/sessions", { problem_id: problemId, intent: "prove" }, fellowA1Token, 201);
  const draftA1 = await call(
    `/v1/sessions/${sessionA1.session_id}/workshop`,
    { type: "draft", title: "Sharpening claim draft", body_md: "Draft text", relates_to: [] },
    fellowA1Token,
    201,
  );

  const lockedRefusal = await call(
    `/v1/sessions/${sessionA1.session_id}/promote`,
    {
      workshop_id: draftA1.workshop_id,
      kind: "conjecture",
      statement: "For all k >= 1, the period of the 3x+1 cycle mod 2^k is at most k.",
      falsifier: "A cycle of length > k mod 2^k.",
    },
    fellowA1Token,
    422,
  );
  assert.equal(lockedRefusal.code, "CLAIMS_BOARD_LOCKED");
  assert.equal(lockedRefusal.rule, "P3");

  // --- Step 5: Statement Review & Sharpening Unlock ---
  // Author fellow attempts review -> 422 REVIEWER_IS_AUTHOR (rule P1)
  const selfReview = await call(
    `/v1/problems/${problemId}/statement-review`,
    { verdict: "statement-clear", basis: "I assert my own statement is clear." },
    fellowA1Token,
    422,
  );
  assert.equal(selfReview.code, "REVIEWER_IS_AUTHOR");
  assert.equal(selfReview.rule, "P1");

  // Independent Fellow B1 submits statement-clear review
  const independentReview = await call(
    `/v1/problems/${problemId}/statement-review`,
    { verdict: "statement-clear", basis: "The formulation is rigorous, types are exact, and falsifier is sharp." },
    fellowB1Token,
    200,
  );
  assert.equal(independentReview.verdict, "statement-clear");
  assert.equal(independentReview.status, "active");

  // Verify status is now active in D1
  const activeProblem = await call(`/v1/problems/${problemId}`, undefined, undefined, 200);
  assert.equal(activeProblem.problem.status, "active");

  // --- Step 6: Active Claims Promotion ---
  const promotedClaim = await call(
    `/v1/sessions/${sessionA1.session_id}/promote`,
    {
      workshop_id: draftA1.workshop_id,
      kind: "conjecture",
      statement: "For all k >= 1, the period of the 3x+1 cycle mod 2^k is at most k.",
      falsifier: "A cycle of length > k mod 2^k.",
    },
    fellowA1Token,
    201,
  );
  assert.ok(promotedClaim.claim_id.startsWith("C-"));

  // --- Step 7: Problem Statement Revision (S@1 -> S@2) & Statement Drift ---
  const revisedProblem = await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "problem-lifecycle",
    {
      action: "revise-statement",
      statement: "For all k >= 3, the non-trivial 3x+1 cycle mod 2^k has length bounded by k - 2.",
      falsifier: "A non-trivial cycle mod 2^k with length > k - 2 for k >= 3.",
      motivation: "Strengthened bound based on modular obstruction analysis.",
    },
    200,
  );
  assert.equal(revisedProblem.problem.current_statement_version, 2);

  // Assert claim now has statement_drift = 1 in D1
  const driftedClaimRow = await env.DB.prepare(
    "SELECT statement_version, statement_drift FROM claims WHERE problem_id = ? AND id = ?",
  )
    .bind(problemId, promotedClaim.claim_id)
    .first();
  assert.equal(driftedClaimRow.statement_version, 1);
  assert.equal(driftedClaimRow.statement_drift, 1);

  // Review on drifted claim is refused (P9)
  const sessionB1 = await call("/v1/sessions", { problem_id: problemId, intent: "review" }, fellowB1Token, 201);
  const driftedReview = await call(
    `/v1/sessions/${sessionB1.session_id}/review`,
    {
      target_claim_id: promotedClaim.claim_id,
      target_version: 1,
      verdict: "confirm",
      basis: "Review on unanchored claim.",
      body_md: "Review body.",
    },
    fellowB1Token,
    422,
  );
  assert.equal(driftedReview.code, "STATEMENT_DRIFT");
  assert.equal(driftedReview.rule, "P9");

  // Re-anchor by author fellow clears statement_drift to 0
  const reanchorRes = await call(
    `/v1/sessions/${sessionA1.session_id}/reanchor`,
    {
      claim_id: promotedClaim.claim_id,
      base_version: 1,
    },
    fellowA1Token,
    200,
  );
  assert.equal(reanchorRes.reanchored, true);
  assert.equal(reanchorRes.statement_version, 2);
  assert.equal(reanchorRes.statement_drift, false);

  const reanchoredRow = await env.DB.prepare(
    "SELECT statement_version, statement_drift FROM claims WHERE problem_id = ? AND id = ?",
  )
    .bind(problemId, promotedClaim.claim_id)
    .first();
  assert.equal(reanchoredRow.statement_version, 2);
  assert.equal(reanchoredRow.statement_drift, 0);

  // Review now succeeds!
  const validReview = await call(
    `/v1/sessions/${sessionB1.session_id}/review`,
    {
      target_claim_id: promotedClaim.claim_id,
      target_version: 1,
      verdict: "confirm",
      basis: "Statement reanchored and verified against S@2.",
      body_md: "Review verification.",
    },
    fellowB1Token,
    201,
  );
  assert.ok(validReview.review_id.startsWith("R-"));

  // --- Step 8: Under-Result-Review & Resolution ---
  // Premature resolution without under-result-review refused (rule P3)
  const prematureResolve = await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "problem-lifecycle",
    {
      action: "resolve",
      direction: "affirmed",
      closing_synthesis: {
        summary: "The modular bound holds for all k >= 3.",
        no_claim_boundary: {
          verified: ["Modular cycle bounds"],
          mechanisms: ["2-adic valuation"],
          independence_tiers: ["T2"],
          remaining_external_validation: ["Full integer Collatz map"],
        },
      },
    },
    422,
  );
  assert.equal(prematureResolve.code, "PREMATURE_RESOLUTION");

  // Transition to under-result-review
  const reviewStage = await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "problem-lifecycle",
    { action: "enter-result-review" },
    200,
  );
  assert.equal(reviewStage.problem.status, "under-result-review");

  // Famous problem guardrail: requires external_expert_review_proof
  const missingProofRefusal = await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "problem-lifecycle",
    {
      action: "resolve",
      direction: "affirmed",
      closing_synthesis: {
        summary: "The modular bound holds for all k >= 3.",
        no_claim_boundary: {
          verified: ["Modular cycle bounds"],
          mechanisms: ["2-adic valuation"],
          independence_tiers: ["T2"],
          remaining_external_validation: ["Full integer Collatz map"],
        },
      },
    },
    422,
  );
  assert.equal(missingProofRefusal.code, "PREMATURE_RESOLUTION");

  // Resolution with valid external proof
  const resolvedProblem = await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "problem-lifecycle",
    {
      action: "resolve",
      direction: "affirmed",
      closing_synthesis: {
        summary: "The modular cycle length bound is settled.",
        no_claim_boundary: {
          verified: ["Modular cycle bounds"],
          mechanisms: ["2-adic valuation"],
          independence_tiers: ["T2"],
          remaining_external_validation: ["Full integer Collatz map"],
        },
      },
      external_expert_review_proof: "Lean 4 formalized proof independently verified by 2 external experts.",
    },
    200,
  );
  assert.equal(resolvedProblem.problem.status, "resolved");

  // Further promotion on resolved problem refused
  const postResolveDraft = await call(
    `/v1/sessions/${sessionA1.session_id}/workshop`,
    { type: "draft", title: "Post-resolution draft", body_md: "Draft", relates_to: [] },
    fellowA1Token,
    201,
  );
  const closedRefusal = await call(
    `/v1/sessions/${sessionA1.session_id}/promote`,
    {
      workshop_id: postResolveDraft.workshop_id,
      kind: "conjecture",
      statement: "A new conjecture on resolved problem.",
      falsifier: "Counterexample.",
    },
    fellowA1Token,
    422,
  );
  assert.equal(closedRefusal.code, "WRITE_REFUSED");

  // --- Step 9: Problem Retirement ---
  const retiredProblemProp = await call(
    "/v1/problems",
    {
      title: "Problem To Retire",
      statement: "A problem statement that will be retired early.",
      falsifier: "A falsifier for retired problem.",
      motivation: "Retirement flow verification.",
      areas: ["geometry"],
    },
    fellowA1Token,
    201,
  );
  const retiredProblemId = retiredProblemProp.problem.id;

  const retireRes = await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${retiredProblemId}/lifecycle`,
    "problem-lifecycle",
    { action: "retire", reason: "Explored alternate topological formulation." },
    200,
  );
  assert.equal(retireRes.problem.status, "retired");

  return {
    status: "pass",
    problem: problemId,
    retiredProblem: retiredProblemId,
  };
}
