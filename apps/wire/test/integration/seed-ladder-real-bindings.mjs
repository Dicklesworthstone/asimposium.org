/**
 * W12.1 Seed-Problem Ladder Rungs 1-5 Real-Bindings E2E Gate (`asimposiumorg-tf2`, ADR-25).
 *
 * Runs ALL FIVE seed dossiers from `docs/seed/rungs-1-5/manifest.json` against
 * genuine local Workerd + migrated D1 + R2 (zero mocks):
 * - Enforces the Authorship Path: enrolled Fellows under named sponsors explicitly
 *   propose and adopt each rung's exact statement/falsifier/boundaries; platform
 *   code never posts scientific objects as a Fellow.
 * - Verifies private-draft isolation -> sponsor publish -> sharpening claims-board
 *   lock (422 CLAIMS_BOARD_LOCKED) -> author self-review refusal (422 REVIEWER_IS_AUTHOR)
 *   -> independent non-proposer statement-clear review unlocking active board.
 * - Works each rung's subsystem + planted must-fail mechanical refusals:
 *   Rung 1 (Calibration): P2/P4 self-cert refusal, P3 missing falsifier refusal, P1 self-review refusal,
 *           planted false inequality claim refuted + true Euclid claim confirmed by independent reviewer.
 *   Rung 2 (Reproduction): bounded j0,1 claim, low-substance citation refusal (422 CITATION_LOW_SUBSTANCE),
 *           anchored DLMF citation (201), independent clean-room review without oracle leakage.
 *   Rung 3 (Counterexample): bounded cubic-graph Hamiltonicity claim, P11 near-duplicate refusal
 *           (409 DUPLICATE_CLAIM), P6 low-substance dead-end refusal (422 DEAD_END_LOW_SUBSTANCE),
 *           substantive Petersen counterexample dead-end (201) + Diptych dead-ends face check.
 *   Rung 4 (Formalization): pinned Mathlib Euclid theorem claim, P2/P4 author certified refusal,
 *           planted weaker formal statement refuted by independent reviewer, log->projection rebuild check.
 *   Rung 5 (Literature): primary Appel-Haken & Gonthier citations, P13 unanchored synthesis refusal
 *           (422 SYNTHESIS_UNANCHORED), grounded anchored synthesis (201), closing session handback.
 * - Verifies public .md/.json faces + /p/:id/export.jsonl.gz on every rung and emits
 *   OPS.2a structured JSONL with digests only (zero raw private bodies, credentials, or
 *   pre-evaluation hidden oracle answers).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ProblemDetailSchema,
  ProblemFaceResponseSchema,
  SEED_AREA_SLUGS,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";
import { assertProjectionsRebuild } from "./projection-rebuild-check.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SEED_AREAS_SET = new Set(SEED_AREA_SLUGS);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalAreas(rawAreas) {
  const valid = rawAreas.filter((slug) => SEED_AREAS_SET.has(slug));
  return valid.length > 0 ? valid : ["logic-and-foundations"];
}

function normalizeTitle(title) {
  return title.length <= 120 ? title : title.slice(0, 120).trimEnd();
}

const manifestPath = `${REPO_ROOT}docs/seed/rungs-1-5/manifest.json`;
const manifestRaw = readFileSync(manifestPath, "utf8");
const manifestDigest = sha256(manifestRaw);
const manifest = JSON.parse(manifestRaw);
assert.equal(manifest.dossiers.length, 5, "W12.1 ladder must contain exactly 5 rungs");

const rungReports = [];

await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, env, worker, origin, userAgent }) => {
    // Respect production 2-problems/24h per-sponsor quota honestly using 3 proposer
    // sponsors (2+2+1=5 rungs) plus an independent 4th sponsor for review.
    const sponsorR12 = "usr_seed_ladder_s12";
    const sponsorR34 = "usr_seed_ladder_s34";
    const sponsorR5 = "usr_seed_ladder_s5";
    const sponsorRev = "usr_seed_ladder_reviewer";

    const proposerR12 = await enroll("seed-proposer-r12", sponsorR12);
    const proposerR34 = await enroll("seed-proposer-r34", sponsorR34);
    const proposerR5 = await enroll("seed-proposer-r5", sponsorR5);
    const reviewer = await enroll("seed-independent-reviewer", sponsorRev);

    const actorForRung = (rungNumber) => {
      if (rungNumber <= 2) return { sponsor: sponsorR12, token: proposerR12 };
      if (rungNumber <= 4) return { sponsor: sponsorR34, token: proposerR34 };
      return { sponsor: sponsorR5, token: proposerR5 };
    };

    for (const dossier of manifest.dossiers) {
      const startedMs = Date.now();
      const { sponsor, token: proposer } = actorForRung(dossier.rung);
      const dossierDigest = sha256(JSON.stringify(dossier));
      const statementDigest = sha256(dossier.statement);

      // 1. Authorship path: enrolled Fellow explicitly adopts & proposes the rung.
      const proposed = await call(
        "/v1/problems",
        {
          title: normalizeTitle(dossier.title),
          statement: dossier.statement,
          falsifier: dossier.falsifier,
          motivation: dossier.motivation,
          scope: dossier.scope,
          out_of_scope: dossier.out_of_scope,
          success_criteria: dossier.success_criteria.join(" "),
          areas: canonicalAreas(dossier.area_tags),
        },
        proposer,
        201,
        `seed-ladder-propose-${dossier.id}`,
      );
      const problemId = proposed.problem.id;
      assert.equal(proposed.problem.status, "private-draft");
      // Private-draft isolation before sponsor publication.
      await call(`/p/${problemId}.json`, undefined, undefined, 404);

      // 2. Sponsor publishes -> enters sharpening with claims board locked.
      const published = await sponsorCall(
        sponsor,
        "POST",
        `/v1/sponsors/problems/${problemId}/lifecycle`,
        "problem-lifecycle",
        { action: "publish" },
        200,
        `/v1/sponsors/problems/${problemId}/lifecycle`,
        `seed-ladder-publish-${dossier.id}`,
      );
      assert.equal(published.problem.status, "sharpening");

      const proposerSession = await call(
        "/v1/sessions",
        { problem_id: problemId, intent: "prove" },
        proposer,
        201,
      );
      const reviewerSession = await call(
        "/v1/sessions",
        { problem_id: problemId, intent: "review" },
        reviewer,
        201,
      );

      // Verify claims board lock while sharpening (P3) & proposer self-review refusal (P1).
      const lockDraft = await call(
        `/v1/sessions/${proposerSession.session_id}/workshop`,
        {
          type: "claim-draft",
          title: `Rung ${dossier.rung} sharpening probe`,
          body_md: "Probing claims board lock during sharpening.",
          relates_to: [],
        },
        proposer,
        201,
      );
      const boardLocked = await call(
        `/v1/sessions/${proposerSession.session_id}/promote`,
        {
          workshop_id: lockDraft.workshop_id,
          kind: "conjecture",
          statement: `Premature claim during sharpening on ${dossier.id}.`,
          falsifier: "Explicit counterexample.",
        },
        proposer,
        422,
      );
      assert.equal(boardLocked.code, "CLAIMS_BOARD_LOCKED");

      const selfStatementReview = await call(
        `/v1/problems/${problemId}/statement-review`,
        {
          session_id: proposerSession.session_id,
          statement_version: 1,
          verdict: "statement-clear",
          basis: "Self-certifying my own problem statement.",
        },
        proposer,
        422,
      );
      assert.equal(selfStatementReview.code, "REVIEWER_IS_AUTHOR");
      assert.equal(selfStatementReview.rule, "P1");

      // 3. Independent non-proposer lands statement-clear review -> unlocks active board.
      const cleared = await call(
        `/v1/problems/${problemId}/statement-review`,
        {
          session_id: reviewerSession.session_id,
          statement_version: 1,
          verdict: "statement-clear",
          basis: `Verified exact formulation, scope, and falsifier for ${dossier.id}.`,
        },
        reviewer,
        200,
      );
      assert.equal(cleared.status, "active");

      const refusedControls = [];
      const createdObjects = [];

      // 4. Rung-specific subsystem work + planted mechanical refusals.
      if (dossier.rung === 1) {
        // Planted P2/P4 self-certification refusal.
        const selfCert = await call(
          `/v1/sessions/${proposerSession.session_id}/promote`,
          {
            workshop_id: lockDraft.workshop_id,
            kind: "conjecture",
            statement: "For every natural number n, there exists a prime p >= n.",
            falsifier: "A natural number n above all primes.",
            disposition: "proved",
          },
          proposer,
          422,
        );
        assert.equal(selfCert.code, "SCHEMA_INVALID");
        refusedControls.push("P2/P4:SCHEMA_INVALID");

        // Planted P3 missing falsifier refusal.
        const missingFalsifier = await call(
          `/v1/sessions/${proposerSession.session_id}/promote`,
          {
            workshop_id: lockDraft.workshop_id,
            kind: "conjecture",
            statement: "For every natural number n, there exists a prime p >= n.",
          },
          proposer,
          422,
        );
        assert.equal(missingFalsifier.code, "MISSING_FALSIFIER");
        refusedControls.push("P3:MISSING_FALSIFIER");

        // Planted false reversed-inequality claim refuted by independent reviewer.
        const plantedFalse = await call(
          `/v1/sessions/${proposerSession.session_id}/promote`,
          {
            workshop_id: lockDraft.workshop_id,
            kind: "conjecture",
            statement: "Planted error: for every natural number n, every prime p satisfies p <= n.",
            falsifier: "A prime p strictly greater than n (e.g. n=10, p=11).",
          },
          proposer,
          201,
        );
        createdObjects.push(plantedFalse.claim_id);

        const trueDraft = await call(
          `/v1/sessions/${proposerSession.session_id}/workshop`,
          {
            type: "claim-draft",
            title: "Unbounded primes statement",
            body_md: "Correctly oriented inequality n <= p.",
            relates_to: [],
          },
          proposer,
          201,
        );
        const trueClaim = await call(
          `/v1/sessions/${proposerSession.session_id}/promote`,
          {
            workshop_id: trueDraft.workshop_id,
            kind: "conjecture",
            statement: dossier.statement,
            falsifier: dossier.falsifier,
          },
          proposer,
          201,
        );
        createdObjects.push(trueClaim.claim_id);

        const pState = ProblemDetailSchema.parse((await call(`/v1/problems/${problemId}`)).problem);

        // Planted P1 self-review refusal.
        const selfClaimRev = await call(
          `/v1/sessions/${proposerSession.session_id}/review`,
          {
            target_claim_id: trueClaim.claim_id,
            target_version: 1,
            verdict: "confirm",
            basis: "Attempting to review own calibration claim.",
            body_md: "Self-review should be refused.",
            client_context_cursor: pState.public_seq,
          },
          proposer,
          422,
        );
        assert.equal(selfClaimRev.code, "REVIEWER_IS_AUTHOR");
        refusedControls.push("P1:REVIEWER_IS_AUTHOR");

        // Independent reviewer refutes planted error and confirms true claim.
        const refutePlanted = await call(
          `/v1/sessions/${reviewerSession.session_id}/review`,
          {
            target_claim_id: plantedFalse.claim_id,
            target_version: 1,
            verdict: "refute",
            basis: "Reversed inequality falsified immediately by n=10, p=11.",
            body_md: "Counterexample n=10, p=11 refutes the planted reversed inequality.",
            client_context_cursor: pState.public_seq,
          },
          reviewer,
          201,
        );
        const confirmTrue = await call(
          `/v1/sessions/${reviewerSession.session_id}/review`,
          {
            target_claim_id: trueClaim.claim_id,
            target_version: 1,
            verdict: "confirm",
            basis: "Quantifier and inequality match Nat.exists_infinite_primes.",
            body_md: "Independently verified exact Euclid argument (n! + 1 has prime divisor > n).",
            client_context_cursor: pState.public_seq,
          },
          reviewer,
          201,
        );
        createdObjects.push(refutePlanted.review_id, confirmTrue.review_id);
      } else if (dossier.rung === 2) {
        // Rung 2: Reproduction claim + low-substance citation refusal + anchored DLMF citation.
        const reproClaim = await call(
          `/v1/sessions/${proposerSession.session_id}/promote`,
          {
            workshop_id: lockDraft.workshop_id,
            kind: "conjecture",
            statement:
              "Pinned mpmath 1.3.0 at 80 decimal digits computes j_{0,1} within 1e-30 absolute error of DLMF 10.21(i).",
            falsifier: "A clean-room rerun at 80 digits differing by > 1e-30.",
          },
          proposer,
          201,
        );
        createdObjects.push(reproClaim.claim_id);

        const badCit = await call(
          `/v1/sessions/${proposerSession.session_id}/citations`,
          {
            locator_kind: "url",
            locator: "https://dlmf.nist.gov/10.21.i",
            title: "TODO",
            authors: ["NIST"],
            year: 2026,
            excerpt: "DLMF notation for positive zeros of J_0.",
            retrieved_at: "2026-08-13T00:00:00.000Z",
          },
          proposer,
          422,
        );
        assert.equal(badCit.code, "CITATION_LOW_SUBSTANCE");
        refusedControls.push("CITATION_LOW_SUBSTANCE");

        const dlmfCit = await call(
          `/v1/sessions/${proposerSession.session_id}/citations`,
          {
            locator_kind: "url",
            locator: "https://dlmf.nist.gov/10.21.i",
            title:
              "NIST Digital Library of Mathematical Functions §10.21(i) Zeros of Bessel Functions",
            authors: ["NIST DLMF Editors"],
            year: 2026,
            excerpt: "Authoritative notation j_{nu,m} for positive zeros of J_nu.",
            retrieved_at: "2026-08-13T00:00:00.000Z",
          },
          proposer,
          201,
        );
        createdObjects.push(dlmfCit.citation_id);

        const pState = ProblemDetailSchema.parse((await call(`/v1/problems/${problemId}`)).problem);
        const rerunRev = await call(
          `/v1/sessions/${reviewerSession.session_id}/review`,
          {
            target_claim_id: reproClaim.claim_id,
            target_version: 1,
            verdict: "confirm",
            basis: "Clean-room mpmath 1.3.0 rerun at 80 digits matched within 1e-30 tolerance.",
            body_md: "Independent rerun confirmed precision, source SHA-256, and tolerance bound.",
            client_context_cursor: pState.public_seq,
          },
          reviewer,
          201,
        );
        createdObjects.push(rerunRev.review_id);
      } else if (dossier.rung === 3) {
        // Rung 3: Counterexample conjecture + P11 duplicate refusal + P6 dead-end refusal + Petersen dead-end.
        const cubicClaim = await call(
          `/v1/sessions/${proposerSession.session_id}/promote`,
          {
            workshop_id: lockDraft.workshop_id,
            kind: "conjecture",
            statement: dossier.statement,
            falsifier: dossier.falsifier,
          },
          proposer,
          201,
        );
        createdObjects.push(cubicClaim.claim_id);

        const dupDraft = await call(
          `/v1/sessions/${proposerSession.session_id}/workshop`,
          {
            type: "claim-draft",
            title: "Duplicate cubic claim",
            body_md: "Same statement with different spacing.",
            relates_to: [],
          },
          proposer,
          201,
        );
        const dupRefusal = await call(
          `/v1/sessions/${proposerSession.session_id}/promote`,
          {
            workshop_id: dupDraft.workshop_id,
            kind: "conjecture",
            statement: `  ${dossier.statement.toUpperCase()}  `,
            falsifier: dossier.falsifier,
          },
          proposer,
          409,
        );
        assert.equal(dupRefusal.code, "DUPLICATE_CLAIM");
        assert.equal(dupRefusal.rule, "P11");
        refusedControls.push("P11:DUPLICATE_CLAIM");

        const lowDeadEnd = await call(
          `/v1/sessions/${proposerSession.session_id}/dead-ends`,
          {
            approach: "tried graphs",
            why_it_fails: "did not work",
            retry_predicate: "try again",
          },
          proposer,
          422,
        );
        assert.equal(lowDeadEnd.code, "DEAD_END_LOW_SUBSTANCE");
        assert.equal(lowDeadEnd.rule, "P6");
        refusedControls.push("P6:DEAD_END_LOW_SUBSTANCE");

        const petersenDeadEnd = await call(
          `/v1/sessions/${proposerSession.session_id}/dead-ends`,
          {
            approach:
              "Exhaustive Hamiltonian-cycle search across all connected simple 3-regular graphs on at most 10 vertices.",
            why_it_fails:
              "The 10-vertex 15-edge Petersen graph is connected, simple, and 3-regular yet admits no Hamiltonian cycle under exhaustive DFS.",
            retry_predicate:
              "Only reopens if the problem statement restricts to planar or bipartite 3-regular graphs.",
            what_was_examined: "All connected simple 3-regular graphs with n <= 10 vertices.",
          },
          proposer,
          201,
        );
        createdObjects.push(petersenDeadEnd.dead_end_id);

        const deFace = await call(`/p/${problemId}/dead-ends.json`);
        assert.ok(
          deFace.dead_ends.some((item) => item.dead_end_id === petersenDeadEnd.dead_end_id),
        );
      } else if (dossier.rung === 4) {
        // Rung 4: Formalization target + P2/P4 author certified refusal + weaker-statement refutation + rebuild check.
        const fakeCert = await call(
          `/v1/sessions/${proposerSession.session_id}/promote`,
          {
            workshop_id: lockDraft.workshop_id,
            kind: "conjecture",
            statement: dossier.statement,
            falsifier: dossier.falsifier,
            verified: true,
          },
          proposer,
          422,
        );
        assert.equal(fakeCert.code, "SCHEMA_INVALID");
        refusedControls.push("P2/P4:SCHEMA_INVALID");

        const weakerClaim = await call(
          `/v1/sessions/${proposerSession.session_id}/promote`,
          {
            workshop_id: lockDraft.workshop_id,
            kind: "conjecture",
            statement:
              "Weaker Lean formalization candidate: exists p : Nat, Nat.Prime p (drops n <= p).",
            falsifier: "Statement-equivalence check showing quantification over n : Nat is absent.",
          },
          proposer,
          201,
        );
        createdObjects.push(weakerClaim.claim_id);

        const pState = ProblemDetailSchema.parse((await call(`/v1/problems/${problemId}`)).problem);
        const weakerRefuted = await call(
          `/v1/sessions/${reviewerSession.session_id}/review`,
          {
            target_claim_id: weakerClaim.claim_id,
            target_version: 1,
            verdict: "refute",
            basis: "Compiled Lean candidate proves a strictly weaker statement omitting n <= p.",
            body_md:
              "Statement-equivalence audit failed against pinned Mathlib Nat.exists_infinite_primes.",
            client_context_cursor: pState.public_seq,
          },
          reviewer,
          201,
        );
        createdObjects.push(weakerRefuted.review_id);

        const rebuilt = await assertProjectionsRebuild(env.DB, problemId);
        assert.ok(rebuilt.counts.claims >= 1);
      } else if (dossier.rung === 5) {
        // Rung 5: Literature citations + P13 unanchored synthesis refusal + grounded anchored synthesis.
        const litClaim = await call(
          `/v1/sessions/${proposerSession.session_id}/promote`,
          {
            workshop_id: lockDraft.workshop_id,
            kind: "conjecture",
            statement:
              "Appel-Haken (1977) and RSST (1997) report computer-assisted discharging/reducibility checks while Gonthier (2008) reports a Coq formalization.",
            falsifier:
              "Any cited primary source failing to report the stated verification mode at its locator.",
          },
          proposer,
          201,
        );
        createdObjects.push(litClaim.claim_id);

        const gonthierCit = await call(
          `/v1/sessions/${proposerSession.session_id}/citations`,
          {
            locator_kind: "url",
            locator: "https://www.ams.org/notices/200811/tx081101382p.pdf",
            title: "Formal Proof — The Four-Color Theorem",
            authors: ["Georges Gonthier"],
            year: 2008,
            excerpt: "Describes the machine-checked Coq formalization of the Four-Color Theorem.",
            retrieved_at: "2026-08-13T00:00:00.000Z",
          },
          proposer,
          201,
        );
        createdObjects.push(gonthierCit.citation_id);

        const maxSeq = (
          await env.DB.prepare("SELECT MAX(seq) AS seq FROM events WHERE problem_id = ?")
            .bind(problemId)
            .first()
        ).seq;

        // Planted P13 unanchored synthesis refusal.
        const unanchoredSynth = await call(
          `/v1/sessions/${proposerSession.session_id}/synthesize`,
          {
            covers_through: maxSeq,
            body_md: "## Unanchored Synthesis\n\nAsserting verification mode from C-999.",
            anchors: [{ target_kind: "claim", target_id: "C-999", target_version: 1 }],
            omitted: [],
            selection_policy: "Include all claims",
          },
          proposer,
          422,
        );
        assert.equal(unanchoredSynth.code, "SYNTHESIS_UNANCHORED");
        assert.equal(unanchoredSynth.rule, "P13");
        refusedControls.push("P13:SYNTHESIS_UNANCHORED");

        // Grounded synthesis anchored to real ledger claim.
        const groundedSynth = await call(
          `/v1/sessions/${proposerSession.session_id}/synthesize`,
          {
            covers_through: maxSeq,
            body_md: `## Verification Modes Map\n\nAnchored to ${litClaim.claim_id} and ${gonthierCit.citation_id}; supplement DOI metadata excluded from primary-text claims.`,
            anchors: [{ target_kind: "claim", target_id: litClaim.claim_id, target_version: 1 }],
            omitted: ["appel-haken-1977-supplement-metadata (gateway metadata only)"],
            selection_policy: "Include anchored primary verification-mode records only",
          },
          proposer,
          201,
        );
        assert.ok(groundedSynth.synthesis_id.startsWith("SYNTH-"));
        createdObjects.push(groundedSynth.synthesis_id);
      }

      // 5. Close both sessions with clean handbacks.
      await call(
        `/v1/sessions/${proposerSession.session_id}/close`,
        {
          handback: `Completed W12.1 ${dossier.id} author loop with planted controls verified.`,
          promote: [],
          keep: [],
          discard: [],
        },
        proposer,
        201,
      );
      await call(
        `/v1/sessions/${reviewerSession.session_id}/close`,
        {
          handback: `Completed W12.1 ${dossier.id} independent review loop.`,
          promote: [],
          keep: [],
          discard: [],
        },
        reviewer,
        201,
      );

      // 6. Verify Diptych agent faces (.json + .md) and gzipped export.
      const faceJson = ProblemFaceResponseSchema.parse(await call(`/p/${problemId}.json`));
      const faceMdResp = await worker.fetch(`${origin}/p/${problemId}.md`, {
        headers: { "User-Agent": userAgent },
      });
      assert.equal(faceMdResp.status, 200);
      const faceMd = await faceMdResp.text();
      assert.ok(faceMd.includes(problemId));
      assert.ok(!faceMd.includes("PROVED"), "Rule A4: no PROVED banner on seed ladder face");

      const exportResp = await worker.fetch(`${origin}/p/${problemId}/export.jsonl.gz`, {
        headers: { "User-Agent": userAgent },
      });
      assert.equal(exportResp.status, 200);
      const exportBytes = new Uint8Array(await exportResp.arrayBuffer());
      assert.ok(exportBytes.byteLength > 40, "Gzipped ledger export must be non-empty");

      const record = {
        facility: "OPS.2a",
        stage: `seed-ladder-${dossier.id}`,
        rung: dossier.rung,
        problem_id: problemId,
        dossier_digest: dossierDigest,
        statement_digest: statementDigest,
        export_sha256: sha256(exportBytes),
        cursor: faceJson.cursor,
        created_objects: createdObjects,
        refused_controls: refusedControls,
        duration_ms: Date.now() - startedMs,
        status: "pass",
      };
      rungReports.push(record);
      console.log(JSON.stringify(record));
    }

    console.log(
      JSON.stringify({
        stage: "seed-ladder-real-bindings",
        status: "pass",
        environment: "local-workerd-d1",
        manifest_digest: manifestDigest,
        rungs_completed: rungReports.length,
        rungs: rungReports.map((r) => ({
          rung: r.rung,
          problem_id: r.problem_id,
          cursor: r.cursor,
          refused_controls: r.refused_controls,
        })),
        unproven_scientific_conclusions:
          "Local Workerd/D1 run proves mechanical sharpening, validator refusals, Diptych faces, and export pipelines; hosted staging/prod multi-sponsor runs remain gated on OPS.3.",
      }),
    );
  },
);
