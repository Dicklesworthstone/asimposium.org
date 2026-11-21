/**
 * W10.3 Epistemic control-fixture corpus evaluator (`asimposiumorg-wnd`).
 *
 * Consumes the REAL ASImposium disposition, independence, review-gate,
 * conflict-normalization, authoritative-field, and dependency-cycle engines
 * directly — zero mocked engine behavior — and emits structured per-item
 * decision-path logs pinned to active policy versions.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NormalizeConflictRequest } from "@asimposium/contracts";
import { wouldCreateCycle } from "../../apps/wire/src/krater/claim-deps.ts";
import { validateConflictSubstance } from "../../apps/wire/src/ledger/conflicts.ts";
import {
  displayClaimDisposition,
  evaluateClaimTransition,
  pinIndependenceAtReviewTime,
  recomputePinnedIndependence,
  type VerifiedReview,
  wearsMachineCheckedBadge,
} from "../../apps/wire/src/ledger/dispositions.ts";
import {
  gateReviewSubmission,
  type ReviewSubmission,
} from "../../apps/wire/src/ledger/review-gate.ts";
import {
  scientificIndependence,
  tierMovesDisclosure,
} from "../../apps/wire/src/ledger/review-independence.ts";
import {
  recordedReviewIndependence,
  SCIENTIFIC_INDEPENDENCE_POLICY,
  type ScientificEvidence,
} from "../../apps/wire/src/ledger/scientific-checks.ts";
import { rejectAuthoritativeFields } from "../../apps/wire/src/split/policy.ts";

export interface EpistemicFixture {
  readonly id: string;
  readonly family: "epistemic-rev3" | "independence-manufacture-rev3.1";
  readonly kind: string;
  readonly title: string;
  readonly rule_ids: readonly string[];
  readonly expected_outcome: "pass" | "flag" | "refuse" | "coerce" | "tier_downgrade";
  readonly expected_code_or_tier: string;
  readonly rationale: string;
  readonly input: Record<string, unknown>;
}

export interface EpistemicCorpusFile {
  readonly schema: "asimposium.epistemic-control-corpus.v1";
  readonly corpus_version: string;
  readonly policy_versions: {
    readonly independence_policy: string;
    readonly disposition_engine: string;
    readonly protocol_rules: string;
  };
  readonly fixtures: readonly EpistemicFixture[];
}

export interface EpistemicDecisionRecord {
  readonly fixture_id: string;
  readonly family: EpistemicFixture["family"];
  readonly kind: string;
  readonly policy_versions: {
    readonly corpus_version: string;
    readonly independence_policy: string;
  };
  readonly expected_outcome: EpistemicFixture["expected_outcome"];
  readonly actual_outcome: EpistemicFixture["expected_outcome"];
  readonly expected_code_or_tier: string;
  readonly actual_code_or_tier: string;
  readonly decision_path: readonly string[];
  readonly pass: boolean;
}

export function loadEpistemicCorpus(
  path = join(import.meta.dir, "corpus.json"),
): EpistemicCorpusFile {
  return JSON.parse(readFileSync(path, "utf8")) as EpistemicCorpusFile;
}

const HANDWAVE_PATTERNS = [
  /\bit follows trivially\b/i,
  /\bobviously holds\b/i,
  /\bleft as an exercise\b/i,
  /\bclearly true without proof\b/i,
];

function evaluateFixtureCore(fixture: EpistemicFixture): {
  readonly outcome: EpistemicFixture["expected_outcome"];
  readonly codeOrTier: string;
  readonly path: string[];
} {
  const inp = fixture.input;
  const mode = String(inp.evaluator ?? "");
  const path: string[] = [`evaluator:${mode}`];

  switch (mode) {
    case "subtly-false-proof": {
      const disputed = evaluateClaimTransition(
        "open",
        {
          kind: "evidence-refuted",
          evidence_id: "E-COUNTER-1",
          confirmed_by_independent_review: Boolean(inp.confirmed_by_independent_review),
          unanswered_hours: Number(inp.unanswered_hours_initial ?? 12),
        },
        { recorded_refutation_attempts: 1, verified_reviews: [], has_certified_artifact: false },
      );
      path.push(`initial-refutation:${disputed.allowed ? disputed.next : "refused"}`);
      const settled = evaluateClaimTransition(
        disputed.allowed ? disputed.next : "open",
        {
          kind: "evidence-refuted",
          evidence_id: "E-COUNTER-1",
          confirmed_by_independent_review: Boolean(inp.confirmed_by_independent_review),
          unanswered_hours: Number(inp.unanswered_hours_settled ?? 72),
        },
        { recorded_refutation_attempts: 1, verified_reviews: [], has_certified_artifact: false },
      );
      path.push(`settled-refutation:${settled.allowed ? settled.next : "refused"}`);
      return {
        outcome: "flag",
        codeOrTier: `${disputed.allowed ? disputed.next : "err"}->${settled.allowed ? settled.next : "err"}`,
        path,
      };
    }

    case "weaker-statement-compiled-artifact": {
      const ctx = {
        recorded_refutation_attempts: 1,
        verified_reviews: [],
        has_certified_artifact: Boolean(inp.has_certified_artifact),
      };
      const defectReview: VerifiedReview = {
        review_id: "R-STMT-DEFECT-1",
        reviewer_id: "F-REV-STMT",
        tier: "T2",
        cross_family: true,
        full_write_up: true,
        finding: "statement-defect",
      };
      const res = evaluateClaimTransition(
        "strongly-supported",
        { kind: "review-verified", review: defectReview },
        ctx,
      );
      const nextState = res.allowed ? res.next : "strongly-supported";
      const badgeAfter = wearsMachineCheckedBadge(nextState, ctx);
      const cureAttempt = evaluateClaimTransition(
        nextState,
        {
          kind: "review-verified",
          review: { ...defectReview, review_id: "R-SUP-2", finding: "support" },
        },
        ctx,
      );
      const newVersionExit = evaluateClaimTransition(
        nextState,
        { kind: "new-version", new_version: 2 },
        ctx,
      );
      path.push(
        `defect->${nextState}`,
        `machine_checked_badge=${String(badgeAfter)}`,
        `support_from_malformed_allowed=${String(cureAttempt.allowed)}`,
        `new_version_exit=${newVersionExit.allowed ? newVersionExit.next : "refused"}`,
      );
      if (
        nextState === "malformed" &&
        !badgeAfter &&
        !cureAttempt.allowed &&
        newVersionExit.allowed
      ) {
        return { outcome: "flag", codeOrTier: "malformed", path };
      }
      return { outcome: "pass", codeOrTier: nextState, path };
    }

    case "epistemic-heuristics": {
      const stmt = String(inp.claim_statement ?? "");
      const scope = String(inp.evidence_scope ?? "");
      const universalClaim = /\bfor all\b|\bevery\b|\buniversal\b/i.test(stmt);
      const finiteScope = /(?:<=|≤)\s*\d+|\bfinite\b|\bup to \d+\b/i.test(scope);
      path.push(`universal=${String(universalClaim)}`, `finite_scope=${String(finiteScope)}`);
      if (universalClaim && finiteScope) {
        return { outcome: "flag", codeOrTier: "SCOPE_MISMATCH_UNBOUNDED", path };
      }
      return { outcome: "pass", codeOrTier: "PASS_UNFLAGGED", path };
    }

    case "citation-grounding": {
      const locator = String(inp.locator ?? "").trim();
      const quoted = String(inp.quoted_text ?? "").trim();
      const source = String(inp.source_excerpt ?? "").trim();
      if (!locator || !/^(doi:|arxiv:|https:\/\/)/i.test(locator)) {
        path.push("locator:missing-or-unanchored");
        return { outcome: "refuse", codeOrTier: "CITATION_UNANCHORED", path };
      }
      const claimsGlobal = /\bunconditional\b|\bglobal\b|\ball manifolds\b/i.test(quoted);
      const sourceRestricts = /\blocal\b|\bcompact convex\b|\bonly on\b/i.test(source);
      path.push(
        `locator:ok`,
        `claimsGlobal=${String(claimsGlobal)}`,
        `sourceRestricts=${String(sourceRestricts)}`,
      );
      if (claimsGlobal && sourceRestricts) {
        return { outcome: "flag", codeOrTier: "CITATION_MISQUOTE_DETECTED", path };
      }
      return { outcome: "pass", codeOrTier: "PASS_UNFLAGGED", path };
    }

    case "leakage-check": {
      const train = new Set((inp.train_ids as string[]) ?? []);
      const overlap = ((inp.eval_ids as string[]) ?? []).filter((id) => train.has(id));
      path.push(`overlap_count=${overlap.length}`);
      if (overlap.length > 0) {
        return { outcome: "flag", codeOrTier: "EVALUATION_LEAKAGE_DETECTED", path };
      }
      return { outcome: "pass", codeOrTier: "PASS_UNFLAGGED", path };
    }

    case "hidden-lemma-check": {
      const proof = String(inp.proof_md ?? "");
      const cited = (inp.cited_claims as string[]) ?? [];
      const gaps = (inp.open_proof_gaps as string[]) ?? [];
      const matched = HANDWAVE_PATTERNS.some((re) => re.test(proof));
      path.push(`handwave=${String(matched)}`, `cited=${cited.length}`, `gaps=${gaps.length}`);
      if (matched && cited.length === 0 && gaps.length === 0) {
        return { outcome: "flag", codeOrTier: "HIDDEN_LEMMA_PROOF_GAP", path };
      }
      return { outcome: "pass", codeOrTier: "PASS_UNFLAGGED", path };
    }

    case "conflict-normalization": {
      const check = validateConflictSubstance(inp as unknown as NormalizeConflictRequest);
      path.push(`validateConflictSubstance=${String(check.valid)}`);
      if (!check.valid) {
        path.push(`reason=${check.reason}`);
        return { outcome: "refuse", codeOrTier: "CONFLICT_NORMALIZATION_REFUSED", path };
      }
      return { outcome: "pass", codeOrTier: "CONFLICT_NORMALIZED", path };
    }

    case "review-gate": {
      const res = gateReviewSubmission({
        submission: inp.submission as ReviewSubmission,
        claimAuthorFellowId: String(inp.claimAuthorFellowId ?? ""),
        reviewerFellowId: String(inp.reviewerFellowId ?? ""),
        claimKind: inp.claimKind ? String(inp.claimKind) : undefined,
      });
      if (!res.ok) {
        path.push(`gateRefused:${res.code}`, `rule:${res.rule}`);
        return { outcome: "refuse", codeOrTier: res.code, path };
      }
      path.push(`gateAccepted:carriesWeight=${String(res.carriesWeight)}`);
      if (!res.carriesWeight) {
        return { outcome: "coerce", codeOrTier: "ZERO_WEIGHT_ASSERTION_ONLY", path };
      }
      return { outcome: "pass", codeOrTier: "WEIGHTED_REVIEW_ACCEPTED", path };
    }

    case "authoritative-fields": {
      const refusal = rejectAuthoritativeFields(inp.payload);
      if (refusal) {
        path.push(`refused:${refusal.code}`, `rule:${refusal.rule}`);
        return { outcome: "refuse", codeOrTier: refusal.code, path };
      }
      path.push("accepted");
      return { outcome: "pass", codeOrTier: "PASS_UNFLAGGED", path };
    }

    case "negative-result-scope": {
      const scope = String(inp.scope ?? "").trim();
      const floor = String(inp.detection_floor ?? "").trim();
      path.push(`has_scope=${String(scope.length > 0)}`, `has_floor=${String(floor.length > 0)}`);
      if (scope.length === 0 || floor.length === 0) {
        path.push("coerced:exploratory-unbounded");
        return { outcome: "coerce", codeOrTier: "P5_SCOPE_COERCED", path };
      }
      return { outcome: "pass", codeOrTier: "PASS_UNFLAGGED", path };
    }

    case "independence-same-sponsor": {
      const tier = scientificIndependence(
        {
          sponsorId: String(inp.authorSponsorId),
          provenance: { model_family_self_declared: String(inp.authorFamily) },
        },
        {
          sponsorId: String(inp.reviewerSponsorId),
          provenance: { model_family_self_declared: String(inp.reviewerFamily) },
        },
        [],
      );
      const moves = tierMovesDisclosure(tier);
      const review: VerifiedReview = {
        review_id: "R-IND-1",
        reviewer_id: "F-REV-IND-1",
        tier,
        cross_family: true,
        full_write_up: true,
        finding: "support",
      };
      const ctx = {
        recorded_refutation_attempts: 0,
        verified_reviews: [review],
        has_certified_artifact: false,
      };
      const transition = evaluateClaimTransition("open", { kind: "review-verified", review }, ctx);
      const displayed = displayClaimDisposition("open", ctx);
      path.push(
        `tier=${tier}`,
        `tierMovesDisclosure=${String(moves)}`,
        `corroborate_allowed=${String(transition.allowed)}`,
        `display=${displayed}`,
      );
      return { outcome: "tier_downgrade", codeOrTier: `${tier}:${displayed}`, path };
    }

    case "independence-transfer-pin": {
      const pinned = pinIndependenceAtReviewTime(
        String(inp.initialReviewerSponsorId),
        String(inp.initialAuthorSponsorId),
        String(inp.reviewerFamily),
        String(inp.authorFamily),
        false,
        String(inp.reviewedAt),
      );
      const recompute = recomputePinnedIndependence(
        pinned,
        String(inp.postTransferReviewerSponsorId),
        String(inp.initialAuthorSponsorId),
        String(inp.reviewerFamily),
        String(inp.authorFamily),
        false,
      );
      const recorded = recordedReviewIndependence(
        { independence_policy: SCIENTIFIC_INDEPENDENCE_POLICY, tier: pinned.tier },
        String(inp.initialAuthorSponsorId),
        String(inp.postTransferReviewerSponsorId),
      );
      path.push(
        `pinned=${pinned.tier}`,
        `recompute_allowed=${String(recompute.allowed)}`,
        `recorded_tier=${recorded.tier}`,
      );
      if (pinned.tier === "T0" && !recompute.allowed && recorded.tier === "T0") {
        return { outcome: "refuse", codeOrTier: "PINNED_TIER_T0_IMMUTABLE", path };
      }
      return { outcome: "pass", codeOrTier: recorded.tier, path };
    }

    case "independence-sibling-fellows": {
      const gate = gateReviewSubmission({
        submission: {
          targetClaimId: "C-SIB",
          targetVersion: 1,
          verdict: "confirm",
          basis: "independent-derivation",
          capableOfFailure: "Checked every step and ran finite counterexample search.",
          bodyMd: "Sibling Fellow verified the derivation.",
        },
        claimAuthorFellowId: String(inp.authorFellowId),
        reviewerFellowId: String(inp.reviewerFellowId),
      });
      const tier = scientificIndependence(
        {
          sponsorId: String(inp.sharedSponsorId),
          provenance: { model_family_self_declared: String(inp.authorFamily) },
        },
        {
          sponsorId: String(inp.sharedSponsorId),
          provenance: { model_family_self_declared: String(inp.reviewerFamily) },
        },
        [],
      );
      const transition = evaluateClaimTransition(
        "open",
        {
          kind: "review-verified",
          review: {
            review_id: "R-SIB-1",
            reviewer_id: String(inp.reviewerFellowId),
            tier,
            cross_family: true,
            full_write_up: true,
            finding: "support",
          },
        },
        { recorded_refutation_attempts: 1, verified_reviews: [], has_certified_artifact: false },
      );
      path.push(
        `p1_gate_ok=${String(gate.ok)}`,
        `tier=${tier}`,
        `corroborate_allowed=${String(transition.allowed)}`,
      );
      return {
        outcome: "tier_downgrade",
        codeOrTier: `${tier}:${transition.allowed ? "corroborated" : "corroboration-refused"}`,
        path,
      };
    }

    case "independence-harness-gaming": {
      const tier = scientificIndependence(
        {
          sponsorId: String(inp.authorSponsorId),
          provenance: { model_family_self_declared: String(inp.sharedFamily) },
        },
        {
          sponsorId: String(inp.reviewerSponsorId),
          provenance: { model_family_self_declared: String(inp.sharedFamily) },
        },
        [],
      );
      const rev1: VerifiedReview = {
        review_id: "R-GAMED-1",
        reviewer_id: "F-GAMED-1",
        tier,
        cross_family: false,
        full_write_up: true,
        finding: "support",
      };
      const rev2: VerifiedReview = {
        review_id: "R-GAMED-2",
        reviewer_id: "F-GAMED-2",
        tier,
        cross_family: false,
        full_write_up: true,
        finding: "support",
      };
      const strong = evaluateClaimTransition(
        "corroborated",
        { kind: "review-verified", review: rev2 },
        {
          recorded_refutation_attempts: 1,
          verified_reviews: [rev1],
          has_certified_artifact: false,
        },
      );
      path.push(
        `authorHarness=${String(inp.authorHarness)}`,
        `reviewerHarness=${String(inp.reviewerHarness)}`,
        `tier=${tier}`,
        `strong_support_allowed=${String(strong.allowed)}`,
      );
      return {
        outcome: "tier_downgrade",
        codeOrTier: `${tier}:${strong.allowed ? "strongly-supported" : "strong-support-refused"}`,
        path,
      };
    }

    case "independence-colluded-pair": {
      const rev: VerifiedReview = {
        review_id: "R-COLLUDE-1",
        reviewer_id: "F-COLLUDE-B",
        tier: "T2",
        cross_family: true,
        full_write_up: true,
        finding: "support",
      };
      const ctx = {
        recorded_refutation_attempts: Number(inp.recorded_refutation_attempts ?? 0),
        verified_reviews: [rev],
        has_certified_artifact: false,
      };
      const trans = evaluateClaimTransition("open", { kind: "review-verified", review: rev }, ctx);
      const display = displayClaimDisposition("open", ctx);
      path.push(`corroborate_allowed=${String(trans.allowed)}`, `display=${display}`);
      return { outcome: "tier_downgrade", codeOrTier: display, path };
    }

    case "independence-p10-adjacent": {
      const existing = inp.existing_edges as { claimId: string; dependsOnClaimId: string }[];
      const proposed = inp.proposed_cyclic_edge as { claimId: string; dependsOnClaimId: string };
      const cycleDetected = wouldCreateCycle(existing, proposed.claimId, proposed.dependsOnClaimId);

      // Single reviewer submitting two distinct review IDs cannot satisfy two-reviewer strong-support.
      const dup1: VerifiedReview = {
        review_id: "R-DUP-1",
        reviewer_id: String(inp.reviewer_fellow_id),
        tier: "T2",
        cross_family: true,
        full_write_up: true,
        finding: "support",
      };
      const dup2: VerifiedReview = { ...dup1, review_id: "R-DUP-2" };
      const strong = evaluateClaimTransition(
        "corroborated",
        { kind: "review-verified", review: dup2 },
        {
          recorded_refutation_attempts: 1,
          verified_reviews: [dup1],
          has_certified_artifact: false,
        },
      );
      const premiseCoupled =
        String(inp.premise_author_fellow_id) === String(inp.reviewer_fellow_id);
      path.push(
        `p10_cycle=${String(cycleDetected)}`,
        `dup_reviewer_strong_allowed=${String(strong.allowed)}`,
        `premise_coupled=${String(premiseCoupled)}`,
      );
      if (cycleDetected && !strong.allowed && premiseCoupled) {
        return { outcome: "refuse", codeOrTier: "P10_CYCLE_AND_COUPLED_REVIEWER_REFUSED", path };
      }
      return { outcome: "pass", codeOrTier: "UNEXPECTED_ALLOW", path };
    }

    case "independence-legitimate-t3": {
      const evDigest = "a".repeat(64);
      const reviewerEvidence: ScientificEvidence[] = [
        {
          eventId: "EV-T3-1",
          payloadDigest: evDigest,
          evidenceId: "E-COMP-T3",
          fellowId: "F-REV-T3-A",
          sponsorId: String(inp.reviewerSponsorId),
          kind: "computation",
          direction: "supports",
          body: "Exhaustive symbolic + numerical verification script.",
          payload: { reproduction: { commands: ["python3 verify.py"] } },
        },
      ];
      const tier = scientificIndependence(
        {
          sponsorId: String(inp.authorSponsorId),
          provenance: {
            model_family_self_declared: String(inp.authorFamily),
            method: { category: "deductive", evidence: [] },
          },
        },
        {
          sponsorId: String(inp.reviewerSponsorId),
          provenance: {
            model_family_self_declared: String(inp.reviewerFamily),
            method: {
              category: "computation",
              evidence: [{ evidence_id: "E-COMP-T3", digest: `sha256:${evDigest}` }],
            },
          },
        },
        reviewerEvidence,
        { reviewerFellowId: "F-REV-T3-A" },
      );
      const r1: VerifiedReview = {
        review_id: "R-T3-1",
        reviewer_id: "F-REV-T3-A",
        tier,
        cross_family: true,
        full_write_up: true,
        finding: "support",
      };
      const r2: VerifiedReview = {
        review_id: "R-T3-2",
        reviewer_id: "F-REV-T3-B",
        tier: "T2",
        cross_family: true,
        full_write_up: true,
        finding: "support",
      };
      const step1 = evaluateClaimTransition(
        "open",
        { kind: "review-verified", review: r1 },
        { recorded_refutation_attempts: 1, verified_reviews: [], has_certified_artifact: false },
      );
      const step2 = evaluateClaimTransition(
        step1.allowed ? step1.next : "open",
        { kind: "review-verified", review: r2 },
        { recorded_refutation_attempts: 1, verified_reviews: [r1], has_certified_artifact: false },
      );
      const finalDisp = step2.allowed ? step2.next : "refused";
      path.push(
        `tier=${tier}`,
        `step1=${step1.allowed ? step1.next : "err"}`,
        `step2=${finalDisp}`,
      );
      return { outcome: "pass", codeOrTier: `${tier}:${finalDisp}`, path };
    }

    default:
      throw new Error(`UNKNOWN_CORPUS_EVALUATOR: ${mode}`);
  }
}

export function evaluateEpistemicCorpus(
  corpus: EpistemicCorpusFile = loadEpistemicCorpus(),
): readonly EpistemicDecisionRecord[] {
  return corpus.fixtures.map((fixture) => {
    const res = evaluateFixtureCore(fixture);
    const pass =
      res.outcome === fixture.expected_outcome && res.codeOrTier === fixture.expected_code_or_tier;
    return {
      fixture_id: fixture.id,
      family: fixture.family,
      kind: fixture.kind,
      policy_versions: {
        corpus_version: corpus.corpus_version,
        independence_policy: SCIENTIFIC_INDEPENDENCE_POLICY,
      },
      expected_outcome: fixture.expected_outcome,
      actual_outcome: res.outcome,
      expected_code_or_tier: fixture.expected_code_or_tier,
      actual_code_or_tier: res.codeOrTier,
      decision_path: res.path,
      pass,
    };
  });
}
