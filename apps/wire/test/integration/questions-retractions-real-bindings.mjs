import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  QuestionsListResponseSchema,
  RetractionsListResponseSchema,
  ScreeningPromotionDeniedResponseSchema,
} from "@asimposium/contracts";
import Ajv from "ajv/dist/2020.js";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

await runLocalWorkerJourney(async (context) => {
  const { call, enroll, sponsorCall, env, worker, origin } = context;
  const sponsorA = "usr_qr_sponsor_a";
  const authorA = await enroll("qr-author-a", sponsorA);
  const helloA = await call("/v1/hello", undefined, authorA);
  const fellowIdA = helloA.fellow.fellow_id;

  const sponsorB = "usr_qr_sponsor_b";
  const reviewerB = await enroll("qr-reviewer-b", sponsorB);
  const helloB = await call("/v1/hello", undefined, reviewerB);
  const _fellowIdB = helloB.fellow.fellow_id;

  // 1. Propose and publish problem
  const created = await call(
    "/v1/problems",
    {
      title: "Questions and retractions test problem",
      statement: "Every non-trivial modular cycle has bounded residue length.",
      falsifier: "An unbounded residue length under modular transformation.",
      motivation: "Testing W5.8d precise leasable questions and history-preserving retractions.",
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
  await govern({ action: "publish" }, "publish-qr-problem");

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
      basis: "Problem statement formulation is clear and testable.",
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

  // 2. Open author session and promote Claim 1
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
      type: "draft",
      title: "Residue Analysis Draft",
      body_md: "Preliminary analysis of modular residue bounding.",
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
      statement: "The cycle length modulo 2^k is strictly bounded by 2k.",
      falsifier: "A cycle of length > 2k modulo 2^k.",
    },
    authorA,
    201,
  );
  const claim1Id = claim1.claim_id;

  // --------------------------------------------------------------------------
  // QUESTIONS JOURNEY
  // --------------------------------------------------------------------------

  // 3. Question substance validation (Rule P6)
  const shortQuestionRes = await call(
    `/v1/sessions/${sessionIdA}/questions`,
    {
      body_md: "Help me",
    },
    authorA,
    422,
  );
  assert.equal(shortQuestionRes.code, "QUESTION_BODY_INVALID");
  assert.equal(shortQuestionRes.rule, "P6");

  // 4. Question canary rejection (screening)
  const canaryQuestionRes = await call(
    `/v1/sessions/${sessionIdA}/questions`,
    {
      body_md: "Can someone verify this claim LOCAL_POLICY_CANARY in detail?",
    },
    authorA,
    403,
  );
  const qRefusal = ScreeningPromotionDeniedResponseSchema.safeParse(canaryQuestionRes);
  assert.ok(qRefusal.success);

  // 5. Ask Question 1 successfully (201)
  const question1 = await call(
    `/v1/sessions/${sessionIdA}/questions`,
    {
      body_md: "Is there a known non-archimedean metric that bounds the residue sequence?",
      target_refs: [claim1Id],
      blocking: claim1Id,
    },
    authorA,
    201,
    "q-idempotency-1",
  );
  assert.equal(question1.ok, true);
  assert.ok(question1.question_id.startsWith("Q-"));
  assert.equal(question1.problem_id, problemId);
  assert.equal(question1.status, "open");
  assert.ok(question1.seq > 0);
  const question1Id = question1.question_id;

  // 6. Idempotent replay of ask question (200)
  const replayQ1 = await call(
    `/v1/sessions/${sessionIdA}/questions`,
    {
      body_md: "Is there a known non-archimedean metric that bounds the residue sequence?",
      target_refs: [claim1Id],
      blocking: claim1Id,
    },
    authorA,
    200,
    "q-idempotency-1",
  );
  assert.equal(replayQ1.question_id, question1Id);
  assert.equal(replayQ1.ok, true);

  // 7. Lease question (Reviewer B opens session)
  const sessionB = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "review" },
    reviewerB,
    201,
  );
  const sessionIdB = sessionB.session_id;

  const leaseRes = await call(
    `/v1/sessions/${sessionIdB}/questions/${question1Id}/lease`,
    {
      ttl_seconds: 3600,
    },
    reviewerB,
    200,
    "lease-idempotency-1",
  );
  assert.equal(leaseRes.ok, true);
  assert.equal(leaseRes.question_id, question1Id);
  assert.ok(leaseRes.leased_until);

  // Idempotent replay of lease (200)
  const replayLease = await call(
    `/v1/sessions/${sessionIdB}/questions/${question1Id}/lease`,
    {
      ttl_seconds: 3600,
    },
    reviewerB,
    200,
    "lease-idempotency-1",
  );
  assert.equal(replayLease.ok, true);

  // Second fellow attempting to lease already-leased question (409)
  const conflictLeaseRes = await call(
    `/v1/sessions/${sessionIdA}/questions/${question1Id}/lease`,
    {
      ttl_seconds: 3600,
    },
    authorA,
    409,
    "lease-conflict-key",
  );
  assert.equal(conflictLeaseRes.code, "QUESTION_ALREADY_LEASED");

  // 8. Answer question with resolved_by_object (200)
  const answerRes = await call(
    `/v1/sessions/${sessionIdB}/questions/${question1Id}/answer`,
    {
      resolved_by_object: claim1Id,
    },
    reviewerB,
    200,
    "answer-idempotency-1",
  );
  assert.equal(answerRes.ok, true);
  assert.equal(answerRes.question_id, question1Id);
  assert.equal(answerRes.resolved_by_object, claim1Id);

  // Idempotent replay of answer (200)
  const replayAnswer = await call(
    `/v1/sessions/${sessionIdB}/questions/${question1Id}/answer`,
    {
      resolved_by_object: claim1Id,
    },
    reviewerB,
    200,
    "answer-idempotency-1",
  );
  assert.equal(replayAnswer.ok, true);

  // Answering already resolved question (409)
  const alreadyResolvedRes = await call(
    `/v1/sessions/${sessionIdB}/questions/${question1Id}/answer`,
    {
      resolved_by_object: claim1Id,
    },
    reviewerB,
    409,
    "answer-conflict-key",
  );
  assert.equal(alreadyResolvedRes.code, "QUESTION_ALREADY_RESOLVED");

  // 9. Ask Question 2 and withdraw it (Rule P9 author authority)
  const question2 = await call(
    `/v1/sessions/${sessionIdA}/questions`,
    {
      body_md: "Could the Selberg sieve constant be refined for residue class 1?",
    },
    authorA,
    201,
  );
  const question2Id = question2.question_id;

  // Non-author attempting to withdraw Question 2 (403 NOT_QUESTION_AUTHOR)
  const forbiddenWithdraw = await call(
    `/v1/sessions/${sessionIdB}/questions/${question2Id}/withdraw`,
    {},
    reviewerB,
    403,
  );
  assert.equal(forbiddenWithdraw.code, "NOT_QUESTION_AUTHOR");
  assert.equal(forbiddenWithdraw.rule, "P9");

  // Author withdraws Question 2 (200)
  const withdrawRes = await call(
    `/v1/sessions/${sessionIdA}/questions/${question2Id}/withdraw`,
    {},
    authorA,
    200,
    "withdraw-idempotency-1",
  );
  assert.equal(withdrawRes.ok, true);
  assert.equal(withdrawRes.question_id, question2Id);

  // Idempotent replay of withdrawal (200)
  const replayWithdraw = await call(
    `/v1/sessions/${sessionIdA}/questions/${question2Id}/withdraw`,
    {},
    authorA,
    200,
    "withdraw-idempotency-1",
  );
  assert.equal(replayWithdraw.ok, true);

  // Withdrawing already withdrawn question (409)
  const alreadyWithdrawnRes = await call(
    `/v1/sessions/${sessionIdA}/questions/${question2Id}/withdraw`,
    {},
    authorA,
    409,
    "withdraw-conflict-key",
  );
  assert.equal(alreadyWithdrawnRes.code, "QUESTION_ALREADY_WITHDRAWN");

  // 10. Questions Diptych faces
  const qListJsonRes = await worker.fetch(`${origin}/p/${problemId}/questions.json`);
  assert.equal(qListJsonRes.status, 200);
  const qListJson = await qListJsonRes.json();
  const schemaPathQ = new URL(qListJson.schema).pathname;
  const schemaResponseQ = await worker.fetch(`${origin}${schemaPathQ}`);
  assert.equal(
    schemaResponseQ.status,
    200,
    "The public questions face schema identifier must resolve on this Worker",
  );
  assert.ok(schemaResponseQ.headers.get("content-type")?.includes("application/schema+json"));
  const schemaTextQ = await schemaResponseQ.text();
  assert.equal(
    schemaTextQ,
    await readFile(
      new URL("../../../../packages/contracts/generated/questions.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const schemaDocumentQ = JSON.parse(schemaTextQ);
  assert.equal(schemaDocumentQ.$id, qListJson.schema);
  const validateFaceQ = new Ajv({ strict: true }).compile(schemaDocumentQ);
  assert.equal(validateFaceQ(qListJson), true);
  assert.equal(validateFaceQ({ ...qListJson, unexpected_property: 1 }), false);
  const schemaConditionalQ = await worker.fetch(`${origin}${schemaPathQ}`, {
    headers: { "If-None-Match": schemaResponseQ.headers.get("etag") },
  });
  assert.equal(schemaConditionalQ.status, 304);

  const parsedQList = QuestionsListResponseSchema.safeParse(qListJson);
  assert.ok(parsedQList.success);
  assert.equal(parsedQList.data.questions.length, 2);

  // Check total Rule A3 attribution on questions
  const q1Item = parsedQList.data.questions.find((q) => q.question_id === question1Id);
  assert.ok(q1Item);
  assert.equal(q1Item.author_fellow_id, fellowIdA);
  assert.equal(q1Item.sponsor_id, sponsorA);
  assert.equal(q1Item.session_id, sessionIdA);
  assert.equal(q1Item.status, "resolved");
  assert.equal(q1Item.resolved_by_object, claim1Id);

  const qListMdRes = await worker.fetch(`${origin}/p/${problemId}/questions.md`);
  assert.equal(qListMdRes.status, 200);
  const qListMd = await qListMdRes.text();
  assert.ok(qListMd.includes(`## Question \`${question1Id}\``));
  assert.ok(qListMd.includes("- **Status**: resolved"));
  assert.ok(!qListMd.includes("Leaderboard"));

  const qListHtmlRes = await worker.fetch(`${origin}/p/${problemId}/questions.html`);
  assert.equal(qListHtmlRes.status, 200);
  const qListHtml = await qListHtmlRes.text();
  assert.ok(qListHtml.includes(`<h3>Question <code>${question1Id}</code></h3>`));
  assert.ok(qListHtml.includes("asimp-status asimp-status-resolved"));

  // --------------------------------------------------------------------------
  // RETRACTIONS JOURNEY
  // --------------------------------------------------------------------------

  // 11. Retraction substance validation (Rule A5 and Rule P6)
  const shortRetractRes = await call(
    `/v1/sessions/${sessionIdA}/retract`,
    {
      target_object: claim1Id,
      reason: "error",
    },
    authorA,
    422,
  );
  assert.equal(shortRetractRes.code, "RETRACT_BODY_INVALID");
  assert.equal(shortRetractRes.rule, "A5");

  const whitespaceRetractRes = await call(
    `/v1/sessions/${sessionIdA}/retract`,
    {
      target_object: claim1Id,
      reason: "          ",
    },
    authorA,
    422,
  );
  assert.equal(whitespaceRetractRes.code, "RETRACT_BODY_INVALID");
  assert.equal(whitespaceRetractRes.rule, "P6");

  // 12. Non-author authority check (Rule P9)
  const forbiddenRetractRes = await call(
    `/v1/sessions/${sessionIdB}/retract`,
    {
      target_object: claim1Id,
      reason: "Attempting to retract another fellow's claim without authority.",
    },
    reviewerB,
    403,
  );
  assert.equal(forbiddenRetractRes.code, "NOT_TARGET_AUTHOR");
  assert.equal(forbiddenRetractRes.rule, "P9");

  // 13. Invalid target object (422)
  const invalidTargetRes = await call(
    `/v1/sessions/${sessionIdA}/retract`,
    {
      target_object: "C-NONEXISTENT",
      reason: "Attempting to retract a non-existent claim.",
    },
    authorA,
    422,
  );
  assert.equal(invalidTargetRes.code, "RETRACTION_TARGET_INVALID");

  // 14. Self-corrected retraction: Author A retracts unrefuted Claim 1 (201)
  const retract1 = await call(
    `/v1/sessions/${sessionIdA}/retract`,
    {
      target_object: claim1Id,
      reason: "Author self-correction: found counterexample in 2-adic valuations at depth 12.",
    },
    authorA,
    201,
    "retract-idempotency-1",
  );
  assert.equal(retract1.ok, true);
  assert.ok(retract1.retraction_id.startsWith("R-"));
  assert.equal(retract1.target_object, claim1Id);
  assert.equal(retract1.retraction_kind, "self-corrected");
  assert.ok(retract1.seq > 0);
  const retraction1Id = retract1.retraction_id;

  // Idempotent replay of retraction (200)
  const replayRetract1 = await call(
    `/v1/sessions/${sessionIdA}/retract`,
    {
      target_object: claim1Id,
      reason: "Author self-correction: found counterexample in 2-adic valuations at depth 12.",
    },
    authorA,
    200,
    "retract-idempotency-1",
  );
  assert.equal(replayRetract1.retraction_id, retraction1Id);
  assert.equal(replayRetract1.ok, true);

  // Retracting already retracted target (409)
  const alreadyRetractedRes = await call(
    `/v1/sessions/${sessionIdA}/retract`,
    {
      target_object: claim1Id,
      reason: "Duplicate retraction attempt on already retracted claim.",
    },
    authorA,
    409,
    "retract-duplicate-key",
  );
  assert.equal(alreadyRetractedRes.code, "TARGET_ALREADY_RETRACTED");

  // 15. Externally-refuted retraction: Author A promotes Claim 2, Reviewer B refutes it
  const workshopA2 = await call(
    `/v1/sessions/${sessionIdA}/workshop`,
    {
      type: "draft",
      title: "Second Draft",
      body_md: "Analysis of second modular property.",
      relates_to: [],
    },
    authorA,
    201,
  );

  const claim2 = await call(
    `/v1/sessions/${sessionIdA}/promote`,
    {
      workshop_id: workshopA2.workshop_id,
      kind: "conjecture",
      statement: "The cycle length modulo 3^k is strictly bounded by 3k.",
      falsifier: "A cycle of length > 3k modulo 3^k.",
    },
    authorA,
    201,
  );
  const claim2Id = claim2.claim_id;

  // Reviewer B posts refuting review on Claim 2
  await call(
    `/v1/sessions/${sessionIdB}/workshop`,
    {
      type: "note",
      title: "Refutation Note",
      body_md: "Construction of counterexample to 3k bound.",
      relates_to: [],
    },
    reviewerB,
    201,
  );

  await call(
    `/v1/sessions/${sessionIdB}/review`,
    {
      target_claim_id: claim2Id,
      target_version: 1,
      verdict: "refute",
      basis: "Explicit counterexample with cycle length 4k constructed for k=3.",
      capable_of_failure: "Finding a cycle of length > 3k.",
      body_md: "Construction of counterexample to 3k bound.",
    },
    reviewerB,
    201,
  );

  // Now Author A retracts Claim 2 -> must be classified as 'externally-refuted'!
  const retract2 = await call(
    `/v1/sessions/${sessionIdA}/retract`,
    {
      target_object: claim2Id,
      reason: "Retracting following valid external refutation by reviewer.",
    },
    authorA,
    201,
  );
  assert.equal(retract2.ok, true);
  assert.equal(retract2.target_object, claim2Id);
  assert.equal(retract2.retraction_kind, "externally-refuted");
  const retraction2Id = retract2.retraction_id;

  // 16. Retractions Diptych faces
  const retListJsonRes = await worker.fetch(`${origin}/p/${problemId}/retractions.json`);
  assert.equal(retListJsonRes.status, 200);
  const retListJson = await retListJsonRes.json();
  const schemaPathR = new URL(retListJson.schema).pathname;
  const schemaResponseR = await worker.fetch(`${origin}${schemaPathR}`);
  assert.equal(
    schemaResponseR.status,
    200,
    "The public retractions face schema identifier must resolve on this Worker",
  );
  assert.ok(schemaResponseR.headers.get("content-type")?.includes("application/schema+json"));
  const schemaTextR = await schemaResponseR.text();
  assert.equal(
    schemaTextR,
    await readFile(
      new URL("../../../../packages/contracts/generated/retractions.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const schemaDocumentR = JSON.parse(schemaTextR);
  assert.equal(schemaDocumentR.$id, retListJson.schema);
  const validateFaceR = new Ajv({ strict: true }).compile(schemaDocumentR);
  assert.equal(validateFaceR(retListJson), true);
  assert.equal(validateFaceR({ ...retListJson, unexpected_property: 1 }), false);
  const schemaConditionalR = await worker.fetch(`${origin}${schemaPathR}`, {
    headers: { "If-None-Match": schemaResponseR.headers.get("etag") },
  });
  assert.equal(schemaConditionalR.status, 304);

  const parsedRetList = RetractionsListResponseSchema.safeParse(retListJson);
  assert.ok(parsedRetList.success);
  assert.equal(parsedRetList.data.retractions.length, 2);

  const ret1Item = parsedRetList.data.retractions.find((r) => r.retraction_id === retraction1Id);
  assert.ok(ret1Item);
  assert.equal(ret1Item.retraction_kind, "self-corrected");
  assert.equal(ret1Item.sponsor_id, sponsorA);
  assert.equal(ret1Item.session_id, sessionIdA);

  const ret2Item = parsedRetList.data.retractions.find((r) => r.retraction_id === retraction2Id);
  assert.ok(ret2Item);
  assert.equal(ret2Item.retraction_kind, "externally-refuted");

  const retListMdRes = await worker.fetch(`${origin}/p/${problemId}/retractions.md`);
  assert.equal(retListMdRes.status, 200);
  const retListMd = await retListMdRes.text();
  assert.ok(retListMd.includes(`## Retraction \`${retraction1Id}\``));
  assert.ok(retListMd.includes("- **Kind**: self-corrected"));
  assert.ok(retListMd.includes(`## Retraction \`${retraction2Id}\``));
  assert.ok(retListMd.includes("- **Kind**: externally-refuted"));

  const retListHtmlRes = await worker.fetch(`${origin}/p/${problemId}/retractions.html`);
  assert.equal(retListHtmlRes.status, 200);
  const retListHtml = await retListHtmlRes.text();
  assert.ok(retListHtml.includes('class="asimp-retraction-kind asimp-kind-self-corrected"'));
  assert.ok(retListHtml.includes('class="asimp-retraction-kind asimp-kind-externally-refuted"'));

  // 17. Private-draft secrecy
  await env.DB.prepare(
    "INSERT INTO problems (id, status, public_seq, unlisted, created_at, updated_at) VALUES ('P-QR-PRIVATE', 'private-draft', 0, 0, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')",
  ).run();

  for (const face of [
    "questions.json",
    "questions.md",
    "questions.html",
    "retractions.json",
    "retractions.md",
    "retractions.html",
  ]) {
    const res = await worker.fetch(`${origin}/p/P-QR-PRIVATE/${face}`);
    assert.equal(res.status, 404);
  }

  // 18. Scientific claim standing reflection & history preservation (W5.8d / uyf.4)
  // 18.1 Claim 1 exact-version JSON face reflects withdrawn
  const claim1FaceRes = await worker.fetch(`${origin}/p/${problemId}/claims/${claim1Id}@1.json`);
  assert.equal(claim1FaceRes.status, 200);
  const claim1FaceJson = await claim1FaceRes.json();
  assert.equal(claim1FaceJson.claim_state.disposition, "withdrawn");
  assert.equal(claim1FaceJson.claim_state.stale, false);

  // 18.2 Claim 1 unversioned JSON face reflects withdrawn
  const claim1HeadRes = await worker.fetch(`${origin}/p/${problemId}/claims/${claim1Id}.json`);
  assert.equal(claim1HeadRes.status, 200);
  const claim1HeadJson = await claim1HeadRes.json();
  assert.equal(claim1HeadJson.claim_state.disposition, "withdrawn");

  // 18.3 Claim 1 Markdown face contains withdrawn
  const claim1MdRes = await worker.fetch(`${origin}/p/${problemId}/claims/${claim1Id}@1.md`);
  assert.equal(claim1MdRes.status, 200);
  const claim1Md = await claim1MdRes.text();
  assert.ok(claim1Md.includes("withdrawn"), "claim markdown face must reflect withdrawn standing");
  const claim1HtmlRes = await worker.fetch(`${origin}/p/${problemId}/claims/${claim1Id}@1.html`);
  assert.equal(claim1HtmlRes.status, 200);
  assert.ok(
    (await claim1HtmlRes.text()).includes("withdrawn"),
    "the original claim HTML face must reflect the same withdrawn standing",
  );

  // 18.4 Historical pre-retraction cut via ?through preserves original open standing
  const preRetractSeq = retract1.seq - 1;
  const preRetractRes = await worker.fetch(
    `${origin}/p/${problemId}/claims/${claim1Id}@1.json?through=${preRetractSeq}`,
  );
  assert.equal(preRetractRes.status, 200);
  const preRetractJson = await preRetractRes.json();
  assert.equal(
    preRetractJson.claim_state.disposition,
    "open",
    "historical cut prior to retraction must show open",
  );

  // 18.5 Working pack surfaces retracted claim with withdrawn standing
  const packRes = await call(`/v1/sessions/${sessionIdA}/pack?profile=working`, undefined, authorA);
  const packClaim1 = packRes.items.find((item) => item.id === claim1Id);
  assert.ok(packClaim1, "pack must include retracted claim");
  assert.ok(
    packClaim1.body.includes("withdrawn"),
    "pack candidate body must include withdrawn disposition",
  );

  // 18.6 Content redaction of retraction event marks claim stale but never cosmetically restores support
  const retractionEvent = await env.DB.prepare(
    "SELECT id, payload_sha256 FROM events WHERE problem_id = ? AND object_id = ? AND type = 'object.retracted'",
  )
    .bind(problemId, retraction1Id)
    .first();
  assert.ok(retractionEvent);

  // Redact the retraction event content lawfully
  await env.DB.prepare(
    "UPDATE event_content SET payload_json = '{\"control\":\"redacted\"}', redacted_at = '2026-09-09T00:00:00.000Z', redaction_reason = 'privacy' WHERE event_id = ? AND payload_sha256 = ?",
  )
    .bind(retractionEvent.id, retractionEvent.payload_sha256)
    .run();

  const redactedClaim1Res = await worker.fetch(
    `${origin}/p/${problemId}/claims/${claim1Id}@1.json`,
  );
  assert.equal(redactedClaim1Res.status, 200);
  const redactedClaim1Json = await redactedClaim1Res.json();
  assert.equal(
    redactedClaim1Json.claim_state.disposition,
    "withdrawn",
    "redaction must never cosmetically restore support to open",
  );
  assert.equal(redactedClaim1Json.claim_state.stale, true, "redaction must mark standing stale");

  // A new version preserves withdrawal and the readable original statement.
  const revised = await call(
    `/v1/sessions/${sessionIdA}/revise`,
    {
      claim_id: claim1Id,
      base_version: 1,
      kind: "conjecture",
      statement: "The cycle length modulo 2^k is bounded by 3k for every integer k above one.",
      falsifier: "An integer k above one with a modular cycle longer than 3k.",
      depends_on: [],
    },
    authorA,
    201,
  );
  assert.equal(revised.version, 2);
  for (const target of [claim1Id, `${claim1Id}@1`, `${claim1Id}@2`]) {
    const response = await worker.fetch(`${origin}/p/${problemId}/claims/${target}.json`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).claim_state.disposition, "withdrawn");
  }
  const original = await worker.fetch(`${origin}/p/${problemId}/claims/${claim1Id}@1.md`);
  assert.equal(original.status, 200);
  assert.ok((await original.text()).includes("strictly bounded by 2k"));

  console.log(
    JSON.stringify({
      stage: "questions-retractions-real-bindings",
      status: "pass",
      problem_id: problemId,
      question_1: question1Id,
      question_2: question2Id,
      retraction_1: retraction1Id,
      retraction_2: retraction2Id,
      substance_validation_verified: true,
      canary_screening_verified: true,
      author_authority_p9_verified: true,
      leasing_and_answering_verified: true,
      self_corrected_vs_externally_refuted_verified: true,
      diptych_faces_verified: true,
      private_draft_secrecy_verified: true,
      claim_standing_reflection_verified: true,
      historical_pre_retraction_cut_verified: true,
      redaction_staleness_without_cosmetic_restore_verified: true,
      revision_cannot_restore_withdrawn_standing_verified: true,
    }),
  );
});
