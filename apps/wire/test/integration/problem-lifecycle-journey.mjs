import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  EnrollmentProblemBindingSchema,
  ProblemIdSchema,
  PublicLedgerProblemIdSchema,
} from "@asimposium/contracts";
import { ProblemDocumentSchema } from "../../../../packages/contracts/src/problem.ts";

/**
 * W5.1 Problem Lifecycle & Statement Drift Journey:
 * 1. Sponsor problem brief creation, listing, assignment, and withdrawal.
 * 2. Fellow problem proposal with private-draft isolation (absent from public index/faces).
 * 3. P11 duplicate statement screening (409 POSSIBLE_DUPLICATE without distinct_because).
 * 4. Sponsor publish to public sharpening status.
 * 5. P3 claims board lock while in sharpening (422 CLAIMS_BOARD_LOCKED).
 * 6. Statement review: P1 author self-certification refusal (422 REVIEWER_IS_AUTHOR).
 * 7. Statement review: independent review (statement-clear) unlocks sharpening -> active.
 * 8. Active claims promotion on unlocked board.
 * 9. Problem statement revision (S@1 -> S@2): flags open claims with statement_drift = 1.
 * 10. P9 review refusal on drifted claims (422 STATEMENT_DRIFT).
 * 11. Author claim re-anchor (POST /v1/sessions/:id/reanchor): clears statement_drift to 0.
 * 12. Enter under-result-review and premature resolution refusal.
 * 13. Famous problem guardrail check and problem resolution with closing synthesis.
 * 14. Problem retirement.
 */
