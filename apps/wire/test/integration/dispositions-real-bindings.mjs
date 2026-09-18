import assert from "node:assert/strict";
import { ClaimFaceResponseSchema, PackResponseSchema } from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

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
  async function assertStanding(claimId, expected) {
    // Pack check
    const query = new URLSearchParams({ profile: "working", max_tokens: "8000" });
    const packRes = PackResponseSchema.parse(
      await call(`${reviewerSessionPathB}/pack?${query}`, undefined, reviewerB),
    );
    const item = packRes.items.find((val) => val.kind === "claim" && val.id === claimId);
    assert.ok(item, `Claim ${claimId} should be present in working pack`);
    assert.ok(
      item.body.includes(`, ${expected}):`),
      `Expected ${claimId} standing "${expected}" in pack; got "${item.body.slice(0, 100)}"`,
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
  await assertStanding(c1Id, "open");

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
  await assertStanding(c1Id, "open · unchallenged");

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
  await assertStanding(c1Id, "corroborated");

  // Reviewer B submits full write-up verification
  await call(
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
  await assertStanding(c1Id, "corroborated");

  // Reviewer C (cross-family: gemini) submits second full write-up review -> "strongly-supported"
  await call(
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
  await assertStanding(c1Id, "strongly-supported");

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
  await assertStanding(c2Id, "open");

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
  await assertStanding(c2Id, "malformed");

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
  await assertStanding(c2Id, "open");

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
  await assertStanding(c3Id, "open");

  // Reviewer B submits refuting evidence (4 is even and composite) -> "disputed"
  await call(
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
  await assertStanding(c3Id, "disputed");

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
  await assertStanding(c4Id, "reduced-to");

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
  await assertStanding(c5Id, "open");

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
  await assertStanding(c5Id, "withdrawn");

  // Terminal state check: review on withdrawn claim is ignored / does not revive it
  await call(
    `${reviewerSessionPathB}/review`,
    {
      target_claim_id: c5Id,
      target_version: 1,
      verdict: "confirm",
      basis: "Attempting to review withdrawn claim.",
      capable_of_failure: "None.",
      body_md: "This review cannot revive a terminal withdrawn claim.",
    },
    reviewerB,
    201,
  );
  await assertStanding(c5Id, "withdrawn");

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

  console.log(
    JSON.stringify({
      kind: "dispositions-real-bindings-complete",
      status: "pass",
    }),
  );
});
