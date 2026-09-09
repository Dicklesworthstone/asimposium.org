import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ScreeningPublicationProvenanceSchema,
  SynthesizeRequestSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, env, fixtures }) => {
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

  // Freeze the source, then advance both actual production writers. A later
  // event must neither invalidate an older anchor nor satisfy a future pin.
  const admission = await env.DB.prepare(
    "SELECT seq FROM events WHERE problem_id = ? AND type = 'problem.admitted'",
  )
    .bind(problemId)
    .first();
  const claimSource = await env.DB.prepare(
    "SELECT seq FROM events WHERE problem_id = ? AND object_id = ? AND type = 'claim.created'",
  )
    .bind(problemId, claim1Id)
    .first();
  assert.ok(admission && claimSource);
  await call(
    `/v1/sessions/${sessionId}/revise`,
    {
      claim_id: claim1Id,
      base_version: 1,
      kind: "conjecture",
      statement: "Every integer n greater than one has a prime divisor at most n.",
      falsifier: "An integer greater than one without a prime divisor at most itself.",
      depends_on: [],
    },
    author,
    201,
  );
  await govern(
    {
      action: "revise-statement",
      statement: "Every integer n greater than one has a prime divisor in the interval [2, n].",
      falsifier: "An integer n greater than one without a prime divisor in [2, n].",
      motivation: "Expose the finite search domain explicitly.",
    },
    "synthesis-statement-revision",
  );

  const failures = [];
  const check = (condition, label) => {
    if (!condition) failures.push(label);
    console.log(JSON.stringify({ stage: "frozen-anchor-check", label, pass: condition }));
  };
  async function footprint() {
    return env.DB.prepare(`SELECT public_seq, chain_digest,
      (SELECT COUNT(*) FROM events) AS events,
      (SELECT COUNT(*) FROM event_content) AS content,
      (SELECT COUNT(*) FROM syntheses) AS syntheses,
      (SELECT COUNT(*) FROM session_write_replays) AS replays,
      (SELECT COUNT(*) FROM screening_publications) AS screening_publications,
      (SELECT COUNT(*) FROM outbox) AS outbox
      FROM problems WHERE id = ?`)
      .bind(problemId)
      .first();
  }
  const cases = [
    [
      "claim sequence belonging to another object",
      false,
      { target_kind: "claim", target_id: claim1Id, target_version: 1, target_seq: admission.seq },
    ],
    [
      "claim sequence beyond frozen cut",
      false,
      { target_kind: "claim", target_id: claim1Id, target_version: 1, target_seq: maxSeq2 + 100 },
    ],
    [
      "unrelated statement identity",
      false,
      { target_kind: "statement", target_id: "P-DOES-NOT-EXIST", target_version: 1 },
    ],
    [
      "statement sequence belonging to a claim",
      false,
      {
        target_kind: "statement",
        target_id: problemId,
        target_version: 1,
        target_seq: claimSource.seq,
      },
    ],
    [
      "future statement version",
      false,
      { target_kind: "statement", target_id: problemId, target_version: 2 },
    ],
    ["historical claim with implicit version", true, { target_kind: "claim", target_id: claim1Id }],
    [
      "historical claim with exact event",
      true,
      { target_kind: "claim", target_id: claim1Id, target_version: 1, target_seq: claimSource.seq },
    ],
    [
      "historical statement with exact event",
      true,
      {
        target_kind: "statement",
        target_id: problemId,
        target_version: 1,
        target_seq: admission.seq,
      },
    ],
    [
      "admission before later statement review and revision",
      true,
      { target_kind: "statement", target_id: problemId },
      admission.seq,
    ],
  ];
  for (const [index, [label, allowed, anchor, through = maxSeq2]] of cases.entries()) {
    const before = await footprint();
    const screeningBefore = await fixtures.screeningCalls();
    const body = {
      covers_through: through,
      body_md:
        "The cited ledger record is retained at the frozen cursor; this summary does not upgrade its disposition.",
      anchors: [anchor],
      omitted: ["Other records are outside this focused historical summary."],
      selection_policy: "Summarize the selected record at the retained cursor.",
    };
    const key = `frozen-anchor-${index}`;
    const response = await call(`/v1/sessions/${sessionId}/synthesize`, body, author, null, key);
    const after = await footprint();
    if (allowed) {
      check(typeof response.synthesis_id === "string", `${label}: accepted`);
      check(after.events === before.events + 1, `${label}: one event`);
      if (response.synthesis_id) {
        const retained = await env.DB.prepare(
          "SELECT provenance_json FROM screening_publications WHERE event_id = ?",
        )
          .bind(response.event_id)
          .first();
        assert.ok(retained, "Successful synthesis retains screening provenance atomically");
        const provenance = ScreeningPublicationProvenanceSchema.parse(
          JSON.parse(retained.provenance_json),
        );
        const screenedBytes = JSON.stringify({
          kind: "synthesis",
          statement: JSON.stringify(SynthesizeRequestSchema.parse(body)),
          falsifier: null,
        });
        assert.equal(
          provenance.input_digest,
          createHash("sha256").update(screenedBytes).digest("hex"),
          "Screening binds the complete validated public payload",
        );
        const replay = await call(`/v1/sessions/${sessionId}/synthesize`, body, author, 200, key);
        assert.deepEqual(replay, response);
        assert.deepEqual(await footprint(), after);
        assert.equal(await fixtures.screeningCalls(), screeningBefore + 1);
      }
    } else {
      check(
        response.code === "SYNTHESIS_UNANCHORED" && response.rule === "P13",
        `${label}: P13 refusal`,
      );
      check(JSON.stringify(after) === JSON.stringify(before), `${label}: no public mutation`);
      check((await fixtures.screeningCalls()) === screeningBefore, `${label}: no paid screen`);
    }
  }
  const screenable = {
    covers_through: maxSeq2,
    body_md: "A focused summary of the retained claim.",
    anchors: [{ target_kind: "claim", target_id: claim1Id, target_version: 1 }],
    omitted: [],
    selection_policy: "Only the selected claim is summarized.",
  };
  // The local classifier rejects a known marker. These cases prove that all
  // published text reaches screening; they do not measure Workers AI accuracy.
  const canaries = [
    ["body", { body_md: "LOCAL_POLICY_CANARY" }],
    ["selection policy", { selection_policy: "LOCAL_POLICY_CANARY" }],
    ["omission", { omitted: ["LOCAL_POLICY_CANARY"] }],
    [
      "anchor summary",
      { anchors: [{ ...screenable.anchors[0], assertion_summary: "LOCAL_POLICY_CANARY" }] },
    ],
  ];
  for (const [index, [label, override]] of canaries.entries()) {
    const before = await footprint();
    const screeningBefore = await fixtures.screeningCalls();
    const denied = await call(
      `/v1/sessions/${sessionId}/synthesize`,
      {
        ...screenable,
        ...override,
      },
      author,
      null,
      `synthesis-screening-${index}`,
    );
    check(denied.code === "POLICY_DENIED", `${label}: policy refusal`);
    check(
      JSON.stringify(await footprint()) === JSON.stringify(before),
      `${label}: no public mutation`,
    );
    check((await fixtures.screeningCalls()) === screeningBefore + 1, `${label}: screened once`);
    if (denied.code === "POLICY_DENIED") {
      assert.deepEqual(Object.keys(denied).sort(), ["appeal", "coarse_category", "code"]);
      assert.ok(!JSON.stringify(denied).includes("LOCAL_POLICY_CANARY"));
    }
  }
  assert.deepEqual(failures, [], "Frozen-anchor and screening regressions must all pass");

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
