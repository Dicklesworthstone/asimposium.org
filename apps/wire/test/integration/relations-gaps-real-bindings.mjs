import assert from "node:assert/strict";
import {
  GapClosedResponseSchema,
  GapFiledResponseSchema,
  PackResponseSchema,
  RelationDisputedResponseSchema,
  RelationFiledResponseSchema,
} from "@asimposium/contracts";
import { faceCensus } from "./face-census.mjs";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

await runLocalWorkerJourney(async (context) => {
  const { call, enroll, sponsorCall } = context;
  const sponsorA = "usr_rel_sponsor_a";
  const authorA = await enroll("rel-author-a", sponsorA);
  const helloA = await call("/v1/hello", undefined, authorA);
  const _fellowIdA = helloA.fellow.fellow_id;

  const sponsorB = "usr_rel_sponsor_b";
  const reviewerB = await enroll("rel-reviewer-b", sponsorB);
  const helloB = await call("/v1/hello", undefined, reviewerB);
  const _fellowIdB = helloB.fellow.fellow_id;

  // 1. Propose and publish problem
  const created = await call(
    "/v1/problems",
    {
      title: "Claim relations and proof gaps test problem",
      statement: "Every non-trivial modular cycle has bounded residue length.",
      falsifier: "An unbounded residue length under modular transformation.",
      motivation: "Testing W5.5 relations, disputes, and proof gaps.",
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
  await govern({ action: "publish" }, "publish-rel-problem");

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

  // 2. Open author session and promote Claim 1 and Claim 2
  const sessionA = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "prove" },
    authorA,
    201,
  );
  const sessionIdA = sessionA.session_id;

  const workshop1 = await call(
    `/v1/sessions/${sessionIdA}/workshop`,
    {
      type: "claim-draft",
      title: "Draft 1: Upper Bound",
      body_md: "Analysis supporting upper bound.",
      relates_to: [],
    },
    authorA,
    201,
  );
  const claim1 = await call(
    `/v1/sessions/${sessionIdA}/promote`,
    {
      workshop_id: workshop1.workshop_id,
      kind: "conjecture",
      statement: "The cycle length modulo 2^k is strictly bounded from above by 2k.",
      falsifier: "A cycle of length > 2k modulo 2^k.",
    },
    authorA,
    201,
  );
  const claim1Id = claim1.claim_id;

  const workshop2 = await call(
    `/v1/sessions/${sessionIdA}/workshop`,
    {
      type: "claim-draft",
      title: "Draft 2: Lower Bound",
      body_md: "Analysis supporting lower bound.",
      relates_to: [],
    },
    authorA,
    201,
  );
  const claim2 = await call(
    `/v1/sessions/${sessionIdA}/promote`,
    {
      workshop_id: workshop2.workshop_id,
      kind: "conjecture",
      statement: "The cycle length modulo 2^k is unconditionally bounded from below by 3k.",
      falsifier: "A cycle of length < 3k modulo 2^k.",
    },
    authorA,
    201,
  );
  const claim2Id = claim2.claim_id;

  // 3. File a proof gap
  const gapFiled = await call(
    `/v1/sessions/${sessionIdA}/gaps`,
    {
      obligation: "Prove that lemma 2 holds for all odd primes",
      closes_what: "Lemma 2 induction step",
      target_claim_id: claim1Id,
      target_version: 1,
    },
    authorA,
    201,
    "gap-file-key-1",
  );
  GapFiledResponseSchema.parse(gapFiled);
  const gapId = gapFiled.gap_id;
  assert.ok(gapId.startsWith("G-"));

  // 4. Assert relations
  // 4a. Bad relation payload (422)
  const badRel = await call(
    `/v1/sessions/${sessionIdA}/relations`,
    {
      kind: "implies",
      source_claim_id: claim1Id,
      source_version: 1,
      target: gapId, // implies cannot target gap
    },
    authorA,
    422,
  );
  assert.equal(badRel.code, "RELATION_BODY_INVALID");

  // 4b. Valid claim relation: claim1 implies claim2
  const relKey1 = "rel-assert-key-1";
  const filedRel1 = await call(
    `/v1/sessions/${sessionIdA}/relations`,
    {
      kind: "implies",
      source_claim_id: claim1Id,
      source_version: 1,
      target: `${claim1Id === "C-1" ? "C-2" : claim2Id}@1`,
    },
    authorA,
    201,
    relKey1,
  );
  RelationFiledResponseSchema.parse(filedRel1);
  assert.equal(filedRel1.kind, "implies");
  assert.equal(filedRel1.source, `${claim1Id}@1`);
  assert.equal(filedRel1.target, `${claim2Id}@1`);

  // 4c. Idempotent replay with same key returns 200 with identical body
  const replayRel1 = await call(
    `/v1/sessions/${sessionIdA}/relations`,
    {
      kind: "implies",
      source_claim_id: claim1Id,
      source_version: 1,
      target: `${claim2Id}@1`,
    },
    authorA,
    200,
    relKey1,
  );
  assert.deepEqual(replayRel1, filedRel1);

  // 4d. Duplicate assertion with new key returns 409 RELATION_ALREADY_ASSERTED
  const dupRel1 = await call(
    `/v1/sessions/${sessionIdA}/relations`,
    {
      kind: "implies",
      source_claim_id: claim1Id,
      source_version: 1,
      target: `${claim2Id}@1`,
    },
    authorA,
    409,
    "rel-assert-key-dup",
  );
  assert.equal(dupRel1.code, "RELATION_ALREADY_ASSERTED");

  // 4e. Addresses-gap relation: claim2 addresses gap
  const relGapKey = "rel-assert-gap-key";
  const filedRelGap = await call(
    `/v1/sessions/${sessionIdA}/relations`,
    {
      kind: "addresses-gap",
      source_claim_id: claim2Id,
      source_version: 1,
      target: gapId,
    },
    authorA,
    201,
    relGapKey,
  );
  RelationFiledResponseSchema.parse(filedRelGap);
  assert.equal(filedRelGap.kind, "addresses-gap");
  assert.equal(filedRelGap.target, gapId);

  // 5. Reviewer opens session and inspects claim-graph pack
  const sessionB = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "review" },
    reviewerB,
    201,
  );
  const sessionIdB = sessionB.session_id;

  const packBefore = await call(
    `/v1/sessions/${sessionIdB}/pack?profile=claim-graph`,
    undefined,
    reviewerB,
    200,
  );
  PackResponseSchema.parse(packBefore);
  // Omitted must NOT contain relation-disputes
  assert.ok(!packBefore.omitted.some((o) => o.detail === "relation-disputes"));
  assert.ok(packBefore.omitted.some((o) => o.detail === "weakest-link-paths"));

  // Check that pack returns the asserted relation
  const relRows = packBefore.items.filter((item) => item.kind === "claim-relation");
  assert.ok(relRows.length >= 2);
  const impliesRow = relRows.find(
    (item) => item.body.includes("implies") && item.body.includes(claim1Id),
  );
  assert.ok(impliesRow);
  assert.ok(impliesRow.body.includes("This edge is an assertion, not an established implication."));

  // 6. Dispute Lifecycle
  // 6a. Malformed dispute body (422)
  const badDispute = await call(
    `/v1/sessions/${sessionIdB}/relations/dispute`,
    {
      kind: "implies",
      source_claim_id: claim1Id,
      source_version: 1,
      target: `${claim2Id}@1`,
      reason: "", // empty reason
    },
    reviewerB,
    422,
  );
  assert.equal(badDispute.code, "RELATION_DISPUTE_BODY_INVALID");

  // 6b. Non-existent relation edge (404)
  const notFoundDispute = await call(
    `/v1/sessions/${sessionIdB}/relations/dispute`,
    {
      kind: "contradicts",
      source_claim_id: claim1Id,
      source_version: 1,
      target: `${claim2Id}@1`,
      reason: "Edge does not exist.",
    },
    reviewerB,
    404,
  );
  assert.equal(notFoundDispute.code, "RELATION_NOT_FOUND");

  // 6c. Self-dispute refused under Rule P1 (422 REVIEWER_IS_AUTHOR)
  const selfDispute = await call(
    `/v1/sessions/${sessionIdA}/relations/dispute`,
    {
      kind: "implies",
      source_claim_id: claim1Id,
      source_version: 1,
      target: `${claim2Id}@1`,
      reason: "I want to dispute my own asserted edge.",
    },
    authorA,
    422,
  );
  assert.equal(selfDispute.code, "REVIEWER_IS_AUTHOR");

  // 6d. ReviewerB successfully disputes the relation (201)
  const disputeKey1 = "rel-dispute-key-1";
  const disputedResp = await call(
    `/v1/sessions/${sessionIdB}/relations/dispute`,
    {
      kind: "implies",
      source_claim_id: claim1Id,
      source_version: 1,
      target: `${claim2Id}@1`,
      reason: "Claim 1 upper bound does not imply Claim 2 lower bound for k=4.",
    },
    reviewerB,
    201,
    disputeKey1,
  );
  RelationDisputedResponseSchema.parse(disputedResp);
  assert.equal(disputedResp.kind, "implies");
  assert.equal(disputedResp.source, `${claim1Id}@1`);
  assert.equal(disputedResp.target, `${claim2Id}@1`);
  assert.equal(disputedResp.status, "disputed");

  // 6e. Idempotent replay of dispute returns 200
  const replayDispute = await call(
    `/v1/sessions/${sessionIdB}/relations/dispute`,
    {
      kind: "implies",
      source_claim_id: claim1Id,
      source_version: 1,
      target: `${claim2Id}@1`,
      reason: "Claim 1 upper bound does not imply Claim 2 lower bound for k=4.",
    },
    reviewerB,
    200,
    disputeKey1,
  );
  assert.deepEqual(replayDispute, disputedResp);

  // 6f. Repeat dispute with new key returns 409 RELATION_ALREADY_DISPUTED
  const repeatDispute = await call(
    `/v1/sessions/${sessionIdB}/relations/dispute`,
    {
      kind: "implies",
      source_claim_id: claim1Id,
      source_version: 1,
      target: `${claim2Id}@1`,
      reason: "Claim 1 upper bound does not imply Claim 2 lower bound for k=4.",
    },
    reviewerB,
    409,
    "rel-dispute-key-repeat",
  );
  assert.equal(repeatDispute.code, "RELATION_ALREADY_DISPUTED");

  // 6g. Check pack after dispute: edge is reflected as disputed
  const packAfter = await call(
    `/v1/sessions/${sessionIdB}/pack?profile=claim-graph`,
    undefined,
    reviewerB,
    200,
  );
  PackResponseSchema.parse(packAfter);
  const impliesRowAfter = packAfter.items.find(
    (item) =>
      item.kind === "claim-relation" &&
      item.body.includes("implies") &&
      item.body.includes(claim1Id),
  );
  assert.ok(impliesRowAfter);
  assert.ok(
    impliesRowAfter.body.includes("Status: disputed. This edge was disputed by peer review."),
  );

  // 6h. ReviewerB disputes addresses-gap relation
  const gapDisputeResp = await call(
    `/v1/sessions/${sessionIdB}/relations/dispute`,
    {
      kind: "addresses-gap",
      source_claim_id: claim2Id,
      source_version: 1,
      target: gapId,
      reason: "Claim 2 lower bound does not prove lemma 2 for odd primes.",
    },
    reviewerB,
    201,
  );
  RelationDisputedResponseSchema.parse(gapDisputeResp);
  assert.equal(gapDisputeResp.status, "disputed");
  assert.equal(gapDisputeResp.target, gapId);

  // 7. Transition / Close Proof Gap
  const gapCloseResp = await call(
    `/v1/sessions/${sessionIdA}/gaps/close`,
    {
      gap_id: gapId,
      outcome: "closed-by",
      closed_by: `${claim2Id}@1`,
    },
    authorA,
    201,
    "gap-close-key-1",
  );
  GapClosedResponseSchema.parse(gapCloseResp);
  assert.equal(gapCloseResp.gap_id, gapId);
  assert.equal(gapCloseResp.status, "closed-by");

  // Diptych census over this journey's gap and relation faces (lu59 / 92x /
  // qvzk). A relation is cited by the seq of its relation.asserted event.
  {
    const census = await faceCensus({
      worker: context.worker,
      origin: context.origin,
      userAgent: context.userAgent,
      params: { id: problemId, gid: gapId, relId: String(filedRel1.seq) },
      kinds: ["proof-gap", "relation"],
    });
    assert.deepEqual(census.failures, [], "face census");
    assert.deepEqual(census.covered.sort(), ["proof-gap", "relation"], "both faces resolved");
  }

  console.log(JSON.stringify({ stage: "relations-gaps-real-bindings-success" }));
});
