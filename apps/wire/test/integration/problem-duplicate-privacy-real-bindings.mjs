import assert from "node:assert/strict";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// P11 duplicate-problem screening must not confirm private text (real local
// Workerd/D1). A sponsor revises a private draft before publishing it; the
// earlier wording stays in problem_statement_versions but was never public.
// Another sponsor proposing that earlier wording must not be told it
// matches, while the published wording still refuses as POSSIBLE_DUPLICATE.

const problemBody = (title, statement) => ({
  title,
  statement,
  falsifier: "An explicit counterexample in the stated range.",
  motivation: "Exercise duplicate screening privacy.",
  areas: ["number-theory"],
});

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall }) => {
  const SPONSOR_A = "usr_dup_privacy_a";
  const SPONSOR_B = "usr_dup_privacy_b";
  const fellowA = await enroll("dup-privacy-a", SPONSOR_A);
  const fellowB = await enroll("dup-privacy-b", SPONSOR_B);
  const DRAFT_WORDING = "Every prime above three is one more or one less than a multiple of six.";
  const PUBLISHED_WORDING = "Each prime greater than three is congruent to 1 or 5 modulo 6.";

  const problem = (
    await call("/v1/problems", problemBody("Primes mod six", DRAFT_WORDING), fellowA, 201)
  ).problem.id;
  await sponsorCall(
    SPONSOR_A,
    "POST",
    `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle",
    {
      action: "revise-statement",
      statement: PUBLISHED_WORDING,
      falsifier: "A prime above three congruent to 3 modulo 6.",
      motivation: "Sharper modular wording before publication.",
    },
  );
  await sponsorCall(
    SPONSOR_A,
    "POST",
    `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle",
    {
      action: "publish",
    },
  );

  // The never-published draft wording is not a public statement: no match.
  const fresh = await call(
    "/v1/problems",
    problemBody("Primes around multiples of six", DRAFT_WORDING),
    fellowB,
    201,
  );
  assert.notEqual(fresh.problem.id, problem);

  // The published wording is: the duplicate refusal names the public problem.
  const refusal = await call(
    "/v1/problems",
    problemBody("Primes mod six again", PUBLISHED_WORDING),
    fellowB,
    409,
  );
  assert.equal(refusal.code, "POSSIBLE_DUPLICATE");
  assert.equal(refusal.existing_problem_id, problem);

  // A sponsor's own private draft still counts for that sponsor.
  const own = await call(
    "/v1/problems",
    problemBody("Own draft again", DRAFT_WORDING),
    fellowB,
    409,
  );
  assert.equal(own.existing_problem_id, fresh.problem.id);

  console.log(
    JSON.stringify({
      kind: "problem-duplicate-privacy-real-bindings",
      status: "pass",
      boundary: "local Workerd/D1; signed sponsor lifecycle; no deploy claim",
    }),
  );
});
