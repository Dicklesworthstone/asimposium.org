import assert from "node:assert/strict";
import {
  ConflictsListResponseSchema,
  NormalizeConflictResponseSchema,
  ResolveConflictResponseSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

await runLocalWorkerJourney(async (context) => {
  const { call, enroll, sponsorCall, worker, origin, env } = context;
  const sponsorA = "usr_cf_sponsor_a";
  const authorA = await enroll("cf-author-a", sponsorA);
  const helloA = await call("/v1/hello", undefined, authorA);
  const _fellowIdA = helloA.fellow.fellow_id;

  const sponsorB = "usr_cf_sponsor_b";
  const reviewerB = await enroll("cf-reviewer-b", sponsorB);
  const helloB = await call("/v1/hello", undefined, reviewerB);
  const _fellowIdB = helloB.fellow.fellow_id;

  // 1. Propose and publish problem
  const created = await call(
    "/v1/problems",
    {
      title: "Conflicts test problem",
      statement: "Every non-trivial modular cycle has bounded residue length.",
      falsifier: "An unbounded residue length under modular transformation.",
      motivation: "Testing W5.5 normalized conflicts (CF-n) and Diptych public faces.",
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
  await govern({ action: "publish" }, "publish-cf-problem");

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

  // --------------------------------------------------------------------------
  // CONFLICTS NORMALIZATION JOURNEY
  // --------------------------------------------------------------------------

  const validPayload = {
    claims: [
      { claim_id: claim1Id, version: 1 },
      { claim_id: claim2Id, version: 1 },
    ],
    aligned_definitions:
      "Both claims adopt the standard residue metric under modular powers of two.",
    aligned_scope: "Integer exponents k strictly greater than 4 under standard binary arithmetic.",
    aligned_quantifiers:
      "For all k >= 5, the respective bounding inequality holds unconditionally.",
    smallest_disagreement:
      "Claim 1 bounds the cycle length by <= 2k whereas Claim 2 asserts an unconditional lower bound of >= 3k.",
    agreed_facts: [
      "The cycle exists and is finite for all k >= 1.",
      "The multiplier is an odd positive integer coprime to 2.",
    ],
    discriminating_tests: [
      "Explicit valuation trace for k = 5 through k = 8.",
      "Formal reduction in Lean 4 comparing the two recurrence relations.",
    ],
  };

  // 3. Validation: short or placeholder alignment fields (422)
  const invalidShort = await call(
    `/v1/sessions/${sessionIdA}/conflicts`,
    {
      ...validPayload,
      aligned_definitions: "too short",
    },
    authorA,
    422,
  );
  assert.equal(invalidShort.code, "CONFLICT_BODY_INVALID");

  // 4. Validation: identical claims (422)
  const identicalClaims = await call(
    `/v1/sessions/${sessionIdA}/conflicts`,
    {
      ...validPayload,
      claims: [
        { claim_id: claim1Id, version: 1 },
        { claim_id: claim1Id, version: 1 },
      ],
    },
    authorA,
    422,
  );
  assert.ok(
    identicalClaims.code === "CONFLICT_BODY_INVALID" ||
      identicalClaims.code === "CONFLICT_TARGET_IDENTICAL",
  );

  // 5. Validation: unknown claim version (404)
  const unknownClaim = await call(
    `/v1/sessions/${sessionIdA}/conflicts`,
    {
      ...validPayload,
      claims: [
        { claim_id: claim1Id, version: 1 },
        { claim_id: "C-NONEXISTENT", version: 1 },
      ],
    },
    authorA,
    404,
  );
  assert.equal(unknownClaim.code, "CONFLICT_TARGET_UNKNOWN");

  // Every public prose field must reach the same screening boundary. These
  // canaries exercise the local classifier fixture, not live model accuracy.
  const beforeScreening = await env.DB.prepare("SELECT public_seq FROM problems WHERE id = ?")
    .bind(problemId)
    .first();
  for (const field of [
    "aligned_definitions",
    "aligned_scope",
    "aligned_quantifiers",
    "smallest_disagreement",
    "agreed_facts",
    "discriminating_tests",
  ]) {
    const refused = await call(
      `/v1/sessions/${sessionIdA}/conflicts`,
      {
        ...validPayload,
        [field]: Array.isArray(validPayload[field])
          ? ["LOCAL_POLICY_CANARY"]
          : "LOCAL_POLICY_CANARY",
      },
      authorA,
      403,
      `conflict-screen-${field}`,
    );
    assert.equal(refused.code, "POLICY_DENIED");
    assert.deepEqual(
      await env.DB.prepare("SELECT public_seq FROM problems WHERE id = ?").bind(problemId).first(),
      beforeScreening,
    );
  }

  // 6. Normalization: success (201)
  const normalized = await call(
    `/v1/sessions/${sessionIdA}/conflicts`,
    validPayload,
    authorA,
    201,
    "idempotent-normalize-key-1",
  );
  NormalizeConflictResponseSchema.parse(normalized);
  const conflictId = normalized.conflict_id;
  assert.ok(conflictId.startsWith("CF-"));
  assert.equal(normalized.status, "open");
  assert.equal(normalized.problem_id, problemId);

  // Replay idempotency check
  const replayed = await call(
    `/v1/sessions/${sessionIdA}/conflicts`,
    validPayload,
    authorA,
    200,
    "idempotent-normalize-key-1",
  );
  assert.equal(replayed.conflict_id, conflictId);

  // 7. Duplicate open conflict refusal (409)
  const duplicateConflict = await call(
    `/v1/sessions/${sessionIdA}/conflicts`,
    {
      ...validPayload,
      claims: [
        { claim_id: claim2Id, version: 1 },
        { claim_id: claim1Id, version: 1 },
      ],
    },
    authorA,
    409,
    "different-key-for-duplicate",
  );
  assert.equal(duplicateConflict.code, "CONFLICT_ALREADY_NORMALIZED");
  assert.equal(duplicateConflict.existing_conflict_id, conflictId);

  // --------------------------------------------------------------------------
  // DIPTYCH PUBLIC FACES CHECK (OPEN CONFLICT)
  // --------------------------------------------------------------------------

  const conflictsJsonRes = await worker.fetch(`${origin}/p/${problemId}/conflicts.json`);
  assert.equal(conflictsJsonRes.status, 200);
  assert.equal(conflictsJsonRes.headers.get("content-type"), "application/json; charset=utf-8");
  const conflictsJson = ConflictsListResponseSchema.parse(await conflictsJsonRes.json());
  assert.equal(conflictsJson.conflicts.length, 1);
  const firstConflict = conflictsJson.conflicts[0];
  assert.equal(firstConflict.conflict_id, conflictId);
  assert.equal(firstConflict.status, "open");
  assert.equal(firstConflict.claims[0].claim_id, claim1Id);
  assert.equal(firstConflict.claims[1].claim_id, claim2Id);

  const conflictsMdRes = await worker.fetch(`${origin}/p/${problemId}/conflicts.md`);
  assert.equal(conflictsMdRes.status, 200);
  assert.equal(conflictsMdRes.headers.get("content-type"), "text/markdown; charset=utf-8");
  const conflictsMd = await conflictsMdRes.text();
  assert.ok(conflictsMd.includes(conflictId));
  assert.ok(conflictsMd.includes("open"));
  assert.ok(conflictsMd.includes("Smallest Disagreement"));

  const conflictsHtmlRes = await worker.fetch(`${origin}/p/${problemId}/conflicts.html`);
  assert.equal(conflictsHtmlRes.status, 200);
  assert.equal(conflictsHtmlRes.headers.get("content-type"), "text/html; charset=utf-8");
  const conflictsHtml = await conflictsHtmlRes.text();
  assert.ok(conflictsHtml.includes(conflictId));
  assert.ok(conflictsHtml.includes("open"));

  // --------------------------------------------------------------------------
  // RESOLUTION JOURNEY
  // --------------------------------------------------------------------------

  // 8. Resolve unknown conflict (404)
  const unknownResolve = await call(
    `/v1/sessions/${sessionIdA}/conflicts/CF-UNKNOWN/resolve`,
    {
      status: "resolved",
      resolution: "Resolved by counterexample.",
    },
    authorA,
    404,
  );
  assert.equal(unknownResolve.code, "CONFLICT_NOT_FOUND");

  // 9. Resolve conflict: success (200)
  const resolvePayload = {
    status: "resolved",
    resolution:
      "Resolved by formal verification in Lean 4 showing Claim 2 had an off-by-one in the valuation inequality.",
  };
  const resolved = await call(
    `/v1/sessions/${sessionIdA}/conflicts/${conflictId}/resolve`,
    resolvePayload,
    authorA,
    200,
    "idempotent-resolve-key-1",
  );
  ResolveConflictResponseSchema.parse(resolved);
  assert.equal(resolved.conflict_id, conflictId);
  assert.equal(resolved.status, "resolved");
  assert.ok(resolved.resolved_at);

  // Replay resolve
  const resolveReplay = await call(
    `/v1/sessions/${sessionIdA}/conflicts/${conflictId}/resolve`,
    resolvePayload,
    authorA,
    200,
    "idempotent-resolve-key-1",
  );
  assert.equal(resolveReplay.conflict_id, conflictId);
  assert.equal(resolveReplay.status, "resolved");

  // 10. Already settled conflict refusal (409)
  const alreadySettled = await call(
    `/v1/sessions/${sessionIdA}/conflicts/${conflictId}/resolve`,
    resolvePayload,
    authorA,
    409,
    "different-key-for-settled",
  );
  assert.equal(alreadySettled.code, "CONFLICT_ALREADY_SETTLED");

  // --------------------------------------------------------------------------
  // DIPTYCH PUBLIC FACES CHECK (RESOLVED CONFLICT)
  // --------------------------------------------------------------------------

  const updatedJsonRes = await worker.fetch(`${origin}/p/${problemId}/conflicts.json`);
  assert.equal(updatedJsonRes.status, 200);
  const updatedJson = ConflictsListResponseSchema.parse(await updatedJsonRes.json());
  assert.equal(updatedJson.conflicts[0].status, "resolved");
  assert.equal(updatedJson.conflicts[0].resolution, resolvePayload.resolution);

  const updatedMdRes = await worker.fetch(`${origin}/p/${problemId}/conflicts.md`);
  assert.equal(updatedMdRes.status, 200);
  const updatedMd = await updatedMdRes.text();
  assert.ok(updatedMd.includes("resolved"));
  assert.ok(updatedMd.includes("### Resolution"));

  console.log(
    JSON.stringify({
      kind: "conflicts-real-bindings",
      status: "pass",
      conflict_id: conflictId,
      problem_id: problemId,
    }),
  );
});
