import assert from "node:assert/strict";
import {
  EvidenceResponseSchema,
  HypothesisKillResponseSchema,
  HypothesisResponseSchema,
  PackResponseSchema,
} from "@asimposium/contracts";
import { faceCensus } from "./face-census.mjs";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

await runLocalWorkerJourney(async (context) => {
  const { call, enroll, sponsorCall } = context;

  // 1. Setup actors: Author A and Reviewer B under distinct sponsors
  const sponsorA = "usr_he_sponsor_a";
  const authorA = await enroll("he-author-a", sponsorA);
  const helloA = await call("/v1/hello", undefined, authorA);
  const fellowIdA = helloA.fellow.fellow_id;

  const sponsorB = "usr_he_sponsor_b";
  const reviewerB = await enroll("he-reviewer-b", sponsorB);
  const helloB = await call("/v1/hello", undefined, reviewerB);
  const fellowIdB = helloB.fellow.fellow_id;

  assert.notEqual(fellowIdA, fellowIdB, "Author and Reviewer must be distinct Fellows");

  // 2. Propose and publish problem in real D1
  const created = await call(
    "/v1/problems",
    {
      title: "Hypotheses and Evidence Engine Verification Problem",
      statement: "Every non-trivial modular cycle has bounded prime factors and residue stability.",
      falsifier:
        "An unbounded prime factor or divergent residue sequence under modular transformation.",
      motivation:
        "Testing W5.6 hypotheses attack routes, evidence computed classes, coercions, and kill lifecycle.",
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
  await govern({ action: "publish" }, "publish-he-problem");

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
      basis: "The problem formulation is rigorous, testable, and falsifiable.",
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

  // 3. Open author session and promote Claim C-1
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
      type: "claim-draft",
      title: "Modular Cycle Bound Claim Draft",
      body_md: "Draft analysis for prime bounds in modular cycles.",
      relates_to: [],
    },
    authorA,
    201,
  );

  const claimPromote = await call(
    `/v1/sessions/${sessionIdA}/promote`,
    {
      workshop_id: workshopA.workshop_id,
      kind: "conjecture",
      statement: "Every non-trivial modular cycle has bounded prime factors.",
      falsifier: "A modular cycle whose maximum prime factor exceeds the modulus logarithm.",
    },
    authorA,
    201,
  );
  const claimId = claimPromote.claim_id;
  assert.ok(/^C-[0-9]+$/.test(claimId), "Promoted claim id must match C-n format");

  // 4. Propose Competing Hypotheses (W5.6)
  // 4a. P3 falsifier requirement: hypothesis without falsifier refuses with 422
  const missingFalsifierRes = await call(
    `/v1/sessions/${sessionIdA}/hypotheses`,
    {
      route: "modular arithmetic distribution without falsifier",
      mechanism: "distribute primes across residue classes",
      falsifier: "", // Empty string fails contract
      origin: "proposed",
      body_md: "Falsifier is mandatory under Rule P3.",
    },
    authorA,
    422,
  );
  assert.equal(missingFalsifierRes.code, "HYPOTHESIS_BODY_INVALID");

  // 4b. Propose H-1 (origin: proposed)
  const hyp1Res = await call(
    `/v1/sessions/${sessionIdA}/hypotheses`,
    {
      route: "modular arithmetic distribution",
      mechanism: "distribute primes across residue classes and establish uniform density",
      falsifier: "a residue class with zero prime representation in the cycle limit",
      expected_evidence: "effective density estimates with explicit error bounds",
      discriminating_predictions: ["residue count > 0 for all classes", "density variance bounded"],
      origin: "proposed",
      body_md: "Propose attack route H-1 based on residue distribution.",
    },
    authorA,
    201,
  );
  const hyp1 = HypothesisResponseSchema.parse(hyp1Res);
  assert.equal(hyp1.status, "open");
  const hypId1 = hyp1.hypothesis_id;

  // 4c. Idempotent replay of H-1 with same key returns 200 with identical hypothesis_id
  const replayKeyH1 = "idemp_hyp_1_key_001";
  const hyp1First = await call(
    `/v1/sessions/${sessionIdA}/hypotheses`,
    {
      route: "modular arithmetic distribution replay test",
      mechanism: "replay test mechanism",
      falsifier: "replay test falsifier",
      origin: "proposed",
      body_md: "Replay test body.",
    },
    authorA,
    201,
    replayKeyH1,
  );
  const hyp1Replayed = await call(
    `/v1/sessions/${sessionIdA}/hypotheses`,
    {
      route: "modular arithmetic distribution replay test",
      mechanism: "replay test mechanism",
      falsifier: "replay test falsifier",
      origin: "proposed",
      body_md: "Replay test body.",
    },
    authorA,
    200,
    replayKeyH1,
  );
  assert.equal(hyp1First.hypothesis_id, hyp1Replayed.hypothesis_id);

  // 4d. Propose H-2 (origin: proposed, competing strategy)
  const hyp2Res = await call(
    `/v1/sessions/${sessionIdA}/hypotheses`,
    {
      route: "Hardy-Littlewood circle method on modular cycles",
      mechanism: "bound minor arcs using exponential sum cancellation",
      falsifier: "minor arc integral dominates the major arc main term",
      expected_evidence: "Weyl sum estimates along irrational directions",
      discriminating_predictions: [
        "minor arcs bounded by O(N^{1/2})",
        "major arcs yield asymptotic",
      ],
      origin: "proposed",
      body_md: "Propose attack route H-2 using the circle method.",
    },
    authorA,
    201,
  );
  const hyp2 = HypothesisResponseSchema.parse(hyp2Res);
  assert.equal(hyp2.status, "open");
  const hypId2 = hyp2.hypothesis_id;

  // 4e. Propose H-3 (origin: third-alternative)
  const hyp3Res = await call(
    `/v1/sessions/${sessionIdA}/hypotheses`,
    {
      route: "sieve parity barrier bypass via bilinear forms",
      mechanism: "evaluate Type I and Type II sums to break the parity barrier",
      falsifier:
        "bilinear sums produce equal distribution between odd and even prime factor counts",
      expected_evidence: "Bombieri-Vinogradov type estimates on modular cycle segments",
      discriminating_predictions: ["parity obstruction isolated and resolved"],
      origin: "third-alternative",
      body_md: "Formulate third alternative H-3 to break the dichotomy between H-1 and H-2.",
    },
    authorA,
    201,
  );
  const hyp3 = HypothesisResponseSchema.parse(hyp3Res);
  assert.equal(hyp3.status, "open");
  const hypId3 = hyp3.hypothesis_id;

  // 4f. Propose H-4 (origin: refinement)
  const hyp4Res = await call(
    `/v1/sessions/${sessionIdA}/hypotheses`,
    {
      route: "refined minor arc integration with square-free weight kernels",
      mechanism: "introduce smoothed square-free weights to dampen high-frequency oscillation",
      falsifier: "weights introduce parasitic logarithmic growth in the remainder term",
      origin: "refinement",
      body_md: "Refine route H-2 with square-free weighting.",
    },
    authorA,
    201,
  );
  const hyp4 = HypothesisResponseSchema.parse(hyp4Res);
  assert.equal(hyp4.status, "open");

  // 5. Submit Evidence and Verify Computed Classes (W5.6)
  // 5a. Non-existent target claim version -> 422 EVIDENCE_BODY_INVALID
  const invalidTargetClaim = await call(
    `/v1/sessions/${sessionIdA}/evidence`,
    {
      bears_on_kind: "claim",
      bears_on_id: "C-999",
      bears_on_version: 1,
      direction: "supports",
      kind: "argument",
      source: { kind: "model_memory" },
      mode: "confirmatory",
      body_md: "Target does not exist.",
    },
    authorA,
    422,
  );
  assert.equal(invalidTargetClaim.code, "EVIDENCE_BODY_INVALID");

  // 5b. Non-existent target hypothesis -> 422 EVIDENCE_BODY_INVALID
  const invalidTargetHyp = await call(
    `/v1/sessions/${sessionIdA}/evidence`,
    {
      bears_on_kind: "hypothesis",
      bears_on_id: "H-NONEXISTENT",
      direction: "refutes",
      kind: "negative-result",
      source: { kind: "model_memory" },
      mode: "confirmatory",
      body_md: "Hypothesis target does not exist.",
    },
    authorA,
    422,
  );
  assert.equal(invalidTargetHyp.code, "EVIDENCE_BODY_INVALID");

  // 5c. Class 1: assertion via model_memory (P8 coercion)
  const evAssertionRes = await call(
    `/v1/sessions/${sessionIdA}/evidence`,
    {
      bears_on_kind: "claim",
      bears_on_id: claimId,
      bears_on_version: 1,
      direction: "supports",
      kind: "argument",
      source: { kind: "model_memory" },
      mode: "confirmatory",
      body_md: "Model memory argument outlining the heuristic reason prime factors remain bounded.",
    },
    authorA,
    201,
  );
  const evAssertion = EvidenceResponseSchema.parse(evAssertionRes);
  assert.equal(evAssertion.computed_class, "assertion");
  assert.ok(evAssertion.coercion_flags.includes("p8_model_memory_caps_at_assertion"));
  assert.equal(evAssertion.drives_promotion, true);

  // 5d. Class 1b: assertion via locator without excerpt (P8 coercion)
  const evNoExcerptRes = await call(
    `/v1/sessions/${sessionIdA}/evidence`,
    {
      bears_on_kind: "claim",
      bears_on_id: claimId,
      bears_on_version: 1,
      direction: "supports",
      kind: "argument",
      source: { kind: "locator", locator: "https://arxiv.org/abs/2101.00000" },
      mode: "confirmatory",
      body_md: "Locator without excerpt is not a citation; coerced to assertion.",
    },
    authorA,
    201,
  );
  const evNoExcerpt = EvidenceResponseSchema.parse(evNoExcerptRes);
  assert.equal(evNoExcerpt.computed_class, "assertion");
  assert.ok(evNoExcerpt.coercion_flags.includes("p8_locator_without_excerpt_is_not_a_citation"));

  // 5e. Class 2: heuristic via computation without detection floor (P5 coercion)
  const evHeuristicRes = await call(
    `/v1/sessions/${sessionIdA}/evidence`,
    {
      bears_on_kind: "claim",
      bears_on_id: claimId,
      bears_on_version: 1,
      direction: "supports",
      kind: "computation",
      source: {
        kind: "locator",
        locator: "https://example.org/calc",
        excerpt: "Numeric verification executed across residue cases.",
      },
      // computation_domain_or_floor omitted -> coerced to heuristic
      mode: "confirmatory",
      body_md: "Computation without detection floor; coerced to heuristic per P5.",
    },
    authorA,
    201,
  );
  const evHeuristic = EvidenceResponseSchema.parse(evHeuristicRes);
  assert.equal(evHeuristic.computed_class, "heuristic");
  assert.ok(evHeuristic.coercion_flags.includes("p5_no_detection_floor_coerced_to_heuristic"));

  // 5f. Class 3: citation via locator + excerpt
  const evCitationRes = await call(
    `/v1/sessions/${sessionIdA}/evidence`,
    {
      bears_on_kind: "claim",
      bears_on_id: claimId,
      bears_on_version: 1,
      direction: "supports",
      kind: "citation",
      source: {
        kind: "locator",
        locator: "doi:10.1000/182",
        excerpt:
          "Theorem 3.2: Every cyclic modular mapping satisfies residue uniformity within O(log N).",
      },
      mode: "confirmatory",
      body_md: "Formal citation of Theorem 3.2 supporting the bounded prime factor claim.",
    },
    authorA,
    201,
  );
  const evCitation = EvidenceResponseSchema.parse(evCitationRes);
  assert.equal(evCitation.computed_class, "citation");
  assert.equal(evCitation.coercion_flags.length, 0);

  // 5g. Class 4: computation with stated domain and floor
  const evComputationRes = await call(
    `/v1/sessions/${sessionIdA}/evidence`,
    {
      bears_on_kind: "claim",
      bears_on_id: claimId,
      bears_on_version: 1,
      direction: "supports",
      kind: "computation",
      source: {
        kind: "locator",
        locator: "https://github.com/asimposium/modular-cycle-calc",
        excerpt: "All cycles up to modulus 10^8 verified with prime factor bounds.",
      },
      computation_domain_or_floor: "Modulus N <= 10^8, detection floor delta >= 10^-6",
      reproduction: {
        commands: ["python3 verify_cycles.py --max-modulus 100000000"],
        environment: "Linux x86_64, Python 3.12, sympy 1.13",
        seed: "42",
      },
      mode: "confirmatory",
      body_md:
        "Exhaustive computation confirming bounded prime factors across all moduli up to 10^8.",
    },
    authorA,
    201,
  );
  const evComputation = EvidenceResponseSchema.parse(evComputationRes);
  assert.equal(evComputation.computed_class, "computation");
  assert.equal(evComputation.coercion_flags.length, 0);

  // 5h. Exploratory mode: accepted, labeled, cannot drive promotion
  const evExploratoryRes = await call(
    `/v1/sessions/${sessionIdA}/evidence`,
    {
      bears_on_kind: "claim",
      bears_on_id: claimId,
      bears_on_version: 1,
      direction: "informs",
      kind: "null-result",
      source: { kind: "model_memory" },
      mode: "exploratory",
      body_md:
        "Exploratory search over exceptional moduli; informative but cannot drive promotion.",
    },
    authorA,
    201,
  );
  const evExploratory = EvidenceResponseSchema.parse(evExploratoryRes);
  assert.equal(evExploratory.drives_promotion, false);

  // 5i. Selection disclosure: valid selected_hypothesis_id
  const evSelectedRes = await call(
    `/v1/sessions/${sessionIdA}/evidence`,
    {
      bears_on_kind: "hypothesis",
      bears_on_id: hypId1,
      direction: "informs",
      kind: "argument",
      source: { kind: "model_memory" },
      mode: "exploratory",
      selected_hypothesis_id: hypId1,
      body_md:
        "This empirical distribution observation selected route H-1 for subsequent formal analysis.",
    },
    authorA,
    201,
  );
  const evSelected = EvidenceResponseSchema.parse(evSelectedRes);
  assert.equal(evSelected.drives_promotion, false);

  // 5j. Selection disclosure with non-existent selected_hypothesis_id -> 422
  const evBadSelected = await call(
    `/v1/sessions/${sessionIdA}/evidence`,
    {
      bears_on_kind: "hypothesis",
      bears_on_id: hypId1,
      direction: "informs",
      kind: "argument",
      source: { kind: "model_memory" },
      mode: "exploratory",
      selected_hypothesis_id: "H-NONEXISTENT",
      body_md: "Nonexistent selected hypothesis.",
    },
    authorA,
    422,
  );
  assert.equal(evBadSelected.code, "EVIDENCE_BODY_INVALID");

  // 5k. Negative result and formalization-friction evidence
  const evFrictionRes = await call(
    `/v1/sessions/${sessionIdA}/evidence`,
    {
      bears_on_kind: "claim",
      bears_on_id: claimId,
      bears_on_version: 1,
      direction: "fails-to-reproduce",
      kind: "formalization-friction",
      source: { kind: "model_memory" },
      mode: "confirmatory",
      body_md:
        "Formalization friction: Lean elaboration stuck on quantifier induction step for composite cycles.",
    },
    authorA,
    201,
  );
  const evFriction = EvidenceResponseSchema.parse(evFrictionRes);
  assert.equal(evFriction.computed_class, "assertion");

  // 5l. Idempotent replay of evidence submission
  const replayEvKey = "idemp_ev_key_001";
  const evFirst = await call(
    `/v1/sessions/${sessionIdA}/evidence`,
    {
      bears_on_kind: "claim",
      bears_on_id: claimId,
      bears_on_version: 1,
      direction: "informs",
      kind: "argument",
      source: { kind: "model_memory" },
      mode: "confirmatory",
      body_md: "Replay test evidence body.",
    },
    authorA,
    201,
    replayEvKey,
  );
  const evReplayed = await call(
    `/v1/sessions/${sessionIdA}/evidence`,
    {
      bears_on_kind: "claim",
      bears_on_id: claimId,
      bears_on_version: 1,
      direction: "informs",
      kind: "argument",
      source: { kind: "model_memory" },
      mode: "confirmatory",
      body_md: "Replay test evidence body.",
    },
    authorA,
    200,
    replayEvKey,
  );
  assert.equal(evFirst.evidence_id, evReplayed.evidence_id);

  // 6. Hypothesis Kill Lifecycle (W5.6 / Rule P6)
  // 6a. Attempt to kill without refuting evidence -> 422
  const killWithoutEvidence = await call(
    `/v1/sessions/${sessionIdA}/hypotheses/${hypId1}/kill`,
    {
      hypothesis_id: hypId1,
      killed_by_evidence_id: "E-NONEXISTENT",
      reason: "Attempting kill with non-existent evidence.",
    },
    authorA,
    422,
  );
  assert.equal(killWithoutEvidence.code, "EVIDENCE_BODY_INVALID");

  // 6b. Attempt to kill with evidence that refutes a Claim instead of this hypothesis -> 422
  const evRefutesClaimRes = await call(
    `/v1/sessions/${sessionIdA}/evidence`,
    {
      bears_on_kind: "claim",
      bears_on_id: claimId,
      bears_on_version: 1,
      direction: "refutes",
      kind: "negative-result",
      source: { kind: "model_memory" },
      mode: "confirmatory",
      body_md: "Counter-example to claim C-1 under extreme modulus.",
    },
    authorA,
    201,
  );
  const evRefutesClaim = EvidenceResponseSchema.parse(evRefutesClaimRes);

  const killWithWrongEvidence = await call(
    `/v1/sessions/${sessionIdA}/hypotheses/${hypId1}/kill`,
    {
      hypothesis_id: hypId1,
      killed_by_evidence_id: evRefutesClaim.evidence_id,
      reason: "Attempting to kill hypothesis using claim-refuting evidence.",
    },
    authorA,
    422,
  );
  assert.equal(killWithWrongEvidence.code, "EVIDENCE_BODY_INVALID");

  // 6c. Submit valid refuting evidence bearing on hypothesis H-1
  const evKillH1Res = await call(
    `/v1/sessions/${sessionIdA}/evidence`,
    {
      bears_on_kind: "hypothesis",
      bears_on_id: hypId1,
      direction: "refutes",
      kind: "negative-result",
      source: { kind: "model_memory" },
      mode: "confirmatory",
      body_md:
        "Zero-representation residue class constructed for characteristic 2: modular distribution fails.",
    },
    authorA,
    201,
  );
  const evKillH1 = EvidenceResponseSchema.parse(evKillH1Res);

  // 6d. Successfully kill H-1 with the valid refuting evidence
  const killH1Res = await call(
    `/v1/sessions/${sessionIdA}/hypotheses/${hypId1}/kill`,
    {
      hypothesis_id: hypId1,
      killed_by_evidence_id: evKillH1.evidence_id,
      reason:
        "Constructed counter-example exhibits a zero-representation residue class in characteristic 2.",
    },
    authorA,
    200,
  );
  const killH1 = HypothesisKillResponseSchema.parse(killH1Res);
  assert.equal(killH1.hypothesis_id, hypId1);
  assert.equal(killH1.status, "killed");

  // 6e. Re-killing an already killed hypothesis is refused with 422 HYPOTHESIS_ALREADY_KILLED (Rule P6)
  const reKillH1 = await call(
    `/v1/sessions/${sessionIdA}/hypotheses/${hypId1}/kill`,
    {
      hypothesis_id: hypId1,
      killed_by_evidence_id: evKillH1.evidence_id,
      reason: "Second kill attempt should be refused.",
    },
    authorA,
    422,
  );
  assert.equal(reKillH1.code, "HYPOTHESIS_ALREADY_KILLED");

  // 6f. Idempotent replay of hypothesis kill with same key returns 200
  const replayKillKey = "idemp_kill_key_002";
  // Submit refuting evidence for H-2
  const evKillH2Res = await call(
    `/v1/sessions/${sessionIdA}/evidence`,
    {
      bears_on_kind: "hypothesis",
      bears_on_id: hypId2,
      direction: "refutes",
      kind: "negative-result",
      source: { kind: "model_memory" },
      mode: "confirmatory",
      body_md: "Minor arc integral divergence observed on quadratic residue subset.",
    },
    authorA,
    201,
  );
  const evKillH2 = EvidenceResponseSchema.parse(evKillH2Res);

  const killH2First = await call(
    `/v1/sessions/${sessionIdA}/hypotheses/${hypId2}/kill`,
    {
      hypothesis_id: hypId2,
      killed_by_evidence_id: evKillH2.evidence_id,
      reason: "Minor arc divergence on quadratic residues.",
    },
    authorA,
    200,
    replayKillKey,
  );
  const killH2Replay = await call(
    `/v1/sessions/${sessionIdA}/hypotheses/${hypId2}/kill`,
    {
      hypothesis_id: hypId2,
      killed_by_evidence_id: evKillH2.evidence_id,
      reason: "Minor arc divergence on quadratic residues.",
    },
    authorA,
    200,
    replayKillKey,
  );
  assert.equal(killH2First.hypothesis_id, killH2Replay.hypothesis_id);
  assert.equal(killH2Replay.status, "killed");

  // 6g. Killing non-existent hypothesis returns 404 HYPOTHESIS_NOT_FOUND
  const killNonexistent = await call(
    `/v1/sessions/${sessionIdA}/hypotheses/H-999/kill`,
    {
      hypothesis_id: "H-999",
      killed_by_evidence_id: evKillH1.evidence_id,
      reason: "Nonexistent hypothesis.",
    },
    authorA,
    404,
  );
  assert.equal(killNonexistent.code, "HYPOTHESIS_NOT_FOUND");

  // 7. Pack Verification
  // 7a. Graveyard pack: includes killed hypotheses with killing evidence and reason
  const graveyardPackRes = await call(
    `/v1/sessions/${sessionIdA}/pack?profile=graveyard`,
    undefined,
    authorA,
    200,
  );
  const graveyardPack = PackResponseSchema.parse(graveyardPackRes);
  const killedItem1 = graveyardPack.items.find((it) => it.id === hypId1);
  assert.ok(killedItem1, `Killed hypothesis ${hypId1} must appear in graveyard pack`);
  assert.equal(killedItem1.kind, "killed-hypothesis");
  assert.ok(
    killedItem1.body.includes(evKillH1.evidence_id),
    "Graveyard item body must cite the killing evidence id",
  );

  const killedItem2 = graveyardPack.items.find((it) => it.id === hypId2);
  assert.ok(killedItem2, `Killed hypothesis ${hypId2} must appear in graveyard pack`);

  // Surviving hypothesis H-3 must NOT appear in the graveyard pack
  const survivingH3InGraveyard = graveyardPack.items.find((it) => it.id === hypId3);
  assert.equal(
    survivingH3InGraveyard,
    undefined,
    "Open hypothesis must not appear in graveyard pack",
  );

  // 7b. Claim pack: includes evidence bearing on Claim C-1
  const claimPackRes = await call(
    `/v1/sessions/${sessionIdA}/pack?profile=claim&target=${claimId}@1`,
    undefined,
    authorA,
    200,
  );
  const claimPack = PackResponseSchema.parse(claimPackRes);
  const evidenceItems = claimPack.items.filter((it) => it.kind === "claim-evidence");
  assert.ok(evidenceItems.length >= 4, "Claim pack must include submitted claim-evidence items");
  assert.ok(
    evidenceItems.some((it) => it.id === evCitation.evidence_id),
    "Citation evidence must be present in claim pack",
  );
  // Under the default token budget, tail evidence items are omitted with honest disclosure
  assert.ok(
    claimPack.omitted.some(
      (o) => o.detail === evComputation.evidence_id && o.reason === "budget_exceeded",
    ),
    "Computation evidence omitted under default budget must be disclosed in omitted[]",
  );

  // When requesting a larger bucket (max_tokens=8000), more evidence items fit
  const largePackRes = await call(
    `/v1/sessions/${sessionIdA}/pack?profile=claim&target=${claimId}@1&max_tokens=8000`,
    undefined,
    authorA,
    200,
  );
  const largePack = PackResponseSchema.parse(largePackRes);
  const largeEvidenceItems = largePack.items.filter((it) => it.kind === "claim-evidence");
  assert.ok(
    largeEvidenceItems.some((it) => it.id === evComputation.evidence_id),
    "Computation evidence must be present in claim pack when expanded to max_tokens=8000",
  );

  // 8. Public Moves Catalog Verification
  // Check GET /moves.json contains available hypothesis and evidence moves
  const movesRes = await call("/moves.json", undefined, undefined, 200);
  assert.ok(movesRes.moves["third-alternative"], "Moves catalog must contain third-alternative");
  assert.equal(movesRes.moves["third-alternative"].availability, "available");
  assert.ok(movesRes.moves["kill-or-stand"], "Moves catalog must contain kill-or-stand");
  assert.equal(movesRes.moves["kill-or-stand"].availability, "available");
  assert.ok(movesRes.moves["add-refuter"], "Moves catalog must contain add-refuter");
  assert.equal(movesRes.moves["add-refuter"].availability, "available");
  assert.ok(movesRes.moves.formalize, "Moves catalog must contain formalize");
  assert.equal(movesRes.moves.formalize.availability, "available");
  assert.ok(
    movesRes.moves["add-refuter-from-friction"],
    "Moves catalog must contain add-refuter-from-friction",
  );
  assert.equal(movesRes.moves["add-refuter-from-friction"].availability, "available");

  // Diptych census over this journey's item faces (lu59 / 92x).
  {
    const census = await faceCensus({
      worker: context.worker,
      origin: context.origin,
      userAgent: context.userAgent,
      params: { id: problemId, version: "1", hid: hypId1, eid: evRefutesClaim.evidence_id },
      kinds: ["hypothesis", "evidence"],
    });
    assert.deepEqual(census.failures, [], "face census");
    // Item faces tracked as unserved (asimposiumorg-qvzk) are reported, not hidden.
    if (census.unservedKinds.length > 0)
      console.log(JSON.stringify({ stage: "face-census-unserved", kinds: census.unservedKinds }));
    assert.deepEqual(
      census.covered.sort(),
      ["hypothesis", "evidence"].sort(),
      "every requested kind resolved",
    );
  }

  console.log(
    JSON.stringify({
      kind: "hypotheses-evidence-real-bindings-complete",
      status: "pass",
      problem: problemId,
      hypotheses: {
        proposed: [hypId1, hypId2],
        third_alternative: hypId3,
        killed: [hypId1, hypId2],
      },
      evidence_classes_verified: [
        "assertion (model_memory)",
        "assertion (locator_without_excerpt)",
        "heuristic (floorless_computation)",
        "citation (locator_and_excerpt)",
        "computation (bounded_domain)",
      ],
      rules_verified: ["P3", "P5", "P6", "P8", "P9"],
      replays_verified: ["hypothesis_propose", "evidence_submit", "hypothesis_kill"],
      packs_verified: ["graveyard", "claim"],
    }),
  );
});
