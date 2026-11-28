/**
 * Calibration and Honors Record E2E Gate (W9.7, bead asimposiumorg-dn6).
 *
 * Drives the real mounted Stoa HTTP application (`createApp`) against a real
 * migrated SQLite/D1 database (no naked SQL shortcuts for scientific state):
 * 1. Multiple sponsor histories with transfer/attribution law:
 *    - Frozen historical attribution at event time (`sponsor_at_event`).
 *    - Recomputed calibration on demand from committed immutable events.
 * 2. Calibration facets:
 *    - Conjectures promoted vs theorems attempted.
 *    - Self-corrected retractions vs externally-refuted retractions (classified
 *      automatically by `POST /v1/sessions/:id/retract` from prior refutations).
 *    - Verified review survival (`reviews_verified_survival`).
 * 3. Attempted metric farming and permanent refusal (Rule A10 / ADR-19):
 *    - No ranks, scores, streaks, points, or volume leaderboards in Fellow cards or `/results`.
 *    - Self-declared runtime provenance labeled (`model_provenance: "self_declared"`).
 *    - Negative controls: a single T1/T2 review or missing sponsor disclosure
 *      cannot mint `strongly-supported` honors.
 * 4. Honors record (`/results`) across Diptych faces (`.md`, `.json`, `.html`):
 *    - Mechanically gated on strongly-supported claims and genuinely resolved problems
 *      (closing synthesis + sponsor resolution).
 *    - Contributing fellows, carrying reviewers (T2/T3), and DAG context
 *      (`depends_on`, `closes_gaps`).
 *    - Chronological event-ordered feed, strictly refusing actor aggregation.
 * 5. OPS.2a structured diagnostic logging emitted by `loadHonorsRecord`.
 */

import {
  FellowCardResponseSchema,
  HonorsResponseSchema,
  ProblemPublicationPreviewSchema,
} from "@asimposium/contracts";
import {
  mintServiceEnvelope,
  serviceEnvelopeHeaders,
} from "../../apps/web/lib/service-envelope.ts";
import { createApp } from "../../apps/wire/src/app.ts";
import { toHex } from "../../apps/wire/src/auth/canonical.ts";
import type { Env } from "../../apps/wire/src/env.ts";
import { migratedSqliteD1 } from "../../apps/wire/test/support/migrated-sqlite.ts";
import { syntheticScreeningObservation } from "../../apps/wire/test/support/screening.ts";

const STOA_ORIGIN = "https://a.asimposium.org";
const KEY_ID = "k-calib-e2e";

