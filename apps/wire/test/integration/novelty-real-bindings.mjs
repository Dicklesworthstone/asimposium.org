import assert from "node:assert/strict";
import { ReviewResponseSchema } from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Novelty review (Fable §6.6(c), ADR-21; bead asimposiumorg-ncnw) on real
// Workerd HTTP, D1 and R2 with signed sponsor publication. The shared harness
// supplies a synthetic screening decision; no live model or deployment claim.
await runLocalWorkerJourney(async (context) => {
  const { call, enroll, sponsorCall, worker, origin, userAgent, env } = context;
  const author = await enroll("novelty-author", "usr_novelty_author");
  const first = await enroll("novelty-reviewer-one", "usr_novelty_reviewer_one");
  const second = await enroll("novelty-reviewer-two", "usr_novelty_reviewer_two");
  const third = await enroll("novelty-reviewer-three", "usr_novelty_reviewer_three");
  const sibling = await enroll("novelty-sibling", "usr_novelty_author");
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
      {
        locator: "https://arxiv.org/abs/0000.00000",
        relation: "a weaker bound on a larger class",
      },
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
  // The author's own sponsor cannot make a claim "new": a same-sponsor (T0)
  // novelty review, even with a search record, carries no novelty weight.
  const siblingSession = await session(sibling, "review");
  await call(
    reviewPath(siblingSession),
    review(novelty.claim_id, { novelty: searchBlock("new") }),
    sibling,
    201,
  );
  assert.equal((await standing()).novelty, "unreviewed", "a T0 review does not set novelty");
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

  const withdraw = async (record, sessionId, token) => {
    const source = await env.DB.prepare(
      "SELECT e.id, e.payload_sha256 FROM events e WHERE e.problem_id = ? AND e.object_id = ? AND e.type = 'review.created'",
    )
      .bind(problem, record.review_id)
      .first();
    assert.ok(source, "the review has an immutable publication");
    return call(
      `/v1/sessions/${sessionId}/reviews/${record.review_id}/retract`,
      {
        source_event_id: source.id,
        source_digest: `sha256:${source.payload_sha256}`,
        reason: "The recorded search no longer supports my original assessment.",
      },
      token,
      200,
    );
  };
  // A scientific withdrawal leaves the original review readable as history,
  // but it must remove that review's positive novelty authority.
  const beforeWithdrawal = (await face()).cursor;
  await withdraw(accepted, firstSession, first);
  assert.equal((await standing()).novelty, "unreviewed", "withdrawn support cannot establish new");
  const historical = await call(
    `/p/${problem}/claims/${novelty.claim_id}.json?through=${beforeWithdrawal}`,
  );
  assert.equal(historical.claim_state.novelty, "new", "an earlier cursor excludes the withdrawal");
  const withdrawnFace = await face();
  assert.ok(
    withdrawnFace.items.some((item) => item.id === accepted.review_id),
    "the withdrawn review remains readable history",
  );
  await call(
    reviewPath(firstSession),
    review(novelty.claim_id, { novelty: searchBlock("new") }),
    first,
    201,
  );
  assert.equal((await standing()).novelty, "new");

  // Assertion-only (no capable_of_failure) rediscovery carries no weight.
  const thirdSession = await session(third, "review");
  const assertionOnly = review(novelty.claim_id, { novelty: searchBlock("rediscovery") });
  delete assertionOnly.capable_of_failure;
  await call(reviewPath(thirdSession), assertionOnly, third, 201);
  assert.equal((await standing()).novelty, "new", "an assertion-only review cannot move novelty");

  // Fill the visible review page with weightless reports. Scientific standing
  // must still include the next independent review beyond this display bound.
  for (let index = 0; index < 16; index++) {
    await call(
      reviewPath(thirdSession),
      {
        ...assertionOnly,
        body_md: `Additional search record ${index + 1}; no capable-of-failure check.`,
      },
      third,
      201,
    );
  }
  assert.equal((await standing()).novelty, "new");

  // The weighted twenty-first review contests it even though it is omitted
  // from the bounded page of readable reviews.
  const secondSession = await session(second, "review");
  const adverse = await call(
    reviewPath(secondSession),
    review(novelty.claim_id, { novelty: searchBlock("rediscovery") }),
    second,
    201,
  );
  assert.equal((await standing()).novelty, "contested");
  const boundedFace = await face();
  assert.equal(
    boundedFace.items.some((item) => item.id === adverse.review_id),
    false,
  );
  assert.ok(boundedFace.omitted.some((item) => item.reason === "candidate_limit"));
  await withdraw(adverse, secondSession, second);
  assert.equal(
    (await standing()).novelty,
    "contested",
    "withdrawal cannot erase an adverse finding",
  );
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
      standing_path: ["unreviewed", "new", "unreviewed", "new", "contested", "contested"],
      authority_checks: [
        "withdrawn-positive",
        "historical-cursor",
        "twenty-first-review",
        "withdrawn-adverse",
      ],
      boundary: "local Workerd/D1/R2; fixture screening; no live-model or deployment claim",
    }),
  );
});