export async function problemLifecycleJourney({
  call,
  enroll,
  env,
  worker,
  origin,
  userAgent,
  sponsorCall,
  fixtures,
}) {
  const sponsorA = "usr_problem_sponsor_a";
  const sponsorB = "usr_problem_sponsor_b";

  // Enroll Fellows under Sponsor A and Sponsor B
  const fellowA1Token = await enroll("fellow-a1-proposer", sponsorA);
  const fellowB1Token = await enroll("fellow-b1-independent", sponsorB);

  // --- Step 1: Sponsor Problem Briefs ---
  const briefPayload = {
    title: "Collatz 3x+1 Modular Cycles",
    statement: "Every non-trivial cycle in the 3x+1 mapping modulo 2^k has length bounded by k.",
    falsifier: "A cycle modulo 2^k with length strictly exceeding k.",
    motivation:
      "Bounding modular cycle length constrains non-trivial integer cycles in the Collatz map.",
    areas: ["number-theory", "dynamical-systems"],
  };

  const savedBrief = await sponsorCall(
    sponsorA,
    "POST",
    "/v1/sponsors/problem-briefs",
    "save-problem-brief",
    briefPayload,
    201,
  );
  assert.ok(savedBrief.brief.id.startsWith("brief-"));
  assert.equal(savedBrief.brief.status, "active");

  async function storedBrief(id) {
    return env.DB.prepare("SELECT * FROM sponsor_problem_briefs WHERE id = ?").bind(id).first();
  }
  function briefDigest(row) {
    return createHash("sha256").update(JSON.stringify(row)).digest("hex");
  }
  async function refuseBriefEdit(sponsor, id, title) {
    const before = briefDigest(await storedBrief(id));
    const refused = await sponsorCall(
      sponsor,
      "POST",
      "/v1/sponsors/problem-briefs",
      "save-problem-brief",
      { ...briefPayload, id, title },
      404,
    );
    assert.equal(refused.code, "BRIEF_NOT_FOUND");
    assert.equal(
      briefDigest(await storedBrief(id)),
      before,
      "A refused brief edit must preserve every stored field",
    );
  }

  // A valid signature identifies the caller; it must not authorize edits to
  // another sponsor's known brief ID. Compare hashes without logging drafts.
  await refuseBriefEdit(sponsorB, savedBrief.brief.id, "Cross-sponsor overwrite attempt");
  const fellowA = await call("/v1/hello", undefined, fellowA1Token);
  const editedBrief = await sponsorCall(
    sponsorA,
    "POST",
    "/v1/sponsors/problem-briefs",
    "save-problem-brief",
    {
      ...briefPayload,
      id: savedBrief.brief.id,
      title: "Assigned modular-cycle brief",
      assigned_fellow_id: fellowA.fellow.fellow_id,
    },
    201,
  );
  const storedEditedBrief = await storedBrief(savedBrief.brief.id);
  assert.equal(editedBrief.brief.created_at, savedBrief.brief.created_at);
  assert.equal(editedBrief.brief.status, storedEditedBrief.status);
  assert.equal(editedBrief.brief.assigned_fellow_id, fellowA.fellow.fellow_id);
  assert.equal(storedEditedBrief.assigned_fellow_id, fellowA.fellow.fellow_id);
  assert.ok(storedEditedBrief.title === "Assigned modular-cycle brief");
  assert.ok(editedBrief.brief.title === storedEditedBrief.title);

  const briefList = await sponsorCall(
    sponsorA,
    "GET",
    "/v1/sponsors/problem-briefs",
    "list-problem-briefs",
    undefined,
    200,
  );
  assert.ok(briefList.briefs.some((b) => b.id === savedBrief.brief.id));

  // Withdraw an extra brief to test withdrawal
  const withdrawableBrief = await sponsorCall(
    sponsorA,
    "POST",
    "/v1/sponsors/problem-briefs",
    "save-problem-brief",
    { ...briefPayload, title: "Withdrawable Brief" },
    201,
  );
  const withdrawRes = await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problem-briefs/${withdrawableBrief.brief.id}/withdraw`,
    "withdraw-problem-brief",
    {},
    200,
  );
  assert.equal(withdrawRes.withdrawn, true);
  await refuseBriefEdit(sponsorA, withdrawableBrief.brief.id, "Edit after withdrawal");

  // --- Step 2: Problem Proposal & Private Draft ---
  const proposalPayload = {
    brief_id: savedBrief.brief.id,
    title: "Collatz Modular Cycle Bounds",
    statement: "Every non-trivial cycle in the 3x+1 mapping modulo 2^k has length bounded by k.",
    falsifier: "A cycle modulo 2^k with length strictly exceeding k.",
    motivation: "Constrains possible non-trivial integer cycles.",
    areas: ["number-theory"],
    famous_guardrail: {
      canonical_formulation:
        "Collatz 3x+1 conjecture: all positive integer orbits under the Collatz map reach 1.",
      variant_distinctions:
        "Restricted to modular cycles mod 2^k, which bounds periodic orbits without resolving integer divergence.",
      authoritative_references: ["Lagarias (1985) The 3x+1 problem and its generalizations"],
      standing_banner:
        "This problem investigates a modular cycle variant and does not prove the full Collatz conjecture.",
    },
  };

  // Cross-sponsor fellow cannot adopt Sponsor A's brief
  const unassignedRefusal = await call("/v1/problems", proposalPayload, fellowB1Token, 403);
  assert.equal(unassignedRefusal.code, "BRIEF_NOT_ASSIGNED");

  // Authorized Fellow A1 adopts the brief and proposes the problem
  const proposed = await call("/v1/problems", proposalPayload, fellowA1Token, 201);
  const problemId = proposed.problem.id;
  for (const schema of [
    EnrollmentProblemBindingSchema,
    ProblemIdSchema,
    PublicLedgerProblemIdSchema,
  ])
    assert.equal(schema.parse(problemId), problemId);
  assert.equal(proposed.problem.title, proposalPayload.title);
  assert.equal(proposed.problem.status, "private-draft");
  assert.equal(proposed.problem.current_statement_version, 1);
  await refuseBriefEdit(sponsorA, savedBrief.brief.id, "Edit after adoption");
  console.log(
    JSON.stringify({
      stage: "problem-brief-write-isolation",
      status: "pass",
      refused_edits: ["other-sponsor", "withdrawn", "adopted"],
      own_edit: "persisted",
      assignment: "persisted",
      created_at: "preserved",
      boundary: "real local D1 and signed sponsor ingress; no OAuth or deployment claim",
    }),
  );

  // P11 duplicate screening: identical statement refuses without distinct_because
  const dupRefusal = await call(
    "/v1/problems",
    {
      title: "Duplicate Collatz Problem",
      statement: "Every non-trivial cycle in the 3x+1 mapping modulo 2^k has length bounded by k.",
      falsifier: "A cycle modulo 2^k with length strictly exceeding k.",
      motivation: "Constrains possible non-trivial integer cycles.",
      areas: ["number-theory"],
    },
    fellowA1Token,
    409,
  );
  assert.equal(dupRefusal.code, "POSSIBLE_DUPLICATE");
  assert.equal(dupRefusal.rule, "P11");

  // Private-draft visibility: invisible on public faces
  const publicIndexJson = await call("/problems.json", undefined, undefined, 200);
  assert.ok(!publicIndexJson.problems.some((p) => p.id === problemId));

  const publicProblemFace = await worker.fetch(`${origin}/p/${problemId}.json`, {
    headers: { "user-agent": userAgent },
  });
  assert.equal(publicProblemFace.status, 404, "Private draft must 404 on public /p/:id.json face");

  // Fellow B1 cannot read private draft
  const hiddenDraft = await call(`/v1/problems/${problemId}`, undefined, fellowB1Token, 404);
  assert.equal(hiddenDraft.code, "PROBLEM_NOT_FOUND");

  // Fellow A1 (creator) can read private draft
  const visibleDraft = await call(`/v1/problems/${problemId}`, undefined, fellowA1Token, 200);
  assert.equal(visibleDraft.problem.id, problemId);
  assert.equal(visibleDraft.problem.status, "private-draft");

  const peerToken = await enroll("fellow-a-private-peer", sponsorA);
  async function privateState() {
    const result = {};
    for (const [name, sql] of Object.entries({
      problems: "SELECT * FROM problems WHERE id = ?",
      sessions: "SELECT * FROM sessions WHERE problem_id = ? ORDER BY session_id",
      members: "SELECT * FROM problem_memberships WHERE problem_id = ? ORDER BY fellow_id",
      workshop: "SELECT * FROM workshop_objects WHERE problem_id = ? ORDER BY workshop_id",
      events: "SELECT * FROM events WHERE problem_id = ? ORDER BY seq",
    }))
      result[name] = (await env.DB.prepare(sql).bind(problemId).all()).results;
    result.replays = (
      await env.DB.prepare(
        "SELECT * FROM session_write_replays ORDER BY scope, principal_scope, idempotency_key",
      ).all()
    ).results;
    result.cursor = await call("/cursor");
    return result;
  }
  const beforePrivateRefusals = await privateState();
  for (const token of [peerToken, fellowB1Token]) {
    assert.equal(
      (await call(`/v1/problems/${problemId}`, undefined, token, 404)).code,
      "PROBLEM_NOT_FOUND",
    );
    assert.equal(
      (await call("/v1/sessions", { problem_id: problemId }, token, 404)).code,
      "PROBLEM_NOT_FOUND",
    );
    assert.deepEqual(await privateState(), beforePrivateRefusals);
  }
  async function boundFellow(name, actor, binding) {
    const minted = await sponsorCall(
      actor,
      "POST",
      "/v1/enrollments",
      "enrollment.mint",
      {
        requested_scopes: ["review"],
        problem_binding: binding,
      },
      201,
    );
    const claimed = await call(
      "/v1/fellows",
      {
        enrollment_id: minted.enrollment_id,
        secret: minted.secret,
        name,
        model: "synthetic-problem-model",
        harness: "local-problem-lifecycle-proof",
      },
      undefined,
      202,
    );
    await sponsorCall(
      actor,
      "POST",
      `/v1/enrollments/${minted.enrollment_id}/decision`,
      "enrollment.decide",
      {
        enrollment_id: minted.enrollment_id,
        decision: "approve",
        step_up_authenticated_at: Math.floor(Date.now() / 1000),
      },
      200,
      "/v1/enrollments/:enrollmentId/decision",
    );
    return (await call("/v1/fellows/flow", { flow_handle: claimed.flow_handle })).token;
  }
  const boundPeer = await boundFellow("fellow-a-bound-peer", sponsorA, problemId);
  const foreignBound = await boundFellow("fellow-b-bound-peer", sponsorB, problemId);
  const wrongTarget = await boundFellow("fellow-a-other-binding", sponsorA, "P-OTHER");
  const beforeBoundRefusals = await privateState();
  for (const [token, status, code] of [
    [foreignBound, 404, "PROBLEM_NOT_FOUND"],
    [wrongTarget, 403, "WRITE_REFUSED"],
  ]) {
    await call(`/v1/problems/${problemId}`, undefined, token, 404);
    assert.equal((await call("/v1/sessions", { problem_id: problemId }, token, status)).code, code);
    assert.deepEqual(await privateState(), beforeBoundRefusals);
  }
  for (const [label, token] of [
    ["creator", fellowA1Token],
    ["explicit-owner-grant", boundPeer],
  ]) {
    assert.equal(
      (await call(`/v1/problems/${problemId}`, undefined, token)).problem.statement,
      proposalPayload.statement,
    );
    const key = `private-authority-${label}`;
    const session = await call("/v1/sessions", { problem_id: problemId }, token, 201, key);
    const afterOpen = await privateState();
    assert.deepEqual(
      await call("/v1/sessions", { problem_id: problemId }, token, 200, key),
      session,
    );
    assert.deepEqual(await privateState(), afterOpen);
    const canary = `PRIVATE_WORKSPACE_${label}_CANARY`;
    const pushed = await call(
      `/v1/sessions/${session.session_id}/workshop`,
      {
        type: "claim-draft",
        title: "Private work",
        body_md: canary,
        relates_to: [],
      },
      token,
      201,
    );
    const pack = await call(
      `/v1/sessions/${session.session_id}/pack?profile=working`,
      undefined,
      token,
    );
    assert.ok(
      pack.items.some((item) => item.kind === "workshop-head" && item.id === pushed.workshop_id),
    );
    const stored = await env.DB.prepare(
      "SELECT fellow_id, body_md FROM workshop_objects WHERE workshop_id = ?",
    )
      .bind(pushed.workshop_id)
      .first();
    assert.equal(stored.body_md, canary);
    const sponsorView = await sponsorCall(
      sponsorA,
      "POST",
      "/v1/sponsors/workshop",
      "workshop.read",
      {
        problem_id: problemId,
        fellow_id: stored.fellow_id,
      },
    );
    assert.equal(
      sponsorView.objects.find((object) => object.workshop_id === pushed.workshop_id).body_md,
      canary,
    );
    await call(
      `/v1/sessions/${session.session_id}/close`,
      { handback: "Private work retained for later publication." },
      token,
      201,
    );
    await call(`/p/${problemId}.json`, undefined, undefined, 404);
  }
  const nonLatinTitle = "有限経路の研究".repeat(15);
  const nonLatin = await call(
    "/v1/problems",
    {
      title: nonLatinTitle,
      statement: "Every finite path over this alphabet has finitely many vertices.",
      falsifier: "A finite path in this domain with infinitely many vertices.",
      motivation: "Display text must not control whether enrollment can bind the problem.",
      areas: ["combinatorics"],
    },
    fellowA1Token,
    201,
  );
  for (const schema of [
    EnrollmentProblemBindingSchema,
    ProblemIdSchema,
    PublicLedgerProblemIdSchema,
  ])
    assert.equal(schema.parse(nonLatin.problem.id), nonLatin.problem.id);
  assert.notEqual(nonLatin.problem.id, problemId);
  assert.equal(
    (await call(`/v1/problems/${nonLatin.problem.id}`, undefined, fellowA1Token)).problem.title,
    nonLatinTitle,
  );
  // An explicit legacy read fixture proves this repair does not narrow retained IDs.
  await fixtures.seedProblem("P-LEGACY-TITLE-12345678", sponsorA);
  assert.equal((await call("/p/P-LEGACY-TITLE-12345678.json")).problem, "P-LEGACY-TITLE-12345678");
  console.log(
    JSON.stringify({
      stage: "private-problem-authority",
      status: "pass",
      enrollment_binding: "real signed mint and explicit approval",
      owner_and_granted_workshop: "readable",
      ungranted_and_foreign_admission: "refused",
      retained_ids: "readable",
      boundary: "real local D1 and signed ingress; no OAuth or deployment claim",
    }),
  );

  // --- Step 3: Sponsor Publishes to Sharpening ---
  const publishRes = await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
    200,
  );
  assert.equal(publishRes.problem.status, "sharpening");

  // Now visible on public problems index!
  const publicIndexAfterPublish = await call("/problems.json", undefined, undefined, 200);
  assert.ok(publicIndexAfterPublish.problems.some((p) => p.id === problemId));

  // --- Step 4: P3 Claims Board Gate (Locked in Sharpening) ---
  const sessionA1 = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "prove" },
    fellowA1Token,
    201,
  );
  const draftA1 = await call(
    `/v1/sessions/${sessionA1.session_id}/workshop`,
    { type: "claim-draft", title: "Sharpening claim draft", body_md: "Draft text", relates_to: [] },
    fellowA1Token,
    201,
  );

  const lockedRefusal = await call(
    `/v1/sessions/${sessionA1.session_id}/promote`,
    {
      workshop_id: draftA1.workshop_id,
      kind: "conjecture",
      statement: "For all k >= 1, the period of the 3x+1 cycle mod 2^k is at most k.",
      falsifier: "A cycle of length > k mod 2^k.",
    },
    fellowA1Token,
    422,
  );
  assert.equal(lockedRefusal.code, "CLAIMS_BOARD_LOCKED");
  assert.equal(lockedRefusal.rule, "P3");

  // --- Step 5: Statement Review & Sharpening Unlock ---
  const sessionB1 = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "review" },
    fellowB1Token,
    201,
  );
  // Author fellow attempts review -> 422 REVIEWER_IS_AUTHOR (rule P1)
  const selfReview = await call(
    `/v1/problems/${problemId}/statement-review`,
    {
      session_id: sessionA1.session_id,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "I assert my own statement is clear.",
    },
    fellowA1Token,
    422,
  );
  assert.equal(selfReview.code, "REVIEWER_IS_AUTHOR");
  assert.equal(selfReview.rule, "P1");

  // Independent Fellow B1 submits statement-clear review
  const independentReview = await call(
    `/v1/problems/${problemId}/statement-review`,
    {
      verdict: "statement-clear",
      basis: "The formulation is rigorous, types are exact, and falsifier is sharp.",
      session_id: sessionB1.session_id,
      statement_version: 1,
    },
    fellowB1Token,
    200,
  );
  assert.equal(independentReview.verdict, "statement-clear");
  assert.equal(independentReview.status, "active");

  // Verify review record was persisted in problem_statement_reviews in D1
  const persistedReview = await env.DB.prepare(
    "SELECT * FROM problem_statement_reviews WHERE problem_id = ? AND version = 1",
  )
    .bind(problemId)
    .first();
  assert.ok(persistedReview, "Statement review must be persisted in D1");
  assert.equal(persistedReview.verdict, "statement-clear");
  const statementEvent = await env.DB.prepare(
    "SELECT * FROM events WHERE problem_id = ? AND type = 'problem.statement-reviewed'",
  )
    .bind(problemId)
    .first();
  assert.ok(statementEvent, "Statement review and activation must append a ledger event");
  assert.equal(statementEvent.actor_fellow_id, persistedReview.reviewer_fellow_id);
  assert.equal(statementEvent.actor_sponsor_id, sponsorB);
  assert.ok(statementEvent.actor_session_id, "Statement review must retain its actual session");
  assert.equal(
    persistedReview.basis,
    "The formulation is rigorous, types are exact, and falsifier is sharp.",
  );

  // Duplicate review on the same version is refused 409 REVIEWER_ALREADY_REVIEWED
  const duplicateReview = await call(
    `/v1/problems/${problemId}/statement-review`,
    {
      verdict: "statement-clear",
      basis: "A duplicate review attempt.",
      session_id: sessionB1.session_id,
      statement_version: 1,
    },
    fellowB1Token,
    409,
  );
  assert.equal(duplicateReview.code, "REVIEWER_ALREADY_REVIEWED");
  assert.equal(duplicateReview.rule, "P1");

  // Invalid review body (empty basis) is refused 422 REVIEW_BODY_INVALID
  const invalidReview = await call(
    `/v1/problems/${problemId}/statement-review`,
    {
      verdict: "statement-clear",
      basis: "",
      session_id: sessionB1.session_id,
      statement_version: 1,
    },
    fellowB1Token,
    422,
  );
  assert.equal(invalidReview.code, "REVIEW_BODY_INVALID");

  // Verify status is now active in D1
  const activeProblem = await call(`/v1/problems/${problemId}`, undefined, undefined, 200);
  assert.equal(activeProblem.problem.status, "active");

  // --- Step 6: Active Claims Promotion ---
  const promotedClaim = await call(
    `/v1/sessions/${sessionA1.session_id}/promote`,
    {
      workshop_id: draftA1.workshop_id,
      kind: "conjecture",
      statement: "For all k >= 1, the period of the 3x+1 cycle mod 2^k is at most k.",
      falsifier: "A cycle of length > k mod 2^k.",
    },
    fellowA1Token,
    201,
  );
  assert.ok(promotedClaim.claim_id.startsWith("C-"));

  // --- Step 7: Problem Statement Revision (S@1 -> S@2) & Statement Drift ---
  const revisedProblem = await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "problem-lifecycle",
    {
      action: "revise-statement",
      statement: "For all k >= 3, the non-trivial 3x+1 cycle mod 2^k has length bounded by k - 2.",
      falsifier: "A non-trivial cycle mod 2^k with length > k - 2 for k >= 3.",
      motivation: "Strengthened bound based on modular obstruction analysis.",
    },
    200,
  );
  assert.equal(revisedProblem.problem.current_statement_version, 2);

  // Assert claim now has statement_drift = 1 in D1
  const driftedClaimRow = await env.DB.prepare(
    "SELECT statement_version, statement_drift FROM claims WHERE problem_id = ? AND id = ?",
  )
    .bind(problemId, promotedClaim.claim_id)
    .first();
  assert.equal(driftedClaimRow.statement_version, 1);
  assert.equal(driftedClaimRow.statement_drift, 1);

  // Review on drifted claim is refused (P9)
  const driftedReview = await call(
    `/v1/sessions/${sessionB1.session_id}/review`,
    {
      target_claim_id: promotedClaim.claim_id,
      target_version: 1,
      verdict: "confirm",
      basis: "Review on unanchored claim.",
      body_md: "Review body.",
    },
    fellowB1Token,
    422,
  );
  assert.equal(driftedReview.code, "STATEMENT_DRIFT");
  assert.equal(driftedReview.rule, "P9");

  async function claimLedgerDigest() {
    const rows = await env.DB.batch([
      env.DB.prepare("SELECT * FROM claims WHERE problem_id = ? ORDER BY id").bind(problemId),
      env.DB.prepare(
        "SELECT * FROM claim_versions WHERE problem_id = ? ORDER BY claim_id, version",
      ).bind(problemId),
      env.DB.prepare("SELECT * FROM events WHERE problem_id = ? ORDER BY seq").bind(problemId),
    ]);
    return createHash("sha256")
      .update(JSON.stringify(rows.map((row) => row.results)))
      .digest("hex");
  }

  let policyFace;
  async function refuseClaimWrite(path, body, token, code = "WRITE_REFUSED") {
    const before = await claimLedgerDigest();
    const refused = await call(path, body, token, code === "WRITE_REFUSED" ? 403 : 422);
    assert.equal(refused.code, code);
    assert.ok(ProblemDocumentSchema.safeParse(refused).success);
    if (code === "WRITE_REFUSED") {
      assert.equal(refused.detail, "This credential may not perform this write now.");
      assert.equal(
        refused.fix_hint,
        "Check the console for the credential state or contact your sponsor.",
      );
      const encoded = JSON.stringify(refused);
      if (policyFace === undefined) policyFace = encoded;
      else assert.equal(encoded, policyFace, "Policy causes must share one coarse refusal face");
    } else {
      assert.equal(refused.schema, "https://a.asimposium.org/schemas/sessions.v1.json");
    }
    assert.equal(await claimLedgerDigest(), before, "Refusals must not mutate claims or events");
  }

  await refuseClaimWrite(
    `/v1/sessions/${sessionB1.session_id}/reanchor`,
    { claim_id: promotedClaim.claim_id, base_version: 1 },
    fellowB1Token,
  );
  await refuseClaimWrite(
    `/v1/sessions/${sessionB1.session_id}/reanchor`,
    { claim_id: promotedClaim.claim_id, base_version: 1 },
    fellowB1Token,
  );

  // Re-anchor by author fellow clears statement_drift to 0
  const reanchorRes = await call(
    `/v1/sessions/${sessionA1.session_id}/reanchor`,
    {
      claim_id: promotedClaim.claim_id,
      base_version: 1,
    },
    fellowA1Token,
    200,
  );
  assert.equal(reanchorRes.reanchored, true);
  assert.equal(reanchorRes.statement_version, 2);
  assert.equal(reanchorRes.statement_drift, false);

  const reanchoredRow = await env.DB.prepare(
    "SELECT statement_version, statement_drift FROM claims WHERE problem_id = ? AND id = ?",
  )
    .bind(problemId, promotedClaim.claim_id)
    .first();
  assert.equal(reanchoredRow.statement_version, 2);
  assert.equal(reanchoredRow.statement_drift, 0);

  // Review now succeeds!
  const validReview = await call(
    `/v1/sessions/${sessionB1.session_id}/review`,
    {
      target_claim_id: promotedClaim.claim_id,
      target_version: 1,
      verdict: "confirm",
      basis: "Statement reanchored and verified against S@2.",
      body_md: "Review verification.",
    },
    fellowB1Token,
    201,
  );
  assert.ok(validReview.review_id.startsWith("R-"));

  // --- Step 8: Under-Result-Review & Resolution ---
  // Premature resolution without under-result-review refused (rule P3)
  const prematureResolve = await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "problem-lifecycle",
    {
      action: "resolve",
      direction: "affirmed",
      closing_synthesis: {
        summary: "The modular bound holds for all k >= 3.",
        no_claim_boundary: {
          verified: ["Modular cycle bounds"],
          mechanisms: ["2-adic valuation"],
          independence_tiers: ["T2"],
          remaining_external_validation: ["Full integer Collatz map"],
        },
      },
    },
    422,
  );
  assert.equal(prematureResolve.code, "PREMATURE_RESOLUTION");

  // Transition to under-result-review
  const reviewStage = await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "problem-lifecycle",
    {
      action: "enter-result-review",
      result_claim: { claim_id: promotedClaim.claim_id, version: 1 },
    },
    200,
  );
  assert.equal(reviewStage.problem.status, "under-result-review");
  assert.equal(reviewStage.problem.result_claim.claim_id, promotedClaim.claim_id);
  const reviewFace = await call(`/p/${problemId}.json`);
  assert.ok(
    reviewFace.items.some(
      (item) => item.kind === "result-review" && item.body.includes(`${promotedClaim.claim_id}@1`),
    ),
  );
  const reviewLink = reviewFace.next_actions.find(
    (action) => action.url === `/p/${problemId}/claims/${promotedClaim.claim_id}@1.json`,
  );
  assert.ok(reviewLink);
  await call(reviewLink.url);

  // Missing external proof is insufficient; free-text proof below is insufficient too.
  const missingProofRefusal = await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "problem-lifecycle",
    {
      action: "resolve",
      direction: "affirmed",
      closing_synthesis: {
        summary: "The modular bound holds for all k >= 3.",
        no_claim_boundary: {
          verified: ["Modular cycle bounds"],
          mechanisms: ["2-adic valuation"],
          independence_tiers: ["T2"],
          remaining_external_validation: ["Full integer Collatz map"],
        },
      },
    },
    422,
  );
  assert.equal(missingProofRefusal.code, "PREMATURE_RESOLUTION");

  // Plausible prose is not an external verification record or an anchored synthesis.
  const beforeUnsupportedResolution = await privateState();
  for (const direction of ["affirmed", "refuted-as-stated", "closed-with-negative-result"]) {
    const unsupportedResolution = await sponsorCall(
      sponsorA,
      "POST",
      `/v1/sponsors/problems/${problemId}/lifecycle`,
      "problem-lifecycle",
      {
        action: "resolve",
        direction,
        closing_synthesis: {
          summary: "The modular cycle length bound is settled.",
          no_claim_boundary: {
            verified: ["Modular cycle bounds"],
            mechanisms: ["2-adic valuation"],
            independence_tiers: ["T2"],
            remaining_external_validation: ["Full integer Collatz map"],
          },
        },
        external_expert_review_proof:
          "Lean 4 formalized proof independently verified by 2 external experts.",
      },
      422,
    );
    assert.equal(unsupportedResolution.code, "PREMATURE_RESOLUTION");
    assert.deepEqual(await privateState(), beforeUnsupportedResolution);
  }
  console.log(
    JSON.stringify({
      stage: "anchored-result-review",
      status: "pass",
      result_target: "exact public claim version and evidence/review links",
      unsupported_resolution_directions: 3,
      refused_mutations: 0,
      terminal_fixture_boundary:
        "following resolved-row checks use an explicit retained-data fixture, not resolution admission",
    }),
  );

  // Retained resolved-row fixture ONLY: preserve read/refusal coverage for historical
  // data without presenting a seeded terminal state as successful resolution admission.
  await env.DB.prepare(`UPDATE problems SET status = 'resolved', resolution_direction = 'affirmed',
    resolution_summary = 'Historical resolution record', resolution_no_claim_boundary = ? WHERE id = ?`)
    .bind(
      JSON.stringify({
        verified: ["Modular cycle bounds"],
        mechanisms: ["2-adic valuation"],
        independence_tiers: ["T2"],
        remaining_external_validation: ["Full integer Collatz map"],
      }),
      problemId,
    )
    .run();
  const resolvedBefore = await env.DB.prepare("SELECT * FROM problems WHERE id = ?")
    .bind(problemId)
    .first();
  const resolvedEventsBefore = await env.DB.prepare(
    "SELECT * FROM events WHERE problem_id = ? ORDER BY seq",
  )
    .bind(problemId)
    .all();
  const resolvedCursorBefore = await call("/cursor");
  for (const action of [
    {
      action: "enter-result-review",
      result_claim: { claim_id: promotedClaim.claim_id, version: 1 },
    },
    { action: "retire", reason: "Cannot replace an existing resolution." },
  ]) {
    const refusal = await sponsorCall(
      sponsorA,
      "POST",
      `/v1/sponsors/problems/${problemId}/lifecycle`,
      "problem-lifecycle",
      action,
      409,
    );
    assert.equal(refusal.code, "OBJECT_VERSION_CONFLICT");
  }
  assert.deepEqual(
    await env.DB.prepare("SELECT * FROM problems WHERE id = ?").bind(problemId).first(),
    resolvedBefore,
  );
  assert.deepEqual(
    (
      await env.DB.prepare("SELECT * FROM events WHERE problem_id = ? ORDER BY seq")
        .bind(problemId)
        .all()
    ).results,
    resolvedEventsBefore.results,
  );
  assert.equal(await call("/cursor"), resolvedCursorBefore);

  // Verify problem detail resolution reflects actual saved data and no fabricated fallbacks
  const resolvedDetail = await call(`/v1/problems/${problemId}`, undefined, undefined, 200);
  assert.equal(resolvedDetail.problem.status, "resolved");
  assert.ok(resolvedDetail.problem.resolution, "Problem must have resolution object");
  assert.equal(resolvedDetail.problem.resolution.direction, "affirmed");
  assert.deepEqual(resolvedDetail.problem.resolution.no_claim_boundary.verified, [
    "Modular cycle bounds",
  ]);

  // Verify that a problem without resolution_no_claim_boundary does NOT fabricate resolution literals
  await env.DB.prepare("UPDATE problems SET resolution_no_claim_boundary = NULL WHERE id = ?")
    .bind(problemId)
    .run();
  const unboundaryDetail = await call(`/v1/problems/${problemId}`, undefined, undefined, 200);
  assert.equal(unboundaryDetail.problem.status, "resolved");
  assert.equal(
    unboundaryDetail.problem.resolution,
    undefined,
    "A resolved problem with missing no-claim boundary must not synthesize fake literals",
  );
  // Restore the boundary
  await env.DB.prepare("UPDATE problems SET resolution_no_claim_boundary = ? WHERE id = ?")
    .bind(
      JSON.stringify({
        verified: ["Modular cycle bounds"],
        mechanisms: ["2-adic valuation"],
        independence_tiers: ["T2"],
        remaining_external_validation: ["Full integer Collatz map"],
      }),
      problemId,
    )
    .run();

  // Further promotion on resolved problem refused
  const postResolveDraft = await call(
    `/v1/sessions/${sessionA1.session_id}/workshop`,
    { type: "claim-draft", title: "Post-resolution draft", body_md: "Draft", relates_to: [] },
    fellowA1Token,
    201,
  );
  await refuseClaimWrite(
    `/v1/sessions/${sessionA1.session_id}/promote`,
    {
      workshop_id: postResolveDraft.workshop_id,
      kind: "conjecture",
      statement: "A new conjecture on resolved problem.",
      falsifier: "Counterexample.",
    },
    fellowA1Token,
    "CLAIMS_BOARD_LOCKED",
  );
  await refuseClaimWrite(
    `/v1/sessions/${sessionA1.session_id}/revise`,
    {
      claim_id: promotedClaim.claim_id,
      base_version: 1,
      kind: "conjecture",
      statement: "A revised conjecture on the resolved problem.",
      falsifier: "A counterexample to the revised conjecture.",
    },
    fellowA1Token,
    "CLAIMS_BOARD_LOCKED",
  );
  await refuseClaimWrite(
    `/v1/sessions/${sessionA1.session_id}/reanchor`,
    { claim_id: promotedClaim.claim_id, base_version: 1 },
    fellowA1Token,
    "CLAIMS_BOARD_LOCKED",
  );
  process.stdout.write(
    `${JSON.stringify({
      stage: "lifecycle-refusal-contracts",
      status: "pass",
      refused_writes: [
        "wrong-author-reanchor",
        "closed-promote",
        "closed-revise",
        "closed-reanchor",
      ],
      claim_and_event_mutations: 0,
    })}\n`,
  );

  // --- Step 9: Problem Retirement ---
  const retiredProblemProp = await call(
    "/v1/problems",
    {
      title: "Problem To Retire",
      statement: "A problem statement that will be retired early.",
      falsifier: "A falsifier for retired problem.",
      motivation: "Retirement flow verification.",
      areas: ["topology-and-geometry"],
    },
    fellowA1Token,
    201,
  );
  const retiredProblemId = retiredProblemProp.problem.id;

  const privateRetirement = await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${retiredProblemId}/lifecycle`,
    "problem-lifecycle",
    { action: "retire", reason: "Must remain private before publication." },
    409,
  );
  assert.equal(privateRetirement.code, "OBJECT_VERSION_CONFLICT");
  await call(`/p/${retiredProblemId}.json`, undefined, undefined, 404);
  await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${retiredProblemId}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
    200,
  );

  const retireRes = await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${retiredProblemId}/lifecycle`,
    "problem-lifecycle",
    { action: "retire", reason: "Explored alternate topological formulation." },
    200,
  );
  assert.equal(retireRes.problem.status, "retired");

  // Pin the admission bound independently of the runtime constant. Padding
  // valid JSON with whitespace proves that byte admission precedes parsing.
  const problemBodyLimit = 512 * 1024;
  const encoder = new TextEncoder();
  const boundaryProposal = {
    title: "BYTE_SENTINEL · bounded proposal",
    statement: "Every edge in a finite matching has two distinct endpoints.",
    falsifier: "An edge in the matching with fewer than two distinct endpoints.",
    motivation: "Exercise problem ingress without oversized stored fields.",
    areas: ["combinatorics"],
  };
  const boundaryBrief = await sponsorCall(
    sponsorA,
    "POST",
    "/v1/sponsors/problem-briefs",
    "save-problem-brief",
    boundaryProposal,
    201,
  );
  const boundaryReviewProblem = await call(
    "/v1/problems",
    {
      ...boundaryProposal,
      title: "Bounded statement review",
      statement: "A finite path with n edges has n + 1 distinct vertices.",
    },
    fellowA1Token,
    201,
  );
  const boundaryReviewId = boundaryReviewProblem.problem.id;
  await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${boundaryReviewId}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
    200,
  );

  const boundarySession = await call(
    "/v1/sessions",
    { problem_id: boundaryReviewId, intent: "review" },
    fellowB1Token,
    201,
  );
  async function problemWriteDigest() {
    const rows = await env.DB.batch([
      env.DB.prepare("SELECT * FROM problems ORDER BY id"),
      env.DB.prepare("SELECT * FROM problem_statement_versions ORDER BY problem_id, version"),
      env.DB.prepare("SELECT * FROM sponsor_problem_briefs ORDER BY id"),
      env.DB.prepare("SELECT * FROM krater_integrity_backfill ORDER BY problem_id"),
      env.DB.prepare("SELECT * FROM events ORDER BY problem_id, seq"),
      env.DB.prepare(
        "SELECT * FROM problem_statement_reviews ORDER BY problem_id, version, reviewer_fellow_id",
      ),
    ]);
    return createHash("sha256")
      .update(JSON.stringify(rows.map((row) => row.results)))
      .digest("hex");
  }

  const boundaryRoutes = [
    {
      name: "proposal",
      path: "/v1/problems",
      token: fellowA1Token,
      payload: { ...boundaryProposal, brief_id: boundaryBrief.brief.id },
      malformedCode: "PROBLEM_PROPOSE_BODY_INVALID",
      acceptedStatus: 201,
    },
    {
      name: "statement-review",
      path: `/v1/problems/${boundaryReviewId}/statement-review`,
      token: fellowB1Token,
      payload: {
        session_id: boundarySession.session_id,
        statement_version: 1,
        verdict: "statement-clear",
        basis: "BYTE_SENTINEL · independently checked.",
      },
      malformedCode: "REVIEW_BODY_INVALID",
      acceptedStatus: 200,
    },
  ];
  const boundaryFailures = [];
  for (const route of boundaryRoutes) {
    try {
      const json = JSON.stringify(route.payload);
      const encoded = encoder.encode(json);
      const padded = new Uint8Array(problemBodyLimit + 1).fill(32);
      padded.set(encoded);
      const invalidUtf8 = encoded.slice();
      assert.ok(json.includes("BYTE_SENTINEL"));
      invalidUtf8[encoder.encode(json.slice(0, json.indexOf("BYTE_SENTINEL"))).length] = 255;

      let requestIndex = 0;
      async function submit(bytes, streamed, headers = {}) {
        let offset = 0;
        const body = streamed
          ? new ReadableStream({
              pull(controller) {
                if (offset === bytes.byteLength) return controller.close();
                const end = Math.min(offset + 16 * 1024, bytes.byteLength);
                controller.enqueue(bytes.subarray(offset, end));
                offset = end;
              },
            })
          : bytes;
        return worker.fetch(`${origin}${route.path}`, {
          method: "POST",
          headers: {
            "User-Agent": userAgent,
            authorization: `Bearer ${route.token}`,
            "content-type": "application/json",
            "idempotency-key": `body-boundary-${route.name}-${++requestIndex}`,
            ...headers,
          },
          body,
          duplex: "half",
        });
      }

      const cases = [
        {
          name: "declared-overflow",
          bytes: padded,
          streamed: false,
          headers: { "content-length": String(padded.byteLength) },
          status: 413,
          code: "REQUEST_BODY_TOO_LARGE",
        },
        {
          name: "streamed-overflow-without-length",
          bytes: padded,
          streamed: true,
          status: 413,
          code: "REQUEST_BODY_TOO_LARGE",
        },
        { name: "malformed-json", bytes: encoder.encode("{"), streamed: false },
        { name: "invalid-utf8", bytes: invalidUtf8, streamed: true },
        {
          name: "unsupported-encoding",
          bytes: encoded,
          streamed: true,
          headers: { "content-encoding": "gzip" },
        },
      ];
      for (const entry of cases) {
        const before = await problemWriteDigest();
        const response = await submit(entry.bytes, entry.streamed, entry.headers);
        assert.equal(response.status, entry.status ?? 422, `${route.name}: ${entry.name}`);
        const refused = await response.json();
        assert.equal(refused.code, entry.code ?? route.malformedCode);
        assert.ok(ProblemDocumentSchema.safeParse(refused).success);
        assert.equal(await problemWriteDigest(), before, `${route.name}: refusal mutated D1`);
      }

      const accepted = await submit(padded.subarray(0, problemBodyLimit), true, {
        "content-encoding": "identity",
      });
      assert.equal(accepted.status, route.acceptedStatus, `${route.name}: exact byte limit`);
      const acceptedBody = await accepted.json();
      assert.equal(accepted.headers.get("cache-control"), "private, no-store");
      if (route.name === "proposal") {
        assert.equal(acceptedBody.problem.status, "private-draft");
        assert.equal((await storedBrief(boundaryBrief.brief.id)).status, "adopted");
      } else {
        assert.equal(acceptedBody.status, "active");
        const stored = await env.DB.prepare("SELECT status FROM problems WHERE id = ?")
          .bind(boundaryReviewId)
          .first();
        assert.equal(stored.status, "active");
      }
      console.log(
        JSON.stringify({
          stage: "problem-body-limits",
          route: route.name,
          status: "pass",
          limit_bytes: problemBodyLimit,
          refused_cases: cases.map((entry) => entry.name),
          refused_mutations: 0,
          exact_limit_write: "persisted",
          boundary: "real local Workerd/D1; no deployment or OAuth claim",
        }),
      );
    } catch (error) {
      boundaryFailures.push(error);
    }
  }
  if (boundaryFailures.length > 0) {
    throw new AggregateError(boundaryFailures, "Problem body-limit checks failed");
  }

  return {
    status: "pass",
    problem: problemId,
    retiredProblem: retiredProblemId,
  };
}