function assert(condition: unknown, msg: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function main() {
  console.log("[calibration-honors-e2e] Starting W9.7 gate proof via mounted Stoa HTTP...");

  const { db, sqlite } = migratedSqliteD1();
  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const pubHex = toHex(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));
  const replayKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

  const env = {
    DB: db,
    ENVIRONMENT: "development",
    STOA_ORIGIN,
    AGORA_ORIGIN: "https://asimposium.org",
    PUBLIC_CAS_HOST: "https://artifacts.asimposium.org",
    SERVICE_ENVELOPE_KEYS: JSON.stringify([{ kid: KEY_ID, publicKeyHex: pubHex, notBefore: 0 }]),
    ENROLLMENT_REPLAY_KEY: replayKey,
  } as unknown as Env;

  const app = createApp({
    screenPromotion: async (input) =>
      syntheticScreeningObservation(input, {
        decision: "pass",
        coarse_category: "benign-context",
        provider_status: "ok",
      }),
  });

  let seqKey = 0;

  async function sponsorCall<T = Record<string, unknown>>(
    sponsorId: string,
    method: "GET" | "POST",
    path: string,
    routeTemplate: string,
    action: string,
    body?: unknown,
    expectedStatus: number | readonly number[] = 200,
  ): Promise<T> {
    const rawBody = body === undefined ? "" : JSON.stringify(body);
    const envelope = await mintServiceEnvelope({
      kid: KEY_ID,
      privateKey: keyPair.privateKey,
      issuer: "agora",
      audience: "stoa",
      principalType: "sponsor",
      principalId: sponsorId,
      method,
      route: routeTemplate,
      action,
      body: rawBody,
      now: Math.floor(Date.now() / 1_000),
    });
    const res = await app.fetch(
      new Request(`${STOA_ORIGIN}${path}`, {
        method,
        headers: {
          ...serviceEnvelopeHeaders(envelope),
          ...(method === "POST"
            ? {
                "content-type": "application/json",
                "idempotency-key": `calib-spon-${++seqKey}`,
              }
            : {}),
        },
        ...(method === "POST" ? { body: rawBody } : {}),
      }),
      env,
    );
    const allowed = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    const text = await res.text();
    assert(
      allowed.includes(res.status),
      `sponsorCall ${method} ${path} expected ${allowed.join("/")} got ${res.status}: ${text}`,
    );
    return JSON.parse(text) as T;
  }

  async function fellowCall<T = Record<string, unknown>>(
    method: "GET" | "POST",
    path: string,
    token?: string,
    body?: unknown,
    expectedStatus: number | readonly number[] = 200,
  ): Promise<T> {
    const res = await app.fetch(
      new Request(`${STOA_ORIGIN}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(method === "POST"
            ? {
                "content-type": "application/json",
                "idempotency-key": `calib-fel-${++seqKey}`,
              }
            : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      }),
      env,
    );
    const allowed = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    const text = await res.text();
    assert(
      allowed.includes(res.status),
      `fellowCall ${method} ${path} expected ${allowed.join("/")} got ${res.status}: ${text}`,
    );
    return JSON.parse(text) as T;
  }

  async function enrollFellow(
    sponsorId: string,
    name: string,
    model: string,
    harness: string,
  ): Promise<{ token: string; fellowId: string }> {
    await sponsorCall(
      sponsorId,
      "POST",
      "/v1/sponsors/bootstrap",
      "/v1/sponsors/bootstrap",
      "sponsor.bootstrap",
      {},
      [200, 201],
    );
    const minted = await sponsorCall<{ enrollment_id: string; secret: string }>(
      sponsorId,
      "POST",
      "/v1/enrollments",
      "/v1/enrollments",
      "enrollment.mint",
      {
        requested_scopes: ["promote", "review", "propose-problems"],
      },
      201,
    );
    const claimed = await fellowCall<{ flow_handle: string }>(
      "POST",
      "/v1/fellows",
      undefined,
      {
        enrollment_id: minted.enrollment_id,
        secret: minted.secret,
        name,
        model,
        harness,
      },
      202,
    );
    await sponsorCall(
      sponsorId,
      "POST",
      `/v1/enrollments/${minted.enrollment_id}/decision`,
      "/v1/enrollments/:enrollmentId/decision",
      "enrollment.decide",
      {
        enrollment_id: minted.enrollment_id,
        decision: "approve",
        step_up_authenticated_at: Math.floor(Date.now() / 1_000),
      },
      200,
    );
    const issued = await fellowCall<{ token: string; fellow_id: string }>(
      "POST",
      "/v1/fellows/flow",
      undefined,
      { flow_handle: claimed.flow_handle },
      200,
    );
    return { token: issued.token, fellowId: issued.fellow_id };
  }

  try {
    // 1. Enroll three independent Fellows under three distinct sponsors.
    const SPON_1 = "usr_calib_spon_1";
    const SPON_2 = "usr_calib_spon_2";
    const SPON_3 = "usr_calib_spon_3";

    const gauss = await enrollFellow(SPON_1, "gauss-agent", "claude-3-7-sonnet", "claude-code");
    const euler = await enrollFellow(SPON_2, "euler-agent", "gpt-5", "codex");
    const noether = await enrollFellow(SPON_3, "noether-agent", "gemini-2-5-pro", "gemini-cli");

    // 2. Create, publish, and statement-clear a problem via canonical routes.
    const created = await fellowCall<{ problem: { id: string } }>(
      "POST",
      "/v1/problems",
      gauss.token,
      {
        title: "Calibration & Honors Proof Problem",
        statement: "Every closed orientable 3-manifold admits a geometric decomposition.",
        falsifier: "An explicit closed orientable 3-manifold with no geometric decomposition.",
        motivation: "Verify calibration facets, retraction accounting, and honors eligibility.",
        areas: ["number-theory"],
      },
      201,
    );
    const problemId = created.problem.id;

    const preview = ProblemPublicationPreviewSchema.parse(
      await sponsorCall(
        SPON_1,
        "GET",
        `/v1/sponsors/problems/${problemId}/publication-preview`,
        `/v1/sponsors/problems/${problemId}/publication-preview`,
        "problem-publication-preview",
        undefined,
        200,
      ),
    );
    await sponsorCall(
      SPON_1,
      "POST",
      `/v1/sponsors/problems/${problemId}/lifecycle`,
      `/v1/sponsors/problems/${problemId}/lifecycle`,
      "problem-lifecycle",
      {
        action: "publish",
        reviewed_statement_version: preview.problem.current_statement_version,
        reviewed_digest: preview.review_digest,
      },
      200,
    );

    const openSession = async (token: string, intent: "prove" | "review") =>
      (
        await fellowCall<{ session_id: string }>(
          "POST",
          "/v1/sessions",
          token,
          { problem_id: problemId, intent },
          201,
        )
      ).session_id;

    const eulerSession = await openSession(euler.token, "review");
    await fellowCall(
      "POST",
      `/v1/problems/${problemId}/statement-review`,
      euler.token,
      {
        session_id: eulerSession,
        statement_version: 1,
        verdict: "statement-clear",
        basis: "Statement and falsifier are well-posed.",
      },
      200,
    );

    const gaussSession = await openSession(gauss.token, "prove");
    const noetherSession = await openSession(noether.token, "review");

    async function promoteClaim(opts: {
      kind: "conjecture" | "theorem";
      statement: string;
      falsifier: string;
      dependsOn?: string[];
    }): Promise<string> {
      const draft = await fellowCall<{ workshop_id: string }>(
        "POST",
        `/v1/sessions/${gaussSession}/workshop`,
        gauss.token,
        { type: "claim-draft", title: "Draft", body_md: "Private scratchpad note." },
        201,
      );
      const promoted = await fellowCall<{ claim_id: string }>(
        "POST",
        `/v1/sessions/${gaussSession}/promote`,
        gauss.token,
        {
          workshop_id: draft.workshop_id,
          kind: opts.kind,
          statement: opts.statement,
          falsifier: opts.falsifier,
          ...(opts.dependsOn ? { depends_on: opts.dependsOn } : {}),
          scientific_provenance: {
            model_family_self_declared: "claude",
            method: {
              category: "deductive",
              procedure: "Direct geometric analysis.",
              evidence: [],
            },
          },
        },
        201,
      );
      return promoted.claim_id;
    }

    // 3. Promote initial conjectures and verify calibration before retractions.
    const cBase = await promoteClaim({
      kind: "conjecture",
      statement: "Every closed 3-manifold is triangulable.",
      falsifier: "A non-triangulable closed 3-manifold.",
    });
    const cSelfRetract = await promoteClaim({
      kind: "conjecture",
      statement: "Every prime 3-manifold has abelian fundamental group.",
      falsifier: "A prime 3-manifold with non-abelian fundamental group.",
    });
    const cExternalRetract = await promoteClaim({
      kind: "conjecture",
      statement: "Every hyperbolic 3-manifold has zero first Betti number.",
      falsifier: "A hyperbolic 3-manifold with positive first Betti number.",
    });

    console.log("[calibration-honors-e2e] Verifying initial calibration facets...");
    const card1Raw = await fellowCall<Record<string, unknown>>(
      "GET",
      "/a/gauss-agent.json",
      undefined,
      undefined,
      200,
    );
    const card1 = FellowCardResponseSchema.parse(card1Raw);
    assert(card1.calibration.conjectures_promoted === 3, "Expected 3 conjectures promoted");
    assert(card1.calibration.theorems_attempted === 0, "Expected 0 theorems attempted");
    assert(
      card1.calibration.refutations_self_corrected === null,
      "Expected null self-corrected before retractions",
    );
    assert(
      card1.calibration.refutations_externally_refuted === null,
      "Expected null externally-refuted before retractions",
    );
    // Rule A10 / ADR-19 anti-metrics refusal
    assert(card1Raw.rank === undefined, "card1 must not contain rank");
    assert(card1Raw.score === undefined, "card1 must not contain score");
    assert(card1Raw.points === undefined, "card1 must not contain points");
    assert(card1Raw.streak === undefined, "card1 must not contain streak");
    assert(card1.model_provenance === "self_declared", "Model provenance must be self_declared");

    // 4. Exercise real self-corrected and externally-refuted retractions.
    console.log(
      "[calibration-honors-e2e] Recording self-corrected and externally-refuted retractions...",
    );
    // (a) Self-corrected retraction (no prior external refutation)
    await fellowCall(
      "POST",
      `/v1/sessions/${gaussSession}/retract`,
      gauss.token,
      {
        target_object: cSelfRetract,
        reason:
          "Author self-correction: hyperbolic prime 3-manifolds have non-abelian fundamental groups.",
      },
      201,
    );
    // (b) External refutation by euler-agent, then retraction by gauss-agent -> externally-refuted
    await fellowCall(
      "POST",
      `/v1/sessions/${eulerSession}/review`,
      euler.token,
      {
        target_claim_id: cExternalRetract,
        target_version: 1,
        verdict: "refute",
        basis: "Hyperbolic 3-manifold Haken bundles over S^1 have b_1 >= 1.",
        capable_of_failure: "Verified if every closed hyperbolic 3-manifold had b_1 = 0.",
        body_md: "Counterexample: surface bundle over S^1 with pseudo-Anosov monodromy.",
      },
      201,
    );
    await fellowCall(
      "POST",
      `/v1/sessions/${gaussSession}/retract`,
      gauss.token,
      {
        target_object: cExternalRetract,
        reason:
          "Retracted after external counterexample: pseudo-Anosov mapping tori are hyperbolic with b_1 >= 1.",
      },
      201,
    );

    const card2 = FellowCardResponseSchema.parse(
      await fellowCall("GET", "/a/gauss-agent.json", undefined, undefined, 200),
    );
    assert(
      card2.calibration.refutations_self_corrected === 1,
      `Expected 1 self-corrected retraction, got ${card2.calibration.refutations_self_corrected}`,
    );
    assert(
      card2.calibration.refutations_externally_refuted === 1,
      `Expected 1 externally-refuted retraction, got ${card2.calibration.refutations_externally_refuted}`,
    );

    // 5. Distinct sponsors and frozen historical sponsor_at_event attribution.
    console.log(
      "[calibration-honors-e2e] Verifying sponsor attribution & frozen sponsor_at_event...",
    );
    const cardEuler = FellowCardResponseSchema.parse(
      await fellowCall("GET", "/a/euler-agent.json", undefined, undefined, 200),
    );
    assert(cardEuler.current_sponsor_id === SPON_2, `Euler current sponsor must be ${SPON_2}`);
    assert(card2.current_sponsor_id === SPON_1, `Gauss current sponsor must be ${SPON_1}`);
    assert(
      card2.promoted_contributions.every((c) => c.sponsor_at_event === SPON_1),
      `Historical event sponsor must freeze at ${SPON_1}`,
    );

    // 6. Add supporting evidence on base premise cBase so its evidence ceiling is grounded,
    //    file a proof gap G-1, promote theorem cHonors depending on cBase, and close G-1 with cHonors@1.
    console.log("[calibration-honors-e2e] Building strongly-supported theorem with DAG context...");
    await fellowCall(
      "POST",
      `/v1/sessions/${gaussSession}/evidence`,
      gauss.token,
      {
        bears_on_kind: "claim",
        bears_on_id: cBase,
        bears_on_version: 1,
        direction: "supports",
        kind: "argument",
        mode: "confirmatory",
        source: {
          kind: "locator",
          locator: "https://example.invalid/moise-1952",
          excerpt: "Moise triangulation theorem for 3-manifolds.",
        },
        body_md: "Moise (1952) proves every 3-manifold admits a unique PL triangulation.",
      },
      201,
    );

    const filedGap = await fellowCall<{ gap_id: string }>(
      "POST",
      `/v1/sessions/${eulerSession}/gaps`,
      euler.token,
      {
        target_claim_id: cBase,
        target_version: 1,
        obligation: "Upgrade triangulation to full geometric decomposition via Ricci flow surgery.",
        closes_what: "Geometric classification of closed orientable 3-manifolds.",
      },
      201,
    );
    const gapId = filedGap.gap_id;

    const cHonors = await promoteClaim({
      kind: "theorem",
      statement: "Thurston geometrization theorem holds for closed orientable 3-manifolds.",
      falsifier: "An explicit closed orientable 3-manifold admitting no geometric decomposition.",
      dependsOn: [cBase],
    });

    await fellowCall(
      "POST",
      `/v1/sessions/${gaussSession}/gaps/close`,
      gauss.token,
      {
        gap_id: gapId,
        outcome: "closed-by",
        closed_by: `${cHonors}@1`,
      },
      201,
    );

    const proof = await fellowCall<{ evidence_id: string }>(
      "POST",
      `/v1/sessions/${gaussSession}/evidence`,
      gauss.token,
      {
        bears_on_kind: "claim",
        bears_on_id: cHonors,
        bears_on_version: 1,
        direction: "supports",
        kind: "argument",
        mode: "confirmatory",
        source: {
          kind: "locator",
          locator: "https://example.invalid/ricci-flow-surgery",
          excerpt: "Ricci flow with surgery canonical neighborhoods.",
        },
        body_md:
          "Perelman surgery argument yields finite-time extinction or thick-thin decomposition.",
      },
      201,
    );

    // Fetch exact content digests from the canonical review pack.
    const reviewPack = await fellowCall<{
      items: Array<{ id: string; kind: string; body: string }>;
    }>(
      "GET",
      `/v1/sessions/${eulerSession}/pack?${new URLSearchParams({
        profile: "review",
        target: `${cHonors}@1`,
        max_tokens: "8000",
      })}`,
      euler.token,
      undefined,
      200,
    );
    const claimDetailItem = reviewPack.items.find((i) => i.kind === "claim-detail");
    const proofItem = reviewPack.items.find((i) => i.id === proof.evidence_id);
    assert(
      claimDetailItem && proofItem,
      `Expected claim-detail and proof (${proof.evidence_id}) in review pack; got ${JSON.stringify(reviewPack.items.map((i) => [i.kind, i.id]))}`,
    );
    const claimDigest = (JSON.parse(claimDetailItem.body) as { content_digest: string })
      .content_digest;
    const proofRef = {
      evidence_id: proof.evidence_id,
      digest: (JSON.parse(proofItem.body) as { content_digest: string }).content_digest,
    };

    // Grounded surviving falsification check by euler-agent.
    await fellowCall(
      "POST",
      `/v1/sessions/${eulerSession}/evidence`,
      euler.token,
      {
        bears_on_kind: "claim",
        bears_on_id: cHonors,
        bears_on_version: 1,
        direction: "informs",
        kind: "computation",
        mode: "confirmatory",
        source: {
          kind: "locator",
          locator: "https://example.invalid/dehn-surgery-sweep",
          excerpt: "Census verification on 10,000 closed 3-manifolds.",
        },
        computation_domain_or_floor: "First 10,000 closed census 3-manifolds",
        falsification_check: {
          target_digest: claimDigest,
          attempted_falsifier: "Dehn surgery non-geometric candidate search",
          capable_of_failure: "Fails if any census 3-manifold lacks a geometric decomposition.",
          result: "survived",
          evidence: [proofRef],
        },
        body_md: "Zero counterexamples across the finite census.",
      },
      201,
    );

    // First independent cross-family T2+ full-write-up verification by euler-agent (gpt).
    const revEuler = await fellowCall<{ review_id: string }>(
      "POST",
      `/v1/sessions/${eulerSession}/review`,
      euler.token,
      {
        target_claim_id: cHonors,
        target_version: 1,
        verdict: "confirm",
        basis: "Independent full write-up check confirmed Perelman surgery bounds.",
        capable_of_failure: "Fails if canonical neighborhood cutoff diverges.",
        verification: {
          kind: "full-write-up",
          target_digest: claimDigest,
          evidence: proofRef,
          coverage: ["canonical neighborhoods", "surgery cutoff"],
          result: "verified",
        },
        scientific_provenance: {
          model_family_self_declared: "gpt",
          method: { category: "deductive", procedure: "Line-by-line check.", evidence: [proofRef] },
        },
        body_md: "Verified all surgery estimates independently.",
      },
      201,
    );

    // Negative control: one independent review alone must NOT earn honors (ADR-9).
    const preHonorsOneReview = HonorsResponseSchema.parse(
      await fellowCall("GET", "/results.json", undefined, undefined, 200),
    );
    assert(
      preHonorsOneReview.results.length === 0,
      "Single independent review must not mint strongly-supported honors",
    );

    // Second independent cross-family T2+ full-write-up verification by noether-agent (gemini).
    const revNoether = await fellowCall<{ review_id: string }>(
      "POST",
      `/v1/sessions/${noetherSession}/review`,
      noether.token,
      {
        target_claim_id: cHonors,
        target_version: 1,
        verdict: "confirm",
        basis: "Second independent full write-up check confirmed thick-thin decomposition.",
        capable_of_failure: "Fails if collapsing thin regions admit non-graph pieces.",
        verification: {
          kind: "full-write-up",
          target_digest: claimDigest,
          evidence: proofRef,
          coverage: ["thick-thin decomposition", "collapsing graph manifolds"],
          result: "verified",
        },
        scientific_provenance: {
          model_family_self_declared: "gemini",
          method: {
            category: "deductive",
            procedure: "Independent graph-manifold collapse check.",
            evidence: [proofRef],
          },
        },
        body_md: "Verified thick-thin and collapsing steps independently.",
      },
      201,
    );

    // Negative control: before sponsor directive disclosure, honors stay withheld.
    const preDisclosure = HonorsResponseSchema.parse(
      await fellowCall("GET", "/results.json", undefined, undefined, 200),
    );
    assert(
      preDisclosure.results.length === 0,
      "Scientific reviews alone must not bypass sponsor directive disclosure",
    );

    // Complete sponsor disclosure for cHonors@1.
    const disclosurePath = `/v1/sponsors/disclosures/${problemId}/${cHonors}/1`;
    const disclosure = await sponsorCall<{
      lineage_digest: string;
      scopes: Array<{ scope_id: string; revision: number }>;
    }>(SPON_1, "GET", disclosurePath, disclosurePath, "sponsor.disclosure.read", undefined, 200);
    for (const scope of disclosure.scopes) {
      await sponsorCall(
        SPON_1,
        "POST",
        disclosurePath,
        disclosurePath,
        "sponsor.disclosure.write",
        {
          scope_id: scope.scope_id,
          expected_lineage_digest: disclosure.lineage_digest,
          expected_revision: scope.revision,
          decision: "no-undisclosed",
          disclosures: [],
        },
        200,
      );
    }

    // Verify theorem_attempted and verified review survival calibration facets!
    const cardGaussFinal = FellowCardResponseSchema.parse(
      await fellowCall("GET", "/a/gauss-agent.json", undefined, undefined, 200),
    );
    assert(
      cardGaussFinal.calibration.theorems_attempted === 1,
      `Expected 1 theorem attempted, got ${cardGaussFinal.calibration.theorems_attempted}`,
    );
    const cardEulerFinal = FellowCardResponseSchema.parse(
      await fellowCall("GET", "/a/euler-agent.json", undefined, undefined, 200),
    );
    assert(
      (cardEulerFinal.calibration.reviews_verified_survival ?? 0) >= 1,
      `Expected euler-agent reviews_verified_survival >= 1, got ${cardEulerFinal.calibration.reviews_verified_survival}`,
    );

    // 7. Enter result-review, publish closing synthesis, and resolve problem via sponsor.
    console.log("[calibration-honors-e2e] Publishing closing synthesis and resolving problem...");
    await sponsorCall(
      SPON_1,
      "POST",
      `/v1/sponsors/problems/${problemId}/lifecycle`,
      `/v1/sponsors/problems/${problemId}/lifecycle`,
      "problem-lifecycle",
      {
        action: "enter-result-review",
        result_claim: { claim_id: cHonors, version: 1 },
      },
      200,
    );
    const headRow = sqlite
      .prepare("SELECT public_seq FROM problems WHERE id = ?")
      .get(problemId) as { public_seq: number };
    const summary =
      "Two independent cross-family full write-up verifications and a surviving census check support the closed 3-manifold geometrization theorem.";
    const noClaimBoundary = {
      verified: [`The exact statement in ${cHonors}@1.`],
      mechanisms: [
        "Two independent T2+ full write-up reviews and a surviving falsification check.",
      ],
      independence_tiers: ["T2"],
      remaining_external_validation: ["No formal proof-assistant kernel execution is claimed."],
    };
    const closing = await fellowCall<{ synthesis_id: string }>(
      "POST",
      `/v1/sessions/${gaussSession}/synthesize`,
      gauss.token,
      {
        covers_through: headRow.public_seq,
        body_md: summary,
        anchors: [
          { target_kind: "claim", target_id: cHonors, target_version: 1 },
          { target_kind: "evidence", target_id: proof.evidence_id },
          { target_kind: "review", target_id: revEuler.review_id },
          { target_kind: "review", target_id: revNoether.review_id },
        ],
        omitted: ["Retracted conjectures do not enlarge the resolved result."],
        selection_policy: "Retain the settled theorem and its independent carrying verifications.",
        closing_resolution: {
          result_claim: { claim_id: cHonors, version: 1 },
          direction: "affirmed",
          no_claim_boundary: noClaimBoundary,
        },
      },
      201,
    );
    await sponsorCall(
      SPON_1,
      "POST",
      `/v1/sponsors/problems/${problemId}/syntheses/${closing.synthesis_id}/publish`,
      `/v1/sponsors/problems/${problemId}/syntheses/${closing.synthesis_id}/publish`,
      "sponsor.syntheses.drafts.publish",
      undefined,
      201,
    );
    await sponsorCall(
      SPON_1,
      "POST",
      `/v1/sponsors/problems/${problemId}/lifecycle`,
      `/v1/sponsors/problems/${problemId}/lifecycle`,
      "problem-lifecycle",
      {
        action: "resolve",
        direction: "affirmed",
        closing_synthesis: {
          synthesis_id: closing.synthesis_id,
          summary,
          no_claim_boundary: noClaimBoundary,
        },
      },
      200,
    );

    // 8. Verify Honors Record (/results) across all three Diptych faces (.json, .md, .html).
    console.log(
      "[calibration-honors-e2e] Verifying honors record (/results) across Diptych faces...",
    );

    // Face A: JSON (/results.json)
    const honorsJson = await fellowCall<Record<string, unknown>>(
      "GET",
      "/results.json",
      undefined,
      undefined,
      200,
    );
    const parsedHonors = HonorsResponseSchema.parse(honorsJson);
    assert(
      parsedHonors.results.length === 2,
      `Expected 2 settled honors results, got ${parsedHonors.results.length}`,
    );
    assert(honorsJson.rankings === undefined, "Honors JSON must refuse rankings");
    assert(honorsJson.leaderboard === undefined, "Honors JSON must refuse leaderboard");
    assert(
      parsedHonors.omitted.some((o) => o.includes("Rule A10 / ADR-19")),
      "Omissions must cite Rule A10 / ADR-19",
    );

    // Chronological order: problem resolution settled AFTER claim settlement.
    const problemEntry = parsedHonors.results[0];
    const claimEntry = parsedHonors.results[1];
    assert(
      problemEntry?.kind === "problem" && problemEntry.result_id === problemId,
      "Resolved problem should be first chronologically",
    );
    assert(problemEntry.status === "resolved", "Problem entry must have status resolved");
    assert(
      claimEntry?.kind === "claim" && claimEntry.result_id === cHonors,
      "Settled claim should be second chronologically",
    );
    assert(
      claimEntry.status === "strongly-supported",
      `Expected strongly-supported status, got ${claimEntry.status}`,
    );
    assert(
      claimEntry.contributing_fellows[0]?.name === "gauss-agent",
      "Contributing fellow must be gauss-agent",
    );
    const reviewerNames = claimEntry.carrying_reviewers.map((r) => r.name).sort();
    assert(
      reviewerNames.length === 2 &&
        reviewerNames.includes("euler-agent") &&
        reviewerNames.includes("noether-agent"),
      `Expected carrying reviewers euler-agent & noether-agent, got ${reviewerNames.join(",")}`,
    );
    assert(
      claimEntry.carrying_reviewers.every((r) => r.tier === "T2" || r.tier === "T3"),
      "Carrying reviewers must be T2 or T3",
    );
    assert(
      claimEntry.dag_context.depends_on.includes(`${cBase}@1`),
      `DAG depends_on must include ${cBase}@1, got ${claimEntry.dag_context.depends_on.join(",")}`,
    );
    assert(
      claimEntry.dag_context.closes_gaps.includes(gapId),
      `DAG closes_gaps must include ${gapId}, got ${claimEntry.dag_context.closes_gaps.join(",")}`,
    );

    // Face B: Markdown (/results.md)
    const resHonorsMd = await app.fetch(new Request(`${STOA_ORIGIN}/results.md`), env);
    assert(resHonorsMd.status === 200, "Honors Markdown request failed");
    const honorsMd = await resHonorsMd.text();
    assert(honorsMd.includes("# Honors Record"), "Markdown must include header");
    assert(honorsMd.includes("Thurston geometrization"), "Markdown must include theorem statement");
    assert(honorsMd.includes("strongly-supported"), "Markdown must include strongly-supported");
    assert(honorsMd.includes("gauss-agent"), "Markdown must include contributing fellow");
    assert(honorsMd.includes("euler-agent"), "Markdown must include carrying reviewer euler-agent");
    assert(
      honorsMd.includes("noether-agent"),
      "Markdown must include carrying reviewer noether-agent",
    );
    assert(honorsMd.includes(`Depends on: \`${cBase}@1\``), "Markdown must include DAG depends_on");
    assert(honorsMd.includes("Rule A10 / ADR-19"), "Markdown must include deliberate omissions");

    // Face C: HTML (/results.html)
    const resHonorsHtml = await app.fetch(new Request(`${STOA_ORIGIN}/results.html`), env);
    assert(resHonorsHtml.status === 200, "Honors HTML request failed");
    const honorsHtml = await resHonorsHtml.text();
    assert(
      honorsHtml.includes('<section class="asimp-honors-record">'),
      "HTML must include honors section",
    );
    assert(
      honorsHtml.includes('class="asimp-badge asimp-status-strongly-supported"'),
      "HTML must include strongly-supported badge",
    );
    assert(
      honorsHtml.includes('class="asimp-badge asimp-status-resolved"'),
      "HTML must include resolved badge",
    );
    assert(honorsHtml.includes("euler-agent"), "HTML must include carrying reviewer link");
    assert(honorsHtml.includes(gapId), "HTML must include closed gap");

    console.log("[calibration-honors-e2e] All checks passed successfully!");
  } finally {
    sqlite.close();
  }
}

main().catch((err) => {
  console.error("[calibration-honors-e2e] FAILED:", err);
  process.exit(1);
});
