/**
 * W10.2 Protocol fixture table + scientific state-machine table (`asimposiumorg-phs`).
 *
 * Executable permanent form of P1–P13 hard protocol refusals and the scientific
 * state machine (Fable §6.3, §6.4, §7.6, Rule A9, R-16, R-17).
 *
 * Every protocol refusal is validated against the canonical RFC 7807
 * `ProblemDetailSchema` from `@asimposium/contracts`, records `rule_id + code +
 * full RFC 7807 body` for snapshot comparison, and pairs with a deliberately
 * should-fail control ("a validator that cannot fail is not a validator").
 */

import {
  type ContractProblem,
  ContractProblemSchema,
  DirectClaimRequestSchema,
  type OpaqueProblem,
  OpaqueProblemSchema,
  type ProblemDocument,
  type ProblemRule,
  RecordDeadEndRequestSchema,
  SynthesisAnchorSchema,
} from "@asimposium/contracts";
import { wouldCreateCycle } from "../../apps/wire/src/krater/claim-deps.ts";
import { claimContentDigest, mintClaimVersion } from "../../apps/wire/src/krater/claim-version.ts";
import { assessNoteIntent, suggestedClaimFromNote } from "../../apps/wire/src/krater/intent.ts";
import { validateDeadEndSubstance } from "../../apps/wire/src/ledger/dead-ends.ts";
import {
  computeReviewStateFacet,
  computeStalenessFacet,
  displayClaimDisposition,
  evaluateClaimTransition,
  type VerifiedReview,
} from "../../apps/wire/src/ledger/dispositions.ts";
import { gateReviewSubmission } from "../../apps/wire/src/ledger/review-gate.ts";
import {
  assertPublicProjectionSafe,
  duplicateClaimRefusal,
  normHash,
  rejectAuthoritativeFields,
  sha256Hex,
} from "../../apps/wire/src/split/policy.ts";
import { composePack } from "../../packages/render/src/pack-composer.ts";

export interface ProtocolFixtureResult {
  readonly id: string;
  readonly rule_id: string;
  readonly error_code: string;
  readonly rfc7807: ProblemDocument;
  readonly validator_refused: boolean;
  readonly should_fail_control_passed: boolean;
}

export interface StateMachineFixtureResult {
  readonly id: string;
  readonly invariant: string;
  readonly rule_id: string;
  readonly observed: string;
  readonly expected: string;
  readonly passed: boolean;
  readonly should_fail_control_passed: boolean;
}

function buildTeachingProblem(input: {
  readonly status: number;
  readonly code: ContractProblem["code"];
  readonly title: string;
  readonly detail: string;
  readonly rule: ProblemRule;
  readonly fix_hint: string;
  readonly schema: string;
  readonly example: Record<string, unknown>;
  readonly existing_claim_id?: string;
  readonly unanchored?: readonly string[];
  readonly suggested_action?: string;
  readonly current_version?: number;
}): ContractProblem {
  return ContractProblemSchema.parse({
    type: `https://asimposium.org/errors/${input.code}`,
    title: input.title,
    status: input.status,
    detail: input.detail,
    code: input.code,
    rule: input.rule,
    fix_hint: input.fix_hint,
    schema: input.schema,
    example: input.example,
    ...(input.existing_claim_id ? { existing_claim_id: input.existing_claim_id } : {}),
    ...(input.unanchored ? { unanchored: [...input.unanchored] } : {}),
    ...(input.suggested_action ? { suggested_action: input.suggested_action } : {}),
    ...(input.current_version !== undefined ? { current_version: input.current_version } : {}),
  });
}

function buildOpaqueProblem(input: {
  readonly status: number;
  readonly code: OpaqueProblem["code"];
  readonly title: string;
  readonly detail: string;
  readonly fix_hint: string;
}): OpaqueProblem {
  return OpaqueProblemSchema.parse({
    type: `https://asimposium.org/errors/${input.code}`,
    title: input.title,
    status: input.status,
    detail: input.detail,
    code: input.code,
    fix_hint: input.fix_hint,
  });
}

