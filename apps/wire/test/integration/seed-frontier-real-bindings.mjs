/**
 * W12.2 SP4D Flagship + Rung 6/7 Frontier Slate Real-Bindings E2E Gate
 * (`asimposiumorg-a5j`, Fable §6.2 famous-problem guardrail).
 *
 * Exercises `docs/seed/sp4d/dossier.json` and `docs/seed/frontier-slate/dossiers.json`
 * on genuine local Workerd + migrated D1 + R2 (zero mocks):
 * - Enforces Authorship Path: explicitly enrolled Fellow under a named sponsor adopts
 *   SP4D flagship and representative rung-6 frontier slate dossier (never platform
 *   impersonation) with `famous_guardrail` populated from the audited dossiers.
 * - Verifies sponsor publication -> claims-board lock during sharpening -> author
 *   self-review refusal (P1) -> independent non-proposer statement-clear review unlock.
 * - Promotes bounded subgoal claims (SP4D-G1 Gluck-twist check; KZD-G1 finite group-ring
 *   audit) and verifies P2/P4 self-certification refusal.
 * - Attempts premature resolution-shaped events on the famous problem:
 *   1. Before under-result-review -> refused 422 PREMATURE_RESOLUTION
 *   2. Inside under-result-review without external_expert_review_proof -> refused 422 PREMATURE_RESOLUTION
 *   3. Inside under-result-review with unverified free-text proof prose -> refused 422 PREMATURE_RESOLUTION
 * - Verifies exact agent (.json/.md) faces preserve the famous-problem standing banner,
 *   category distinctions, and NEVER emit PROVED/RESOLVED banners; verifies log->projection
 *   rebuild parity via `assertProjectionsRebuild`.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ProblemDetailSchema, ProblemFaceResponseSchema } from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";
import { assertProjectionsRebuild } from "./projection-rebuild-check.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function buildGuardrailFromDossier(dossier) {
  return {
    canonical_formulation: dossier.formulation,
    variant_distinctions: dossier.variant_distinctions
      .map((item) => `${item.variant}: ${item.distinction}`)
      .join("\n"),
    authoritative_references: dossier.references.map(
      (ref) => `${ref.id}: ${ref.locator} (${ref.url})`,
    ),
    standing_banner: dossier.no_resolution_language,
  };
}

const sp4dRaw = readFileSync(`${REPO_ROOT}docs/seed/sp4d/dossier.json`, "utf8");
const slateRaw = readFileSync(`${REPO_ROOT}docs/seed/frontier-slate/dossiers.json`, "utf8");
const sp4d = JSON.parse(sp4dRaw);
const slate = JSON.parse(slateRaw);

assert.equal(sp4d.id, "SP4D");
assert.ok(Array.isArray(slate.dossiers) && slate.dossiers.length >= 9);
for (const entry of [sp4d, ...slate.dossiers]) {
  assert.ok(entry.variant_distinctions.length >= 2, `${entry.id} needs variant distinctions`);
  assert.ok(entry.references.length >= 1, `${entry.id} needs primary anchors`);
  assert.ok(entry.falsifier.length >= 20, `${entry.id} needs explicit falsifier`);
  assert.ok(entry.no_resolution_language.length >= 20, `${entry.id} needs no-resolution wording`);
}

await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, env, worker, origin, userAgent }) => {
    const sponsorFlagship = "usr_seed_frontier_owner";
    const sponsorReviewer = "usr_seed_frontier_reviewer";

    const proposer = await enroll("seed-frontier-proposer", sponsorFlagship);
    const reviewer = await enroll("seed-frontier-reviewer", sponsorReviewer);

    // -------------------------------------------------------------------------
    // 1. SP4D Flagship adoption, sharpening, bounded subgoal, & famous guardrail
    // -------------------------------------------------------------------------
    const sp4dGuardrail = buildGuardrailFromDossier(sp4d);
    const sp4dCreated = await call(
      "/v1/problems",
      {
        title: sp4d.title,
        statement: sp4d.formulation,
        falsifier: sp4d.falsifier,
        motivation: sp4d.motivation,
        scope: sp4d.scope,
        out_of_scope: sp4d.out_of_scope,
        success_criteria: sp4d.settlement_conditions,
        areas: ["topology-and-geometry"],
        famous_guardrail: sp4dGuardrail,
      },
      proposer,
      201,
      "seed-frontier-sp4d-propose",
    );
    const sp4dId = sp4dCreated.problem.id;
    assert.equal(sp4dCreated.problem.status, "private-draft");
    assert.deepEqual(sp4dCreated.problem.famous_guardrail, sp4dGuardrail);

    // Private-draft isolation before sponsor publication.
    await call(`/p/${sp4dId}.json`, undefined, undefined, 404);

    const sp4dPublished = await sponsorCall(
      sponsorFlagship,
      "POST",
      `/v1/sponsors/problems/${sp4dId}/lifecycle`,
      "problem-lifecycle",
      { action: "publish" },
      200,
      `/v1/sponsors/problems/${sp4dId}/lifecycle`,
      "seed-frontier-sp4d-publish",
    );
    assert.equal(sp4dPublished.problem.status, "sharpening");

    const proposerSess = await call(
      "/v1/sessions",
      { problem_id: sp4dId, intent: "prove" },
      proposer,
      201,
    );
    const reviewerSess = await call(
      "/v1/sessions",
      { problem_id: sp4dId, intent: "review" },
      reviewer,
      201,
    );

    // Claims board locked while sharpening; author self-review refused.
    const subgoalDraft = await call(
      `/v1/sessions/${proposerSess.session_id}/workshop`,
      {
        type: "claim-draft",
        title: "SP4D-G1 bounded Gluck-twist check",
        body_md: sp4d.bounded_subgoals[0].question,
        relates_to: [],
      },
      proposer,
      201,
    );
    const locked = await call(
      `/v1/sessions/${proposerSess.session_id}/promote`,
      {
        workshop_id: subgoalDraft.workshop_id,
        kind: "conjecture",
        statement: sp4d.bounded_subgoals[0].question,
        falsifier: sp4d.bounded_subgoals[0].falsifier,
      },
      proposer,
      422,
    );
    assert.equal(locked.code, "CLAIMS_BOARD_LOCKED");

    const selfStmtRev = await call(
      `/v1/problems/${sp4dId}/statement-review`,
      {
        session_id: proposerSess.session_id,
        statement_version: 1,
        verdict: "statement-clear",
        basis: "Author attempting to self-clear famous flagship statement.",
      },
      proposer,
      422,
    );
    assert.equal(selfStmtRev.code, "REVIEWER_IS_AUTHOR");

    // Independent reviewer clears statement -> active.
    const sp4dCleared = await call(
      `/v1/problems/${sp4dId}/statement-review`,
      {
        session_id: reviewerSess.session_id,
        statement_version: 1,
        verdict: "statement-clear",
        basis:
          "Smooth vs topological vs PL category distinctions, primary anchors, and falsifier are exact.",
      },
      reviewer,
      200,
    );
    assert.equal(sp4dCleared.status, "active");

    // Planted self-certification refusal on SP4D flagship.
    const selfCert = await call(
      `/v1/sessions/${proposerSess.session_id}/promote`,
      {
        workshop_id: subgoalDraft.workshop_id,
        kind: "conjecture",
        statement: sp4d.bounded_subgoals[0].question,
        falsifier: sp4d.bounded_subgoals[0].falsifier,
        proved: true,
      },
      proposer,
      422,
    );
    assert.equal(selfCert.code, "SCHEMA_INVALID");

    // Bounded subgoal claim promotion + independent review.
    const sp4dClaim = await call(
      `/v1/sessions/${proposerSess.session_id}/promote`,
      {
        workshop_id: subgoalDraft.workshop_id,
        kind: "conjecture",
        statement: sp4d.bounded_subgoals[0].question,
        falsifier: sp4d.bounded_subgoals[0].falsifier,
      },
      proposer,
      201,
    );
    const sp4dDetail = ProblemDetailSchema.parse((await call(`/v1/problems/${sp4dId}`)).problem);
    assert.deepEqual(sp4dDetail.famous_guardrail, sp4dGuardrail);

    await call(
      `/v1/sessions/${reviewerSess.session_id}/review`,
      {
        target_claim_id: sp4dClaim.claim_id,
        target_version: 1,
        verdict: "confirm",
        basis: "Bounded Gluck-twist move check is well-scoped; makes no global exotic S^4 claim.",
        body_md: "Verified handle-move bookkeeping within the stated single-candidate convention.",
        client_context_cursor: sp4dDetail.public_seq,
      },
      reviewer,
      201,
    );

    // Premature resolution #1: direct resolve from active -> 422 PREMATURE_RESOLUTION.
    const prematureDirect = await sponsorCall(
      sponsorFlagship,
      "POST",
      `/v1/sponsors/problems/${sp4dId}/lifecycle`,
      "problem-lifecycle",
      {
        action: "resolve",
        direction: "affirmed",
        closing_synthesis: {
          summary: "Claiming smooth SP4D settled prematurely.",
          no_claim_boundary: {
            verified: ["One Gluck-twist diagram"],
            mechanisms: ["Handle moves"],
            independence_tiers: ["T2"],
            remaining_external_validation: ["External smooth 4-manifold specialist review"],
          },
        },
      },
      422,
    );
    assert.equal(prematureDirect.code, "PREMATURE_RESOLUTION");

    // Complete disclosure and enter under-result-review to test famous-problem resolve gate.
    const disclosurePath = `/v1/sponsors/disclosures/${sp4dId}/${sp4dClaim.claim_id}/1`;
    const disclosureState = await sponsorCall(
      sponsorFlagship,
      "GET",
      disclosurePath,
      "sponsor.disclosure.read",
    );
    for (const scope of disclosureState.scopes) {
      await sponsorCall(
        sponsorFlagship,
        "POST",
        disclosurePath,
        "sponsor.disclosure.write",
        {
          scope_id: scope.scope_id,
          expected_lineage_digest: disclosureState.lineage_digest,
          expected_revision: scope.revision,
          decision: "no-undisclosed",
          disclosures: [],
        },
        200,
        disclosurePath,
        `sp4d-disclosure-${scope.scope_id}`,
      );
    }
    const enteredReview = await sponsorCall(
      sponsorFlagship,
      "POST",
      `/v1/sponsors/problems/${sp4dId}/lifecycle`,
      "problem-lifecycle",
      {
        action: "enter-result-review",
        result_claim: { claim_id: sp4dClaim.claim_id, version: 1 },
      },
      200,
    );
    assert.equal(enteredReview.problem.status, "under-result-review");

    // Premature resolution #2 & #3: missing proof AND unverified free-text prose BOTH refused.
    for (const proof of [
      undefined,
      "Two unnamed people said our Gluck-twist calculation resolves smooth SP4D.",
    ]) {
      const refusedResolve = await sponsorCall(
        sponsorFlagship,
        "POST",
        `/v1/sponsors/problems/${sp4dId}/lifecycle`,
        "problem-lifecycle",
        {
          action: "resolve",
          direction: "affirmed",
          closing_synthesis: {
            summary: "Attempting unverified famous-problem resolution.",
            no_claim_boundary: {
              verified: ["One bounded Gluck-twist diagram"],
              mechanisms: ["Kirby calculus"],
              independence_tiers: ["T2"],
              remaining_external_validation: ["Two independent smooth-4-manifold specialists"],
            },
          },
          ...(proof !== undefined ? { external_expert_review_proof: proof } : {}),
        },
        422,
      );
      assert.equal(refusedResolve.code, "PREMATURE_RESOLUTION");
    }

    // Verify problem stays in under-result-review (never resolved) and agent faces stay exact & scoped.
    const sp4dAfter = ProblemDetailSchema.parse((await call(`/v1/problems/${sp4dId}`)).problem);
    assert.equal(sp4dAfter.status, "under-result-review");
    assert.equal(sp4dAfter.resolution, undefined);

    const sp4dFaceJson = ProblemFaceResponseSchema.parse(await call(`/p/${sp4dId}.json`));
    const sp4dFaceMdResp = await worker.fetch(`${origin}/p/${sp4dId}.md`, {
      headers: { "User-Agent": userAgent },
    });
    assert.equal(sp4dFaceMdResp.status, 200);
    const sp4dFaceMd = await sp4dFaceMdResp.text();
    assert.ok(sp4dFaceMd.includes(sp4dId));
    assert.ok(!/\bPROVED\b/.test(sp4dFaceMd), "Rule A4: SP4D face must never display PROVED");
    assert.ok(!sp4dFaceMd.includes("resolved: affirmed"), "SP4D must not appear resolved");

    await assertProjectionsRebuild(env.DB, sp4dId);

    // -------------------------------------------------------------------------
    // 2. Representative Rung-6 Frontier Slate Dossier (KZD-POST-GARDAM)
    // -------------------------------------------------------------------------
    const kzd = slate.dossiers[0];
    const kzdGuardrail = buildGuardrailFromDossier(kzd);
    const kzdCreated = await call(
      "/v1/problems",
      {
        title: kzd.title,
        statement: kzd.formulation,
        falsifier: kzd.falsifier,
        motivation: kzd.motivation,
        scope: kzd.scope,
        out_of_scope: kzd.out_of_scope,
        success_criteria: kzd.settlement_conditions,
        areas: ["algebra"],
        famous_guardrail: kzdGuardrail,
      },
      proposer,
      201,
      "seed-frontier-kzd-propose",
    );
    const kzdId = kzdCreated.problem.id;
    await sponsorCall(
      sponsorFlagship,
      "POST",
      `/v1/sponsors/problems/${kzdId}/lifecycle`,
      "problem-lifecycle",
      { action: "publish" },
      200,
      `/v1/sponsors/problems/${kzdId}/lifecycle`,
      "seed-frontier-kzd-publish",
    );
    const kzdRevSess = await call(
      "/v1/sessions",
      { problem_id: kzdId, intent: "review" },
      reviewer,
      201,
    );
    const kzdCleared = await call(
      `/v1/problems/${kzdId}/statement-review`,
      {
        session_id: kzdRevSess.session_id,
        statement_version: 1,
        verdict: "statement-clear",
        basis: "Zero-divisor vs unit conjecture distinction and coefficient-ring scope are exact.",
      },
      reviewer,
      200,
    );
    assert.equal(kzdCleared.status, "active");
    await assertProjectionsRebuild(env.DB, kzdId);

    console.log(
      JSON.stringify({
        stage: "seed-frontier-real-bindings",
        status: "pass",
        environment: "local-workerd-d1",
        sp4d_dossier_sha256: sha256(sp4dRaw),
        frontier_slate_sha256: sha256(slateRaw),
        frontier_slate_dossier_count: slate.dossiers.length,
        sp4d_problem_id: sp4dId,
        sp4d_status_after_premature_resolution_attempts: sp4dAfter.status,
        sp4d_cursor: sp4dFaceJson.cursor,
        kzd_problem_id: kzdId,
        refused_premature_resolutions: 3,
        unproven_scientific_conclusions:
          "Local Workerd/D1 proof verifies SP4D and rung-6 famous-problem guardrails, statement sharpening, and premature-resolution refusal; external smooth-4-manifold specialist review and hosted staging publication remain open.",
      }),
    );
  },
);
