import assert from "node:assert/strict";
import {
  EvidenceResponseSchema,
  HypothesisEvidenceItemResponseSchema,
  HypothesisKillResponseSchema,
  HypothesisResponseSchema,
  InboxResponseSchema,
  PackResponseSchema,
} from "@asimposium/contracts";
import { ScientificWithdrawalReceiptSchema } from "@asimposium/contracts/scientific-withdrawals";
import { renderHypothesisEvidenceHtml } from "@asimposium/render";
import { parsePublicRecord, resolvePublicRecord } from "../../../web/lib/public-record.ts";
import { faceCensus } from "./face-census.mjs";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";
import { assertProjectionsRebuild } from "./projection-rebuild-check.mjs";

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
  // The independent reviewer records this kill, keeping each actor's real
  // publication budget within the same limits as a normal session.
  const peerSession = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "refute" },
    reviewerB,
    201,
  );
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
    `/v1/sessions/${peerSession.session_id}/hypotheses/${hypId2}/kill`,
    {
      hypothesis_id: hypId2,
      killed_by_evidence_id: evKillH2.evidence_id,
      reason: "Minor arc divergence on quadratic residues.",
    },
    reviewerB,
    200,
    replayKillKey,
  );
  const killH2Replay = await call(
    `/v1/sessions/${peerSession.session_id}/hypotheses/${hypId2}/kill`,
    {
      hypothesis_id: hypId2,
      killed_by_evidence_id: evKillH2.evidence_id,
      reason: "Minor arc divergence on quadratic residues.",
    },
    reviewerB,
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
    `/v1/sessions/${sessionIdA}/pack?profile=graveyard&max_tokens=8000`,
    undefined,
    authorA,
    200,
  );
  const graveyardPack = PackResponseSchema.parse(graveyardPackRes);
  const hypothesisAdmissions = new Map(
    (
      await context.env.DB.prepare(
        "SELECT object_id, seq FROM events WHERE problem_id = ? AND type = 'hypothesis.created'",
      )
        .bind(problemId)
        .all()
    ).results.map((event) => [event.object_id, event.seq]),
  );
  const killedItem1 = graveyardPack.items.find(
    (it) => it.id === `KH-${hypothesisAdmissions.get(hypId1)}`,
  );
  assert.ok(killedItem1, `Killed hypothesis ${hypId1} must appear in graveyard pack`);
  assert.equal(killedItem1.kind, "killed-hypothesis");
  assert.ok(
    killedItem1.body.includes(evKillH1.evidence_id),
    "Graveyard item body must cite the killing evidence id",
  );

  const killedItem2 = graveyardPack.items.find(
    (it) => it.id === `KH-${hypothesisAdmissions.get(hypId2)}`,
  );
  assert.ok(killedItem2, `Killed hypothesis ${hypId2} must appear in graveyard pack`);

  // Surviving hypothesis H-3 must NOT appear in the graveyard pack
  const survivingH3InGraveyard = graveyardPack.items.find(
    (it) => it.id === `KH-${hypothesisAdmissions.get(hypId3)}`,
  );
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
  assert.ok(evidenceItems.length > 0, "Claim pack must include submitted claim-evidence items");
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
    largeEvidenceItems.some((it) => it.id === evCitation.evidence_id),
    "Citation evidence must be present when the complete-record pack budget is expanded",
  );
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

  // Evidence on an attack route reaches its immutable author through the same
  // durable inbox as claim evidence. Bodies stay on the evidence/workshop faces.
  const privateCanary = "HYPOTHESIS-INBOX-PRIVATE-WORKSPACE-CANARY";
  const evidenceCanary = "HYPOTHESIS-INBOX-EVIDENCE-BODY-CANARY";
  await call(
    `/v1/sessions/${peerSession.session_id}/workshop`,
    {
      type: "note",
      title: "Private route review preparation",
      body_md: privateCanary,
      relates_to: [],
    },
    reviewerB,
    201,
  );
  const peerSources = [];
  for (const direction of ["supports", "refutes", "informs"]) {
    const body = {
      bears_on_kind: "hypothesis",
      bears_on_id: hypId3,
      direction,
      kind: "argument",
      source: { kind: "model_memory" },
      mode: "confirmatory",
      body_md: `${evidenceCanary}: ${direction} the recorded bilinear route.`,
    };
    const key = `hypothesis-peer-inbox-${direction}`;
    const evidence = EvidenceResponseSchema.parse(
      await call(`/v1/sessions/${peerSession.session_id}/evidence`, body, reviewerB, 201, key),
    );
    const replay = EvidenceResponseSchema.parse(
      await call(`/v1/sessions/${peerSession.session_id}/evidence`, body, reviewerB, 200, key),
    );
    assert.equal(replay.evidence_id, evidence.evidence_id, "replay keeps the exact evidence");
    const source = await context.env.DB.prepare(
      "SELECT id, payload_sha256 FROM events WHERE problem_id = ? AND object_id = ? AND type = 'evidence.created'",
    )
      .bind(problemId, evidence.evidence_id)
      .first();
    assert.ok(source, "the published evidence has an immutable source event");
    assert.equal(
      (
        await context.env.DB.prepare(
          "SELECT COUNT(*) AS n FROM inbox_event_deliveries WHERE event_id = ?",
        )
          .bind(source.id)
          .first()
      ).n,
      1,
      "publication and replay leave exactly one causal delivery job",
    );
    peerSources.push({ evidence_id: evidence.evidence_id, direction, ...source });
  }
  const inbox = async (token) =>
    InboxResponseSchema.parse(await call("/v1/inbox?since=0&limit=100", undefined, token));
  const hypothesisNotices = (response) =>
    response.items.filter((item) => item.type === "object_critique" && item.target_id === hypId3);
  context.clearWorkerLogs();
  for (let tick = 0; tick < 6; tick++) await context.fixtures.deliverInboxTick();
  const delivered = hypothesisNotices(await inbox(authorA));
  assert.equal(
    delivered.length,
    3,
    "support, refutation and neutral evidence each notify the author",
  );
  assert.deepEqual(
    hypothesisNotices(await inbox(reviewerB)),
    [],
    "the evidence author is not notified",
  );
  assert.ok(
    !(await inbox(authorA)).items.some(
      (item) => item.type === "object_critique" && [hypId1, hypId2].includes(item.target_id),
    ),
    "the author's earlier self-evidence did not notify them",
  );
  for (const source of peerSources) {
    const notice = delivered.find((item) => item.caused_by_event_id === source.id);
    assert.ok(notice, "the notice preserves the exact causal event");
    assert.equal(notice.problem_id, problemId);
    assert.ok(
      notice.detail.includes(source.direction),
      "direction is attributed to the evidence author",
    );
    const urls = notice.next_actions.map((action) => action.url);
    assert.deepEqual(urls, [
      `/p/${problemId}/hypotheses/${hypId3}.json`,
      `/p/${problemId}/evidence/${source.evidence_id}.json`,
    ]);
    for (const url of urls) await call(url, undefined, undefined, 200);
  }
  const noticeBytes = JSON.stringify(delivered);
  assert.ok(!noticeBytes.includes(privateCanary) && !noticeBytes.includes(evidenceCanary));
  const deliveryLogs = JSON.stringify(context.workerLogs());
  assert.ok(!deliveryLogs.includes(privateCanary) && !deliveryLogs.includes(evidenceCanary));
  await call("/v1/inbox/ack", { notice_ids: [delivered[0].id] }, authorA);
  for (let tick = 0; tick < 2; tick++) await context.fixtures.deliverInboxTick();
  const repeated = hypothesisNotices(await inbox(authorA));
  assert.deepEqual(
    repeated.map((item) => item.id),
    delivered.map((item) => item.id),
  );
  assert.ok(repeated.find((item) => item.id === delivered[0].id).acknowledged_at);

  // Current controls also govern previously delivered notices, unread counts and
  // acknowledgments. Restoring content restores the original receipt, not new mail.
  const beforeHide = await inbox(authorA);
  const control = (action) =>
    context.operatorCall("POST", "/v1/operators/content-control", "operator.content.control", {
      target_id: problemId,
      target_kind: "problem",
      action,
      reason: "Inbox route visibility verification.",
    });
  await control("hide");
  const hidden = await inbox(authorA);
  assert.deepEqual(hypothesisNotices(hidden), []);
  assert.equal(hidden.unacknowledged_count, beforeHide.unacknowledged_count - 2);
  const hiddenAck = await call(
    "/v1/inbox/ack",
    { notice_ids: delivered.slice(1).map((item) => item.id) },
    authorA,
  );
  assert.equal(
    hiddenAck.acknowledged_count,
    0,
    "hidden notices cannot be probed through ack counts",
  );
  await control("restore");
  const restored = hypothesisNotices(await inbox(authorA));
  assert.deepEqual(
    restored.map((item) => item.id),
    delivered.map((item) => item.id),
  );
  assert.equal(restored.filter((item) => item.acknowledged_at === null).length, 2);
  console.log(
    JSON.stringify({
      stage: "hypothesis-evidence-inbox",
      notices: delivered.length,
      status: "pass",
    }),
  );

  // The evidence author can correct an exact hypothesis input. Its history
  // stays public while fresh scientific work and inbox actions stop using it.
  const refuter = peerSources.find((source) => source.direction === "refutes");
  const neutral = peerSources.find((source) => source.direction === "informs");
  const withdrawalPath = (source, session = peerSession.session_id) =>
    `/v1/sessions/${session}/evidence/${source.evidence_id}/retract`;
  const withdrawalBody = (source) => ({
    source_event_id: source.id,
    source_digest: `sha256:${source.payload_sha256}`,
    reason: "The author identified an unsupported assumption in this route evidence.",
  });
  const post = async (path, body, key, token = reviewerB) => {
    const response = await context.worker.fetch(`${context.origin}${path}`, {
      method: "POST",
      headers: {
        "User-Agent": context.userAgent,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const nextMoves = async () => {
    const next = await call(`/v1/p/${problemId}/next`, undefined, reviewerB);
    return [next.primary_move, ...(next.alternatives ?? [])].filter(Boolean);
  };
  const offeredKill = (await nextMoves()).find((move) => move.move === "kill-or-stand");
  assert.ok(offeredKill, "current refuting evidence offers its exact kill-or-stand work");
  assert.deepEqual(offeredKill.refs, [problemId, hypId3, refuter.evidence_id]);
  const beforeCorrection = HypothesisEvidenceItemResponseSchema.parse(
    await call(`/p/${problemId}/evidence/${refuter.evidence_id}.json`),
  );
  assert.equal(beforeCorrection.withdrawn, false);
  // The Agora reader consumes these actual Workerd/D1 bytes, not a fabricated
  // `items: []` projection. This validates the shared adapter and human face;
  // it is not a browser or Next-server assertion.
  const humanEvidenceTarget = resolvePublicRecord(["p", problemId, "evidence", refuter.evidence_id]);
  assert.ok(humanEvidenceTarget);
  const humanEvidence = parsePublicRecord(beforeCorrection, humanEvidenceTarget);
  assert.equal(humanEvidence?.kind, "hypothesis-evidence");
  const humanEvidenceHtml = renderHypothesisEvidenceHtml(humanEvidence.face);
  assert.ok(humanEvidenceHtml.includes(`Evidence ${refuter.evidence_id}`));
  assert.ok(humanEvidenceHtml.includes(`data-cursor="${beforeCorrection.cursor}"`));
  assert.ok(humanEvidenceHtml.includes(beforeCorrection.publication.event_id));
  assert.ok(humanEvidenceHtml.includes(beforeCorrection.publication.payload_sha256));
  assert.ok(humanEvidenceHtml.includes("Published scientific body"));
  assert.ok(humanEvidenceHtml.includes("Scientific withdrawal: <strong>not recorded</strong>"));
  const originalSource = await context.env.DB.prepare(
    `SELECT e.*, c.payload_json AS source_payload, c.payload_sha256 AS content_digest,
      c.redacted_at FROM events e JOIN event_content c ON c.event_id=e.id WHERE e.id=?`,
  )
    .bind(refuter.id)
    .first();
  const sourceRows = async (source) =>
    context.env.DB.prepare(
      `SELECT e.*, c.payload_json AS source_payload, c.payload_sha256 AS content_digest,
      c.redacted_at FROM events e JOIN event_content c ON c.event_id=e.id WHERE e.id=?`,
    )
      .bind(source.id)
      .first();
  const scalar = async (sql, ...bindings) =>
    (
      await context.env.DB.prepare(sql)
        .bind(...bindings)
        .first()
    ).n;
  const publicEffects = async () => ({
    head: await context.env.DB.prepare("SELECT public_seq, chain_digest FROM problems WHERE id=?")
      .bind(problemId)
      .first(),
    events: await scalar("SELECT COUNT(*) AS n FROM events WHERE problem_id=?", problemId),
    contents: await scalar(
      "SELECT COUNT(*) AS n FROM event_content c JOIN events e ON e.id=c.event_id WHERE e.problem_id=?",
      problemId,
    ),
    retractions: await scalar(
      "SELECT COUNT(*) AS n FROM retractions WHERE problem_id=?",
      problemId,
    ),
    withdrawals: await scalar(
      "SELECT COUNT(*) AS n FROM scientific_withdrawals WHERE problem_id=?",
      problemId,
    ),
    checkpoints: await scalar(
      "SELECT COUNT(*) AS n FROM integrity_checkpoints WHERE problem_id=?",
      problemId,
    ),
    replay_receipts: await scalar(
      "SELECT COUNT(*) AS n FROM idempotency WHERE problem_id=? AND event_id IS NOT NULL",
      problemId,
    ),
    screens: await scalar(
      "SELECT COUNT(*) AS n FROM screening_publications p JOIN events e ON e.id=p.event_id WHERE e.problem_id=?",
      problemId,
    ),
    public_cursor: await scalar("SELECT cursor AS n FROM public_cursor WHERE singleton=1"),
  });
  const beforeRefusals = await publicEffects();
  const rejectedAuthor = await post(
    withdrawalPath(refuter, sessionIdA),
    withdrawalBody(refuter),
    "withdraw-wrong-author",
    authorA,
  );
  assert.equal(rejectedAuthor.status, 401, "a hypothesis author cannot withdraw a peer's evidence");
  const rejectedSource = await post(
    withdrawalPath(refuter),
    withdrawalBody(neutral),
    "withdraw-wrong-source",
  );
  assert.equal(rejectedSource.status, 401, "the target and source event must agree");
  const rejectedDigest = await post(
    withdrawalPath(refuter),
    {
      ...withdrawalBody(refuter),
      source_digest: `sha256:${"0".repeat(64)}`,
    },
    "withdraw-wrong-digest",
  );
  assert.equal(rejectedDigest.status, 401, "the source digest must agree with the immutable event");
  assert.deepEqual(
    await publicEffects(),
    beforeRefusals,
    "refused correction attempts publish nothing",
  );
  const beforeWithdrawalInbox = await inbox(authorA);
  const refuterNotice = hypothesisNotices(beforeWithdrawalInbox).find(
    (item) => item.caused_by_event_id === refuter.id,
  );
  assert.ok(refuterNotice && refuterNotice.acknowledged_at === null);
  const overlapping = await Promise.all(
    Array.from({ length: 6 }, () =>
      post(withdrawalPath(refuter), withdrawalBody(refuter), "withdraw-hypothesis-refuter"),
    ),
  );
  assert.ok(overlapping.some((result) => result.status === 200));
  assert.ok(
    overlapping.every((result) => [200, 429].includes(result.status)),
    "an in-flight replay may wait for the charged request; it cannot create a second correction",
  );
  const correction = ScientificWithdrawalReceiptSchema.parse(
    overlapping.find((result) => result.status === 200).body,
  );
  assert.equal(correction.hypothesis_id, hypId3);
  assert.equal(correction.target_event_id, refuter.id);
  assert.equal(correction.target_digest, `sha256:${refuter.payload_sha256}`);
  assert.equal("claim_id" in correction, false);
  assert.equal("claim_version" in correction, false);
  for (const result of overlapping.filter((result) => result.status === 200))
    assert.deepEqual(result.body, correction);
  const committedEffects = await publicEffects();
  assert.deepEqual(
    await call(
      withdrawalPath(refuter),
      withdrawalBody(refuter),
      reviewerB,
      200,
      "withdraw-hypothesis-refuter",
    ),
    correction,
  );
  assert.deepEqual(
    await publicEffects(),
    committedEffects,
    "same-key replay preserves every public effect",
  );
  const duplicateCorrection = await post(
    withdrawalPath(refuter),
    withdrawalBody(refuter),
    "withdraw-hypothesis-duplicate",
  );
  assert.equal(duplicateCorrection.status, 409);
  assert.equal(
    await scalar(
      "SELECT COUNT(*) AS n FROM scientific_withdrawals WHERE source_event_id=?",
      refuter.id,
    ),
    1,
  );
  assert.deepEqual(
    await sourceRows(refuter),
    originalSource,
    "the original event and scientific bytes stay immutable",
  );
  const withdrawn = HypothesisEvidenceItemResponseSchema.parse(
    await call(`/p/${problemId}/evidence/${refuter.evidence_id}.json`),
  );
  assert.equal(withdrawn.withdrawn, true);
  assert.deepEqual(withdrawn.publication, beforeCorrection.publication);
  assert.deepEqual(withdrawn.content, beforeCorrection.content);
  assert.equal(withdrawn.computed.drives_promotion, false);
  const humanWithdrawn = parsePublicRecord(withdrawn, humanEvidenceTarget);
  assert.equal(humanWithdrawn?.kind, "hypothesis-evidence");
  const humanWithdrawnHtml = renderHypothesisEvidenceHtml(humanWithdrawn.face);
  assert.ok(humanWithdrawnHtml.includes("Scientific withdrawal: <strong>withdrawn</strong>"));
  assert.ok(humanWithdrawnHtml.includes("cannot drive promotion"));
  assert.ok(humanWithdrawnHtml.includes(withdrawn.publication.payload_sha256));
  assert.ok(
    !(await nextMoves()).some((move) => move.move === "kill-or-stand"),
    "the current work selector drops the withdrawn refuter",
  );
  const correctedInbox = await inbox(authorA);
  assert.ok(!correctedInbox.items.some((item) => item.id === refuterNotice.id));
  assert.equal(correctedInbox.unacknowledged_count, beforeWithdrawalInbox.unacknowledged_count - 1);
  const correctedAck = await call("/v1/inbox/ack", { notice_ids: [refuterNotice.id] }, authorA);
  assert.equal(
    correctedAck.acknowledged_count,
    0,
    "withdrawn evidence cannot expose a stale notice through acknowledgment",
  );
  const beforeStaleKill = await publicEffects();
  const beforeStaleKillScreens = await context.fixtures.screeningCalls();
  const staleKill = await post(
    `/v1/sessions/${peerSession.session_id}/hypotheses/${hypId3}/kill`,
    {
      hypothesis_id: hypId3,
      killed_by_evidence_id: refuter.evidence_id,
      reason: "This stale attempt must not eliminate a route with withdrawn evidence.",
    },
    "withdrawn-refuter-cannot-kill",
  );
  assert.equal(staleKill.status, 422, "withdrawn evidence cannot authorize a new elimination");
  assert.equal(staleKill.body.code, "EVIDENCE_BODY_INVALID");
  assert.equal(
    await context.fixtures.screeningCalls(),
    beforeStaleKillScreens,
    "an already withdrawn source refuses before paid screening",
  );
  assert.deepEqual(await publicEffects(), beforeStaleKill, "a stale kill changes no public state");
  assert.equal(
    (
      await context.env.DB.prepare(
        "SELECT status FROM hypotheses WHERE problem_id=? AND hypothesis_id=?",
      )
        .bind(problemId, hypId3)
        .first()
    ).status,
    "open",
  );

  // A late database failure rolls back the entire correction; its unchanged
  // caller identity remains retryable under the ordinary publication budget.
  await context.env.DB.prepare(`CREATE TRIGGER hypothesis_withdrawal_fault BEFORE INSERT ON scientific_withdrawals
    BEGIN SELECT RAISE(ABORT,'INJECTED_HYPOTHESIS_WITHDRAWAL_FAILURE'); END`).run();
  try {
    const beforeFault = await publicEffects();
    const failed = await post(
      withdrawalPath(neutral),
      withdrawalBody(neutral),
      "withdraw-hypothesis-fault",
    );
    assert.equal(failed.status, 503);
    assert.deepEqual(await publicEffects(), beforeFault);
    assert.equal(
      HypothesisEvidenceItemResponseSchema.parse(
        await call(`/p/${problemId}/evidence/${neutral.evidence_id}.json`),
      ).withdrawn,
      false,
    );
  } finally {
    await context.env.DB.prepare("DROP TRIGGER hypothesis_withdrawal_fault").run();
  }
  const retriedCorrection = ScientificWithdrawalReceiptSchema.parse(
    await call(
      withdrawalPath(neutral),
      withdrawalBody(neutral),
      reviewerB,
      200,
      "withdraw-hypothesis-fault",
    ),
  );
  assert.equal(retriedCorrection.target_event_id, neutral.id);

  // Use the actual governance route to make the evidence author an observer.
  // The same authority that admits their evidence must admit its correction.
  await govern(
    {
      action: "manage-member",
      operation: "set-role",
      target_fellow_id: fellowIdB,
      role: "observer",
    },
    "reviewer-now-observer",
  );
  const observerEvidence = EvidenceResponseSchema.parse(
    await call(
      `/v1/sessions/${peerSession.session_id}/evidence`,
      {
        bears_on_kind: "hypothesis",
        bears_on_id: hypId3,
        direction: "informs",
        kind: "argument",
        source: { kind: "model_memory" },
        mode: "exploratory",
        body_md: "An observer records a bounded observation about the route.",
      },
      reviewerB,
      201,
      "observer-hypothesis-evidence",
    ),
  );
  const observerSource = {
    evidence_id: observerEvidence.evidence_id,
    ...(await context.env.DB.prepare(
      "SELECT id,payload_sha256 FROM events WHERE problem_id=? AND object_id=? AND type='evidence.created'",
    )
      .bind(problemId, observerEvidence.evidence_id)
      .first()),
  };
  const observerCorrection = ScientificWithdrawalReceiptSchema.parse(
    await call(
      withdrawalPath(observerSource),
      withdrawalBody(observerSource),
      reviewerB,
      200,
      "observer-hypothesis-withdrawal",
    ),
  );
  assert.equal(observerCorrection.hypothesis_id, hypId3);
  assert.equal(
    (
      await context.env.DB.prepare(
        "SELECT role FROM problem_memberships WHERE problem_id=? AND fellow_id=?",
      )
        .bind(problemId, fellowIdB)
        .first()
    ).role,
    "observer",
  );
  assert.equal(
    HypothesisEvidenceItemResponseSchema.parse(
      await call(`/p/${problemId}/evidence/${observerEvidence.evidence_id}.json`),
    ).withdrawn,
    true,
  );
  for (let tick = 0; tick < 2; tick++) await context.fixtures.deliverInboxTick();
  assert.ok(
    !(await inbox(authorA)).items.some((item) => item.caused_by_event_id === observerSource.id),
    "evidence withdrawn before delivery creates no stale inbox notice",
  );

  // Another contributor starts an elimination while its evidence author finds
  // an error. The correction wins before the held kill screen can commit.
  const killReviewer = await enroll("he-kill-reviewer-c", "usr_he_kill_c");
  const killReviewSession = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "refute" },
    killReviewer,
    201,
  );
  const counterevidence = async (key) => {
    const result = EvidenceResponseSchema.parse(
      await call(
        `/v1/sessions/${peerSession.session_id}/evidence`,
        {
          bears_on_kind: "hypothesis",
          bears_on_id: hypId3,
          direction: "refutes",
          kind: "argument",
          source: { kind: "model_memory" },
          mode: "confirmatory",
          body_md: `A bounded counterexample report with a declared assumption (${key}).`,
        },
        reviewerB,
        201,
        key,
      ),
    );
    return {
      evidence_id: result.evidence_id,
      ...(await context.env.DB.prepare(
        "SELECT id,payload_sha256 FROM events WHERE problem_id=? AND object_id=? AND type='evidence.created'",
      )
        .bind(problemId, result.evidence_id)
        .first()),
    };
  };
  const racingSource = await counterevidence("withdrawal-during-kill-screen");
  const killBody = (source) => ({
    hypothesis_id: hypId3,
    killed_by_evidence_id: source.evidence_id,
    reason: "The recorded counterexample defeats this route under its declared assumptions.",
  });
  const killRoute = `/v1/sessions/${killReviewSession.session_id}/hypotheses/${hypId3}/kill`;
  const heldScreens = await context.fixtures.screeningCalls();
  let racedKill;
  await context.fixtures.pauseScreening(3000);
  try {
    const pending = post(killRoute, killBody(racingSource), "kill-withdrawal-race", killReviewer);
    const deadline = Date.now() + 10_000;
    while ((await context.fixtures.screeningCalls()) === heldScreens && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      await context.fixtures.screeningCalls(),
      heldScreens + 1,
      "the kill reached its delayed screen",
    );
    // The first request retains its timer; new requests can now screen normally.
    await context.fixtures.resumeScreening();
    const racedCorrection = ScientificWithdrawalReceiptSchema.parse(
      await call(
        withdrawalPath(racingSource),
        withdrawalBody(racingSource),
        reviewerB,
        200,
        "author-corrects-during-kill",
      ),
    );
    assert.equal(racedCorrection.target_event_id, racingSource.id);
    const afterWinningCorrection = await publicEffects();
    racedKill = await pending;
    assert.equal(racedKill.status, 422);
    assert.equal(racedKill.body.code, "EVIDENCE_BODY_INVALID");
    assert.deepEqual(
      await publicEffects(),
      afterWinningCorrection,
      "the winning correction leaves no kill event, projection, checkpoint or receipt prefix",
    );
    assert.equal(
      (
        await context.env.DB.prepare(
          "SELECT status FROM hypotheses WHERE problem_id=? AND hypothesis_id=?",
        )
          .bind(problemId, hypId3)
          .first()
      ).status,
      "open",
    );
  } finally {
    await context.fixtures.resumeScreening();
  }

  // Correcting the source of an already recorded elimination cannot rewrite
  // that historical result or silently revive a route.
  const committedKillSource = await counterevidence("correction-after-recorded-elimination");
  const recordedKill = await post(
    killRoute,
    killBody(committedKillSource),
    "recorded-kill-before-correction",
    killReviewer,
  );
  assert.equal(recordedKill.status, 200);
  const originalElimination = await context.env.DB.prepare(
    "SELECT * FROM hypotheses WHERE problem_id=? AND hypothesis_id=?",
  )
    .bind(problemId, hypId3)
    .first();
  assert.equal(originalElimination.status, "killed");
  const afterKillCorrection = ScientificWithdrawalReceiptSchema.parse(
    await call(
      withdrawalPath(committedKillSource),
      withdrawalBody(committedKillSource),
      reviewerB,
      200,
      "correct-already-used-evidence",
    ),
  );
  assert.equal(afterKillCorrection.hypothesis_id, hypId3);
  assert.deepEqual(
    await context.env.DB.prepare("SELECT * FROM hypotheses WHERE problem_id=? AND hypothesis_id=?")
      .bind(problemId, hypId3)
      .first(),
    originalElimination,
  );
  assert.equal(
    HypothesisEvidenceItemResponseSchema.parse(
      await call(`/p/${problemId}/evidence/${committedKillSource.evidence_id}.json`),
    ).withdrawn,
    true,
  );
  assert.deepEqual(
    (
      await post(
        killRoute,
        killBody(committedKillSource),
        "recorded-kill-before-correction",
        killReviewer,
      )
    ).body,
    recordedKill.body,
    "a winning historical kill receipt still replays after its evidence is corrected",
  );
  console.log(
    JSON.stringify({
      stage: "hypothesis-evidence-withdrawal",
      status: "pass",
      owner_withdrawal: true,
      concurrent_replay: true,
      late_rollback_and_retry: true,
      observer_publish_and_correct: true,
      withdrawn_refuter_kill_status: staleKill.status,
      correction_during_kill_status: racedKill.status,
      prior_elimination_preserved: true,
    }),
  );

  // Diptych census over this journey's item faces (lu59 / 92x).
  {
    const census = await faceCensus({
      worker: context.worker,
      origin: context.origin,
      userAgent: context.userAgent,
      params: { id: problemId, version: "1", hid: hypId1, eid: evRefutesClaim.evidence_id },
      kinds: ["hypothesis", "evidence", "hypotheses-list"],
    });
    assert.deepEqual(census.failures, [], "face census");
    // Item faces tracked as unserved (asimposiumorg-qvzk) are reported, not hidden.
    if (census.unservedKinds.length > 0)
      console.log(JSON.stringify({ stage: "face-census-unserved", kinds: census.unservedKinds }));
    assert.deepEqual(
      census.covered.sort(),
      ["hypothesis", "evidence", "hypotheses-list"].sort(),
      "every requested kind resolved",
    );
  }

  // W2.6: every projection row this journey built is reproducible from the log.
  const rebuilt = await assertProjectionsRebuild(context.env.DB, problemId);
  console.log(JSON.stringify({ stage: "projection-rebuild", ...rebuilt }));

  console.log(
    JSON.stringify({
      kind: "hypotheses-evidence-real-bindings-complete",
      status: "pass",
      problem: problemId,
      hypotheses: {
        proposed: [hypId1, hypId2],
        third_alternative: hypId3,
        killed: [hypId1, hypId2, hypId3],
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