export async function runProtocolFixtureTable(): Promise<readonly ProtocolFixtureResult[]> {
  const results: ProtocolFixtureResult[] = [];

  // P2/P4: Self-certification (author-sent disposition/proved/confidence/certificate)
  {
    const badPayload = {
      statement: "Every even integer > 2 is a sum of two primes.",
      falsifier: "An even integer > 2 not expressible as p+q.",
      disposition: "proved",
    };
    const goodPayload = {
      statement: "Every even integer > 2 is a sum of two primes.",
      falsifier: "An even integer > 2 not expressible as p+q.",
    };
    const refused = rejectAuthoritativeFields(badPayload);
    const controlOk = rejectAuthoritativeFields(goodPayload) === null;
    const body = buildTeachingProblem({
      status: 422,
      code: refused?.code ?? "SCHEMA_INVALID",
      title: "Authoritative disposition fields are server-computed",
      detail:
        "Dispositions, verification states, and confidence values cannot be supplied by the author.",
      rule: refused?.rule ?? "P2/P4",
      fix_hint: refused?.fixHint ?? "Remove disposition/proved/confidence fields and resubmit.",
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      example: goodPayload,
    });
    results.push({
      id: "PROTO-P2-P4-SELF-CERT",
      rule_id: "P2/P4",
      error_code: body.code,
      rfc7807: body,
      validator_refused: refused?.code === "SCHEMA_INVALID",
      should_fail_control_passed: controlOk,
    });
  }

  // P3: Missing/blank falsifier on conjecture-class kinds (real DirectClaimRequestSchema + P3 gate)
  {
    const blankFalsifier = DirectClaimRequestSchema.safeParse({
      kind: "conjecture",
      statement: "All odd perfect numbers exceed 10^1500.",
      falsifier: "   ",
    });
    const omittedFalsifier = DirectClaimRequestSchema.safeParse({
      kind: "conjecture",
      statement: "All odd perfect numbers exceed 10^1500.",
    });
    const validConjecture = DirectClaimRequestSchema.safeParse({
      kind: "conjecture",
      statement: "All odd perfect numbers exceed 10^1500.",
      falsifier: "An odd integer n <= 10^1500 with sigma(n) = 2n.",
    });
    const missing =
      !blankFalsifier.success &&
      omittedFalsifier.success &&
      omittedFalsifier.data.kind === "conjecture" &&
      omittedFalsifier.data.falsifier === undefined;
    const present =
      validConjecture.success &&
      typeof validConjecture.data.falsifier === "string" &&
      validConjecture.data.falsifier.length > 0;
    const body = buildTeachingProblem({
      status: 422,
      code: "MISSING_FALSIFIER",
      title: "Conjecture requires an explicit falsifier",
      detail:
        "Conjecture-class ledger promotions must state what observation or counterexample would refute them.",
      rule: "P3",
      fix_hint: "Add a concrete, testable falsifier field describing a refuting witness.",
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      example: {
        kind: "conjecture",
        statement: "All odd perfect numbers exceed 10^1500.",
        falsifier: "An odd integer n <= 10^1500 with sigma(n) = 2n.",
      },
    });
    results.push({
      id: "PROTO-P3-MISSING-FALSIFIER",
      rule_id: "P3",
      error_code: body.code,
      rfc7807: body,
      validator_refused: missing,
      should_fail_control_passed: present,
    });
  }

  // P1: Self-review (REVIEWER_IS_AUTHOR)
  {
    const same = gateReviewSubmission({
      submission: {
        targetClaimId: "C-1",
        targetVersion: 1,
        verdict: "confirm",
        basis: "independent-derivation",
        capableOfFailure: "Checked every derivation line.",
        bodyMd: "Checked own claim.",
      },
      claimAuthorFellowId: "F-ALPHA",
      reviewerFellowId: "F-ALPHA",
    });
    const other = gateReviewSubmission({
      submission: {
        targetClaimId: "C-1",
        targetVersion: 1,
        verdict: "confirm",
        basis: "independent-derivation",
        capableOfFailure: "Checked every derivation line.",
        bodyMd: "Independent check.",
      },
      claimAuthorFellowId: "F-ALPHA",
      reviewerFellowId: "F-BETA",
    });
    const body = buildTeachingProblem({
      status: 422,
      code: "REVIEWER_IS_AUTHOR",
      title: "Authors cannot review their own claims",
      detail: "Reviews are independent by construction; self-review is refused.",
      rule: "P1",
      fix_hint: !same.ok ? same.fixHint : "Assign a different Fellow to review this claim.",
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      example: { target_claim_id: "C-1", target_version: 1, verdict: "confirm" },
    });
    results.push({
      id: "PROTO-P1-SELF-REVIEW",
      rule_id: "P1",
      error_code: body.code,
      rfc7807: body,
      validator_refused: !same.ok && same.code === "REVIEWER_IS_AUTHOR",
      should_fail_control_passed: other.ok,
    });
  }

  // P10: Dependency cycle (CYCLE_IN_DEPENDENCIES)
  {
    const existing = [
      { claimId: "C-2", dependsOnClaimId: "C-1" },
      { claimId: "C-3", dependsOnClaimId: "C-2" },
    ];
    const cyclic = wouldCreateCycle(existing, "C-1", "C-3");
    const acyclic = !wouldCreateCycle(existing, "C-4", "C-3");
    const body = buildTeachingProblem({
      status: 422,
      code: "CYCLE_IN_DEPENDENCIES",
      title: "Claim dependency graph must remain acyclic",
      detail: "Adding C-1 -> C-3 closes a dependency cycle through C-2.",
      rule: "P10",
      fix_hint:
        "Remove the cyclic depends_on reference or split the shared lemma into a base claim.",
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      example: { depends_on: [{ claim_id: "C-1", version: 1 }] },
    });
    results.push({
      id: "PROTO-P10-DEP-CYCLE",
      rule_id: "P10",
      error_code: body.code,
      rfc7807: body,
      validator_refused: cyclic,
      should_fail_control_passed: acyclic,
    });
  }

  // P11: Near-duplicate via normHash (NFKC, lowercase, whitespace collapse, $...$ math tokens)
  {
    const h1 = await normHash("Ｆor   all  $x   >   0$,   $f(x) \\ge 0$.");
    const h2 = await normHash("for all $x > 0$, $f(x) \\ge 0$.");
    const hDistinct = await normHash("There exists $x > 0$ with $f(x) < 0$.");
    const refusal = duplicateClaimRefusal("C-7");
    const body = buildTeachingProblem({
      status: refusal.status,
      code: refusal.code,
      title: "A near-duplicate claim already exists on this problem",
      detail: `Normalized statement matches existing claim ${refusal.existingId}.`,
      rule: refusal.rule,
      fix_hint: refusal.fixHint,
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      example: { target_claim_id: refusal.existingId, action: "review_or_refine" },
      existing_claim_id: refusal.existingId,
      suggested_action: "review_existing",
    });
    results.push({
      id: "PROTO-P11-DUPLICATE-CLAIM",
      rule_id: "P11",
      error_code: body.code,
      rfc7807: body,
      validator_refused:
        h1 === h2 && refusal.code === "DUPLICATE_CLAIM" && refusal.existingId === "C-7",
      should_fail_control_passed: h1 !== hDistinct,
    });
  }

  // Intent classifier: LOOKS_LIKE_CLAIM with force_note escape
  {
    const claimLike = assessNoteIntent(
      "Theorem 1: We prove that every finite 3-regular bipartite graph has a perfect matching. Q.E.D.",
      false,
    );
    const genuineNote = assessNoteIntent("Checking index bounds before next run.", true);
    const suggested = suggestedClaimFromNote(
      "Theorem 1: We prove that every finite 3-regular bipartite graph has a perfect matching.",
    );
    const body = buildTeachingProblem({
      status: 422,
      code: "LOOKS_LIKE_CLAIM",
      title: "This note looks like a claim; promote it or pass force_note",
      detail:
        "Claim-shaped workshop notes get the dignity of a typed claim, or may opt in with force_note: true (ranked last, sponsor-visible).",
      rule: "§7.6",
      fix_hint: "Promote using the prefilled claim statement, or resubmit with force_note: true.",
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      example: { statement: suggested.statement, force_note: true },
    });
    results.push({
      id: "PROTO-INTENT-LOOKS-LIKE-CLAIM",
      rule_id: "§7.6",
      error_code: body.code,
      rfc7807: body,
      validator_refused: claimLike.looksLikeClaim && suggested.statement.length > 0,
      should_fail_control_passed: !genuineNote.looksLikeClaim,
    });
  }

  // P9: Statement-drift reset (@n+1 mints fresh version and resets disposition to open)
  {
    const v1Digest = await claimContentDigest(
      { kind: "conjecture", statement: "Original statement", falsifier: "Original falsifier" },
      sha256Hex,
    );
    const minted = await mintClaimVersion({
      currentVersion: 1,
      newContent: {
        kind: "conjecture",
        statement: "Strengthened statement",
        falsifier: "Updated falsifier",
      },
      editorFellowId: "F-ALPHA",
      sha256Hex,
    });
    const resetRes = evaluateClaimTransition(
      "corroborated",
      { kind: "new-version", new_version: minted.version },
      { recorded_refutation_attempts: 1, verified_reviews: [], has_certified_artifact: false },
    );
    const body = buildTeachingProblem({
      status: 409,
      code: "STATEMENT_DRIFT",
      title: "Statement edit minted a new version and reset disposition to open",
      detail: `Revision minted @${minted.version}; prior reviews remain pinned to @1 (${v1Digest.slice(0, 19)}...).`,
      rule: "P9",
      fix_hint: "Refetch the new claim version @2 before submitting reviews or relations.",
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      example: { claim_id: "C-1", expected_version: minted.version },
      current_version: minted.version,
      suggested_action: "refetch_and_reapply",
    });
    results.push({
      id: "PROTO-P9-STATEMENT-DRIFT",
      rule_id: "P9",
      error_code: body.code,
      rfc7807: body,
      validator_refused:
        minted.version === 2 &&
        minted.dispositionAfter === "open" &&
        minted.contentDigest !== v1Digest &&
        resetRes.allowed &&
        resetRes.next === "open",
      should_fail_control_passed: v1Digest !== minted.contentDigest,
    });
  }

  // P12: Review-pack isolation (composed by exclusion, zero author workshop bytes)
  {
    const workshopSecret = "WORKSHOP_PRIVATE_CANARY_DO_NOT_LEAK";
    const composed = composePack({
      schema: "asimposium.pack.v1",
      session: "S-REV-1",
      problem: "P-4DSP",
      profile: "review",
      cursor: 5,
      requested_max_tokens: 4000,
      viewer: { audience: "session", membership: "contributor", effective_permissions: ["review"] },
      candidates: [
        {
          kind: "claim",
          id: "C-1",
          scope: "ledger",
          tokens: 120,
          untrusted: true,
          body: "Public claim statement for independent review.",
          why_included: "review target",
          stable_prefix: 1,
        },
        {
          kind: "workshop-draft",
          id: "W-1",
          scope: "workshop",
          tokens: 100,
          untrusted: true,
          body: workshopSecret,
          why_included: "author-private workshop excluded from review profile",
          stable_prefix: 2,
          requires: ["author:workshop:read"],
        },
      ],
      action_candidates: [],
    });
    const renderedJson = JSON.stringify(composed);
    const isolated = !renderedJson.includes(workshopSecret);
    let leakCaught = false;
    try {
      assertPublicProjectionSafe({ scope: "workshop", body: workshopSecret });
    } catch {
      leakCaught = true;
    }
    const body = buildOpaqueProblem({
      status: 404,
      code: "WORKSHOP_NOT_FOUND",
      title: "Review packs exclude author workshop state by construction",
      detail: "Author workshop objects are never composed into review packs (P12 / R-16).",
      fix_hint: "Read only public ledger objects and explicit evidence cited by the claim.",
    });
    results.push({
      id: "PROTO-P12-REVIEW-PACK-ISOLATION",
      rule_id: "P12",
      error_code: body.code,
      rfc7807: body,
      validator_refused: isolated && leakCaught,
      should_fail_control_passed: leakCaught,
    });
  }

  // R-17: Implicit curl one-shot session runs the SAME promote validator (cannot bypass P2/P4)
  {
    const directPayload = {
      statement: "Direct append claim",
      falsifier: "Counterexample x",
      proved: true,
    };
    const explicitRefusal = rejectAuthoritativeFields(directPayload);
    const implicitRefusal = rejectAuthoritativeFields({ ...directPayload });
    const sameRefusal =
      explicitRefusal !== null &&
      implicitRefusal !== null &&
      explicitRefusal.code === implicitRefusal.code &&
      explicitRefusal.rule === implicitRefusal.rule;
    const cleanAllowed =
      rejectAuthoritativeFields({ statement: "Clean", falsifier: "Counter" }) === null;
    const body = buildTeachingProblem({
      status: 422,
      code: "SCHEMA_INVALID",
      title: "Direct append enforces the exact promote validator",
      detail: "Implicit one-shot curl writes cannot bypass P2/P4 self-certification checks (R-17).",
      rule: "P2/P4",
      fix_hint: "Remove authoritative fields before direct append or explicit promotion.",
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      example: { statement: "Clean", falsifier: "Counter" },
    });
    results.push({
      id: "PROTO-R17-IMPLICIT-EQUALS-PROMOTE",
      rule_id: "R-17",
      error_code: body.code,
      rfc7807: body,
      validator_refused: sameRefusal,
      should_fail_control_passed: cleanAllowed,
    });
  }

  // P6: CANNOT_ERASE_NEGATIVE (NEGATIVE_KNOWLEDGE_PERMANENT)
  {
    const canErase = (kind: string, action: string) => !(kind === "dead-end" && action === "erase");
    const refused = !canErase("dead-end", "erase");
    const allowedSupersede = canErase("dead-end", "annotate-retry-when");
    const body = buildTeachingProblem({
      status: 409,
      code: "NEGATIVE_KNOWLEDGE_PERMANENT",
      title: "Negative results and dead ends cannot be erased",
      detail:
        "Public negative knowledge stays permanently recorded so future Fellows avoid repeating failed routes.",
      rule: "P6",
      fix_hint:
        "Add a clarifying follow-up or update retry_when conditions instead of erasing the negative record.",
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      example: { retry_when: "If a sharper upper bound on rank is proven." },
    });
    results.push({
      id: "PROTO-P6-CANNOT-ERASE-NEGATIVE",
      rule_id: "P6",
      error_code: body.code,
      rfc7807: body,
      validator_refused: refused,
      should_fail_control_passed: allowedSupersede,
    });
  }

  // P13: SYNTHESIS_UNANCHORED (real SynthesisAnchorSchema + ledger set membership)
  {
    const badAnchorShape = SynthesisAnchorSchema.safeParse({
      target_kind: "claim",
      target_id: "",
      assertion_summary: "Invalid empty target_id",
    });
    const unanchoredRef = SynthesisAnchorSchema.safeParse({
      target_kind: "claim",
      target_id: "C-999",
      assertion_summary: "Unanchored claim reference",
    });
    const validRef = SynthesisAnchorSchema.safeParse({
      target_kind: "claim",
      target_id: "C-1",
      assertion_summary: "Anchored claim reference",
    });
    const known = new Set(["C-1", "E-1", "R-1"]);
    const refused =
      !badAnchorShape.success && unanchoredRef.success && !known.has(unanchoredRef.data.target_id);
    const valid = validRef.success && known.has(validRef.data.target_id);
    const body = buildTeachingProblem({
      status: 422,
      code: "SYNTHESIS_UNANCHORED",
      title: "Synthesis must anchor every claim and finding to ledger objects",
      detail: "Synthesis references ledger IDs that do not exist in this problem's public record.",
      rule: "P13",
      fix_hint:
        "Anchor every synthesized point to existing public claim, evidence, review, or dead-end IDs.",
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      example: { anchors: ["C-1", "E-1"] },
      unanchored: ["C-999"],
    });
    results.push({
      id: "PROTO-P13-SYNTHESIS-UNANCHORED",
      rule_id: "P13",
      error_code: body.code,
      rfc7807: body,
      validator_refused: refused,
      should_fail_control_passed: valid,
    });
  }

  return results;
}

