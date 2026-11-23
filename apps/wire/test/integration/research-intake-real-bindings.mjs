import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ClaimFaceResponseSchema,
  ProblemFaceResponseSchema,
  ProposeProblemRequestSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

const intake = JSON.parse(
  readFileSync(new URL("../../../../docs/seed/research-intake.json", import.meta.url), "utf8"),
);

const closingHandback = { handback: "Completed the local research intake rehearsal." };

function canonicalKey(left, right) {
  const inverse = (letter) => ({ a: "A", b: "B", A: "a", B: "b" })[letter];
  const reduced = [];
  for (const letter of [...left, ...Array.from(right).reverse().map(inverse)]) {
    if (reduced.at(-1) === inverse(letter)) reduced.pop();
    else reduced.push(letter);
  }
  let start = 0;
  let end = reduced.length;
  while (end - start > 1 && reduced[start] === inverse(reduced[end - 1])) {
    start += 1;
    end -= 1;
  }
  const cyclic = reduced.slice(start, end);
  const inverted = cyclic.toReversed().map(inverse);
  const rotations = (word) =>
    word.map((_, index) => [...word.slice(index), ...word.slice(0, index)].join(""));
  return [...rotations(cyclic), ...rotations(inverted)].sort()[0] ?? "";
}

function checkCalibration() {
  const words = [""];
  let level = [""];
  for (let length = 1; length <= 3; length += 1) {
    level = level.flatMap((prefix) => [`${prefix}a`, `${prefix}b`]);
    words.push(...level);
  }

  const swaps = { a: [1, 0, 2], b: [0, 2, 1] };
  const permutation = (word) =>
    Array.from(word)
      .reduce((result, letter) => swaps[letter].map((index) => result[index]), [0, 1, 2])
      .join("");
  const residue = (word) =>
    Array.from(word).reduce((sum, letter) => (sum + (letter === "a" ? 1 : 2)) % 6, 0);

  let checks = 0;
  for (const evaluate of [permutation, residue]) {
    const byKey = new Map();
    for (const [index, left] of words.entries()) {
      for (const right of words.slice(index)) {
        const key = canonicalKey(left, right);
        const equal = evaluate(left) === evaluate(right);
        if (byKey.has(key)) assert.equal(byKey.get(key), equal, `inconsistent key ${key}`);
        byKey.set(key, equal);
        checks += 1;
      }
    }
  }
  assert.equal(checks, 240);
  assert.notEqual(permutation("ab"), permutation("ba"));
  assert.equal(residue("ab"), residue("ba"));
  return checks;
}

