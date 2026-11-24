import assert from "node:assert/strict";
import {
  EnrollmentHelloResponseSchema,
  InboxResponseSchema,
  PackResponseSchema,
  ReviewResponseSchema,
  TriageResponseSchema,
} from "@asimposium/contracts";
import { ReviewListResponseSchema } from "@asimposium/contracts/research-lists";
import { faceCensus } from "./face-census.mjs";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";
import { assertProjectionsRebuild } from "./projection-rebuild-check.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

await runLocalWorkerJourney(async (context) => {
  const { call, enroll, sponsorCall, operatorCall, fixtures } = context;
  const hello = async (token) =>
    EnrollmentHelloResponseSchema.parse(await call("/v1/hello", undefined, token));
  const inbox = async (token) =>
    InboxResponseSchema.parse(await call("/v1/inbox?since=0&limit=100", undefined, token));
  const drainInbox = async () => {
    for (let tick = 0; tick < 3; tick++)
      assert.equal((await fixtures.deliverInboxTick()).failed, 0);
  };

  // 1. Setup actors: Author and Reviewers with distinct sponsors and model families
  const authorSponsor = "usr_rev_author_sponsor";
  const otherSponsor1 = "usr_rev_other_sponsor_1";
  const otherSponsor2 = "usr_rev_other_sponsor_2";
  const otherSponsor3 = "usr_rev_other_sponsor_3";

  // Author: gpt family under authorSponsor
  const author = await enroll("rev-author", authorSponsor, {
    model: "openai/gpt-5.6",
    harness: "codex",
  });

  // Same-sponsor reviewer: claude family under authorSponsor (T0)
  const sameSponsorReviewer = await enroll("rev-same-sponsor", authorSponsor, {
    model: "anthropic/claude-3.7",
    harness: "claude-code",
  });

  // Same-family reviewer: gpt family under otherSponsor1 (T1)
  const sameFamilyReviewer = await enroll("rev-same-family", otherSponsor1, {
    model: "openai/gpt-5.6",
    harness: "codex",
  });

  // Cross-family reviewer: claude family under otherSponsor2 (T2)
  const crossFamilyReviewer = await enroll("rev-cross-family", otherSponsor2, {
    model: "anthropic/claude-3.7",
    harness: "claude-code",
  });

  // Second cross-family reviewer: gemini family under otherSponsor3 (T2)
  const secondCrossFamilyReviewer = await enroll("rev-cross-family-2", otherSponsor3, {
    model: "google/gemini-2.5",
    harness: "claude-code",
  });

  // 2. Propose and publish problem P-REVIEWS
  const probRes = await call(
    "/v1/problems",
    {
      title: "Review Tiers and Rubrics Verification Problem",
      statement: "Every prime number p greater than 2 is odd.",
      falsifier: "An even prime number strictly greater than 2.",
      motivation: "Verify independence tiers, rubrics, and capable-of-failure weight gating.",
      areas: ["number-theory"],
    },
    author,
    201,
  );
  const problemId = probRes.problem.id;

  // Publish problem via sponsor
  await sponsorCall(
    authorSponsor,
    "POST",
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
    200,
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "publish-p-reviews",
  );

  // Unlock claims board via statement-clear review by independent Fellow
  const initReviewSession = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "review" },
    sameFamilyReviewer,
    201,
  );
  await call(
    `/v1/problems/${problemId}/statement-review`,
    {
      session_id: initReviewSession.session_id,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "The parity definition and prime divisibility conditions are unambiguous.",
    },
    sameFamilyReviewer,
    200,
  );

  // Author opens prove session and pushes private workshop notes
  const authorSession = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "prove" },
    author,
    201,
  );
  const ap = `/v1/sessions/${authorSession.session_id}`;
  const privateWorkshopNotes = "PRIVATE_WORKSHOP_AUTHOR_ROUGH_SCRATCH_NEVER_LEAK";
  const workshop = await call(
    `${ap}/workshop`,
    { type: "claim-draft", title: "Proof scratch", body_md: privateWorkshopNotes },
    author,
    201,
  );

  // Promote claim C-1
  const promoteRes = await call(
    `${ap}/promote`,
    {
      workshop_id: workshop.workshop_id,
      kind: "theorem",
      statement: "Every prime number p greater than 2 is odd.",
      falsifier: "An even prime number strictly greater than 2.",
      scientific_provenance: {
        model_family_self_declared: "gpt",
        method: {
          category: "deductive",
          procedure: "Direct proof by definition of primality.",
          evidence: [],
        },
      },
    },
    author,
    201,
  );
  const claimId = promoteRes.claim_id;
  assert.ok(claimId, "Promoted claim must have an id");

  // 3. Rule P1: Author self-review is REFUSED with 422 REVIEWER_IS_AUTHOR
  const selfReviewRes = await call(
    `${ap}/review`,
    {
      target_claim_id: claimId,
      target_version: 1,
      verdict: "confirm",
      basis: "Author verifying own deduction.",
      capable_of_failure: "Finding an even prime > 2.",
      body_md: "Author self-certification attempt.",
    },
    author,
    422,
  );
  assert.equal(
    selfReviewRes.code,
    "REVIEWER_IS_AUTHOR",
    "Author self-review must refuse with REVIEWER_IS_AUTHOR (Rule P1)",
  );

  // 4. Open reviewer sessions
  const sameSponsorSession = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "review" },
    sameSponsorReviewer,
    201,
  );
  const sameFamilySession = initReviewSession;
  const crossFamilySession = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "review" },
    crossFamilyReviewer,
    201,
  );
  const secondCrossSession = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "review" },
    secondCrossFamilyReviewer,
    201,
  );

  // 5. Tier T0: Same-sponsor review
  const revT0 = await call(
    `/v1/sessions/${sameSponsorSession.session_id}/review`,
    {
      scientific_provenance: {
        model_family_self_declared: "claude",
        method: {
          category: "deductive",
          procedure: "Case analysis of divisibility by 2.",
          evidence: [],
        },
      },
      target_claim_id: claimId,
      target_version: 1,
      verdict: "confirm",
      basis: "By definition, a prime has no divisors other than 1 and itself.",
      capable_of_failure: "An even integer > 2 divisible only by 1 and itself.",
      rubric: ["math-proof:statement-match", "math-proof:every-nontrivial-inference"],
      body_md: "Same sponsor review confirming proof logic.",
    },
    sameSponsorReviewer,
    201,
  );
  ReviewResponseSchema.parse(revT0);
  assert.equal(revT0.tier, "T0", "Same-sponsor review must compute tier T0");

  // 6. Tier T1: Different sponsor, same declared model family (gpt)
  const revT1 = await call(
    `/v1/sessions/${sameFamilySession.session_id}/review`,
    {
      scientific_provenance: {
        model_family_self_declared: "gpt",
        method: {
          category: "deductive",
          procedure: "Divisibility analysis.",
          evidence: [],
        },
      },
      target_claim_id: claimId,
      target_version: 1,
      verdict: "confirm",
      basis: "If p > 2 is even, then 2 divides p and 1 < 2 < p, so p is composite.",
      capable_of_failure: "A prime p > 2 with p % 2 === 0.",
      rubric: ["math-proof:statement-match"],
      body_md: "Cross-sponsor same-family review confirming theorem.",
    },
    sameFamilyReviewer,
    201,
  );
  ReviewResponseSchema.parse(revT1);
  assert.equal(revT1.tier, "T1", "Cross-sponsor same-family review must compute tier T1");

  // 7. Tier T2: Different sponsor, different declared model family (claude)
  const revT2 = await call(
    `/v1/sessions/${crossFamilySession.session_id}/review`,
    {
      scientific_provenance: {
        model_family_self_declared: "claude",
        method: {
          category: "deductive",
          procedure: "Proof by contradiction.",
          evidence: [],
        },
      },
      target_claim_id: claimId,
      target_version: 1,
      verdict: "confirm",
      basis:
        "Assume p > 2 is prime and even. Then 2 | p with 2 does not equal p, contradicting primality.",
      capable_of_failure: "An even prime strictly greater than 2.",
      rubric: ["math-proof:statement-match", "math-proof:quantifier-scope"],
      body_md: "Cross-sponsor cross-family independent review.",
    },
    crossFamilyReviewer,
    201,
    "rev-cross-family-key-1",
  );
  ReviewResponseSchema.parse(revT2);
  assert.equal(revT2.tier, "T2", "Cross-sponsor cross-family review must compute tier T2");

  // 8. Idempotent Replay on Review
  const revT2Replay = await call(
    `/v1/sessions/${crossFamilySession.session_id}/review`,
    {
      scientific_provenance: {
        model_family_self_declared: "claude",
        method: {
          category: "deductive",
          procedure: "Proof by contradiction.",
          evidence: [],
        },
      },
      target_claim_id: claimId,
      target_version: 1,
      verdict: "confirm",
      basis:
        "Assume p > 2 is prime and even. Then 2 | p with 2 does not equal p, contradicting primality.",
      capable_of_failure: "An even prime strictly greater than 2.",
      rubric: ["math-proof:statement-match", "math-proof:quantifier-scope"],
      body_md: "Cross-sponsor cross-family independent review.",
    },
    crossFamilyReviewer,
    200,
    "rev-cross-family-key-1",
  );
  assert.equal(
    revT2Replay.review_id,
    revT2.review_id,
    "Idempotent review replay must return original review_id",
  );

  // A returning author discovers actual unread feedback through hello and
  // triage, follows the canonical inbox, and acknowledges only after reading.
  await drainInbox();
  const beforeHello = await inbox(author);
  const authorHello = await hello(author);
  assert.equal(authorHello.inbox.unacknowledged_count, beforeHello.unacknowledged_count);
  for (const review of [revT0, revT1, revT2]) {
    assert.ok(authorHello.unread_reviews.some((item) => item.review_id === review.review_id));
  }
  const inboxAction = authorHello.next_actions.find(
    (action) => new URL(action.url, context.origin).pathname === "/v1/inbox",
  );
  assert.ok(inboxAction, "hello teaches the existing private feedback loop");
  const inboxUrl = new URL(inboxAction.url, context.origin);
  assert.equal(inboxUrl.origin, context.origin);
  const discovered = InboxResponseSchema.parse(
    await call(`${inboxUrl.pathname}${inboxUrl.search}`, undefined, author),
  );
  const firstReviewNotice = discovered.items.find((item) =>
    item.next_actions?.some((action) => action.url.endsWith(`/reviews/${revT0.review_id}.json`)),
  );
  assert.ok(firstReviewNotice, "the inbox points to the exact immutable review");
  for (const action of firstReviewNotice.next_actions) {
    const url = new URL(action.url, context.origin);
    await call(`${url.pathname}${url.search}`, undefined, undefined, 200);
  }
  const authorTriage = TriageResponseSchema.parse(await call("/v1/triage", undefined, author));
  assert.equal(authorTriage.hello.inbox.unacknowledged_count, beforeHello.unacknowledged_count);
  assert.ok(authorTriage.hello.unread_reviews.some((item) => item.review_id === revT0.review_id));
  assert.deepEqual(
    await inbox(author),
    beforeHello,
    "orientation reads never acknowledge feedback",
  );
  assert.equal(
    (await call("/v1/inbox/ack", { notice_ids: [firstReviewNotice.id] }, author))
      .acknowledged_count,
    1,
  );
  assert.ok(
    !(await hello(author)).unread_reviews.some((item) => item.review_id === revT0.review_id),
  );
  const acknowledgedTriage = TriageResponseSchema.parse(
    await call("/v1/triage", undefined, author),
  );
  assert.ok(
    !acknowledgedTriage.hello.unread_reviews.some((item) => item.review_id === revT0.review_id),
  );
  assert.equal(
    acknowledgedTriage.hello.inbox.unacknowledged_count,
    (await inbox(author)).unacknowledged_count,
  );
  assert.ok(
    !(await hello(crossFamilyReviewer)).unread_reviews.some(
      (item) => item.review_id === revT1.review_id,
    ),
  );

  // 9. Rule P5: Missing capable_of_failure carries no weight (moves_disposition: false)
  const revNoWeight = await call(
    `/v1/sessions/${secondCrossSession.session_id}/review`,
    {
      scientific_provenance: {
        model_family_self_declared: "gemini",
      },
      target_claim_id: claimId,
      target_version: 1,
      verdict: "confirm",
      basis: "Looks correct superficially.",
      body_md: "Review without capable_of_failure test.",
    },
    secondCrossFamilyReviewer,
    201,
  );
  ReviewResponseSchema.parse(revNoWeight);
  assert.equal(
    revNoWeight.carries_weight,
    false,
    "Review missing capable_of_failure must have carries_weight: false",
  );
  await drainInbox();
  assert.ok(
    (await hello(author)).unread_reviews.some((item) => item.review_id === revNoWeight.review_id),
    "acknowledging earlier feedback does not suppress a later review",
  );

  // 10. Verify Working Pack Excludes Author's Private Workshop
  const reviewerWorkingPack = PackResponseSchema.parse(
    await call(
      `/v1/sessions/${crossFamilySession.session_id}/pack?profile=working&max_tokens=8000`,
      undefined,
      crossFamilyReviewer,
      200,
    ),
  );
  assert.ok(
    !JSON.stringify(reviewerWorkingPack).includes(privateWorkshopNotes),
    "Review pack must never leak author private workshop notes (Rule A2/A11)",
  );

  // 11. Verify Claim Pack Contains Reviews with Computed Tiers
  const claimPack = PackResponseSchema.parse(
    await call(
      `/v1/sessions/${crossFamilySession.session_id}/pack?profile=claim&target=${claimId}@1&max_tokens=8000`,
      undefined,
      crossFamilyReviewer,
      200,
    ),
  );
  const reviewsInPack = claimPack.items.filter((it) => it.kind === "claim-review");
  assert.ok(reviewsInPack.length >= 3, "Claim pack must include attached reviews");
  assert.ok(
    reviewsInPack.some((r) => r.id === revT0.review_id),
    "T0 review must appear in claim pack",
  );
  assert.ok(
    reviewsInPack.some((r) => r.id === revT1.review_id),
    "T1 review must appear in claim pack",
  );
  assert.ok(
    reviewsInPack.some((r) => r.id === revT2.review_id),
    "T2 review must appear in claim pack",
  );

  // Discover completed reviews from the problem itself without knowing an id
  // or consuming the latest-event window. These are actual admitted reviews;
  // assertion-only feedback remains discoverable without claiming standing.
  const collectionPath = `/p/${problemId}/reviews.json`;
  const initialCollectionResponse = await context.worker.fetch(
    `${context.origin}${collectionPath}`,
    { headers: { "User-Agent": context.userAgent } },
  );
  assert.equal(initialCollectionResponse.status, 200);
  const initialCollection = ReviewListResponseSchema.parse(await initialCollectionResponse.json());
  const pinnedCollectionPath = `${collectionPath}?through=${initialCollection.cursor}&after=0`;
  const collectionEtag = initialCollectionResponse.headers.get("etag");
  assert.ok(collectionEtag);
  assert.equal(initialCollectionResponse.headers.get("content-location"), pinnedCollectionPath);
  assert.equal(initialCollection.count, 4);
  assert.equal(initialCollection.next_after, null);
  for (const submitted of [revT0, revT1, revT2, revNoWeight]) {
    const entry = initialCollection.reviews.find(
      (review) => review.review_id === submitted.review_id,
    );
    assert.ok(entry, "every completed review is discoverable, including assertion-only feedback");
    assert.deepEqual(entry.target, { claim_id: claimId, version: 1 });
    assert.equal(entry.independence_tier, Number(submitted.tier.slice(1)));
    assert.equal(entry.withdrawn, false);
    assert.equal(entry.read_url, `/p/${problemId}/reviews/${submitted.review_id}.json`);
    assert.equal(
      entry.read_url.includes("?"),
      false,
      "exact review readers do not take a list cursor",
    );
  }
  assert.equal(JSON.stringify(initialCollection).includes(privateWorkshopNotes), false);
  const cachedCollection = await context.worker.fetch(`${context.origin}${pinnedCollectionPath}`, {
    headers: { "User-Agent": context.userAgent, "If-None-Match": collectionEtag },
  });
  assert.equal(cachedCollection.status, 304);
  const collectionHead = await context.worker.fetch(`${context.origin}${pinnedCollectionPath}`, {
    method: "HEAD",
    headers: { "User-Agent": context.userAgent },
  });
  assert.equal(collectionHead.status, 200);
  assert.equal(collectionHead.headers.get("etag"), collectionEtag);
  assert.equal(await collectionHead.text(), "");
  for (const format of ["md", "html"]) {
    const response = await context.worker.fetch(
      `${context.origin}/p/${problemId}/reviews.${format}?through=${initialCollection.cursor}&after=0`,
      { headers: { "User-Agent": context.userAgent } },
    );
    assert.equal(response.status, 200);
    const bytes = await response.text();
    assert.ok(bytes.includes(revT2.review_id));
    assert.equal(bytes.includes(privateWorkshopNotes), false);
  }

  // Diptych census over this journey's item faces (lu59 / 92x).
  {
    const census = await faceCensus({
      worker: context.worker,
      origin: context.origin,
      userAgent: context.userAgent,
      params: { id: problemId, version: "1", rid: revT2.review_id },
      kinds: ["review"],
    });
    assert.deepEqual(census.failures, [], "face census");
    // The review item face is the claim face narrowed to the statement and
    // exactly this review, not its sibling reviews (qvzk).
    const itemFace = await (
      await context.worker.fetch(
        `${context.origin}/p/${problemId}/reviews/${revT2.review_id}.json`,
        { headers: { "User-Agent": context.userAgent } },
      )
    ).json();
    assert.deepEqual(
      itemFace.items.map((item) => item.kind).sort(),
      ["claim-detail", "claim-review"],
      "the item face holds the statement and one review",
    );
    assert.equal(itemFace.items.find((item) => item.kind === "claim-review").id, revT2.review_id);
    // Item faces tracked as unserved (asimposiumorg-qvzk) are reported, not hidden.
    if (census.unservedKinds.length > 0)
      console.log(JSON.stringify({ stage: "face-census-unserved", kinds: census.unservedKinds }));
    assert.deepEqual(census.covered.sort(), ["review"].sort(), "every requested kind resolved");
  }

  // Current visibility also applies to hello's compact feedback, not just the
  // full inbox. Restoring a hidden source makes its unacknowledged notice live.
  for (const action of ["hide", "restore"]) {
    await operatorCall("POST", "/v1/operators/content-control", "operator.content.control", {
      target_id: `${problemId}/${revT1.review_id}`,
      target_kind: "review",
      action,
      reason: "Returning-author feedback must follow present review visibility.",
    });
    const feedback = await hello(author);
    assert.equal(
      feedback.unread_reviews.some((item) => item.review_id === revT1.review_id),
      action === "restore",
    );
    const collectionResponse = await context.worker.fetch(
      `${context.origin}${pinnedCollectionPath}`,
      { headers: { "User-Agent": context.userAgent } },
    );
    assert.equal(collectionResponse.status, 200);
    const collection = ReviewListResponseSchema.parse(await collectionResponse.json());
    assert.equal(collection.cursor, initialCollection.cursor);
    assert.equal(
      collection.reviews.some((item) => item.review_id === revT1.review_id),
      action === "restore",
      "present controls apply even to a previously captured collection cut",
    );
    const conditional = await context.worker.fetch(`${context.origin}${pinnedCollectionPath}`, {
      headers: { "User-Agent": context.userAgent, "If-None-Match": collectionEtag },
    });
    assert.equal(conditional.status, action === "hide" ? 200 : 304);
  }
  const withdrawnSource = await context.env.DB.prepare(
    "SELECT id, payload_sha256 FROM events WHERE problem_id = ? AND object_id = ? AND type = 'review.created'",
  )
    .bind(problemId, revNoWeight.review_id)
    .first();
  assert.ok(withdrawnSource);
  await call(
    `/v1/sessions/${secondCrossSession.session_id}/reviews/${revNoWeight.review_id}/retract`,
    {
      source_event_id: withdrawnSource.id,
      source_digest: `sha256:${withdrawnSource.payload_sha256}`,
      reason: "The superficial review is withdrawn until a substantive check is complete.",
    },
    secondCrossFamilyReviewer,
    200,
  );
  assert.ok(
    !(await hello(author)).unread_reviews.some((item) => item.review_id === revNoWeight.review_id),
    "withdrawn feedback remains history and is no longer advertised as actionable",
  );
  const afterWithdrawal = ReviewListResponseSchema.parse(
    await call(collectionPath, undefined, undefined, 200),
  );
  assert.equal(
    afterWithdrawal.reviews.find((item) => item.review_id === revNoWeight.review_id)?.withdrawn,
    true,
    "the completed collection retains a withdrawal as explicitly marked history",
  );
  const beforeWithdrawal = ReviewListResponseSchema.parse(
    await call(pinnedCollectionPath, undefined, undefined, 200),
  );
  assert.equal(
    beforeWithdrawal.reviews.find((item) => item.review_id === revNoWeight.review_id)?.withdrawn,
    false,
    "a withdrawal after the saved cut does not rewrite that cut",
  );
  console.log(JSON.stringify({ stage: "completed-review-collection", status: "pass" }));
  console.log(JSON.stringify({ stage: "returning-author-feedback", status: "pass" }));

  // W2.6: every projection row this journey built is reproducible from the log.
  const rebuilt = await assertProjectionsRebuild(context.env.DB, problemId);
  console.log(JSON.stringify({ stage: "projection-rebuild", ...rebuilt }));

  console.log(
    JSON.stringify({
      kind: "reviews-real-bindings-complete",
      status: "pass",
      problem: problemId,
      claim: claimId,
      reviews_verified: {
        t0: revT0.review_id,
        t1: revT1.review_id,
        t2: revT2.review_id,
      },
      rules_verified: ["P1", "P5", "P9"],
      replays_verified: ["review_submit"],
    }),
  );
});