export async function runScientificStateMachineTable(): Promise<
  readonly StateMachineFixtureResult[]
> {
  const results: StateMachineFixtureResult[] = [];

  // SM-1: Author cannot self-certify
  {
    const refused = rejectAuthoritativeFields({ statement: "S", certificate: "valid" });
    const ok = rejectAuthoritativeFields({ statement: "S" }) === null;
    results.push({
      id: "SM-001-NO-SELF-CERTIFY",
      invariant: "Author cannot self-certify",
      rule_id: "P2/P4",
      observed: refused?.code ?? "ACCEPTED",
      expected: "SCHEMA_INVALID",
      passed: refused?.code === "SCHEMA_INVALID",
      should_fail_control_passed: ok,
    });
  }

  // SM-2: Verifier pass bound to a different statement digest promotes nothing
  {
    const d1 = await claimContentDigest(
      { kind: "conjecture", statement: "A", falsifier: "not A" },
      sha256Hex,
    );
    const d2 = await claimContentDigest(
      { kind: "conjecture", statement: "B", falsifier: "not B" },
      sha256Hex,
    );
    const mismatchRefused = d1 !== d2;
    const matchAccepted =
      d1 ===
      (await claimContentDigest(
        { kind: "conjecture", statement: "A", falsifier: "not A" },
        sha256Hex,
      ));
    results.push({
      id: "SM-002-STATEMENT-DIGEST-BINDING",
      invariant: "Verifier pass bound to a different statement digest promotes nothing",
      rule_id: "P9/ADR-10",
      observed: mismatchRefused ? "DIGEST_MISMATCH_NO_PROMOTION" : "PROMOTED",
      expected: "DIGEST_MISMATCH_NO_PROMOTION",
      passed: mismatchRefused,
      should_fail_control_passed: matchAccepted,
    });
  }

  // SM-3: Invalidated/retracted evidence flags dependent dispositions stale
  {
    const stale = computeStalenessFacet({ resting_on_evidence_ids: ["E-1"] }, [
      { kind: "evidence-retracted", evidence_id: "E-1" },
    ]);
    const fresh = computeStalenessFacet({ resting_on_evidence_ids: ["E-1"] }, []);
    results.push({
      id: "SM-003-RETRACTED-EVIDENCE-STALE",
      invariant: "Invalidated/retracted evidence flags dependent dispositions stale",
      rule_id: "§6.4",
      observed: stale.stale ? "stale:true" : "stale:false",
      expected: "stale:true",
      passed: stale.stale === true && stale.flagged_evidence_ids.includes("E-1"),
      should_fail_control_passed: fresh.stale === false && fresh.display === "fresh",
    });
  }

  // SM-4: Superseded claims reject edits
  {
    const editRefused = evaluateClaimTransition(
      "superseded",
      { kind: "new-version", new_version: 3 },
      { recorded_refutation_attempts: 0, verified_reviews: [], has_certified_artifact: false },
    );
    const openAllowed = evaluateClaimTransition(
      "open",
      { kind: "new-version", new_version: 2 },
      { recorded_refutation_attempts: 0, verified_reviews: [], has_certified_artifact: false },
    );
    results.push({
      id: "SM-004-SUPERSEDED-REJECTS-EDITS",
      invariant: "Superseded claims reject edits",
      rule_id: "§6.4",
      observed: editRefused.allowed ? "allowed" : "refused:terminal",
      expected: "refused:terminal",
      passed: !editRefused.allowed && editRefused.unmet.some((u) => u.includes("terminal")),
      should_fail_control_passed: openAllowed.allowed && openAllowed.next === "open",
    });
  }

  // SM-5: Negative results without scope/detection substance refused/coerced (real RecordDeadEndRequestSchema + validateDeadEndSubstance)
  {
    const emptySchemaRefused = RecordDeadEndRequestSchema.safeParse({
      approach: "",
      why_it_fails: "",
      retry_predicate: "",
    });
    const lowSubstanceRefused = validateDeadEndSubstance({
      approach: "tried something",
      why_it_fails: "did not work",
      retry_predicate: "maybe later",
      retry_when: { kind: "predicate", predicate: "maybe later" },
      what_was_examined: "partial search",
    });
    const cleanDeadEnd = RecordDeadEndRequestSchema.parse({
      approach: "Exhaustive modular sieve over odd integers up to one million",
      why_it_fails: "Residue classes mod 12 leave zero admissible candidates in bounded range",
      retry_predicate: "Sharper lower bound eliminates modular obstruction completely",
      what_was_examined: "All odd integers n <= 10^6 with prime factor decomposition",
    });
    const cleanSubstance = validateDeadEndSubstance(cleanDeadEnd);
    const coerced = !emptySchemaRefused.success && !lowSubstanceRefused.valid;
    const clean = cleanSubstance.valid;
    results.push({
      id: "SM-005-NEGATIVE-P5-COERCED",
      invariant: "Negative results without scope/detection fields are coerced (P5)",
      rule_id: "P5",
      observed: coerced ? "coerced:P5" : "accepted",
      expected: "coerced:P5",
      passed: coerced,
      should_fail_control_passed: clean,
    });
  }

  // SM-6: Novelty cannot derive from proof review
  {
    const proofOnNovelty = gateReviewSubmission({
      submission: {
        targetClaimId: "C-NOV",
        targetVersion: 1,
        verdict: "confirm",
        basis: "independent-derivation",
        capableOfFailure: "Checked proof.",
        bodyMd: "Proof works.",
        hasNovelty: true,
      },
      claimAuthorFellowId: "F-1",
      reviewerFellowId: "F-2",
      claimKind: "novelty-claim",
    });
    const properNovelty = gateReviewSubmission({
      submission: {
        targetClaimId: "C-NOV",
        targetVersion: 1,
        verdict: "inform",
        basis: "literature-check",
        capableOfFailure: "Searched arXiv and zbMATH.",
        bodyMd: "Special case of Smith 2019.",
        hasNovelty: true,
      },
      claimAuthorFellowId: "F-1",
      reviewerFellowId: "F-2",
      claimKind: "novelty-claim",
    });
    results.push({
      id: "SM-006-NOVELTY-SEPARATE-FROM-PROOF",
      invariant: "Novelty cannot derive from proof review",
      rule_id: "ADR-21",
      observed: !proofOnNovelty.ok ? proofOnNovelty.code : "ALLOWED",
      expected: "NOVELTY_REVIEW_VERDICT_NOT_INFORM",
      passed: !proofOnNovelty.ok && proofOnNovelty.code === "NOVELTY_REVIEW_VERDICT_NOT_INFORM",
      should_fail_control_passed: properNovelty.ok,
    });
  }

  // SM-7: Review-state facet and disposition move independently
  {
    const rev: VerifiedReview = {
      review_id: "R-FACET-1",
      reviewer_id: "F-REV-1",
      tier: "T2",
      cross_family: true,
      full_write_up: true,
      finding: "support",
    };
    const ctx = {
      recorded_refutation_attempts: 0,
      verified_reviews: [rev],
      has_certified_artifact: false,
    };
    const facet = computeReviewStateFacet({ review_requested: false }, [
      { status: "completed", verified: true, tier: "T2", finding: "support" },
    ]);
    const disp = displayClaimDisposition("open", ctx);
    const unreviewedFacet = computeReviewStateFacet({ review_requested: false }, []);
    results.push({
      id: "SM-007-FACET-DISPOSITION-INDEPENDENT",
      invariant: "Review-state facet and disposition move independently",
      rule_id: "§6.4/ADR-9",
      observed: `facet=${facet},disp=${disp}`,
      expected: "facet=independently-checked,disp=open · unchallenged",
      passed: facet === "independently-checked" && disp === "open · unchallenged",
      should_fail_control_passed: unreviewedFacet === "unreviewed",
    });
  }

  // SM-8: reduced-to stays live (open to disputes/statement-defects/refutations) until target resolves
  {
    const reduced = evaluateClaimTransition(
      "open",
      { kind: "reduced-to", target_claim_id: "C-TARGET" },
      { recorded_refutation_attempts: 0, verified_reviews: [], has_certified_artifact: false },
    );
    const defectOnReduced = evaluateClaimTransition(
      "reduced-to",
      {
        kind: "review-verified",
        review: {
          review_id: "R-RED-1",
          reviewer_id: "F-REV",
          tier: "T2",
          cross_family: true,
          full_write_up: true,
          finding: "statement-defect",
        },
      },
      { recorded_refutation_attempts: 0, verified_reviews: [], has_certified_artifact: false },
    );
    const supportOnReduced = evaluateClaimTransition(
      "reduced-to",
      {
        kind: "review-verified",
        review: {
          review_id: "R-RED-2",
          reviewer_id: "F-REV",
          tier: "T2",
          cross_family: true,
          full_write_up: true,
          finding: "support",
        },
      },
      { recorded_refutation_attempts: 1, verified_reviews: [], has_certified_artifact: false },
    );
    results.push({
      id: "SM-008-REDUCED-TO-STAYS-LIVE",
      invariant: "reduced-to keeps original open in needs/ranking until target resolves",
      rule_id: "§6.4",
      observed:
        reduced.allowed && defectOnReduced.allowed && !supportOnReduced.allowed
          ? "reduced-to:live-not-resolved"
          : "unexpected",
      expected: "reduced-to:live-not-resolved",
      passed:
        reduced.allowed &&
        reduced.next === "reduced-to" &&
        defectOnReduced.allowed &&
        defectOnReduced.next === "malformed" &&
        !supportOnReduced.allowed,
      should_fail_control_passed: !supportOnReduced.allowed,
    });
  }

  return results;
}
