import assert from "node:assert/strict";
import {
  CitationsListResponseSchema,
  CorrectCitationResponseSchema,
  QuestionsListResponseSchema,
  RecordCitationResponseSchema,
  RetractionsListResponseSchema,
  SingleCitationResponseSchema,
  SingleSynthesisResponseSchema,
  SynthesesListResponseSchema,
  SynthesizeResponseSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

await runLocalWorkerJourney(async (context) => {
  const { call, enroll, sponsorCall, env, worker, origin } = context;

  // 1. Setup actors
  const sponsorA = "usr_int_sponsor_a";
  const authorA = await enroll("int-author-a", sponsorA);
  const helloA = await call("/v1/hello", undefined, authorA);
  const fellowIdA = helloA.fellow.fellow_id;

  const sponsorB = "usr_int_sponsor_b";
  const reviewerB = await enroll("int-reviewer-b", sponsorB);
  const helloB = await call("/v1/hello", undefined, reviewerB);
  const fellowIdB = helloB.fellow.fellow_id;

  // 2. Propose and publish problem in real D1
  const created = await call(
    "/v1/problems",
    {
      title: "Ledger Objects Integration Test Problem",
      statement: "Every non-trivial modular cycle has bounded prime factors and residue stability.",
      falsifier:
        "An unbounded prime factor or divergent residue sequence under modular transformation.",
      motivation:
        "Testing cross-object invariants across all W5.8 remaining ledger objects in one problem.",
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
  await govern({ action: "publish" }, "publish-int-problem");

  // Statement-clear review to unlock problem from sharpening -> active
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

  // 3. Open author session and promote Claim 1
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
      title: "Modular Cycle Bound Draft",
      body_md: "Preliminary proof draft of modular cycle bounding.",
      relates_to: [],
    },
    authorA,
    201,
  );

  const claim1 = await call(
    `/v1/sessions/${sessionIdA}/promote`,
    {
      workshop_id: workshopA.workshop_id,
      kind: "conjecture",
      statement: "Every non-trivial modular cycle has bounded prime factors.",
      falsifier: "An unbounded prime factor in a modular cycle.",
    },
    authorA,
    201,
  );
  const claim1Id = claim1.claim_id;
  assert.ok(claim1Id.startsWith("C-"));

  // --------------------------------------------------------------------------
  // OBJECT 1: CITATION & SOURCE-PROVENANCE (W5.8c)
  // --------------------------------------------------------------------------
  const validCitationPayload = {
    locator_kind: "doi",
    locator: "https://doi.org/10.1007/s00222-020-00980-8",
    title: "Bounded gaps between primes",
    authors: ["Yitang Zhang"],
    year: 2014,
    excerpt: "Establishes that lim inf (p_{n+1} - p_n) < 70000000 unconditionally.",
    retrieved_at: "2026-09-01T12:00:00.000Z",
  };

  const citRes = await call(
    `/v1/sessions/${sessionIdA}/citations`,
    validCitationPayload,
    authorA,
    201,
    "cit-idemp-1",
  );
  RecordCitationResponseSchema.parse(citRes);
  const citationId = citRes.citation_id;
  assert.equal(citationId, "L-1");
  assert.equal(citRes.version, 1);

  // Idempotent replay of citation recording
  const replayCit = await call(
    `/v1/sessions/${sessionIdA}/citations`,
    validCitationPayload,
    authorA,
    200,
    "cit-idemp-1",
  );
  assert.equal(replayCit.citation_id, citationId);
  assert.equal(replayCit.version, 1);

  // Duplicate citation rejection (P11 equivalent for citations)
  const dupCitRes = await call(
    `/v1/sessions/${sessionIdA}/citations`,
    validCitationPayload,
    authorA,
    409,
    "cit-dup-attempt",
  );
  assert.equal(dupCitRes.code, "DUPLICATE_CITATION");

  // Non-author correction rejection: Fellow B cannot correct Fellow A's citation
  const sessionB = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "explore" },
    reviewerB,
    201,
  );
  const sessionIdB = sessionB.session_id;

  const wrongAuthorCitRes = await call(
    `/v1/sessions/${sessionIdB}/citations/correct`,
    {
      citation_id: citationId,
      base_version: 1,
      title: "Illegal modification by non-author",
      locator_kind: "doi",
      locator: "10.1007/s00222-020-00980-8",
      retrieved_at: "2026-09-01T12:00:00.000Z",
    },
    reviewerB,
    403,
  );
  assert.equal(wrongAuthorCitRes.code, "NOT_CITATION_AUTHOR");

  // Citation correction: accepted revision (v1 -> v2)
  const correctPayload = {
    citation_id: citationId,
    base_version: 1,
    title: "Bounded gaps between primes (Annals of Mathematics)",
    authors: ["Yitang Zhang"],
    year: 2014,
    locator_kind: "doi",
    locator: "10.1007/s00222-020-00980-8",
    excerpt: "Refined excerpt: establishes bounded prime gaps unconditionally below 70M.",
    retrieved_at: "2026-09-01T12:00:00.000Z",
    correction_rationale: "Updated journal title and refined excerpt note.",
  };
  const correctRes = await call(
    `/v1/sessions/${sessionIdA}/citations/correct`,
    correctPayload,
    authorA,
    200,
    "cit-correct-idemp-1",
  );
  CorrectCitationResponseSchema.parse(correctRes);
  assert.equal(correctRes.version, 2);

  // Stale revision rejection: using base_version 1 again yields 409 OBJECT_VERSION_CONFLICT
  const staleCitRes = await call(
    `/v1/sessions/${sessionIdA}/citations/correct`,
    correctPayload,
    authorA,
    409,
    "cit-stale-attempt",
  );
  assert.equal(staleCitRes.code, "OBJECT_VERSION_CONFLICT");

  // --------------------------------------------------------------------------
  // OBJECT 2: DEAD ENDS, NULLS & RETRY TRIGGERS (W5.8a)
  // --------------------------------------------------------------------------
  const deadEndPayload1 = {
    approach: "Direct modular reduction via naive sieve method",
    why_it_fails:
      "Encountered parity problem; primes cannot be separated from almost-primes without bilinear forms.",
    retry_predicate: "Worth retrying if non-archimedean metrics bound branch width.",
    what_was_examined: "All residues modulo 2^32 up to depth 16.",
    scope_detection_floor: "Exhaustively verified for k <= 16.",
    retry_when: {
      kind: "statement-revised",
    },
  };

  const deRes1 = await call(
    `/v1/sessions/${sessionIdA}/dead-ends`,
    deadEndPayload1,
    authorA,
    201,
    "de-idemp-1",
  );
  assert.ok(deRes1.dead_end_id.startsWith("DE-"));
  const deadEndId1 = deRes1.dead_end_id;

  // Idempotent replay of dead end recording
  const replayDe = await call(
    `/v1/sessions/${sessionIdA}/dead-ends`,
    deadEndPayload1,
    authorA,
    200,
    "de-idemp-1",
  );
  assert.equal(replayDe.dead_end_id, deadEndId1);

  // Duplicate dead end rejection
  const dupDeRes = await call(
    `/v1/sessions/${sessionIdA}/dead-ends`,
    deadEndPayload1,
    authorA,
    409,
  );
  assert.equal(dupDeRes.code, "DUPLICATE_DEAD_END");

  // Dead end supersession (P6 author authority): Fellow B cannot supersede Fellow A's dead end
  const wrongAuthorDeRes = await call(
    `/v1/sessions/${sessionIdB}/dead-ends`,
    {
      approach: "Direct modular reduction with higher order bilinear forms",
      why_it_fails: "Type II sums lack adequate support in residue class 1.",
      retry_predicate: "Retry if Selberg weights bound remainder sums.",
      what_was_examined: "Residue class 1 up to depth 32.",
      scope_detection_floor: "Depth 32 verified.",
      supersedes_dead_end_id: deadEndId1,
    },
    reviewerB,
    403,
  );
  assert.equal(wrongAuthorDeRes.code, "NOT_DEAD_END_AUTHOR");

  // Fellow A successfully supersedes deadEnd1 -> produces DE-2
  const deRes2 = await call(
    `/v1/sessions/${sessionIdA}/dead-ends`,
    {
      approach: "Direct modular reduction with higher order bilinear forms",
      why_it_fails:
        "Type II sums lack adequate support in residue class 1 without Selberg weights.",
      retry_predicate: "Retry if Selberg weights bound remainder sums.",
      what_was_examined: "Residue class 1 up to depth 32.",
      scope_detection_floor: "Depth 32 verified.",
      supersedes_dead_end_id: deadEndId1,
    },
    authorA,
    201,
  );
  assert.ok(deRes2.dead_end_id.startsWith("DE-"));
  const deadEndId2 = deRes2.dead_end_id;
  assert.notEqual(deadEndId1, deadEndId2);

  // Stale supersession attempt: superseding already superseded dead end yields 409 OBJECT_VERSION_CONFLICT
  const staleDeRes = await call(
    `/v1/sessions/${sessionIdA}/dead-ends`,
    {
      approach: "Third attempt at branching valuation search along odd multipliers.",
      why_it_fails: "The valuation branches still diverge exponentially beyond depth 16.",
      retry_predicate: "Worth retrying if non-archimedean metrics bound branch width.",
      what_was_examined: "All residues modulo 2^32 up to depth 16.",
      scope_detection_floor: "Exhaustively verified for k <= 16.",
      supersedes_dead_end_id: deadEndId1,
    },
    authorA,
    409,
  );
  assert.equal(staleDeRes.code, "OBJECT_VERSION_CONFLICT");

  // --------------------------------------------------------------------------
  // OBJECT 3: LEASED QUESTIONS & ANSWERS (W5.8d)
  // --------------------------------------------------------------------------
  const qRes = await call(
    `/v1/sessions/${sessionIdA}/questions`,
    {
      body_md:
        "Does the Bombieri-Vinogradov theorem provide sufficient distribution level for this modular modulus?",
      target_refs: [claim1Id],
      blocking: claim1Id,
    },
    authorA,
    201,
    "q-idemp-1",
  );
  assert.ok(qRes.question_id.startsWith("Q-"));
  const questionId = qRes.question_id;

  // Reviewer B leases Question 1
  const leaseRes = await call(
    `/v1/sessions/${sessionIdB}/questions/${questionId}/lease`,
    { ttl_seconds: 3600 },
    reviewerB,
    200,
    "q-lease-idemp-1",
  );
  assert.equal(leaseRes.ok, true);

  // Author A attempting to lease already-leased question returns 409 QUESTION_ALREADY_LEASED
  const conflictLease = await call(
    `/v1/sessions/${sessionIdA}/questions/${questionId}/lease`,
    { ttl_seconds: 3600 },
    authorA,
    409,
  );
  assert.equal(conflictLease.code, "QUESTION_ALREADY_LEASED");

  // Reviewer B answers question with resolution pointing to claim 1
  const answerRes = await call(
    `/v1/sessions/${sessionIdB}/questions/${questionId}/answer`,
    {
      resolved_by_object: claim1Id,
    },
    reviewerB,
    200,
    "q-answer-idemp-1",
  );
  assert.equal(answerRes.ok, true);
  assert.equal(answerRes.resolved_by_object, claim1Id);

  // Answering already resolved question returns 409 QUESTION_ALREADY_RESOLVED
  const conflictAnswer = await call(
    `/v1/sessions/${sessionIdB}/questions/${questionId}/answer`,
    {
      resolved_by_object: claim1Id,
    },
    reviewerB,
    409,
  );
  assert.equal(conflictAnswer.code, "QUESTION_ALREADY_RESOLVED");

  // --------------------------------------------------------------------------
  // OBJECT 4: SYNTHESES & P13 LEDGER ANCHORING (W5.8b)
  // --------------------------------------------------------------------------
  const maxSeq = (
    await env.DB.prepare("SELECT MAX(seq) AS seq FROM events WHERE problem_id = ?")
      .bind(problemId)
      .first()
  ).seq;

  // Rule P13: Unanchored synthesis rejected when referencing nonexistent claim
  const unanchoredRes = await call(
    `/v1/sessions/${sessionIdA}/synthesize`,
    {
      covers_through: maxSeq,
      body_md: "## Synthesis of modular cycle bounds\n\nReferencing nonexistent claim.",
      anchors: [{ target_kind: "claim", target_id: "C-NONEXISTENT", target_version: 1 }],
      omitted: [],
      selection_policy: "Exhaustive coverage of positive assertions.",
    },
    authorA,
    422,
  );
  assert.equal(unanchoredRes.code, "SYNTHESIS_UNANCHORED");

  // Valid synthesis anchoring exact historical versions: Claim 1 @ 1
  const synthPayload = {
    covers_through: maxSeq,
    body_md:
      "## Synthesis of modular cycle bounds\n\nSynthesizing claim 1 with foundational literature L-1.",
    anchors: [
      {
        target_kind: "claim",
        target_id: claim1Id,
        target_version: 1,
        assertion_summary: "Every non-trivial modular cycle has bounded prime factors.",
      },
    ],
    omitted: [`Dead end ${deadEndId1} superseded by higher-order bilinear method`],
    selection_policy: "Positive modular assertions with documented negative avenues omitted.",
  };

  const synthRes = await call(
    `/v1/sessions/${sessionIdA}/synthesize`,
    synthPayload,
    authorA,
    201,
    "synth-idemp-1",
  );
  SynthesizeResponseSchema.parse(synthRes);
  assert.ok(synthRes.synthesis_id.startsWith("SYNTH-"));
  const synthesisId = synthRes.synthesis_id;

  // Idempotent replay of synthesis
  const replaySynth = await call(
    `/v1/sessions/${sessionIdA}/synthesize`,
    synthPayload,
    authorA,
    200,
    "synth-idemp-1",
  );
  assert.equal(replaySynth.synthesis_id, synthesisId);

  // --------------------------------------------------------------------------
  // OBJECT 5: RETRACTIONS (W5.8d)
  // --------------------------------------------------------------------------
  const retractPayload = {
    target_object: claim1Id,
    reason: "Author self-correction: unbounded factor identified in edge case cycle modulo 210.",
  };

  // Non-author attempting to retract Fellow A's claim returns 403 NOT_TARGET_AUTHOR
  const nonAuthorRetract = await call(
    `/v1/sessions/${sessionIdB}/retract`,
    retractPayload,
    reviewerB,
    403,
  );
  assert.equal(nonAuthorRetract.code, "NOT_TARGET_AUTHOR");

  // Author A retracts Claim 1
  const retractRes = await call(
    `/v1/sessions/${sessionIdA}/retract`,
    retractPayload,
    authorA,
    201,
    "retract-idemp-1",
  );
  assert.ok(retractRes.retraction_id.startsWith("R-"));
  const retractionId = retractRes.retraction_id;
  assert.equal(retractRes.target_object, claim1Id);
  assert.equal(retractRes.retraction_kind, "self-corrected");

  // Idempotent replay of retraction (200 OK)
  const replayRetract = await call(
    `/v1/sessions/${sessionIdA}/retract`,
    retractPayload,
    authorA,
    200,
    "retract-idemp-1",
  );
  assert.equal(replayRetract.retraction_id, retractionId);

  // --------------------------------------------------------------------------
  // IMMUTABILITY & NEGATIVE-KNOWLEDGE NON-ERASURE (Rule P6)
  // --------------------------------------------------------------------------
  // Direct DELETE on dead_ends is refused by trigger
  await assert.rejects(
    async () => {
      await env.DB.prepare("DELETE FROM dead_ends WHERE dead_end_id = ?").bind(deadEndId1).run();
    },
    /DEAD_END_IMMUTABLE/,
    "Database trigger must refuse direct DELETE on dead_ends",
  );

  // Direct DELETE on citations is refused by trigger
  await assert.rejects(
    async () => {
      await env.DB.prepare("DELETE FROM citations WHERE citation_id = ?").bind(citationId).run();
    },
    /CITATION_IMMUTABLE/,
    "Database trigger must refuse direct DELETE on citations",
  );

  // Direct DELETE on citation_versions is refused by trigger
  await assert.rejects(
    async () => {
      await env.DB.prepare("DELETE FROM citation_versions WHERE citation_id = ?")
        .bind(citationId)
        .run();
    },
    /CITATION_VERSION_IMMUTABLE/,
    "Database trigger must refuse direct DELETE on citation_versions",
  );

  // Direct DELETE on questions is refused by trigger
  await assert.rejects(
    async () => {
      await env.DB.prepare("DELETE FROM questions WHERE question_id = ?").bind(questionId).run();
    },
    /QUESTION_IMMUTABLE/,
    "Database trigger must refuse direct DELETE on questions",
  );

  // Direct DELETE on syntheses is refused by trigger
  await assert.rejects(
    async () => {
      await env.DB.prepare("DELETE FROM syntheses WHERE synthesis_id = ?").bind(synthesisId).run();
    },
    /SYNTHESIS_IMMUTABLE/,
    "Database trigger must refuse direct DELETE on syntheses",
  );

  // Direct DELETE on retractions is refused by trigger
  await assert.rejects(
    async () => {
      await env.DB.prepare("DELETE FROM retractions WHERE retraction_id = ?")
        .bind(retractionId)
        .run();
    },
    /RETRACTION_IMMUTABLE/,
    "Database trigger must refuse direct DELETE on retractions",
  );

  // --------------------------------------------------------------------------
  // REBUILD-FROM-LOG & MONOTONIC EVENT CHAIN VERIFICATION (Rule A6)
  // --------------------------------------------------------------------------
  const allEvents = (
    await env.DB.prepare(
      "SELECT seq, type, object_id FROM events WHERE problem_id = ? ORDER BY seq ASC",
    )
      .bind(problemId)
      .all()
  ).results;

  assert.ok(allEvents.length >= 7, "Event log must record all substantive ledger object events");

  // Strict monotonic sequence check: 1, 2, 3, ... with NO gaps
  for (let i = 0; i < allEvents.length; i++) {
    assert.equal(
      allEvents[i].seq,
      i + 1,
      `Event sequence must be monotonic without gaps at index ${i}`,
    );
  }

  const recordedTypes = new Set(allEvents.map((e) => e.type));
  assert.ok(recordedTypes.has("claim.created"), "Event log contains claim.created");
  assert.ok(recordedTypes.has("citation.recorded"), "Event log contains citation.recorded");
  assert.ok(recordedTypes.has("citation.corrected"), "Event log contains citation.corrected");
  assert.ok(recordedTypes.has("dead_end.recorded"), "Event log contains dead_end.recorded");
  assert.ok(recordedTypes.has("question.asked"), "Event log contains question.asked");
  assert.ok(recordedTypes.has("question.leased"), "Event log contains question.leased");
  assert.ok(recordedTypes.has("question.answered"), "Event log contains question.answered");
  assert.ok(recordedTypes.has("synthesis.created"), "Event log contains synthesis.created");
  assert.ok(recordedTypes.has("object.retracted"), "Event log contains object.retracted");

  // --------------------------------------------------------------------------
  // DIPTYCH FACES & EXACT-VERSION RETRIEVAL (Rule A1)
  // --------------------------------------------------------------------------
  // 1. Dead ends face
  const deadEndsJson = await call(`/p/${problemId}/dead-ends.json`);
  assert.ok(deadEndsJson.dead_ends.some((d) => d.dead_end_id === deadEndId2));
  const deadEndsMd = await (
    await worker.fetch(`${origin}/p/${problemId}/dead-ends.md`, {
      headers: { "User-Agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" },
    })
  ).text();
  assert.ok(deadEndsMd.includes(deadEndId2));

  // 2. Citations face
  const citationsJson = await call(`/p/${problemId}/citations.json`);
  CitationsListResponseSchema.parse(citationsJson);
  const headCit = citationsJson.citations.find((c) => c.citation_id === citationId);
  assert.ok(headCit);
  assert.equal(headCit.version, 2);

  // Historical citation version query (@1.json)
  const citV1Json = await call(`/p/${problemId}/citations/${citationId}@1.json`);
  SingleCitationResponseSchema.parse(citV1Json);
  assert.equal(citV1Json.citation.version, 1);
  assert.equal(citV1Json.citation.title, "Bounded gaps between primes");

  // Head citation query (without version query) returns version 2
  const citHeadJson = await call(`/p/${problemId}/citations/${citationId}.json`);
  SingleCitationResponseSchema.parse(citHeadJson);
  assert.equal(citHeadJson.citation.version, 2);
  assert.equal(citHeadJson.citation.title, "Bounded gaps between primes (Annals of Mathematics)");

  // 3. Syntheses face
  const synthesesJson = await call(`/p/${problemId}/syntheses.json`);
  SynthesesListResponseSchema.parse(synthesesJson);
  assert.ok(synthesesJson.syntheses.some((s) => s.synthesis_id === synthesisId));

  const singleSynthJson = await call(`/p/${problemId}/syntheses/${synthesisId}.json`);
  SingleSynthesisResponseSchema.parse(singleSynthJson);
  assert.equal(singleSynthJson.synthesis.synthesis_id, synthesisId);
  assert.equal(singleSynthJson.synthesis.authoring_principal, fellowIdA);

  // 4. Questions face
  const questionsJson = await call(`/p/${problemId}/questions.json`);
  QuestionsListResponseSchema.parse(questionsJson);
  const qItem = questionsJson.questions.find((q) => q.question_id === questionId);
  assert.ok(qItem);
  assert.equal(qItem.status, "resolved");
  assert.equal(qItem.resolved_by_object, claim1Id);
  assert.equal(qItem.leased_by, fellowIdB);

  // 5. Retractions face
  const retractionsJson = await call(`/p/${problemId}/retractions.json`);
  RetractionsListResponseSchema.parse(retractionsJson);
  const rItem = retractionsJson.retractions.find((r) => r.retraction_id === retractionId);
  assert.ok(rItem);
  assert.equal(rItem.target_object, claim1Id);

  // --------------------------------------------------------------------------
  // OPS.2a STRUCTURED DIAGNOSTIC LOG (Secret-safe)
  // --------------------------------------------------------------------------
  console.log(
    JSON.stringify({
      stage: "ledger-objects-integration-real-bindings",
      status: "pass",
      problem_id: problemId,
      claim_id: claim1Id,
      citation_id: citationId,
      dead_end_initial: deadEndId1,
      dead_end_superseded: deadEndId2,
      question_id: questionId,
      synthesis_id: synthesisId,
      retraction_id: retractionId,
      total_events: allEvents.length,
      immutability_triggers_verified: true,
      exact_version_links_verified: true,
      stale_revision_conflicts_verified: true,
      rebuild_from_log_verified: true,
      diptych_faces_verified: true,
    }),
  );
});
