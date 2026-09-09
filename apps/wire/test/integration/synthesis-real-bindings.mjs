import assert from "node:assert/strict";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, env }) => {
  const sponsorA = "usr_synthesis_sponsor_a";
  const author = await enroll("synthesis-author", sponsorA);

  const sponsorB = "usr_synthesis_sponsor_b";
  const reviewer = await enroll("synthesis-reviewer", sponsorB);

  // 1. Propose and publish problem
  const created = await call(
    "/v1/problems",
    {
      title: "Synthesis lifecycle problem",
      statement: "Every positive integer greater than one has a prime factor.",
      falsifier: "A positive integer greater than one with no prime factors.",
      motivation: "Anchor verification and synthesis lifecycle validation.",
      areas: ["number-theory"],
    },
    author,
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
  await govern({ action: "publish" }, "publish-synth-problem");

  // Independent statement-clear review to unlock claims board from sharpening
  const reviewSession = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "review" },
    reviewer,
    201,
  );
  await call(
    `/v1/problems/${problemId}/statement-review`,
    {
      session_id: reviewSession.session_id,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "The formulation is rigorous and well-quantified.",
    },
    reviewer,
    200,
  );

  // 2. Open author session
  const session = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "prove" },
    author,
    201,
  );
  const sessionId = session.session_id;

  // 3. Promote claim C-1
  const workshop1 = await call(
    `/v1/sessions/${sessionId}/workshop`,
    {
      type: "draft",
      title: "Draft 1",
      body_md: "First draft body.",
      relates_to: [],
    },
    author,
    201,
  );

  const claim1 = await call(
    `/v1/sessions/${sessionId}/promote`,
    {
      workshop_id: workshop1.workshop_id,
      kind: "conjecture",
      statement: "Every positive integer greater than one has a prime factor.",
      falsifier: "A positive integer with no prime factor.",
    },
    author,
    201,
  );
  const claim1Id = claim1.claim_id;

  const maxSeq1 = (
    await env.DB.prepare("SELECT MAX(seq) AS seq FROM events WHERE problem_id = ?")
      .bind(problemId)
      .first()
  ).seq;

  // 4. Test unanchored anchor (Rule P13) with unknown claim
  const unanchoredNonexistent = await call(
    `/v1/sessions/${sessionId}/synthesize`,
    {
      covers_through: maxSeq1,
      body_md: "## Synthesis\n\nReferencing ungrounded claim.",
      anchors: [{ target_kind: "claim", target_id: "C-999", target_version: 1 }],
      omitted: [],
      selection_policy: "Include all claims",
    },
    author,
    422,
  );
  assert.equal(unanchoredNonexistent.code, "SYNTHESIS_UNANCHORED");
  assert.equal(unanchoredNonexistent.rule, "P13");
  assert.ok(Array.isArray(unanchoredNonexistent.unanchored));
  assert.ok(unanchoredNonexistent.unanchored.some((u) => u.includes("C-999")));

  // 5. Test unanchored anchor (Rule P13) where covers_through exceeds max sequence
  const unanchoredFuture = await call(
    `/v1/sessions/${sessionId}/synthesize`,
    {
      covers_through: maxSeq1 + 50,
      body_md: "## Synthesis\n\nCovers through future.",
      anchors: [{ target_kind: "claim", target_id: claim1Id, target_version: 1 }],
      omitted: [],
      selection_policy: "Include all claims",
    },
    author,
    422,
  );
  assert.equal(unanchoredFuture.code, "SYNTHESIS_UNANCHORED");
  assert.equal(unanchoredFuture.rule, "P13");

  // 6. Valid synthesis creation grounded in claim C-1
  const synth1 = await call(
    `/v1/sessions/${sessionId}/synthesize`,
    {
      covers_through: maxSeq1,
      body_md: "## State of the Problem\n\nPrime factor existence holds.",
      anchors: [{ target_kind: "claim", target_id: claim1Id, target_version: 1 }],
      omitted: [],
      selection_policy: "Include established claims",
    },
    author,
    201,
    "synth-idempotent-key-1",
  );
  assert.ok(synth1.synthesis_id.startsWith("SYNTH-"));
  assert.equal(synth1.problem_id, problemId);
  assert.equal(synth1.covers_through, maxSeq1);
  assert.equal(synth1.anchors_count, 1);
  assert.equal(synth1.dropped_single_author_count, 0);
  assert.ok(synth1.sequence > maxSeq1);

  // 7. Idempotent replay
  const replay1 = await call(
    `/v1/sessions/${sessionId}/synthesize`,
    {
      covers_through: maxSeq1,
      body_md: "## State of the Problem\n\nPrime factor existence holds.",
      anchors: [{ target_kind: "claim", target_id: claim1Id, target_version: 1 }],
      omitted: [],
      selection_policy: "Include established claims",
    },
    author,
    200,
    "synth-idempotent-key-1",
  );
  assert.equal(replay1.synthesis_id, synth1.synthesis_id);
  assert.equal(replay1.sequence, synth1.sequence);

  // 8. Promote claim C-2 by same author, then omit it in synthesis 2
  const workshop2 = await call(
    `/v1/sessions/${sessionId}/workshop`,
    {
      type: "draft",
      title: "Draft 2",
      body_md: "Second draft body.",
      relates_to: [],
    },
    author,
    201,
  );
  const claim2 = await call(
    `/v1/sessions/${sessionId}/promote`,
    {
      workshop_id: workshop2.workshop_id,
      kind: "conjecture",
      statement: "Smallest prime number is two.",
      falsifier: "A prime smaller than two.",
    },
    author,
    201,
  );
  const claim2Id = claim2.claim_id;

  const maxSeq2 = (
    await env.DB.prepare("SELECT MAX(seq) AS seq FROM events WHERE problem_id = ?")
      .bind(problemId)
      .first()
  ).seq;

  // Synthesis 2: covers through maxSeq2, but anchors only C-1, dropping C-2.
  // C-2 is single-author because no other Fellow reviewed or related it.
  const synth2 = await call(
    `/v1/sessions/${sessionId}/synthesize`,
    {
      covers_through: maxSeq2,
      body_md: "## State of the Problem v2\n\nCovering through C-2 but omitting C-2.",
      anchors: [{ target_kind: "claim", target_id: claim1Id, target_version: 1 }],
      omitted: [`claim:${claim2Id}: Focused on existence theorem only`],
      selection_policy: "Include existence claims only",
    },
    author,
    201,
    "synth-idempotent-key-2",
  );
  assert.ok(synth2.synthesis_id.startsWith("SYNTH-"));
  assert.equal(synth2.covers_through, maxSeq2);
  assert.equal(synth2.dropped_single_author_count, 1);

  // 9. Verify D1 database state
  const synthRows = (
    await env.DB.prepare("SELECT * FROM syntheses WHERE problem_id = ? ORDER BY covers_through")
      .bind(problemId)
      .all()
  ).results;
  assert.equal(synthRows.length, 2);
  assert.equal(synthRows[0].synthesis_id, synth1.synthesis_id);
  assert.equal(synthRows[0].dropped_single_author_count, 0);
  assert.equal(synthRows[1].synthesis_id, synth2.synthesis_id);
  assert.equal(synthRows[1].dropped_single_author_count, 1);

  console.log(
    JSON.stringify({
      kind: "synthesis-real-bindings",
      status: "pass",
      problemId,
      synthesis1: synth1.synthesis_id,
      synthesis2: synth2.synthesis_id,
    }),
  );
});
