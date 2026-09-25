import assert from "node:assert/strict";
import { ReviewResponseSchema } from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Novelty review (Fable §6.6(c), ADR-21; bead asimposiumorg-ncnw) on real
// Workerd HTTP, D1 and R2 with signed sponsor publication. The shared harness
// supplies a synthetic screening decision; no live model or deployment claim.
await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, worker, origin, userAgent }) => {
  const author = await enroll("novelty-author", "usr_novelty_author");
  const first = await enroll("novelty-reviewer-one", "usr_novelty_reviewer_one");
  const second = await enroll("novelty-reviewer-two", "usr_novelty_reviewer_two");
  const third = await enroll("novelty-reviewer-three", "usr_novelty_reviewer_three");
  const created = await call(
    "/v1/problems",
    {
      title: "Novelty of a bounded packing statement",
      statement: "The stated finite packing bound holds on the declared class.",
      falsifier: "A member of the declared class that exceeds the stated bound.",
      motivation: "Exercise novelty review separately from correctness review.",
      areas: ["combinatorics"],
    },
    author,
    201,
  );
  const problem = created.problem.id;
  await sponsorCall(
    "usr_novelty_author",
    "POST",
    `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle",
    {
      action: "publish",
    },
  );
  const session = async (token, intent) =>
    (await call("/v1/sessions", { problem_id: problem, intent }, token, 201)).session_id;
  const firstSession = await session(first, "review");
  await call(
    `/v1/problems/${problem}/statement-review`,
    {
      session_id: firstSession,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "The class and the bound are exact and a counterexample is checkable.",
    },
    first,
  );
  const authorSession = await session(author, "prove");
  const promote = async (kind, statement) => {
    const draft = await call(
      `/v1/sessions/${authorSession}/workshop`,
      { type: "claim-draft", title: "Draft", body_md: "Private draft." },
      author,
      201,
    );
    return call(
      `/v1/sessions/${authorSession}/promote`,
      {
        workshop_id: draft.workshop_id,
        kind,
        statement,
        falsifier: "A published statement of the same bound on the same class.",
      },
      author,
      201,
    );
  };
  const novelty = await promote(
    "novelty-claim",
    "No published work states this packing bound for this class before 2026.",
  );
  const lemma = await promote("lemma", "The declared class is closed under the stated reflection.");

  const searchBlock = (verdict) => ({
    verdict,
    searches: [
      {
        source: "arXiv full-text search",
        searched_on: "2026-09-24",
        terms: ["packing bound declared class", "reflection-closed packing"],
      },
    ],
    nearest_prior_art: [
      { locator: "https://arxiv.org/abs/0000.00000", relation: "a weaker bound on a larger class" },
    ],
    semantic_difference:
      "The claimed bound is sharper on this class and is not implied by the nearest result.",
  });
  const review = (target, overrides) => ({
    target_claim_id: target,
    target_version: 1,
    verdict: "inform",
    basis: "Searched two indexes for the bound and its standard names.",
    capable_of_failure:
      "Any earlier statement of this bound on this class would make it a rediscovery.",
    body_md: "Search log and comparison with the nearest result.",
    ...overrides,
  });
  const reviewPath = (sessionId) => `/v1/sessions/${sessionId}/review`;

  // The three novelty refusals teach through the real route.
  const missing = await call(reviewPath(firstSession), review(novelty.claim_id, {}), first, 422);
  assert.equal(missing.code, "NOVELTY_REVIEW_REQUIRED");
  assert.ok(missing.example?.novelty, "the refusal shows a novelty example");
  const proofVerdict = await call(
    reviewPath(firstSession),
    review(novelty.claim_id, { verdict: "confirm", novelty: searchBlock("new") }),
    first,
    422,
  );
  assert.equal(proofVerdict.code, "NOVELTY_REVIEW_VERDICT_NOT_INFORM");
  const wrongKind = await call(
    reviewPath(firstSession),
    review(lemma.claim_id, { verdict: "confirm", novelty: searchBlock("new") }),
    first,
    422,
  );
  assert.equal(wrongKind.code, "NOVELTY_REVIEW_NOT_APPLICABLE");
  const noSearch = await call(
    reviewPath(firstSession),
    review(novelty.claim_id, { novelty: { ...searchBlock("new"), searches: [] } }),
    first,
    422,
  );
  assert.equal(noSearch.code, "REVIEW_BODY_INVALID", "a novelty verdict needs a search record");
  // It is taught the novelty contract: the failing field and an accepted example.
  assert.match(noSearch.detail, /novelty\.searches/);
  assert.match(noSearch.fix_hint, /searches/);
  assert.equal(noSearch.example?.verdict, "inform");
  assert.ok(noSearch.example?.novelty?.searches?.length >= 1);

  const face = async () =>
    call(`/p/${problem}/claims/${novelty.claim_id}.json`, undefined, undefined, 200);
  const standing = async () => (await face()).claim_state;
  const initial = await standing();
  assert.equal(initial.novelty, "unreviewed");
  const lemmaFace = await call(`/p/${problem}/claims/${lemma.claim_id}.json`);
  assert.equal("novelty" in lemmaFace.claim_state, false, "only novelty-claims carry novelty");

  // An independent weighted `new` verdict: standing becomes new, correctness unmoved.
  const accepted = ReviewResponseSchema.parse(
    await call(
      reviewPath(firstSession),
      review(novelty.claim_id, { novelty: searchBlock("new") }),
      first,
      201,
    ),
  );
  assert.equal(accepted.novelty_verdict, "new");
  const afterNew = await standing();
  assert.equal(afterNew.novelty, "new");
  assert.equal(
    afterNew.disposition,
    initial.disposition,
    "a novelty review moves no correctness standing",
  );
  const reviewItem = (await face()).items.find((item) => item.kind === "claim-review");
  assert.equal(JSON.parse(reviewItem.body).novelty.verdict, "new", "the search record is public");

  // Assertion-only (no capable_of_failure) rediscovery carries no weight.
  const thirdSession = await session(third, "review");
  const assertionOnly = review(novelty.claim_id, { novelty: searchBlock("rediscovery") });
  delete assertionOnly.capable_of_failure;
  await call(reviewPath(thirdSession), assertionOnly, third, 201);
  assert.equal((await standing()).novelty, "new", "an assertion-only review cannot move novelty");

  // A weighted rediscovery verdict contests it.
  const secondSession = await session(second, "review");
  await call(
    reviewPath(secondSession),
    review(novelty.claim_id, { novelty: searchBlock("rediscovery") }),
    second,
    201,
  );
  assert.equal((await standing()).novelty, "contested");
  // Diptych: the Markdown face carries the same computed standing.
  const markdown = await (
    await worker.fetch(`${origin}/p/${problem}/claims/${novelty.claim_id}.md`, {
      headers: { "User-Agent": userAgent },
    })
  ).text();
  assert.ok(markdown.includes('"novelty": "contested"'), "Markdown face shows novelty standing");

  // The author cannot review their own novelty claim.
  const self = await call(
    reviewPath(authorSession),
    review(novelty.claim_id, { novelty: searchBlock("new") }),
    author,
    422,
  );
  assert.equal(self.code, "REVIEWER_IS_AUTHOR");

  console.log(
    JSON.stringify({
      stage: "novelty-journey-passed",
      kind: "novelty-real-bindings",
      status: "pass",
      refusals: [
        "NOVELTY_REVIEW_REQUIRED",
        "NOVELTY_REVIEW_VERDICT_NOT_INFORM",
        "NOVELTY_REVIEW_NOT_APPLICABLE",
        "REVIEW_BODY_INVALID",
      ],
      standing_path: ["unreviewed", "new", "new", "contested"],
      boundary: "local Workerd/D1/R2; fixture screening; no live-model or deployment claim",
    }),
  );
});
