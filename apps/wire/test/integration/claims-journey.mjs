import assert from "node:assert/strict";
import { ClaimFaceResponseSchema } from "../../../../packages/contracts/src/ledger.ts";
import { ClaimKindSchema } from "../../../../packages/contracts/src/sessions.ts";
import { normHash } from "../../src/split/policy.ts";

/**
 * W5.3 Claims Lifecycle & Gates:
 * - 16 claim kinds
 * - P3 missing falsifier refusal on conjecture
 * - P11 duplicate gate + concurrent race on real D1
 * - P9 monotonic @n+1 version minting with immutable content digests
 * - Author-only revision authority
 * - Stale-base version conflict (409) + concurrent revision race on real D1
 * - Statement drift / reanchor
 * - P10 DAG dependencies, cycles refusal, dangling refusal
 * - Review pin history across revisions
 * - Workshop / direct revision isolation
 * - Diptych faces (.json, .md, .bib, .csl.json)
 * - OPS.2a structured diagnostic logging
 *
 * Runs against real Workerd / D1 / R2 bindings.
 */
export async function claimsJourney({
  call,
  enroll,
  fixtures,
  env,
  worker,
  origin,
  userAgent,
  sponsorWorkshop,
  sponsorCall,
}) {
  const problem = "P-CLAIMS-E2E";
  await fixtures.seedProblem(problem);

  const privateCanary = "PRIVATE_CLAIMS_WORKSHOP_CANARY_DO_NOT_PUBLISH";

  async function createFellow(name, sponsor, intent = "prove") {
    const token = await enroll(name, sponsor);
    const session = await call("/v1/sessions", { problem_id: problem, intent }, token, 201);
    const draft = await call(
      `/v1/sessions/${session.session_id}/workshop`,
      { type: "draft", title: `${name} draft`, body_md: privateCanary, relates_to: [] },
      token,
      201,
    );
    return { token, session, path: `/v1/sessions/${session.session_id}`, draft };
  }

  // 1. Enroll synthetic Fellows with isolated quotas
  const kindsFellow = await createFellow("claims-kinds-author", "usr_claims_sponsor_1");
  const raceFellow = await createFellow("claims-race-author", "usr_claims_sponsor_2");
  const revFellow = await createFellow("claims-rev-author", "usr_claims_sponsor_3");
  const nonAuthorFellow = await createFellow("claims-non-author", "usr_claims_sponsor_4");
  const dagFellow = await createFellow("claims-dag-author", "usr_claims_sponsor_5");
  const reviewerFellow = await createFellow("claims-reviewer", "usr_claims_sponsor_6", "review");

  const countEvents = async () => {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id = ?")
      .bind(problem)
      .first();
    return row?.n ?? 0;
  };

  const getPublicCursor = async () => {
    const row = await env.DB.prepare(
      "SELECT cursor FROM public_cursor WHERE singleton = 1",
    ).first();
    return row?.cursor ?? 0;
  };

  const face = async (target, format = "json") => {
    const response = await worker.fetch(`${origin}/p/${problem}/claims/${target}.${format}`, {
      headers: { "user-agent": userAgent },
    });
    return response;
  };

  // --- Requirement 1: P3 Missing Falsifier on Conjecture Class ---
  const initialEvents = await countEvents();
  const p3Refusal = await call(
    `${kindsFellow.path}/promote`,
    {
      workshop_id: kindsFellow.draft.workshop_id,
      kind: "conjecture",
      statement: "Every even integer greater than 2 is the sum of two prime numbers.",
      // deliberately omitting falsifier
    },
    kindsFellow.token,
    422,
  );
  assert.equal(p3Refusal.code, "MISSING_FALSIFIER");
  assert.equal(p3Refusal.rule, "P3");
  assert.ok(p3Refusal.fix_hint);
  assert.equal(await countEvents(), initialEvents, "Refused promotion must not append events");

  // --- Requirement 2: All 16 Claim Kinds Valid Promotion ---
  const allKinds = ClaimKindSchema.options;
  assert.ok(allKinds.length >= 12, `Expected at least 12 claim kinds, found ${allKinds.length}`);
  const promotedKinds = new Map();

  for (let i = 0; i < allKinds.length; i++) {
    const kind = allKinds[i];
    const statement = `Formal statement of ${kind} for integer index ${i + 1}: property P holds.`;
    const needsFalsifier =
      ["conjecture", "theorem-attempt", "counterexample-claim", "bound"].includes(kind) ||
      i % 2 === 0;
    const falsifier = needsFalsifier
      ? `A counterexample showing integer index ${i + 1} violates property P.`
      : undefined;

    const payload = {
      workshop_id: kindsFellow.draft.workshop_id,
      kind,
      statement,
      ...(falsifier ? { falsifier } : {}),
    };

    const res = await call(`${kindsFellow.path}/promote`, payload, kindsFellow.token, 201);
    assert.ok(res.claim_id.startsWith("C-"), `Expected claim_id format C-*, got ${res.claim_id}`);
    assert.equal(res.version, 1);
    promotedKinds.set(kind, res);
  }

  // --- Requirement 3: Math and NFKC Normalization Equivalence ---
  const mathS1 = "For any $n \\in \\mathbb{N}$, we have $2n \\ge 0$.";
  const mathS2 = "For any \\(n \\in \\mathbb{N}\\), we have \\(2n \\ge 0\\).";
  const h1 = await normHash(mathS1);
  const h2 = await normHash(mathS2);
  assert.equal(h1, h2, "LaTeX $..$ and \\(..\\) must produce identical norm_hash");

  const unnorm1 = "Theorem   with    spaces   and\u00A0nonbreaking.";
  const unnorm2 = "Theorem with spaces and nonbreaking.";
  assert.equal(
    await normHash(unnorm1),
    await normHash(unnorm2),
    "Whitespace and NFKC must normalize",
  );

  // --- Requirement 4: P11 Duplicate Claim Gate & Real D1 Concurrency Race ---
  // 4a. Sequential duplicate refusal
  const seqDuplicateRefusal = await call(
    `${raceFellow.path}/promote`,
    {
      workshop_id: raceFellow.draft.workshop_id,
      kind: "lemma",
      statement: "For any \\(n \\in \\mathbb{N}\\), we have \\(2n \\ge 0\\).", // Equivalent to mathS1 if published
    },
    raceFellow.token,
    201,
  );
  // Now attempt to publish mathS1 with different syntax
  const dupAttempt = await call(
    `${raceFellow.path}/promote`,
    {
      workshop_id: raceFellow.draft.workshop_id,
      kind: "definition",
      statement: mathS1, // Same math
    },
    raceFellow.token,
    409,
  );
  assert.equal(dupAttempt.code, "DUPLICATE_CLAIM");
  assert.equal(dupAttempt.existing_claim_id, seqDuplicateRefusal.claim_id);

  // 4b. Real D1 Concurrent Promotion Race (P11 atomicity)
  const raceStatement =
    "Concurrent candidate statement: prime factors of 2^p - 1 under condition K.";
  const eventsBeforeRace = await countEvents();

  fixtures.pauseScreening(); // Delays screening by 2000ms
  const p1 = call(
    `${raceFellow.path}/promote`,
    {
      workshop_id: raceFellow.draft.workshop_id,
      kind: "theorem-attempt",
      statement: raceStatement,
      falsifier: "A non-prime divisor.",
    },
    raceFellow.token,
    null, // don't assert status yet
    "race-p1-key",
  );
  const p2 = call(
    `${raceFellow.path}/promote`,
    {
      workshop_id: raceFellow.draft.workshop_id,
      kind: "theorem-attempt",
      statement: raceStatement,
      falsifier: "A non-prime divisor.",
    },
    raceFellow.token,
    null,
    "race-p2-key",
  );

  const [r1, r2] = await Promise.all([p1, p2]);
  fixtures.resumeScreening();

  const statuses = [r1._status ?? (r1.code ? 409 : 201), r2._status ?? (r2.code ? 409 : 201)];
  assert.ok(
    (statuses[0] === 201 && statuses[1] === 409) || (statuses[0] === 409 && statuses[1] === 201),
    `Expected exactly one 201 and one 409 in concurrent duplicate race, got ${JSON.stringify(statuses)}`,
  );
  assert.equal(
    await countEvents(),
    eventsBeforeRace + 1,
    "Real D1 concurrency race must append exactly one event",
  );

  // --- Requirement 5: P9 Version Monotonicity & Content Digests ---
  const targetClaim = await call(
    `${revFellow.path}/promote`,
    {
      workshop_id: revFellow.draft.workshop_id,
      kind: "conjecture",
      statement:
        "Base conjecture: every even integer greater than 2 is the sum of two prime numbers.",
      falsifier: "An even integer > 2 not expressible as sum of two primes.",
    },
    revFellow.token,
    201,
  );
  const rev1Statement =
    "Revised conjecture: every even integer greater than 4 is the sum of two primes.";
  const rev1Falsifier = "An even integer > 4 not expressible as sum of two primes.";

  const revRes = await call(
    `${revFellow.path}/revise`,
    {
      claim_id: targetClaim.claim_id,
      base_version: 1,
      kind: "conjecture",
      statement: rev1Statement,
      falsifier: rev1Falsifier,
      depends_on: [],
    },
    revFellow.token,
    201,
  );
  assert.equal(revRes.claim_id, targetClaim.claim_id);
  assert.equal(revRes.version, 2, "Monotonic increment must mint @2");

  // Verify claim_versions table in D1
  const versionRows = (
    await env.DB.prepare(
      "SELECT version, statement, content_digest, falsifier FROM claim_versions WHERE problem_id = ? AND claim_id = ? ORDER BY version ASC",
    )
      .bind(problem, targetClaim.claim_id)
      .all()
  ).results;

  assert.equal(versionRows.length, 2);
  assert.equal(versionRows[0].version, 1);
  assert.equal(versionRows[1].version, 2);
  assert.notEqual(versionRows[0].content_digest, versionRows[1].content_digest);
  assert.notEqual(versionRows[0].statement, versionRows[1].statement);

  // --- Requirement 6: Author Authority & Stale Base Conflicts ---
  // 6a. Non-author revision refusal
  const nonAuthorRefusal = await call(
    `${nonAuthorFellow.path}/revise`,
    {
      claim_id: targetClaim.claim_id,
      base_version: 2,
      kind: "conjecture",
      statement: "Hostile unauthorized revision by second fellow.",
      falsifier: rev1Falsifier,
    },
    nonAuthorFellow.token,
    403,
  );
  assert.equal(nonAuthorRefusal.code, "NOT_CLAIM_AUTHOR");
  assert.equal(nonAuthorRefusal.rule, "P9");

  // 6b. Stale base conflict (sequential)
  const staleBaseRefusal = await call(
    `${revFellow.path}/revise`,
    {
      claim_id: targetClaim.claim_id,
      base_version: 1, // Stale! Head is 2
      kind: "conjecture",
      statement: "Revision on stale base 1.",
      falsifier: rev1Falsifier,
    },
    revFellow.token,
    409,
  );
  assert.equal(staleBaseRefusal.code, "OBJECT_VERSION_CONFLICT");
  assert.equal(staleBaseRefusal.head_version, 2);

  // 6c. Real D1 Concurrent Revision Race (PK conflict on claim_versions)
  fixtures.pauseScreening();
  const revRace1 = call(
    `${revFellow.path}/revise`,
    {
      claim_id: targetClaim.claim_id,
      base_version: 2,
      kind: "conjecture",
      statement: "Revision racer Alpha: prime sum formulation A.",
      falsifier: rev1Falsifier,
    },
    revFellow.token,
    null,
    "rev-race-1",
  );
  const revRace2 = call(
    `${revFellow.path}/revise`,
    {
      claim_id: targetClaim.claim_id,
      base_version: 2,
      kind: "conjecture",
      statement: "Revision racer Beta: prime sum formulation B.",
      falsifier: rev1Falsifier,
    },
    revFellow.token,
    null,
    "rev-race-2",
  );

  const [revR1, revR2] = await Promise.all([revRace1, revRace2]);
  fixtures.resumeScreening();

  const revStatuses = [
    revR1._status ?? (revR1.code ? 409 : 201),
    revR2._status ?? (revR2.code ? 409 : 201),
  ];
  assert.ok(
    (revStatuses[0] === 201 && revStatuses[1] === 409) ||
      (revStatuses[0] === 409 && revStatuses[1] === 201),
    `Expected exactly one 201 and one 409 in revision race, got ${JSON.stringify(revStatuses)}`,
  );

  // 6d. P11 Duplicate Collision on Replacement (fails without minting a version)
  const versionsBeforeDup = (
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM claim_versions WHERE problem_id = ? AND claim_id = ?",
    )
      .bind(problem, targetClaim.claim_id)
      .first()
  ).n;
  const p11RevRefusal = await call(
    `${revFellow.path}/revise`,
    {
      claim_id: targetClaim.claim_id,
      base_version: 3,
      kind: "conjecture",
      statement: mathS1, // Collides with existing claim from raceFellow
      falsifier: rev1Falsifier,
    },
    revFellow.token,
    409,
  );
  assert.equal(p11RevRefusal.code, "DUPLICATE_CLAIM");
  assert.equal(p11RevRefusal.rule, "P11");
  const versionsAfterDup = (
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM claim_versions WHERE problem_id = ? AND claim_id = ?",
    )
      .bind(problem, targetClaim.claim_id)
      .first()
  ).n;
  assert.equal(
    versionsAfterDup,
    versionsBeforeDup,
    "P11 duplicate collision on replacement must not mint a claim version",
  );

  // 6e. Sponsor Promotion Boundary & Workshop Revision Parity
  // Direct sponsor write boundary: missing or non-fellow token returns 401
  const sponsorDirectRefusal = await call(
    `${revFellow.path}/revise`,
    {
      claim_id: targetClaim.claim_id,
      base_version: 3,
      kind: "conjecture",
      statement: "Direct sponsor revision attempt without fellow bearer.",
      falsifier: rev1Falsifier,
    },
    undefined,
    401,
  );
  assert.equal(sponsorDirectRefusal.code, "FELLOW_TOKEN_INVALID");

  // Cross-fellow workshop boundary: fellow cannot promote another fellow's draft
  const foreignWorkshopRefusal = await call(
    `${nonAuthorFellow.path}/promote`,
    {
      workshop_id: kindsFellow.draft.workshop_id,
      kind: "definition",
      statement: "Attempting to promote foreign fellow workshop object.",
    },
    nonAuthorFellow.token,
    404,
  );
  assert.equal(foreignWorkshopRefusal.code, "WORKSHOP_OBJECT_NOT_FOUND");

  // Workshop revision flow: push draft to workshop before revising
  const revWorkshopDraft = await call(
    `${revFellow.path}/workshop`,
    {
      type: "draft",
      title: "Revision v4 draft notes",
      body_md: "Scratch notes for subsequent revision candidate.",
      relates_to: [targetClaim.claim_id],
    },
    revFellow.token,
    201,
  );
  assert.ok(revWorkshopDraft.workshop_id.startsWith("W-"));

  // --- Requirement 7: Statement Drift and Reanchor ---
  // 7a. The claims table head reflects head version 3 statement, while version 1 retains original.
  const claimHeadRow = await env.DB.prepare(
    "SELECT id, statement, norm_hash, statement_version, statement_drift FROM claims WHERE problem_id = ? AND id = ?",
  )
    .bind(problem, targetClaim.claim_id)
    .first();
  assert.ok(
    claimHeadRow.statement.includes("Revision racer"),
    "Head claim statement must drift to latest revision",
  );
  const claimV1Row = await env.DB.prepare(
    "SELECT statement, content_digest FROM claim_versions WHERE problem_id = ? AND claim_id = ? AND version = 1",
  )
    .bind(problem, targetClaim.claim_id)
    .first();
  assert.equal(
    claimV1Row.statement,
    "Base conjecture: every even integer greater than 2 is the sum of two prime numbers.",
    "Historical version 1 statement must remain immutable",
  );
  assert.equal(claimHeadRow.statement_version, 1);
  assert.equal(claimHeadRow.statement_drift, 0);

  // 7b. Problem statement revision S@1 -> S@2 via sponsor lifecycle action (W5.1)
  if (sponsorCall) {
    const reviseStatementRes = await sponsorCall(
      "usr_claims_sponsor_1",
      "POST",
      `/v1/sponsors/problems/${problem}/lifecycle`,
      "problem-lifecycle",
      {
        action: "revise-statement",
        statement:
          "Revised problem statement S@2: every even integer greater than 4 is the sum of two odd primes.",
        falsifier: "An even integer > 4 not expressible as sum of two odd primes.",
        motivation: "Refining Goldbach conjecture to exclude 4 = 2 + 2.",
      },
      200,
    );
    assert.equal(reviseStatementRes.problem.current_statement_version, 2);

    // Assert that targetClaim is now flagged with statement_drift = 1!
    const driftedClaim = await env.DB.prepare(
      "SELECT statement_version, statement_drift FROM claims WHERE problem_id = ? AND id = ?",
    )
      .bind(problem, targetClaim.claim_id)
      .first();
    assert.equal(driftedClaim.statement_version, 1);
    assert.equal(
      driftedClaim.statement_drift,
      1,
      "Existing claim must be flagged with statement_drift on problem statement revision",
    );

    // 7c. Review on drifted claim is refused with STATEMENT_DRIFT (P9)
    const driftedReview = await call(
      `${reviewerFellow.path}/review`,
      {
        target_claim_id: targetClaim.claim_id,
        target_version: 1,
        verdict: "confirm",
        basis: "Attempting review on drifted claim statement.",
        body_md: "Looks good but statement drifted.",
      },
      reviewerFellow.token,
      422,
    );
    assert.equal(driftedReview.code, "STATEMENT_DRIFT");
    assert.equal(driftedReview.rule, "P9");

    // 7d. Non-author cannot re-anchor (WRITE_REFUSED)
    const unauthorizedReanchor = await call(
      `${nonAuthorFellow.path}/reanchor`,
      {
        claim_id: targetClaim.claim_id,
        base_version: 3,
      },
      nonAuthorFellow.token,
      403,
    );
    assert.equal(unauthorizedReanchor.code, "WRITE_REFUSED");

    // 7e. Stale base_version is refused (OBJECT_VERSION_CONFLICT)
    const staleReanchor = await call(
      `${revFellow.path}/reanchor`,
      {
        claim_id: targetClaim.claim_id,
        base_version: 1, // Head is at 3!
      },
      revFellow.token,
      409,
    );
    assert.equal(staleReanchor.code, "OBJECT_VERSION_CONFLICT");

    // 7f. Author successfully re-anchors claim to current statement version (S@2)
    const reanchorRes = await call(
      `${revFellow.path}/reanchor`,
      {
        claim_id: targetClaim.claim_id,
        base_version: 3,
      },
      revFellow.token,
      200,
    );
    assert.equal(reanchorRes.reanchored, true);
    assert.equal(reanchorRes.statement_version, 2);
    assert.equal(reanchorRes.statement_drift, false);

    // Verify in D1
    const reanchoredClaim = await env.DB.prepare(
      "SELECT statement_version, statement_drift FROM claims WHERE problem_id = ? AND id = ?",
    )
      .bind(problem, targetClaim.claim_id)
      .first();
    assert.equal(reanchoredClaim.statement_version, 2);
    assert.equal(reanchoredClaim.statement_drift, 0, "Reanchored claim clears statement_drift");
  }

  // --- Requirement 8: DAG Dependencies & Cycle Refusal (P10) ---
  const claimDef = await call(
    `${dagFellow.path}/promote`,
    {
      workshop_id: dagFellow.draft.workshop_id,
      kind: "definition",
      statement: "A gadget G is balanced if all edge weights sum to zero.",
    },
    dagFellow.token,
    201,
  );

  // 8a. Self-dependency refusal
  const selfCycle = await call(
    `${dagFellow.path}/revise`,
    {
      claim_id: claimDef.claim_id,
      base_version: 1,
      kind: "definition",
      statement: "Definition depending on self.",
      depends_on: [claimDef.claim_id],
    },
    dagFellow.token,
    422,
  );
  assert.equal(selfCycle.code, "CYCLE_IN_DEPENDENCIES");

  // 8b. Dangling dependency refusal
  const danglingRefusal = await call(
    `${dagFellow.path}/promote`,
    {
      workshop_id: dagFellow.draft.workshop_id,
      kind: "lemma",
      statement: "Lemma depending on missing claim.",
      depends_on: ["C-99999"],
    },
    dagFellow.token,
    422,
  );
  assert.equal(danglingRefusal.code, "DEPENDENCY_NOT_FOUND");

  // 8c. Valid dependency wiring
  const parentWithDep = await call(
    `${dagFellow.path}/promote`,
    {
      workshop_id: dagFellow.draft.workshop_id,
      kind: "lemma",
      statement: "Lemma depending on definition.",
      depends_on: [claimDef.claim_id],
    },
    dagFellow.token,
    201,
  );
  const depRow = await env.DB.prepare(
    "SELECT claim_id, depends_on_claim_id FROM claim_deps WHERE problem_id = ? AND claim_id = ?",
  )
    .bind(problem, parentWithDep.claim_id)
    .first();
  assert.equal(depRow.depends_on_claim_id, claimDef.claim_id);

  // 8d. P10 Cycle Collision on Replacement (fails without minting a version)
  // parentWithDep depends on claimDef. Revising claimDef to depend on parentWithDep forms a 2-node cycle!
  const defVersionsBeforeCycle = (
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM claim_versions WHERE problem_id = ? AND claim_id = ?",
    )
      .bind(problem, claimDef.claim_id)
      .first()
  ).n;
  const cycleOnReplacement = await call(
    `${dagFellow.path}/revise`,
    {
      claim_id: claimDef.claim_id,
      base_version: 1,
      kind: "definition",
      statement: "Definition creating multi-node cycle via parent.",
      depends_on: [parentWithDep.claim_id],
    },
    dagFellow.token,
    422,
  );
  assert.equal(cycleOnReplacement.code, "CYCLE_IN_DEPENDENCIES");
  assert.equal(cycleOnReplacement.rule, "P10");
  const defVersionsAfterCycle = (
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM claim_versions WHERE problem_id = ? AND claim_id = ?",
    )
      .bind(problem, claimDef.claim_id)
      .first()
  ).n;
  assert.equal(
    defVersionsAfterCycle,
    defVersionsBeforeCycle,
    "P10 cycle collision on replacement must not mint a claim version",
  );

  // --- Requirement 9: Review Pin History Across Revisions ---
  // Review ClaimDef @ 1
  const reviewRes = await call(
    `${reviewerFellow.path}/review`,
    {
      target_claim_id: claimDef.claim_id,
      target_version: 1,
      verdict: "confirm",
      basis: "Grounded line-by-line validation of definitions.",
      capable_of_failure: "If any undefined symbol or circular term was introduced.",
      rubric: ["statement match", "quantifier scope"],
      body_md: "Verified that definition terms are well-founded and domain is non-empty.",
    },
    reviewerFellow.token,
    201,
  );
  assert.equal(reviewRes.carries_weight, true);
  assert.equal(reviewRes.target_claim_id, claimDef.claim_id);
  assert.equal(reviewRes.target_version, 1);

  // Now revise claimDef to @2
  const defV2 = await call(
    `${dagFellow.path}/revise`,
    {
      claim_id: claimDef.claim_id,
      base_version: 1,
      kind: "definition",
      statement: "Definition updated with broader domain.",
      depends_on: [],
    },
    dagFellow.token,
    201,
  );
  assert.equal(defV2.version, 2);

  // Version 1 face must show review attached; Version 2 face must reset to open with review isolation
  const fV1 = await face(`${claimDef.claim_id}@1`, "json");
  assert.equal(fV1.status, 200);
  const fV1Body = ClaimFaceResponseSchema.parse(await fV1.json());
  assert.equal(fV1Body.claim_state.version, 1);
  assert.equal(fV1Body.claim_state.latest_version, 2);
  assert.equal(fV1Body.claim_state.disposition, "open");
  assert.equal(
    fV1Body.claim_state.unchallenged,
    true,
    "Version 1 with supporting review displays as open · unchallenged",
  );
  const v1Reviews = fV1Body.items.filter((item) => item.kind === "claim-review");
  assert.ok(
    v1Reviews.length >= 1,
    "Version 1 face must include attached review item with kind claim-review",
  );
  assert.equal(v1Reviews[0].id, reviewRes.review_id);

  const fV2 = await face(`${claimDef.claim_id}@2`, "json");
  assert.equal(fV2.status, 200);
  const fV2Body = ClaimFaceResponseSchema.parse(await fV2.json());
  assert.equal(fV2Body.claim_state.version, 2);
  assert.equal(fV2Body.claim_state.latest_version, 2);
  assert.equal(fV2Body.claim_state.disposition, "open", "Version 2 must reset disposition to open");
  assert.equal(
    fV2Body.claim_state.unchallenged,
    false,
    "Version 2 has no reviews, so it displays as bare open (unchallenged is false)",
  );
  assert.equal(
    fV2Body.claim_state.recorded_refutation_attempts,
    0,
    "Version 2 must reset recorded refutation attempts to 0",
  );
  const v2Reviews = fV2Body.items.filter((item) => item.kind === "claim-review");
  assert.equal(
    v2Reviews.length,
    0,
    "Version 2 face must strictly isolate and exclude reviews targeting version 1",
  );

  // --- Requirement 10: Diptych Faces & Nonexistent Version Handling ---
  for (const fmt of ["json", "md", "bib", "csl.json"]) {
    const resp = await face(`${targetClaim.claim_id}@1`, fmt);
    assert.equal(resp.status, 200, `Expected 200 for format ${fmt}`);
    const text = await resp.text();
    assert.ok(text.length > 0);
    assert.ok(!text.includes(privateCanary), "Public faces must never leak private canary");
  }

  const missingFace = await face(`${targetClaim.claim_id}@999`, "json");
  assert.equal(missingFace.status, 404, "Nonexistent version pin must return 404");

  // Typed workshop replacement -> the same production revision validator.
  // A dedicated Fellow keeps this journey inside the unchanged write quotas.
  const workshopSponsor = "usr_claims_workshop_sponsor";
  const workshopAuthor = await createFellow("typed-workshop-author", workshopSponsor);
  const initialStatement = "A workshop gadget has exactly three labeled ports.";
  const workshopClaim = await call(
    `${workshopAuthor.path}/promote`,
    {
      workshop_id: workshopAuthor.draft.workshop_id,
      kind: "definition",
      statement: initialStatement,
    },
    workshopAuthor.token,
    201,
  );
  const replacement = {
    claim_id: workshopClaim.claim_id,
    base_version: 1,
    kind: "definition",
    statement: "A workshop gadget has exactly three labeled ports and one distinguished port.",
    depends_on: [],
  };
  const privateNotes = `${privateCanary}: abandoned attempts must stay private.`;
  const pushRevision = (revision, author = workshopAuthor) =>
    call(
      `${author.path}/workshop`,
      {
        type: "draft",
        title: "Exact replacement",
        body_md: privateNotes,
        revision,
      },
      author.token,
      201,
    );
  const publicState = async () => ({
    events: await countEvents(),
    cursor: await getPublicCursor(),
    versions: (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM claim_versions WHERE problem_id = ?")
        .bind(problem)
        .first()
    ).n,
  });
  const beforePush = await publicState();
  const draft = await pushRevision(replacement);
  assert.deepEqual(await publicState(), beforePush, "Private revision push cannot publish");
  const draftRow = await env.DB.prepare(
    "SELECT revision_json, fellow_id FROM workshop_objects WHERE workshop_id = ?",
  )
    .bind(draft.workshop_id)
    .first();
  assert.deepEqual(JSON.parse(draftRow.revision_json), replacement);
  const sponsorPage = await sponsorWorkshop(workshopSponsor, {
    problem_id: problem,
    fellow_id: draftRow.fellow_id,
  });
  const privateObject = sponsorPage.objects.find(
    (object) => object.workshop_id === draft.workshop_id,
  );
  assert.deepEqual(privateObject.revision, replacement);
  assert.equal(privateObject.body_md, privateNotes);
  const deniedRead = await sponsorWorkshop(
    "usr_claims_sponsor_4",
    { problem_id: problem, fellow_id: draftRow.fellow_id },
    404,
  );
  assert.equal(deniedRead.code, "WORKSHOP_NOT_FOUND");
  assert.ok(!JSON.stringify(deniedRead).includes(privateNotes));
  const unpublishedFace = await face(workshopClaim.claim_id);
  const unpublishedText = await unpublishedFace.text();
  assert.ok(!unpublishedText.includes(replacement.statement));
  assert.ok(!unpublishedText.includes(privateCanary));

  // The exact content and owning scope cannot mutate behind a workshop ID.
  await assert.rejects(
    env.DB.prepare("UPDATE workshop_objects SET revision_json = ? WHERE workshop_id = ?")
      .bind(JSON.stringify({ ...replacement, claim_id: targetClaim.claim_id }), draft.workshop_id)
      .run(),
    /WORKSHOP_REVISION_IMMUTABLE/,
  );
  await assert.rejects(
    env.DB.prepare("UPDATE workshop_objects SET session_id = ? WHERE workshop_id = ?")
      .bind(nonAuthorFellow.session.session_id, draft.workshop_id)
      .run(),
    /WORKSHOP_REVISION_IMMUTABLE/,
  );

  for (const [path, body, token, status, code] of [
    [
      workshopAuthor.path,
      { workshop_id: draft.workshop_id, claim_id: targetClaim.claim_id },
      workshopAuthor.token,
      422,
      "REVISE_BODY_INVALID",
    ],
    [
      nonAuthorFellow.path,
      { workshop_id: draft.workshop_id },
      nonAuthorFellow.token,
      404,
      "WORKSHOP_OBJECT_NOT_FOUND",
    ],
    [
      workshopAuthor.path,
      { workshop_id: workshopAuthor.draft.workshop_id },
      workshopAuthor.token,
      404,
      "WORKSHOP_OBJECT_NOT_FOUND",
    ],
  ]) {
    const refused = await call(`${path}/revise`, body, token, status);
    assert.equal(refused.code, code);
    assert.ok(refused.rule && refused.fix_hint && refused.schema && refused.example);
  }
  const invalidPush = await call(
    `${workshopAuthor.path}/workshop`,
    {
      type: "draft",
      title: "Invalid base",
      body_md: privateNotes,
      revision: { ...replacement, base_version: 0 },
    },
    workshopAuthor.token,
    422,
  );
  assert.equal(invalidPush.code, "WORKSHOP_PUSH_BODY_INVALID");

  // Both input forms must refuse the same invalid replacement without a
  // version/event/cursor burn. Stored drafts intentionally have a lower bar.
  const assertParity = async (revision, status, code, author = workshopAuthor) => {
    const candidate = await pushRevision(revision, author);
    const before = await publicState();
    const direct = await call(`${author.path}/revise`, revision, author.token, status);
    const stored = await call(
      `${author.path}/revise`,
      { workshop_id: candidate.workshop_id },
      author.token,
      status,
    );
    assert.equal(direct.code, code);
    assert.equal(stored.code, code);
    assert.equal(stored.rule, direct.rule);
    assert.deepEqual(await publicState(), before, `${code} cannot mint public state`);
  };
  await assertParity({ ...replacement, kind: "conjecture" }, 422, "MISSING_FALSIFIER");
  await assertParity(
    { ...replacement, depends_on: [workshopClaim.claim_id] },
    422,
    "CYCLE_IN_DEPENDENCIES",
  );
  await assertParity({ ...replacement, depends_on: ["C-999999"] }, 422, "DEPENDENCY_NOT_FOUND");
  await assertParity(
    { ...replacement, statement: "Definition updated with broader domain." },
    409,
    "DUPLICATE_CLAIM",
  );
  await assertParity(replacement, 403, "NOT_CLAIM_AUTHOR", nonAuthorFellow);
  await fixtures.setScreenMode("reject");
  try {
    await assertParity(replacement, 403, "POLICY_DENIED");
  } finally {
    await fixtures.setScreenMode("pass");
  }

  const screenBefore = await fixtures.screeningCalls();
  const beforePublish = await publicState();
  const publicationKey = "typed-workshop-publication";
  const published = await call(
    `${workshopAuthor.path}/revise`,
    { workshop_id: draft.workshop_id },
    workshopAuthor.token,
    201,
    publicationKey,
  );
  assert.equal(published.claim_id, workshopClaim.claim_id);
  assert.equal(published.version, 2);
  assert.equal(await fixtures.screeningCalls(), screenBefore + 1);
  assert.deepEqual(await publicState(), {
    events: beforePublish.events + 1,
    cursor: beforePublish.cursor + 1,
    versions: beforePublish.versions + 1,
  });
  const event = await env.DB.prepare(
    "SELECT actor_fellow_id, actor_sponsor_id, actor_session_id, model_string_self_declared, harness FROM events WHERE problem_id = ? AND seq = ?",
  )
    .bind(problem, published.seq)
    .first();
  assert.deepEqual(event, {
    actor_fellow_id: draftRow.fellow_id,
    actor_sponsor_id: workshopSponsor,
    actor_session_id: workshopAuthor.session.session_id,
    model_string_self_declared: "synthetic-claim-model",
    harness: "local-claims-proof",
  });
  for (const [version, statement] of [
    [1, initialStatement],
    [2, replacement.statement],
  ]) {
    const jsonFace = ClaimFaceResponseSchema.parse(
      await (await face(`${workshopClaim.claim_id}@${version}`)).json(),
    );
    assert.equal(jsonFace.claim_state.version, version);
    assert.equal(jsonFace.claim_state.disposition, "open");
    assert.ok(JSON.stringify(jsonFace).includes(statement));
    for (const fmt of ["md", "html", "json"]) {
      const response = await face(`${workshopClaim.claim_id}@${version}`, fmt);
      assert.equal(response.status, 200);
      assert.ok(!(await response.text()).includes(privateCanary));
    }
  }
  const replay = await call(
    `${workshopAuthor.path}/revise`,
    { workshop_id: draft.workshop_id },
    workshopAuthor.token,
    200,
    publicationKey,
  );
  assert.deepEqual({ ...replay, _status: 201 }, published);
  assert.equal(await fixtures.screeningCalls(), screenBefore + 1);
  await assertParity(replacement, 409, "OBJECT_VERSION_CONFLICT");

  // Distinct keys, same base, concurrent direct vs stored: exactly one wins.
  const raceReplacement = {
    ...replacement,
    base_version: 2,
    statement: "A revision race gadget has three ports and a chosen orientation.",
  };
  const raceDraft = await pushRevision(raceReplacement);
  const beforeRace = await publicState();
  await fixtures.pauseScreening();
  let raced;
  try {
    raced = await Promise.all([
      call(`${workshopAuthor.path}/revise`, raceReplacement, workshopAuthor.token, null),
      call(
        `${workshopAuthor.path}/revise`,
        { workshop_id: raceDraft.workshop_id },
        workshopAuthor.token,
        null,
      ),
    ]);
  } finally {
    await fixtures.resumeScreening();
  }
  assert.deepEqual(raced.map((value) => value._status).sort(), [201, 409]);
  assert.equal(raced.find((value) => value._status === 409).code, "OBJECT_VERSION_CONFLICT");
  assert.deepEqual(await publicState(), {
    events: beforeRace.events + 1,
    cursor: beforeRace.cursor + 1,
    versions: beforeRace.versions + 1,
  });

  // Exact replay survives session close; a new session cannot adopt an old ID.
  await call(
    `${workshopAuthor.path}/close`,
    { handback: "Typed revision published; old versions remain available." },
    workshopAuthor.token,
    201,
  );
  const afterClose = await publicState();
  const closedReplay = await call(
    `${workshopAuthor.path}/revise`,
    { workshop_id: draft.workshop_id },
    workshopAuthor.token,
    200,
    publicationKey,
  );
  assert.deepEqual({ ...closedReplay, _status: 201 }, published);
  const nextSession = await call(
    "/v1/sessions",
    { problem_id: problem },
    workshopAuthor.token,
    201,
  );
  const foreignSession = await call(
    `/v1/sessions/${nextSession.session_id}/revise`,
    { workshop_id: raceDraft.workshop_id },
    workshopAuthor.token,
    404,
  );
  assert.equal(foreignSession.code, "WORKSHOP_OBJECT_NOT_FOUND");
  assert.deepEqual(await publicState(), afterClose);

  // Corrupt stored content is an internal failure, with no draft bytes in the
  // response and no fallback to generic Markdown or paid screening.
  const corruptDraft = await call(
    `/v1/sessions/${nextSession.session_id}/workshop`,
    {
      type: "draft",
      title: "Storage corruption fixture",
      body_md: privateNotes,
    },
    workshopAuthor.token,
    201,
  );
  await env.DB.prepare("UPDATE workshop_objects SET revision_json = ? WHERE workshop_id = ?")
    .bind(JSON.stringify({ unexpected: privateNotes }), corruptDraft.workshop_id)
    .run();
  const beforeCorruptRead = await publicState();
  const screenBeforeCorruptRead = await fixtures.screeningCalls();
  const corruptRefusal = await call(
    `/v1/sessions/${nextSession.session_id}/revise`,
    {
      workshop_id: corruptDraft.workshop_id,
    },
    workshopAuthor.token,
    500,
  );
  assert.equal(corruptRefusal.code, "INTERNAL_ERROR");
  assert.ok(!JSON.stringify(corruptRefusal).includes(privateCanary));
  assert.deepEqual(await publicState(), beforeCorruptRead);
  assert.equal(await fixtures.screeningCalls(), screenBeforeCorruptRead);

  // --- Requirement 11: OPS.2a Structured Diagnostic Log ---
  const cursor = await getPublicCursor();
  const claimCountRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM claims WHERE problem_id = ?",
  )
    .bind(problem)
    .first();
  const summaryReceipt = {
    kind: "claims-journey-real-bindings",
    status: "pass",
    problem,
    cursor,
    claims_verified: claimCountRow?.n ?? allKinds.length,
    concurrency_races: [
      "duplicate_claim_p11",
      "version_conflict_p9",
      "direct_vs_workshop_revision",
    ],
    typed_workshop_revision:
      "private push, signed sponsor read, author publication, refusal parity, immutable history and closed-session replay",
    kinds_tested: allKinds,
    rules_verified: ["P3", "P9", "P10", "P11"],
    boundary: {
      runtime: "workerd",
      database: "Cloudflare D1 (local migrated, migrations 0001-0046)",
      cas: "Cloudflare R2 CAS",
      durable_objects: "KraterOutboxDrainer (sqlite storage)",
      routes: "production wire routes",
      fixtures: "synthetic sponsor enrollment bootstrap and local screening classifier",
      upstream_dependencies: {
        problem_statement_versions: "deferred to asimposiumorg-5yu (W5.1)",
      },
    },
  };
  console.log(JSON.stringify(summaryReceipt));

  return summaryReceipt;
}