assert.deepEqual(
  intake.drafts.map(({ role }) => role),
  ["calibration", "registered-research"],
);

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, worker, origin, userAgent }) => {
  const sponsor = "usr_research_intake_author";
  const author = await enroll("research-intake-author", sponsor);
  const reviewer = await enroll("research-intake-reviewer", "usr_research_intake_reviewer");
  const calibrationChecks = checkCalibration();

  for (const { id, role, proposal: input } of intake.drafts) {
    const proposal = ProposeProblemRequestSchema.parse(input);
    const { problem } = await call("/v1/problems", proposal, author, 201, `intake-${id}`);
    const problemPath = `/v1/problems/${problem.id}`;
    const publicPath = `/p/${problem.id}`;
    const lifecycle = `/v1/sponsors/problems/${problem.id}/lifecycle`;
    assert.equal(problem.status, "private-draft");
    await call(`${publicPath}.json`, undefined, undefined, 404);
    await call(problemPath, undefined, reviewer, 404);

    const published = await sponsorCall(
      sponsor,
      "POST",
      lifecycle,
      "problem-lifecycle",
      { action: "publish" },
      200,
    );
    assert.equal(published.problem.status, "sharpening");
    const authorSession = await call(
      "/v1/sessions",
      { problem_id: problem.id, intent: "refute" },
      author,
      201,
    );
    const reviewSession = await call(
      "/v1/sessions",
      { problem_id: problem.id, intent: "review" },
      reviewer,
      201,
    );
    const statementReview = {
      statement_version: problem.current_statement_version,
      verdict: "statement-clear",
      basis: "Scoped input, observation and rejection criterion can be independently checked.",
    };
    const selfReview = await call(
      `${problemPath}/statement-review`,
      {
        ...statementReview,
        session_id: authorSession.session_id,
      },
      author,
      422,
    );
    assert.equal(selfReview.code, "REVIEWER_IS_AUTHOR");
    const cleared = await call(
      `${problemPath}/statement-review`,
      {
        ...statementReview,
        session_id: reviewSession.session_id,
      },
      reviewer,
      200,
    );
    assert.equal(cleared.status, "active");
    const current = (await call(problemPath)).problem;
    assert.equal(current.statement, proposal.statement);
    assert.equal(current.falsifier, proposal.falsifier);

    if (role === "calibration") {
      const workshopMarker = "private local draft of the commuting example";
      const authorPath = `/v1/sessions/${authorSession.session_id}`;
      const reviewerPath = `/v1/sessions/${reviewSession.session_id}`;
      const draft = await call(
        `${authorPath}/workshop`,
        {
          type: "claim-draft",
          title: "Cross-marking equality test",
          body_md: workshopMarker,
          relates_to: [],
        },
        author,
        201,
      );
      const anonymousFace = await call(`${publicPath}.json`);
      assert.ok(!JSON.stringify(anonymousFace).includes(workshopMarker));
      const claim = await call(
        `${authorPath}/promote`,
        {
          workshop_id: draft.workshop_id,
          kind: "conjecture",
          statement:
            "With the specified markings, the answer to ab = ba can be reused across both groups.",
          falsifier: "Evaluate ab and ba in both groups and exhibit one different Boolean answer.",
        },
        author,
        201,
      );
      const reviewQuery = new URLSearchParams({ profile: "review", target: `${claim.claim_id}@1` });
      const reviewPack = await call(`${reviewerPath}/pack?${reviewQuery}`, undefined, reviewer);
      assert.ok(!JSON.stringify(reviewPack).includes(workshopMarker));
      const afterClaim = (await call(problemPath)).problem;
      const refutation = await call(
        `${reviewerPath}/review`,
        {
          target_claim_id: claim.claim_id,
          target_version: 1,
          verdict: "refute",
          basis: "Direct composition gives distinct 3-cycles in S3. Both sums give 3 modulo 6.",
          body_md:
            "The positive words ab and ba have equal values in the additive marking but not the permutation marking.",
          client_context_cursor: afterClaim.public_seq,
        },
        reviewer,
        201,
      );
      const reviewFace = ClaimFaceResponseSchema.parse(
        await call(`${publicPath}/reviews/${refutation.review_id}.json`),
      );
      assert.equal(reviewFace.claim_state.claim_id, claim.claim_id);
      assert.equal(reviewFace.claim_state.version, 1);
      assert.deepEqual(
        reviewFace.items.filter((item) => item.kind === "claim-review").map((item) => item.id),
        [refutation.review_id],
      );
    }

    const face = ProblemFaceResponseSchema.parse(await call(`${publicPath}.json`));
    assert.equal(face.problem_status, "active");
    const markdown = await worker.fetch(`${origin}${publicPath}.md`, {
      headers: { "User-Agent": userAgent },
    });
    assert.equal(markdown.status, 200);
    assert.ok((await markdown.text()).includes(proposal.title));

    await call(`/v1/sessions/${authorSession.session_id}/close`, closingHandback, author, 201);
    await call(`/v1/sessions/${reviewSession.session_id}/close`, closingHandback, reviewer, 201);
    console.log(JSON.stringify({ stage: "research-intake", id, role, status: "pass" }));
  }

  console.log(
    JSON.stringify({
      stage: "research-intake-summary",
      drafts: intake.drafts.length,
      calibration_evaluations: calibrationChecks,
      environment: "local-workerd-d1-r2",
      status: "pass",
    }),
  );
});
