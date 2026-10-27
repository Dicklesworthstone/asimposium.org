import assert from "node:assert/strict";
import {
  ClaimFaceResponseSchema,
  PackResponseSchema,
  ProblemGovernanceEventSchema,
  ProblemResolutionResponseSchema,
} from "@asimposium/contracts";
import { opsRecords, runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";
import { assertProjectionsRebuild } from "./projection-rebuild-check.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

await runLocalWorkerJourney(async (context) => {
  const { call, enroll, sponsorCall, worker, origin, userAgent } = context;

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`Failed to parse JSON: ${e}`);
    }
  }

  const sponsorA = "usr_disp_sponsor_a";
  const authorA = await enroll("disp-author-a", sponsorA, {
    model: "openai/gpt-5.6",
    harness: "codex",
  });

  const sponsorB = "usr_disp_sponsor_b";
  const reviewerB = await enroll("disp-reviewer-b", sponsorB, {
    model: "anthropic/claude-3.7",
    harness: "claude-code",
  });

  const sponsorC = "usr_disp_sponsor_c";
  const reviewerC = await enroll("disp-reviewer-c", sponsorC, {
    model: "google/gemini-2.5",
    harness: "claude-code",
  });

  // 1. Propose and publish problem P-DISP
  const created = await call(
    "/v1/problems",
    {
      title: "Disposition state machine verification problem",
      statement: "For all natural numbers n, n + 0 = n and arithmetic operations are well-defined.",
      falsifier: "A natural number n such that n + 0 !== n.",
      motivation:
        "Verification of honest computed scientific standing across all lifecycle states.",
      areas: ["number-theory", "logic-and-foundations"],
    },
    authorA,
    201,
  );
  const problemId = created.problem.id;

  const govern = (body, key, expected = 200) =>
    sponsorCall(
      sponsorA,
      "POST",
      `/v1/sponsors/problems/${problemId}/lifecycle`,
      "problem-lifecycle",
      body,
      expected,
      `/v1/sponsors/problems/${problemId}/lifecycle`,
      key,
    );
  await govern({ action: "publish" }, "publish-disp-problem");

  // Statement-clear review unlocks sharpening -> active
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
      basis: "The problem statement is clear, well-quantified, and mathematically sound.",
    },
    reviewerB,
    200,
  );
  await call(
    `/v1/sessions/${reviewSession.session_id}/close`,
    {
      handback: "Sharpening unlocked.",
      promote: [],
      keep: [],
      discard: [],
    },
    reviewerB,
    201,
  );

  // Open author session
  const authorSession = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "prove" },
    authorA,
    201,
  );
  const authorSessionPath = `/v1/sessions/${authorSession.session_id}`;

  // Open reviewer sessions
  const reviewerSessionB = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "review" },
    reviewerB,
    201,
  );
  const reviewerSessionPathB = `/v1/sessions/${reviewerSessionB.session_id}`;

  const reviewerSessionC = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "review" },
    reviewerC,
    201,
  );
  const reviewerSessionPathC = `/v1/sessions/${reviewerSessionC.session_id}`;

  // Helper to assert standing across pack and public .json/.md/.html faces
  // Fable §6.6: the review-state facet is computed from recorded public
  // reviews of the exact version and moves independently of the disposition.
  async function assertStanding(claimId, expected, expectedReviewState) {
    // Pack check
    const query = new URLSearchParams({ profile: "working", max_tokens: "8000" });
    const packRes = PackResponseSchema.parse(
      await call(`${reviewerSessionPathB}/pack?${query}`, undefined, reviewerB),
    );
    const item = packRes.items.find((val) => val.kind === "claim" && val.id === claimId);
    assert.ok(item, `Claim ${claimId} should be present in working pack`);
    // The facet follows the disposition directly (Fable §6.6), so an
    // expected "open" cannot match an actual "open · unchallenged".
    assert.ok(
      item.body.includes(`, ${expected} · review: ${expectedReviewState}`),
      `Expected ${claimId} standing "${expected}" with review state "${expectedReviewState}" in pack; got "${item.body.slice(0, 120)}"`,
    );

    // Public face check (.json)
    const jsonUrl = `${origin}/p/${problemId}/claims/${claimId}.json`;
    const jsonRes = await worker.fetch(jsonUrl, { headers: { "user-agent": userAgent } });
    assert.equal(jsonRes.status, 200, "Anonymous .json claim face should return 200");
    const jsonText = await jsonRes.text();
    const claimFace = ClaimFaceResponseSchema.parse(safeJsonParse(jsonText));
    const state = claimFace.claim_state;
    const computedDisplay =
      state.disposition +
      (state.unchallenged ? " · unchallenged" : "") +
      (state.stale ? " · stale" : "");
    assert.equal(
      computedDisplay,
      expected,
      `Computed public disposition display mismatch for ${claimId}`,
    );
    assert.equal(
      state.review_state,
      expectedReviewState,
      `Computed review-state facet mismatch for ${claimId}`,
    );

    // ETag revalidation check (304)
    const etag = jsonRes.headers.get("etag");
    assert.ok(etag, "Face must return ETag");
    const reval = await worker.fetch(jsonUrl, {
      headers: { "user-agent": userAgent, "if-none-match": etag },
    });
    assert.equal(reval.status, 304, "Unchanged face must 304 with If-None-Match");

    // Diptych parity: .md and .html faces match the computed disposition
    for (const suffix of ["md", "html"]) {
      const faceUrl = `${origin}/p/${problemId}/claims/${claimId}.${suffix}`;
      const faceRes = await worker.fetch(faceUrl, { headers: { "user-agent": userAgent } });
      assert.equal(faceRes.status, 200, `Anonymous .${suffix} claim face must return 200`);
      const faceBody = await faceRes.text();
      assert.ok(
        faceBody.includes(state.disposition),
        `Expected .${suffix} face to include disposition "${state.disposition}"`,
      );
      assert.ok(
        faceBody.includes(state.review_state),
        `Expected .${suffix} face to include review state "${state.review_state}"`,
      );
      assert.ok(
        faceBody.includes(claimFace.fingerprint),
        `Expected .${suffix} face to share canonical projection fingerprint`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 2. Rule P2/P4: Forbidden self-assertion of disposition
  // -------------------------------------------------------------------------
  const draftA = await call(
    `${authorSessionPath}/workshop`,
    {
      type: "claim-draft",
      title: "Forbidden self-assertion draft",
      body_md: "Draft attempting to directly set disposition.",
      relates_to: [],
    },
    authorA,
    201,
  );

  const directSetRes = await call(
    `${authorSessionPath}/promote`,
    {
      workshop_id: draftA.workshop_id,
      kind: "conjecture",
      statement: "Direct disposition setting is forbidden.",
      falsifier: "Any counterexample.",
      disposition: "strongly-supported",
    },
    authorA,
    422,
  );
  assert.equal(directSetRes.code, "SCHEMA_INVALID", "Direct disposition write must be refused");

  // -------------------------------------------------------------------------
  // 3. Claim C-1: open -> open · unchallenged -> corroborated -> strongly-supported
  // -------------------------------------------------------------------------
  const c1Draft = await call(
    `${authorSessionPath}/workshop`,
    {
      type: "claim-draft",
      title: "Additive identity in natural numbers",
      body_md: "For all n in N, n + 0 = n by definition of zero in Peano arithmetic.",
      relates_to: [],
    },
    authorA,
    201,
  );

  const c1 = await call(
    `${authorSessionPath}/promote`,
    {
      workshop_id: c1Draft.workshop_id,
      kind: "conjecture",
      statement: "For every natural number n, n + 0 = n.",
      falsifier: "A natural number n such that n + 0 !== n.",
      scientific_provenance: {
        model_family_self_declared: "gpt",
        method: {
          category: "deductive",
          procedure: "Peano axiom base case.",
          evidence: [],
        },
      },
    },
    authorA,
    201,
  );
  const c1Id = c1.claim_id;

  // Initial state is bare "open" (unchallenged is false with zero reviews)
  await assertStanding(c1Id, "open", "unreviewed");

  // Rule P1: Reviewer cannot be author (REVIEWER_IS_AUTHOR refusal)
  const selfReviewRes = await call(
    `${authorSessionPath}/review`,
    {
      target_claim_id: c1Id,
      target_version: 1,
      verdict: "confirm",
      basis: "I verified my own claim.",
      capable_of_failure: "If n + 0 !== n.",
      body_md: "Self review is forbidden by Rule P1.",
    },
    authorA,
    422,
  );
  assert.equal(selfReviewRes.code, "REVIEWER_IS_AUTHOR", "Author cannot review own claim");

  // Reviewer B submits supporting review without refutation attempt -> "open · unchallenged"
  await call(
    `${reviewerSessionPathB}/review`,
    {
      target_claim_id: c1Id,
      target_version: 1,
      verdict: "confirm",
      basis: "Verified Peano zero definition across n in {0, 1, 2, 100}.",
      capable_of_failure: "An n with n + 0 !== n.",
      scientific_provenance: {
        model_family_self_declared: "claude",
        method: {
          category: "deductive",
          procedure: "Inductive verification.",
          evidence: [],
        },
      },
      body_md: "Base step of addition is universally valid.",
    },
    reviewerB,
    201,
  );
  await assertStanding(c1Id, "open · unchallenged", "independently-checked");

  // Author publishes proof argument
  const c1Proof = await call(
    `${authorSessionPath}/evidence`,
    {
      bears_on_kind: "claim",
      bears_on_id: c1Id,
      bears_on_version: 1,
      direction: "supports",
      kind: "argument",
      mode: "confirmatory",
      source: {
        kind: "locator",
        locator: "https://example.invalid/peano/addition",
        excerpt: "n + 0 = n is axiom 4 of Peano addition.",
      },
      body_md: "By axiom 4 of Peano arithmetic, addition with 0 is the identity.",
    },
    authorA,
    201,
  );
  // Reviewer B fetches pack to get published digests
  const reviewPackRes = await call(
    `${reviewerSessionPathB}/pack?${new URLSearchParams({ profile: "review", target: `${c1Id}@1` })}`,
    undefined,
    reviewerB,
  );
  const c1Detail = safeJsonParse(reviewPackRes.items.find((it) => it.kind === "claim-detail").body);
  const proofItem = reviewPackRes.items.find((it) => it.id === c1Proof.evidence_id);
  assert.ok(proofItem, `Published proof ${c1Proof.evidence_id} must be in review pack`);
  const proofDetail = safeJsonParse(proofItem.body);
  const proofRef = {
    evidence_id: c1Proof.evidence_id,
    digest: proofDetail.content_digest,
  };

  await call(
    `${reviewerSessionPathB}/evidence`,
    {
      bears_on_kind: "claim",
      bears_on_id: c1Id,
      bears_on_version: 1,
      direction: "informs",
      kind: "computation",
      mode: "confirmatory",
      source: {
        kind: "locator",
        locator: "https://example.invalid/peano/check",
        excerpt: "Falsification attempt over 0..10000.",
      },
      computation_domain_or_floor: "Natural n in [0, 10000]",
      falsification_check: {
        target_digest: c1Detail.content_digest,
        attempted_falsifier: "A natural number n such that n + 0 !== n.",
        capable_of_failure: "Any counterexample found in range.",
        result: "survived",
        evidence: [proofRef],
      },
      body_md:
        "Computationally verified n + 0 = n for all n in 0..10000 with zero falsification hits.",
    },
    reviewerB,
    201,
  );
  await assertStanding(c1Id, "corroborated", "independently-checked");

  // Reviewer B submits full write-up verification
  const fullReviewB = await call(
    `${reviewerSessionPathB}/review`,
    {
      target_claim_id: c1Id,
      target_version: 1,
      verdict: "confirm",
      basis: "Full write-up proof inspection.",
      capable_of_failure: "Contradiction in inductive step.",
      verification: {
        kind: "full-write-up",
        target_digest: c1Detail.content_digest,
        evidence: proofRef,
        coverage: ["n=0 base case", "successor induction step"],
        result: "verified",
      },
      scientific_provenance: {
        model_family_self_declared: "claude",
        method: {
          category: "deductive",
          procedure: "Exhaustive coverage of Peano addition.",
          evidence: [proofRef],
        },
      },
      body_md: "Full verification covering base and inductive steps.",
    },
    reviewerB,
    201,
  );
  await assertStanding(c1Id, "corroborated", "independently-checked");

  // Reviewer C (cross-family: gemini) submits second full write-up review -> "strongly-supported"
  const fullReviewC = await call(
    `${reviewerSessionPathC}/review`,
    {
      target_claim_id: c1Id,
      target_version: 1,
      verdict: "confirm",
      basis: "Independent second model family write-up verification.",
      capable_of_failure: "Failure of recursive equality.",
      verification: {
        kind: "full-write-up",
        target_digest: c1Detail.content_digest,
        evidence: proofRef,
        coverage: ["n=0 base case", "successor induction step"],
        result: "verified",
      },
      scientific_provenance: {
        model_family_self_declared: "gemini",
        method: {
          category: "deductive",
          procedure: "Second family re-derivation.",
          evidence: [proofRef],
        },
      },
      body_md: "Gemini verification confirming addition identity.",
    },
    reviewerC,
    201,
  );
  // Strong scientific evidence still needs the sponsor's exact-lineage
  // disclosure before the strongest public standing is earned.
  const firstDisclosurePath = `/v1/sponsors/disclosures/${problemId}/${c1Id}/1`;
  const firstDisclosure = await sponsorCall(
    sponsorA,
    "GET",
    firstDisclosurePath,
    "sponsor.disclosure.read",
    undefined,
  );
  for (const scope of firstDisclosure.scopes) {
    assert.equal(scope.sponsor_id, sponsorA);
    await sponsorCall(
      sponsorA,
      "POST",
      firstDisclosurePath,
      "sponsor.disclosure.write",
      {
        scope_id: scope.scope_id,
        expected_lineage_digest: firstDisclosure.lineage_digest,
        expected_revision: scope.revision,
        decision: "no-undisclosed",
        disclosures: [],
      },
      200,
      firstDisclosurePath,
      `standing-disclosure-${scope.scope_id}`,
    );
  }
  await assertStanding(c1Id, "strongly-supported", "independently-checked");

  // -------------------------------------------------------------------------
  // 4. Claim C-2: malformed via statement-defect review -> exit via revision
  // -------------------------------------------------------------------------
  const c2Draft = await call(
    `${authorSessionPath}/workshop`,
    {
      type: "claim-draft",
      title: "Malformed statement draft",
      body_md: "For all objects x, x has property P.",
      relates_to: [],
    },
    authorA,
    201,
  );

  const c2 = await call(
    `${authorSessionPath}/promote`,
    {
      workshop_id: c2Draft.workshop_id,
      kind: "conjecture",
      statement: "For all mathematical objects x, x has property P.",
      falsifier: "An object without property P.",
    },
    authorA,
    201,
  );
  const c2Id = c2.claim_id;
  await assertStanding(c2Id, "open", "unreviewed");

  // Reviewer B submits review indicating statement-defect rubric -> "malformed"
  await call(
    `${reviewerSessionPathB}/review`,
    {
      target_claim_id: c2Id,
      target_version: 1,
      verdict: "refute",
      basis: "Statement fails review: property P is ill-defined and unbound.",
      capable_of_failure: "If P were well-typed in formal semantics.",
      rubric: ["statement-defect"],
      body_md: "The statement is malformed: property P is not defined in any mathematical domain.",
    },
    reviewerB,
    201,
  );
  await assertStanding(c2Id, "malformed", "contested");

  // Prove malformed exit rule: revising to version 2 resets disposition to "open" (Rule P9)
  const c2Revised = await call(
    `${authorSessionPath}/revise`,
    {
      claim_id: c2Id,
      base_version: 1,
      kind: "conjecture",
      statement: "For all non-empty sets S, S contains at least one element.",
      falsifier: "A non-empty set with zero elements.",
    },
    authorA,
    201,
  );
  assert.equal(c2Revised.version, 2);
  await assertStanding(c2Id, "open", "unreviewed");

  // -------------------------------------------------------------------------
  // 5. Claim C-3: disputed via refuting evidence
  // -------------------------------------------------------------------------
  const c3Draft = await call(
    `${authorSessionPath}/workshop`,
    {
      type: "claim-draft",
      title: "False claim draft",
      body_md: "Every even natural number is prime.",
      relates_to: [],
    },
    authorA,
    201,
  );

  const c3 = await call(
    `${authorSessionPath}/promote`,
    {
      workshop_id: c3Draft.workshop_id,
      kind: "conjecture",
      statement: "Every even natural number is prime.",
      falsifier: "An even natural number that is composite.",
    },
    authorA,
    201,
  );
  const c3Id = c3.claim_id;
  await assertStanding(c3Id, "open", "unreviewed");

  // Reviewer B submits refuting evidence (4 is even and composite) -> "disputed"
  const c3Refutation = await call(
    `${reviewerSessionPathB}/evidence`,
    {
      bears_on_kind: "claim",
      bears_on_id: c3Id,
      bears_on_version: 1,
      direction: "refutes",
      kind: "argument",
      mode: "confirmatory",
      source: {
        kind: "locator",
        locator: "https://example.invalid/counterexamples/four",
        excerpt: "4 = 2 * 2 is composite and even.",
      },
      body_md: "4 is even (4 = 2 * 2) and composite (divisible by 2), contradicting the claim.",
    },
    reviewerB,
    201,
  );
  await assertStanding(c3Id, "disputed", "unreviewed");

  // -------------------------------------------------------------------------
  // 6. Claim C-4: reduced-to via reduction relation
  // -------------------------------------------------------------------------
  const c4Draft = await call(
    `${authorSessionPath}/workshop`,
    {
      type: "claim-draft",
      title: "Reduction claim draft",
      body_md: "Even sum identity reduces to additive identity.",
      relates_to: [c1Id],
    },
    authorA,
    201,
  );

  const c4 = await call(
    `${authorSessionPath}/promote`,
    {
      workshop_id: c4Draft.workshop_id,
      kind: "reduction",
      statement: "Computing 2n + 0 reduces to computing n + 0.",
      relates_to: [c1Id],
      depends_on: [c1Id],
    },
    authorA,
    201,
  );
  const c4Id = c4.claim_id;
  await assertStanding(c4Id, "reduced-to", "unreviewed");
  const c4Review = await call(
    `${reviewerSessionPathB}/review`,
    {
      target_claim_id: c4Id,
      target_version: 1,
      verdict: "confirm",
      basis: "Substitute 2n for the quantified natural number in the additive identity.",
      capable_of_failure: "The substitution could fail to stay in the quantified domain.",
      body_md: "The target identity applies because twice a natural number is still natural.",
    },
    reviewerB,
    201,
  );
  await assertStanding(c4Id, "reduced-to", "independently-checked");

  // -------------------------------------------------------------------------
  // 7. Claim C-5: withdrawn via retraction
  // -------------------------------------------------------------------------
  const c5Draft = await call(
    `${authorSessionPath}/workshop`,
    {
      type: "claim-draft",
      title: "Retracted claim draft",
      body_md: "Temporary claim to be withdrawn.",
      relates_to: [],
    },
    authorA,
    201,
  );

  const c5 = await call(
    `${authorSessionPath}/promote`,
    {
      workshop_id: c5Draft.workshop_id,
      kind: "conjecture",
      statement: "A speculative statement to be retracted.",
      falsifier: "Any counterexample.",
    },
    authorA,
    201,
  );
  const c5Id = c5.claim_id;
  await assertStanding(c5Id, "open", "unreviewed");

  // An honest cannot-verify review still makes its author a recipient of a
  // later correction. It does not establish independent scientific support.
  await call(
    `${reviewerSessionPathC}/review`,
    {
      target_claim_id: c5Id,
      target_version: 1,
      verdict: "cannot-verify",
      basis: "The speculative statement has no supporting argument to check.",
      capable_of_failure: "A supplied argument could contain an invalid inference.",
      body_md: "No verification is asserted while the argument is absent.",
    },
    reviewerC,
    201,
  );

  // Author retracts C-5
  await call(
    `${authorSessionPath}/retract`,
    {
      target_object: c5Id,
      reason: "Author retracts speculative claim.",
    },
    authorA,
    201,
  );
  await assertStanding(c5Id, "withdrawn", "unreviewed");

  // Terminal state check: new reviews cannot revive a withdrawn claim.
  const c5LateReview = await call(
    `${reviewerSessionPathB}/review`,
    {
      target_claim_id: c5Id,
      target_version: 1,
      verdict: "confirm",
      basis: "Attempting to review withdrawn claim.",
      capable_of_failure:
        "The pinned statement could differ from the statement this check addresses.",
      body_md: "This review cannot revive a terminal withdrawn claim.",
    },
    reviewerB,
    422,
  );
  assert.equal(c5LateReview.code, "REVIEW_BODY_INVALID");
  await assertStanding(c5Id, "withdrawn", "unreviewed");

  // W5.4: an explicit independent check of exact counterevidence can settle
  // a refutation. Only fixture setup uses historical Krater event timestamps;
  // verification, all refusal paths, packs, faces and inbox delivery use the
  // mounted production HTTP surface and real Workerd/D1 bindings.
  const historical = await context.fixtures.seedAgedRefutation({
    problemId,
    authorToken: authorA,
    authorSessionId: authorSession.session_id,
    evidenceToken: reviewerB,
    evidenceSessionId: reviewerSessionB.session_id,
    ageHours: 73,
    statement: "Every positive multiple of six is prime.",
  });
  const refutationRequest = (target) => ({
    target_claim_id: target.claim_id,
    target_version: 1,
    verdict: "refute",
    basis:
      "Independently enumerated the witness's proper divisors and checked the exact hypotheses.",
    capable_of_failure: "The integer is outside the quantified domain or has no proper divisor.",
    verification: {
      kind: "refutation",
      target_digest: target.content_digest,
      evidence: target.evidence,
      coverage: ["Six is in the quantified domain.", "Two and three are proper divisors of six."],
      result: "verified",
    },
    body_md: "The published witness satisfies the hypotheses and violates the asserted conclusion.",
  });
  await assertStanding(historical.claim_id, "disputed", "unreviewed");
  const prior = await worker.fetch(`${origin}/p/${problemId}/claims/${historical.claim_id}.json`, {
    headers: { "user-agent": userAgent },
  });
  const priorEtag = prior.headers.get("etag");
  await prior.arrayBuffer();
  const ownEvidence = await call(
    `${reviewerSessionPathB}/review`,
    refutationRequest(historical),
    reviewerB,
    422,
  );
  assert.equal(ownEvidence.code, "REVIEW_BODY_INVALID", "an evidence author cannot self-verify");
  const forgedClock = refutationRequest(historical);
  forgedClock.verification.unanswered_hours = 10000;
  assert.equal(
    (await call(`${reviewerSessionPathC}/review`, forgedClock, reviewerC, 422)).code,
    "REVIEW_BODY_INVALID",
    "elapsed time is never author-writable",
  );
  const wrongVerdict = { ...refutationRequest(historical), verdict: "confirm" };
  assert.equal(
    (await call(`${reviewerSessionPathC}/review`, wrongVerdict, reviewerC, 422)).code,
    "REVIEW_BODY_INVALID",
    "a refutation check cannot mint positive support",
  );
  await call(`${reviewerSessionPathC}/review`, refutationRequest(historical), reviewerC, 201);
  await assertStanding(historical.claim_id, "refuted", "contested");
  const changed = await worker.fetch(
    `${origin}/p/${problemId}/claims/${historical.claim_id}.json`,
    {
      headers: { "user-agent": userAgent, "if-none-match": priorEtag },
    },
  );
  assert.equal(changed.status, 200, "the settling review invalidates the prior claim face");
  assert.notEqual(changed.headers.get("etag"), priorEtag);
  await changed.arrayBuffer();

  const answered = await context.fixtures.seedAgedRefutation({
    problemId,
    authorToken: authorA,
    authorSessionId: authorSession.session_id,
    evidenceToken: reviewerB,
    evidenceSessionId: reviewerSessionB.session_id,
    ageHours: 73,
    statement: "Every positive integer divisible by six is prime.",
  });
  await call(
    `${authorSessionPath}/evidence`,
    {
      bears_on_kind: "claim",
      bears_on_id: answered.claim_id,
      bears_on_version: 1,
      direction: "informs",
      kind: "argument",
      mode: "exploratory",
      source: { kind: "model_memory" },
      body_md:
        "The author disputes whether the witness is in the intended domain; the disagreement is unresolved.",
    },
    authorA,
    201,
  );
  await call(`${reviewerSessionPathC}/review`, refutationRequest(answered), reviewerC, 201);
  await assertStanding(answered.claim_id, "disputed", "contested");

  const fresh = await context.fixtures.seedAgedRefutation({
    problemId,
    authorToken: authorA,
    authorSessionId: authorSession.session_id,
    evidenceToken: reviewerB,
    evidenceSessionId: reviewerSessionB.session_id,
    ageHours: 1,
    statement: "All positive multiples of six have no proper divisor.",
  });
  await call(`${reviewerSessionPathC}/review`, refutationRequest(fresh), reviewerC, 201);
  await assertStanding(fresh.claim_id, "disputed", "contested");
  console.log(
    JSON.stringify({
      stage: "independent-refutation-settlement",
      status: "pass",
      time_basis: "immutable-evidence-and-verifying-review-events",
      answered_and_recent_remain_disputed: true,
      boundary:
        "Historical fixture setup through production Krater; production HTTP verification and read paths.",
    }),
  );

  // -------------------------------------------------------------------------
  // 8. OPS.2a structured diagnostic record
  // -------------------------------------------------------------------------
  const finalCursor = (await call("/cursor")).cursor;
  console.log(
    JSON.stringify({
      kind: "dispositions-journey-real-bindings",
      status: "pass",
      problem: problemId,
      cursor: finalCursor,
      states_verified: [
        "open",
        "open · unchallenged",
        "corroborated",
        "strongly-supported",
        "malformed",
        "disputed",
        "refuted",
        "reduced-to",
        "withdrawn",
      ],
      malformed_exit_rule: "revising malformed claim resets disposition to open (P9)",
      refuter_first_rule: "support without refutation attempt displays open · unchallenged (ADR-9)",
      rules_verified: ["P1", "P2", "P4", "P9", "P10"],
      boundary: {
        runtime: "workerd",
        database: "Cloudflare D1 (local; repository migrations applied by Wrangler)",
        cas: "Cloudflare R2 CAS",
        durable_objects: "KraterOutboxDrainer (sqlite storage)",
        routes: "production wire routes",
        fixtures: "synthetic sponsor enrollment bootstrap and local screening classifier",
      },
    }),
  );

  // disposition_change notices (1e7, migration 0083): the production pass
  // recomputes each queued claim's standing before and at the event and tells
  // the author and prior reviewers, never the actor.
  const { fixtures, env } = context;
  // The production cron (index.ts scheduled) delivers the queue, as workerd
  // does on deploy; its OPS.2a records land in the captured runtime logs.
  const pendingChanges = async () =>
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM disposition_change_deliveries WHERE state = 'pending'",
      ).first()
    ).n;
  assert.ok((await pendingChanges()) > 0, "the lane's reviews queued disposition changes");
  for (let round = 0; round < 20 && (await pendingChanges()) > 0; round++) {
    // Every cron consumer must succeed, not only the disposition delivery.
    const run = await worker.scheduled({ cron: "*/5 * * * *" });
    const failureCodes =
      run.outcome === "ok"
        ? []
        : context
            .workerLogs()
            .flatMap((log) =>
              [
                ...String(log.message).matchAll(/Error:\s+([A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,})\b/g),
              ].map((match) => match[1]),
            );
    assert.equal(
      run.outcome,
      "ok",
      `the production cron run failed: ${JSON.stringify(run)} codes=${JSON.stringify([...new Set(failureCodes)])}`,
    );
  }
  assert.equal(await pendingChanges(), 0, "the production cron drained the queue");
  for (let round = 0; round < 20; round++) {
    const tick = await fixtures.deliverDispositionTick();
    assert.equal(tick.failed, 0, "disposition delivery never fails");
    if (tick.examined === 0) break;
  }
  const changesFor = async (token) =>
    (await call("/v1/inbox?limit=100", undefined, token)).items.filter(
      (item) => item.type === "disposition_change",
    );
  // 3b9 OPS.2a, read from the Worker's own logs: each delivered transition
  // records its claim, from/to, the ledger cursor that is its time basis and
  // digests of the computed standing before and at the event. Never a body.
  const dispositionRecords = opsRecords(context.workerLogs(), "disposition-change-job");
  const corroborated = dispositionRecords.find(
    (record) =>
      record.state === "delivered" && record.claim_id === c1Id && record.to === "corroborated",
  );
  assert.ok(
    corroborated,
    `the corroborating transition left an OPS.2a record; seen: ${JSON.stringify(
      dispositionRecords.map((record) => [record.state, record.claim_id, record.from, record.to]),
    )} of ${context.workerLogs().length} log lines`,
  );
  assert.ok(Number.isSafeInteger(corroborated.cursor) && corroborated.cursor > 0);
  assert.equal(corroborated.time_basis, "ledger_seq");
  assert.match(corroborated.facets_before_digest, /^[0-9a-f]{64}$/);
  assert.match(corroborated.facets_after_digest, /^[0-9a-f]{64}$/);
  assert.notEqual(corroborated.facets_before_digest, corroborated.facets_after_digest);
  for (const record of dispositionRecords) {
    assert.ok(!JSON.stringify(record).includes("moved from"), "no notice text in the log");
  }
  const authorChanges = await changesFor(authorA);
  const titles = authorChanges.map((item) => item.title);
  assert.ok(titles.includes(`${c1Id} is now corroborated`), `author told: ${titles}`);
  assert.ok(titles.includes(`${c1Id}@1 is now strongly-supported`), `author told: ${titles}`);
  assert.ok(
    titles.includes(`${c1Id} is now open · unchallenged`),
    "refuter-first standing is reported without inventing corroboration",
  );
  assert.ok(
    titles.includes(`${c4Id} scientific standing updated`),
    "a new review-state facet is delivered even when the bookkeeping disposition is unchanged",
  );
  assert.ok(
    (await changesFor(reviewerC)).some((notice) => notice.title === `${c5Id} is now withdrawn`),
    "the canonical retraction reaches a prior reviewer",
  );
  for (const [token, fellowToken] of [
    [authorA, "author"],
    [reviewerB, "reviewer B"],
    [reviewerC, "reviewer C"],
  ]) {
    const me = (await call("/v1/hello", undefined, token)).fellow.fellow_id;
    for (const notice of await changesFor(token)) {
      const cause = await env.DB.prepare("SELECT actor_fellow_id FROM events WHERE id = ?")
        .bind(notice.caused_by_event_id)
        .first();
      assert.notEqual(cause?.actor_fellow_id, me, `${fellowToken} is not told of its own write`);
      assert.deepEqual(
        notice.next_actions?.map((action) => action.url),
        [`/p/${problemId}/claims/${notice.target_id}.json`],
      );
    }
  }
  const settledCount = authorChanges.length;
  assert.equal((await fixtures.deliverDispositionTick()).examined, 0, "the queue is drained");
  assert.equal((await changesFor(authorA)).length, settledCount, "no second notice per change");
  assert.ok(
    !JSON.stringify(await call(`/p/${problemId}.json`)).includes("is now strongly-supported"),
    "notices are private",
  );

  // Corrections of evidence/reviews are retraction objects, not new claim
  // objects. Resolve their exact immutable affinity and notify the claim's
  // author, preserving the negative finding while exposing lost authority.
  for (const [kind, publication, sessionPath, claimId] of [
    ["evidence", c3Refutation, reviewerSessionPathB, c3Id],
    ["review", c4Review, reviewerSessionPathB, c4Id],
  ]) {
    const objectId = kind === "review" ? publication.review_id : publication.evidence_id;
    const source = await env.DB.prepare(`SELECT id,payload_sha256 FROM events
      WHERE problem_id=? AND object_id=? AND type=?`)
      .bind(problemId, objectId, `${kind}.created`)
      .first();
    assert.ok(source);
    const path = `${sessionPath}/${kind === "review" ? "reviews" : "evidence"}/${objectId}/retract`;
    const body = {
      source_event_id: source.id,
      source_digest: `sha256:${source.payload_sha256}`,
      reason: "The author is correcting the stated scope of this earlier work product.",
    };
    const key = `standing-notice-${kind}-withdrawal`;
    const correction = await call(path, body, reviewerB, 200, key);
    assert.deepEqual(
      await call(path, body, reviewerB, 200, key),
      correction,
      "retrying the correction must replay its original event",
    );
    for (let round = 0; round < 20; round++) {
      const tick = await fixtures.deliverDispositionTick();
      assert.equal(tick.failed, 0);
      assert.equal(tick.quarantined, 0, "a canonical withdrawal has a valid claim affinity");
      if (tick.examined === 0) break;
    }
    const updates = (await changesFor(authorA)).filter(
      (notice) => notice.caused_by_event_id === correction.event_id,
    );
    assert.equal(updates.length, 1, `${kind} correction reaches the claim's author exactly once`);
    assert.equal(updates[0].target_id, claimId);
    assert.ok(updates[0].detail.includes("stale false → true"));
    assert.ok(
      !updates[0].detail.includes(body.reason),
      "private notifications do not copy scientific bodies",
    );
    assert.equal(
      (await changesFor(reviewerB)).some(
        (notice) => notice.caused_by_event_id === correction.event_id,
      ),
      false,
    );
    const face = await call(`/p/${problemId}/claims/${claimId}.json`);
    assert.equal(face.claim_state.stale, true);
    assert.equal(
      face.claim_state.disposition,
      kind === "review" ? "reduced-to" : "disputed",
      "withdrawing an input does not erase a negative finding or settle a reduction",
    );
  }

  // W2.6 (79n, z3or): claims, their versions and dependencies (C-4 depends
  // on C-1), reviews, evidence and retractions rebuild from the log.
  const rebuilt = await assertProjectionsRebuild(context.env.DB, problemId);
  assert.ok(rebuilt.counts.claim_deps > 0, "the journey recorded a claim dependency");
  console.log(JSON.stringify({ stage: "projection-rebuild", ...rebuilt }));

  // Fable §6.6 tier floor, on its own problem: a same-sponsor (T0) confirm,
  // even with a falsifiable check, and a cross-sponsor confirm without
  // capable_of_failure both leave a claim unreviewed. Only a weight-carrying
  // check at T1+ makes it independently-checked.
  {
    const SPONSOR = "usr_tier_floor_sponsor";
    const tierAuthor = await enroll("tier-floor-author", SPONSOR);
    const sameSponsor = await enroll("tier-floor-sibling", SPONSOR);
    const crossSponsor = await enroll("tier-floor-cross", "usr_tier_floor_other");
    const tierProblem = (
      await call(
        "/v1/problems",
        {
          title: "Tier floor problem for computed review states",
          statement: "For all natural numbers n, n + 0 = n.",
          falsifier: "A natural number n such that n + 0 differs from n.",
          motivation: "Pin the review-state tier floor on real bindings.",
          areas: ["number-theory"],
        },
        tierAuthor,
        201,
      )
    ).problem.id;
    await sponsorCall(
      SPONSOR,
      "POST",
      `/v1/sponsors/problems/${tierProblem}/lifecycle`,
      "problem-lifecycle",
      { action: "publish" },
      200,
      `/v1/sponsors/problems/${tierProblem}/lifecycle`,
      "publish-tier-floor",
    );
    const statementSession = await call(
      "/v1/sessions",
      { problem_id: tierProblem, intent: "review" },
      crossSponsor,
      201,
    );
    await call(
      `/v1/problems/${tierProblem}/statement-review`,
      {
        session_id: statementSession.session_id,
        statement_version: 1,
        verdict: "statement-clear",
        basis: "The statement is clear and well quantified over the natural numbers.",
      },
      crossSponsor,
      200,
    );
    await call(
      `/v1/sessions/${statementSession.session_id}/close`,
      { handback: "Statement reviewed.", promote: [], keep: [], discard: [] },
      crossSponsor,
      201,
    );
    const authorSession = await call(
      "/v1/sessions",
      { problem_id: tierProblem, intent: "prove" },
      tierAuthor,
      201,
    );
    const siblingSession = await call(
      "/v1/sessions",
      { problem_id: tierProblem, intent: "review" },
      sameSponsor,
      201,
    );
    const crossSession = await call(
      "/v1/sessions",
      { problem_id: tierProblem, intent: "review" },
      crossSponsor,
      201,
    );
    const draft = await call(
      `/v1/sessions/${authorSession.session_id}/workshop`,
      { type: "claim-draft", title: "Additive identity", body_md: "n + 0 = n.", relates_to: [] },
      tierAuthor,
      201,
    );
    const tierClaim = (
      await call(
        `/v1/sessions/${authorSession.session_id}/promote`,
        {
          workshop_id: draft.workshop_id,
          kind: "conjecture",
          statement: "For every natural number n, n + 0 = n.",
          falsifier: "A natural number n such that n + 0 differs from n.",
        },
        tierAuthor,
        201,
      )
    ).claim_id;
    const reviewState = async () =>
      (
        await (
          await worker.fetch(`${origin}/p/${tierProblem}/claims/${tierClaim}.json`, {
            headers: { "user-agent": userAgent },
          })
        ).json()
      ).claim_state.review_state;
    assert.equal(await reviewState(), "unreviewed");
    await call(
      `/v1/sessions/${siblingSession.session_id}/review`,
      {
        target_claim_id: tierClaim,
        target_version: 1,
        verdict: "confirm",
        basis: "Checked the zero definition for n in 0, 1 and 2.",
        capable_of_failure: "An n with n + 0 different from n.",
        body_md: "Same-sponsor confirm.",
      },
      sameSponsor,
      201,
    );
    assert.equal(await reviewState(), "unreviewed", "a same-sponsor (T0) confirm is no check");
    await call(
      `/v1/sessions/${crossSession.session_id}/review`,
      {
        target_claim_id: tierClaim,
        target_version: 1,
        verdict: "confirm",
        basis: "Checked the zero definition for n in 0 through 3.",
        body_md: "No capable_of_failure: an assertion, not a check.",
      },
      crossSponsor,
      201,
    );
    assert.equal(await reviewState(), "unreviewed", "a weightless confirm is no check");
    const crossChecked = await call(
      `/v1/sessions/${crossSession.session_id}/review`,
      {
        target_claim_id: tierClaim,
        target_version: 1,
        verdict: "confirm",
        basis: "Checked n + 0 = n by the Peano successor definition for n up to 5.",
        capable_of_failure: "Any n up to 5 with n + 0 different from n.",
        body_md: "Cross-sponsor, falsifiable check.",
      },
      crossSponsor,
      null,
    );
    assert.equal(crossChecked.code, undefined, JSON.stringify(crossChecked).slice(0, 200));
    assert.equal(
      await reviewState(),
      "independently-checked",
      "a weight-carrying cross-sponsor confirm is the check",
    );
    console.log(JSON.stringify({ stage: "review-state-tier-floor", status: "pass" }));
  }

  // Close an ordinary problem only after the production scientific writers
  // earned strong standing. Sponsor disclosure and governance use signed HTTP;
  // the scientific closing declaration is published by the Fellow.
  await assertStanding(c1Id, "strongly-supported", "independently-checked");
  const disclosurePath = `/v1/sponsors/disclosures/${problemId}/${c1Id}/1`;
  const disclosure = await sponsorCall(
    sponsorA,
    "GET",
    disclosurePath,
    "sponsor.disclosure.read",
    undefined,
  );
  for (const scope of disclosure.scopes) {
    assert.equal(scope.sponsor_id, sponsorA);
    await sponsorCall(
      sponsorA,
      "POST",
      disclosurePath,
      "sponsor.disclosure.write",
      {
        scope_id: scope.scope_id,
        expected_lineage_digest: disclosure.lineage_digest,
        expected_revision: scope.revision,
        decision: "no-undisclosed",
        disclosures: [],
      },
      200,
      disclosurePath,
      `resolution-disclosure-${scope.scope_id}`,
    );
  }
  const entered = await govern(
    { action: "enter-result-review", result_claim: { claim_id: c1Id, version: 1 } },
    "ordinary-result-review",
  );
  assert.equal(entered.problem.status, "under-result-review");
  const through = (
    await env.DB.prepare("SELECT public_seq FROM problems WHERE id = ?").bind(problemId).first()
  ).public_seq;
  const summary =
    "The recorded additive-identity claim has two independent full-write-up checks and a recorded falsification attempt. This closes only the stated arithmetic result.";
  const boundary = {
    verified: [`The exact additive-identity statement in ${c1Id}@1.`],
    mechanisms: ["Two full-write-up checks and a recorded falsification attempt."],
    independence_tiers: ["T2"],
    remaining_external_validation: [
      "No formal-kernel execution or external expert review is claimed.",
    ],
  };
  const closingBody = {
    covers_through: through,
    body_md: summary,
    anchors: [
      { target_kind: "claim", target_id: c1Id, target_version: 1 },
      { target_kind: "evidence", target_id: c1Proof.evidence_id },
      { target_kind: "review", target_id: fullReviewB.review_id },
      { target_kind: "review", target_id: fullReviewC.review_id },
    ],
    omitted: ["The other exploratory claims do not enlarge the result being closed."],
    selection_policy:
      "Retain the exact result and the independent checks that earned its standing.",
    closing_resolution: {
      result_claim: { claim_id: c1Id, version: 1 },
      direction: "affirmed",
      no_claim_boundary: boundary,
    },
  };
  const closing = await call(
    `${authorSessionPath}/synthesize`,
    closingBody,
    authorA,
    201,
    "ordinary-closing-synthesis",
  );
  const command = {
    action: "resolve",
    direction: "affirmed",
    closing_synthesis: { synthesis_id: closing.synthesis_id, summary, no_claim_boundary: boundary },
  };
  const resolutionState = () =>
    env.DB.prepare(`SELECT status,public_seq,chain_digest,famous_guardrail,
    resolution_direction,resolution_summary,resolution_no_claim_boundary,
    (SELECT cursor FROM public_cursor WHERE singleton=1) AS global_cursor,
    (SELECT COUNT(*) FROM events) AS events,
    (SELECT COUNT(*) FROM event_content) AS content,
    (SELECT COUNT(*) FROM idempotency) AS receipts,
    (SELECT COUNT(*) FROM screening_publications) AS screening_publications,
    (SELECT COUNT(*) FROM outbox) AS outbox FROM problems WHERE id = ?`)
      .bind(problemId)
      .first();
  const { synthesis_id: _publicationId, ...unpublished } = command.closing_synthesis;
  const refusedCommands = [
    ["missing-publication", { ...command, closing_synthesis: unpublished }],
    [
      "changed-summary",
      {
        ...command,
        closing_synthesis: {
          ...command.closing_synthesis,
          summary: "Sponsor-supplied replacement scientific conclusion.",
        },
      },
    ],
    [
      "changed-boundary",
      {
        ...command,
        closing_synthesis: {
          ...command.closing_synthesis,
          no_claim_boundary: { ...boundary, verified: ["An enlarged result."] },
        },
      },
    ],
    ["changed-direction", { ...command, direction: "refuted-as-stated" }],
  ];
  for (const [label, request] of refusedCommands) {
    const before = await resolutionState();
    const refusal = await govern(request, `ordinary-resolution-${label}`, 422);
    assert.equal(refusal.code, "PREMATURE_RESOLUTION");
    assert.deepEqual(
      await resolutionState(),
      before,
      `${label} cannot mutate public state or receipts`,
    );
  }

  // Classification-only fault injection isolates the famous-problem guard
  // against an otherwise fully admissible result. It asserts no classification
  // workflow and restores the original value before ordinary admission.
  const famous = JSON.stringify({
    canonical_formulation: "Famous-problem guard control over the same fully supported fixture.",
    variant_distinctions: "This is a local classification control, not a new research result.",
    authoritative_references: ["https://example.invalid/famous-problem-control"],
    standing_banner: "External expert admission remains required.",
  });
  await env.DB.prepare("UPDATE problems SET famous_guardrail = ? WHERE id = ?")
    .bind(famous, problemId)
    .run();
  const beforeFamous = await resolutionState();
  const famousRefusal = await govern(
    {
      ...command,
      external_expert_review_proof: "A sponsor asserts that outside experts checked it.",
    },
    "ordinary-resolution-famous-control",
    422,
  );
  assert.equal(famousRefusal.code, "PREMATURE_RESOLUTION");
  assert.deepEqual(await resolutionState(), beforeFamous);
  await env.DB.prepare("UPDATE problems SET famous_guardrail = NULL WHERE id = ?")
    .bind(problemId)
    .run();

  const beforeResolution = await resolutionState();
  const resolved = ProblemResolutionResponseSchema.parse(
    await govern(command, "ordinary-resolution-success"),
  );
  assert.equal(resolved.problem.status, "resolved");
  assert.deepEqual(resolved.problem.result_claim, entered.problem.result_claim);
  assert.equal(resolved.problem.resolution_summary, summary);
  assert.deepEqual(resolved.problem.resolution_no_claim_boundary, boundary);
  assert.equal(resolved.problem.closing_synthesis.synthesis_id, closing.synthesis_id);
  assert.equal(resolved.problem.closing_synthesis.event_id, closing.event_id);
  assert.equal(resolved.problem.closing_synthesis.seq, closing.sequence);
  assert.equal(resolved.problem.closing_synthesis.covers_through, through);
  const afterResolution = await resolutionState();
  assert.equal(afterResolution.public_seq, beforeResolution.public_seq + 1);
  assert.equal(afterResolution.global_cursor, beforeResolution.global_cursor + 1);
  assert.equal(afterResolution.events, beforeResolution.events + 1);
  assert.equal(afterResolution.content, beforeResolution.content + 1);
  assert.equal(afterResolution.receipts, beforeResolution.receipts + 1);
  const recorded = await env.DB.prepare(`SELECT e.actor_fellow_id,e.actor_sponsor_id,c.payload_json
    FROM events e JOIN event_content c ON c.event_id=e.id
    WHERE e.problem_id=? AND e.type='problem.resolved'`)
    .bind(problemId)
    .all();
  assert.equal(recorded.results.length, 1);
  const resolutionEvent = ProblemGovernanceEventSchema.parse(
    JSON.parse(recorded.results[0].payload_json),
  );
  assert.equal(resolutionEvent.action, "resolve");
  assert.deepEqual(resolutionEvent.problem, resolved.problem);
  assert.equal(
    recorded.results[0].actor_fellow_id,
    null,
    "Sponsor governance never impersonates the Fellow author",
  );
  assert.equal(recorded.results[0].actor_sponsor_id, sponsorA);
  assert.deepEqual(
    ProblemResolutionResponseSchema.parse(await govern(command, "ordinary-resolution-success")),
    resolved,
  );
  assert.deepEqual(
    await resolutionState(),
    afterResolution,
    "A lost successful reply replays without a second event",
  );
  const conflictingRetry = await govern(refusedCommands[1][1], "ordinary-resolution-success", 409);
  assert.equal(conflictingRetry.code, "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(await resolutionState(), afterResolution);
  const detail = await call(`/v1/problems/${problemId}`);
  assert.equal(detail.problem.status, "resolved");
  assert.equal(detail.problem.resolution.summary, summary);
  assert.deepEqual(detail.problem.resolution.no_claim_boundary, boundary);
  assert.deepEqual(detail.problem.resolution.closing_synthesis, resolved.problem.closing_synthesis);
  assert.deepEqual(detail.problem.resolution.result_claim, entered.problem.result_claim);
  assert.equal((await call(`/p/${problemId}.json`)).problem_status, "resolved");
  const markdown = await worker.fetch(`${origin}/p/${problemId}.md`, {
    headers: { "User-Agent": userAgent },
  });
  assert.equal(markdown.status, 200);
  assert.ok((await markdown.text()).includes("Problem lifecycle: **resolved**"));
  const closedWrite = await call(
    `${authorSessionPath}/synthesize`,
    closingBody,
    authorA,
    422,
    "ordinary-resolution-closed-write",
  );
  assert.equal(closedWrite.code, "CLAIMS_BOARD_LOCKED");
  assert.deepEqual(await resolutionState(), afterResolution);
  const resolutionRebuild = await assertProjectionsRebuild(env.DB, problemId);
  console.log(
    JSON.stringify({
      stage: "ordinary-resolution",
      status: "pass",
      result_claim: `${c1Id}@1`,
      closing_synthesis: closing.synthesis_id,
      typed_refusals: refusedCommands.length + 1,
      rebuilt: resolutionRebuild.counts,
    }),
  );

  console.log(
    JSON.stringify({
      kind: "dispositions-real-bindings-complete",
      status: "pass",
    }),
  );
});
