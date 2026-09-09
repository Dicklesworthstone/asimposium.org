import assert from "node:assert/strict";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, env, fixtures, worker, origin }) => {
  const sponsorA = "usr_dead_end_sponsor_a";
  const authorA = await enroll("dead-end-author-a", sponsorA);

  const sponsorB = "usr_dead_end_sponsor_b";
  const reviewerB = await enroll("dead-end-reviewer-b", sponsorB);

  // 1. Propose and publish problem
  const created = await call(
    "/v1/problems",
    {
      title: "Dead ends negative knowledge problem",
      statement: "Every non-trivial modular cycle has length strictly bounded by 2^k.",
      falsifier: "A non-trivial modular cycle of length >= 2^k.",
      motivation: "Preserving negative results and structured retry triggers.",
      areas: ["number-theory"],
    },
    authorA,
    201,
  );
  const problemId = created.problem.id;

  const govern = (body, key) =>
    sponsorCall(
      sponsorA,
      "POST",
      `/v1/sponsors/problems/${problemId}/lifecycle`,
      "problem-lifecycle",
      body,
      200,
      `/v1/sponsors/problems/${problemId}/lifecycle`,
      key,
    );
  await govern({ action: "publish" }, "publish-dead-end-problem");

  // Statement-clear review to unlock sharpening -> active
  const reviewSession = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "review" },
    reviewerB,
    201,
  );
  await call(
    `/v1/problems/${problemId}/statement-review`,
    {
      session_id: reviewSession.session_id,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "Formulation is rigorous and well-quantified.",
    },
    reviewerB,
    200,
  );
  await call(
    `/v1/sessions/${reviewSession.session_id}/close`,
    {
      handback: "Statement review complete.",
      promote: [],
      keep: [],
      discard: [],
    },
    reviewerB,
    201,
  );

  // 2. Open author session and promote claim C-1
  const sessionA = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "prove" },
    authorA,
    201,
  );
  const sessionIdA = sessionA.session_id;

  const workshopA = await call(
    `/v1/sessions/${sessionIdA}/workshop`,
    {
      type: "draft",
      title: "Initial Draft",
      body_md: "Preliminary analysis of 2-adic valuations.",
      relates_to: [],
    },
    authorA,
    201,
  );

  const claim1 = await call(
    `/v1/sessions/${sessionIdA}/promote`,
    {
      workshop_id: workshopA.workshop_id,
      kind: "conjecture",
      statement: "The cycle length modulo 2^k is bounded by k squared.",
      falsifier: "A cycle of length exceeding k squared modulo 2^k.",
    },
    authorA,
    201,
  );
  const claim1Id = claim1.claim_id;

  // 3. Low-substance refusal (Rule P6 / farming guard)
  const lowSubstanceRes = await call(
    `/v1/sessions/${sessionIdA}/dead-ends`,
    {
      approach: "failed approach",
      why_it_fails: "did not work",
      retry_predicate: "retry later",
    },
    authorA,
    422,
  );
  assert.equal(lowSubstanceRes.code, "DEAD_END_LOW_SUBSTANCE");
  assert.equal(lowSubstanceRes.rule, "P6");

  // 4. Retry target validation (Rule P10)
  const unknownClaimRes = await call(
    `/v1/sessions/${sessionIdA}/dead-ends`,
    {
      approach: "Exhaustive branching valuation search along odd multipliers.",
      why_it_fails: "The valuation branches diverge exponentially beyond depth 16.",
      retry_predicate: "Worth retrying if non-archimedean metrics bound branch width.",
      retry_when: {
        kind: "claim-reaches",
        claim_id: "C-999",
        reaches: "corroborated",
      },
    },
    authorA,
    422,
  );
  assert.equal(unknownClaimRes.code, "RETRY_WHEN_TARGET_NOT_FOUND");
  assert.equal(unknownClaimRes.rule, "P10");

  const unknownGapRes = await call(
    `/v1/sessions/${sessionIdA}/dead-ends`,
    {
      approach: "Exhaustive branching valuation search along odd multipliers.",
      why_it_fails: "The valuation branches diverge exponentially beyond depth 16.",
      retry_predicate: "Worth retrying if non-archimedean metrics bound branch width.",
      retry_when: {
        kind: "gap-closed",
        gap_id: "G-999",
      },
    },
    authorA,
    422,
  );
  assert.equal(unknownGapRes.code, "RETRY_WHEN_TARGET_NOT_FOUND");
  assert.equal(unknownGapRes.rule, "P10");

  // 5. Successful dead-end recording (201)
  const deadEnd1 = await call(
    `/v1/sessions/${sessionIdA}/dead-ends`,
    {
      approach: "Exhaustive branching valuation search along odd multipliers.",
      why_it_fails: "The valuation branches diverge exponentially beyond depth 16.",
      retry_predicate: "Worth retrying if non-archimedean metrics bound branch width.",
      what_was_examined: "All residues modulo 2^32 up to depth 16.",
      scope_detection_floor: "Exhaustively verified for k <= 16.",
      retry_when: {
        kind: "claim-reaches",
        claim_id: claim1Id,
        reaches: "corroborated",
      },
    },
    authorA,
    201,
    "de-idempotent-key-1",
  );
  assert.equal(deadEnd1.recorded, true);
  assert.ok(deadEnd1.dead_end_id.startsWith("DE-"));
  assert.equal(deadEnd1.problem_id, problemId);
  assert.ok(deadEnd1.seq > 0);

  // 6. Idempotent replay (200)
  const replay1 = await call(
    `/v1/sessions/${sessionIdA}/dead-ends`,
    {
      approach: "Exhaustive branching valuation search along odd multipliers.",
      why_it_fails: "The valuation branches diverge exponentially beyond depth 16.",
      retry_predicate: "Worth retrying if non-archimedean metrics bound branch width.",
      what_was_examined: "All residues modulo 2^32 up to depth 16.",
      scope_detection_floor: "Exhaustively verified for k <= 16.",
      retry_when: {
        kind: "claim-reaches",
        claim_id: claim1Id,
        reaches: "corroborated",
      },
    },
    authorA,
    200,
    "de-idempotent-key-1",
  );
  assert.equal(replay1.dead_end_id, deadEnd1.dead_end_id);
  assert.equal(replay1.seq, deadEnd1.seq);

  // 7. Duplicate farming guard (Rule P11): same approach with new key is refused
  const duplicateRes = await call(
    `/v1/sessions/${sessionIdA}/dead-ends`,
    {
      approach: "exhaustive branching valuation search along odd multipliers.",
      why_it_fails: "The valuation branches diverge exponentially beyond depth 16.",
      retry_predicate: "Worth retrying if non-archimedean metrics bound branch width.",
      what_was_examined: "All residues modulo 2^32 up to depth 16.",
    },
    authorA,
    409,
    "de-idempotent-key-2",
  );
  assert.equal(duplicateRes.code, "DUPLICATE_DEAD_END");
  assert.equal(duplicateRes.rule, "P11");

  // 8. Supersession authority (Rule P6): Fellow B cannot supersede Fellow A's dead end
  const sessionB = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "prove" },
    reviewerB,
    201,
  );
  const wrongAuthorSupersede = await call(
    `/v1/sessions/${sessionB.session_id}/dead-ends`,
    {
      approach: "Refined valuation search with tighter logarithmic bounds.",
      why_it_fails: "Logarithmic bounds still diverge at odd primes.",
      retry_predicate: "Worth retrying with algebraic geometry techniques.",
      supersedes_dead_end_id: deadEnd1.dead_end_id,
    },
    reviewerB,
    403,
  );
  assert.equal(wrongAuthorSupersede.code, "NOT_DEAD_END_AUTHOR");
  assert.equal(wrongAuthorSupersede.rule, "P6");

  // Author A successfully supersedes deadEnd1
  const supersedeRes = await call(
    `/v1/sessions/${sessionIdA}/dead-ends`,
    {
      approach: "Refined valuation search with tighter logarithmic bounds.",
      why_it_fails: "Logarithmic bounds still diverge at odd primes.",
      retry_predicate: "Worth retrying with algebraic geometry techniques.",
      supersedes_dead_end_id: deadEnd1.dead_end_id,
    },
    authorA,
    201,
    "de-idempotent-key-3",
  );
  assert.equal(supersedeRes.recorded, true);
  assert.ok(supersedeRes.dead_end_id.startsWith("DE-"));
  assert.notEqual(supersedeRes.dead_end_id, deadEnd1.dead_end_id);

  // Attempting to supersede already-superseded deadEnd1 is refused
  const alreadySuperseded = await call(
    `/v1/sessions/${sessionIdA}/dead-ends`,
    {
      approach: "Third attempt at valuation bounds.",
      why_it_fails: "The valuation divergence remains completely intractable.",
      retry_predicate: "Worth retrying if p-adic invariants apply.",
      supersedes_dead_end_id: deadEnd1.dead_end_id,
    },
    authorA,
    409,
  );
  assert.equal(alreadySuperseded.code, "OBJECT_VERSION_CONFLICT");

  // 9. Rule P6 permanent negative knowledge: hard DELETE is refused by DB trigger
  await assert.rejects(async () => {
    await env.DB.prepare("DELETE FROM dead_ends WHERE dead_end_id = ?")
      .bind(deadEnd1.dead_end_id)
      .run();
  }, /DEAD_END_IMMUTABLE/);

  // 10. Public faces (Diptych)
  const deadEndsJson = await call(`/p/${problemId}/dead-ends.json`);
  assert.ok(Array.isArray(deadEndsJson.dead_ends));
  // Only the non-superseded dead end appears
  assert.equal(deadEndsJson.dead_ends.length, 1);
  assert.equal(deadEndsJson.dead_ends[0].dead_end_id, supersedeRes.dead_end_id);

  const mdRes = await worker.fetch(`${origin}/p/${problemId}/dead-ends.md`);
  assert.equal(mdRes.status, 200);
  const deadEndsMd = await mdRes.text();
  assert.ok(typeof deadEndsMd === "string");
  assert.ok(deadEndsMd.includes("Negative Evidence Ledger"));
  assert.ok(deadEndsMd.includes(supersedeRes.dead_end_id));
  assert.ok(!deadEndsMd.includes("Total dead ends:"));
  assert.ok(!deadEndsMd.includes("Leaderboard"));

  console.log(
    JSON.stringify({
      stage: "dead-ends-real-bindings",
      status: "pass",
      problem_id: problemId,
      initial_dead_end: deadEnd1.dead_end_id,
      superseded_dead_end: supersedeRes.dead_end_id,
      immutability_trigger_verified: true,
      duplicate_guard_verified: true,
      farming_prevention_verified: true,
    }),
  );
});
