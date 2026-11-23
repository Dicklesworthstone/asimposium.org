/**
 * W9.3c Scientific-Integrity Cases, Neutral Notices, Minimization, and
 * Immutable Correction Linkage (`asimposiumorg-bum`, Fable §9.1 & §14.4).
 *
 * Core doctrine:
 *  - Scientific misconduct (fabricated citations/verifier output, plagiarism,
 *    model-string misrepresentation, coordinated review/calibration manipulation)
 *    is strictly separated from BOTH safety refusals AND ordinary scientific
 *    mistakes, weak science, unavailable sources, lawful quotation, false
 *    plagiarism matches, failed reproductions, and self-corrections.
 *  - No premature public accusation: open cases show only neutral, non-accusatory
 *    integrity notices and restricted files stay `private, no-store` + `noindex`.
 *  - No silent disposition override: NO integrity action can directly mint,
 *    overwrite, or refute a claim's computed scientific disposition.
 *  - Investigator & appellate conflict-of-interest checks fail closed.
 *  - Agents may draft responses/appeals, but ONLY the accountable human sponsor
 *    can submit them.
 *  - Unsubstantiated dismissals restore visibility and minimize restricted
 *    evidence to an audit-only digest; confirmed cases link immutable
 *    corrections/retractions and feed sponsor strikes only via separate review.
 *  - Every transition emits an OPS.2a redacted log through `prepareRedactedSinkEvent`
 *    never containing allegation/evidence bodies, PII, detector detail, or CoT.
 */

import { createHash } from "node:crypto";
import { prepareRedactedSinkEvent } from "../observability/telemetry.ts";

export const INTEGRITY_POLICY_VERSION = "integrity-policy-v1" as const;

export const INTEGRITY_ALLEGATION_CLASSES = [
  "fabricated-citation",
  "forged-verifier-output",
  "plagiarism",
  "identity-model-misrepresentation",
  "coordinated-review-manipulation",
] as const;
export type IntegrityAllegationClass = (typeof INTEGRITY_ALLEGATION_CLASSES)[number];

export const ORDINARY_SCIENCE_SIGNALS = [
  "honest-error",
  "weak-science",
  "unavailable-source",
  "citation-mistake",
  "lawful-quotation",
  "false-plagiarism-match",
  "honest-failed-reproduction",
  "self-correction",
  "statement-defect",
  "changed-conclusion",
] as const;
export type OrdinaryScienceSignal = (typeof ORDINARY_SCIENCE_SIGNALS)[number];

export type IntegrityIntakeSource = "report" | "screening-signal" | "operator-review";

export type IntegrityCaseState =
  | "intake"
  | "under-review"
  | "awaiting-response"
  | "confirmed"
  | "dismissed-unsubstantiated"
  | "appealed"
  | "appeal-upheld"
  | "appeal-overturned";

export interface IntegrityIntakeInput {
  readonly problem_id: string;
  readonly target_ref: string;
  readonly affected_fellow_id: string;
  readonly affected_sponsor_id: string;
  readonly intake_source: IntegrityIntakeSource;
  readonly reporter_sponsor_id: string | null;
  readonly proposed_class: IntegrityAllegationClass | null;
  readonly ordinary_science_signal: OrdinaryScienceSignal | null;
  /** Evidence of deliberate deception (distinct from honest error/unavailable locator). */
  readonly deception_indicators: readonly string[];
  readonly evidence_anchor: string;
  readonly restricted_evidence_body: string;
  readonly initial_action?: "none" | "neutral-notice" | "quarantine";
  readonly conflicted_actors?: readonly string[];
  readonly event_id?: string | null;
}

export interface IntegrityClassificationResult {
  readonly admissible: boolean;
  readonly code:
    | "INTEGRITY_INTAKE_ADMITTED"
    | "ORDINARY_SCIENCE_NOT_MISCONDUCT"
    | "INSUFFICIENT_DECEPTION_SIGNAL"
    | "INVALID_INTEGRITY_INTAKE";
  readonly allegation_class: IntegrityAllegationClass | null;
  readonly recommended_scientific_path: string | null;
  readonly reason: string;
}

export interface IntegrityCorrectionLink {
  readonly link_id: string;
  readonly kind: "retraction" | "correction" | "superseding-claim";
  readonly target_ref: string;
  readonly linked_object_ref: string;
  readonly event_id: string;
  readonly linked_at: string;
  readonly preserves_immutable_envelopes: true;
}

export interface SponsorStrikeHandoff {
  readonly case_id: string;
  readonly affected_sponsor_id: string;
  readonly coarse_class: IntegrityAllegationClass;
  readonly rationale_digest: string;
  readonly created_at: string;
  readonly requires_separate_strike_review: true;
  readonly auto_suspended: false;
}

export interface PublicIntegrityNotice {
  readonly case_id: string;
  readonly target_ref: string;
  readonly visible: boolean;
  readonly status_banner: "under-integrity-review" | "resolved-correction-linked" | "none";
  readonly text: string;
  readonly disposition_mutated: false;
  readonly linked_corrections: readonly {
    readonly kind: IntegrityCorrectionLink["kind"];
    readonly linked_object_ref: string;
    readonly event_id: string;
  }[];
}

export interface IntegrityCaseRecord {
  readonly case_id: string;
  readonly problem_id: string;
  readonly target_ref: string;
  readonly affected_fellow_id: string;
  readonly affected_sponsor_id: string;
  readonly intake_source: IntegrityIntakeSource;
  readonly reporter_sponsor_id: string | null;
  readonly allegation_class: IntegrityAllegationClass;
  readonly state: IntegrityCaseState;
  readonly visibility_action: "none" | "neutral-notice" | "quarantine" | "restored";
  readonly evidence_anchor: string;
  readonly evidence_digest: string;
  /** Restricted body is wiped to null on unsubstantiated dismissal (minimization). */
  readonly restricted_evidence_body: string | null;
  readonly minimized: boolean;
  readonly sponsor_notified_at: string;
  readonly sponsor_response_digest: string | null;
  readonly sponsor_response_submitted_by: string | null;
  readonly investigator_id: string | null;
  readonly conflicted_actors: readonly string[];
  readonly decided_by: string | null;
  readonly decided_at: string | null;
  readonly decision_rationale_digest: string | null;
  readonly appeal_submitted_by: string | null;
  readonly appeal_digest: string | null;
  readonly appeal_decided_by: string | null;
  readonly appeal_decided_at: string | null;
  readonly correction_links: readonly IntegrityCorrectionLink[];
  readonly strike_handoff: SponsorStrikeHandoff | null;
  readonly policy_version: typeof INTEGRITY_POLICY_VERSION;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface IntegrityActor {
  readonly principal_class: "fellow" | "sponsor" | "operator";
  readonly actor_id: string;
  readonly sponsor_id?: string | null;
}

export interface IntegrityOpsLogEvent {
  readonly facility: "OPS.2a";
  readonly stage: "integrity-case";
  readonly case_id: string;
  readonly action: string;
  readonly event_id: string | null;
  readonly coarse_class: IntegrityAllegationClass | "non-misconduct";
  readonly state: IntegrityCaseState | "refused";
  readonly policy_digest: string;
  readonly result: "ok" | "refused";
  readonly duration_ms: number;
}

const ACCUSATORY_PUBLIC_WORDS_RE =
  /\b(fraud|fraudulent|guilty|cheater|cheated|liar|fabricated|forged|plagiarized|misconduct\s+confirmed\s+before)\b/i;

const FORBIDDEN_DISPOSITION_OVERRIDE_KEYS = new Set([
  "override_disposition",
  "set_disposition",
  "force_disposition",
  "mint_disposition",
  "refute_by_fiat",
  "computed_disposition_override",
]);

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export const INTEGRITY_POLICY_DIGEST = sha256Hex(
  JSON.stringify({
    version: INTEGRITY_POLICY_VERSION,
    classes: INTEGRITY_ALLEGATION_CLASSES,
    non_misconduct: ORDINARY_SCIENCE_SIGNALS,
  }),
);

/**
 * Classifies an integrity-case intake strictly separating ordinary scientific
 * mistakes/disagreement from corroborated deception/misconduct indicators.
 */
export function classifyIntegrityIntake(
  input: IntegrityIntakeInput,
): IntegrityClassificationResult {
  if (!input.problem_id.trim() || !input.target_ref.trim() || !input.evidence_anchor.trim()) {
    return {
      admissible: false,
      code: "INVALID_INTEGRITY_INTAKE",
      allegation_class: null,
      recommended_scientific_path: null,
      reason: "Integrity intake requires problem_id, target_ref, and safe evidence_anchor.",
    };
  }

  // Ordinary scientific errors, weak proofs, unavailable links, lawful quotes,
  // false plagiarism matches, honest failed reproductions, and self-corrections
  // MUST NEVER enter the misconduct track.
  if (input.ordinary_science_signal !== null) {
    const pathMap: Record<OrdinaryScienceSignal, string> = {
      "honest-error": "post-review-or-retraction",
      "weak-science": "post-review-or-proof-gap",
      "unavailable-source": "flag-citation-locator-check",
      "citation-mistake": "post-citation-correction",
      "lawful-quotation": "no-action-lawful-citation",
      "false-plagiarism-match": "no-action-false-positive",
      "honest-failed-reproduction": "post-fails-to-reproduce-evidence",
      "self-correction": "record-self-corrected-retraction",
      "statement-defect": "propose-statement-revision",
      "changed-conclusion": "revise-or-retract-claim",
    };
    return {
      admissible: false,
      code: "ORDINARY_SCIENCE_NOT_MISCONDUCT",
      allegation_class: null,
      recommended_scientific_path: pathMap[input.ordinary_science_signal],
      reason: `Signal '${input.ordinary_science_signal}' belongs to the ordinary scientific record, not the misconduct track.`,
    };
  }

  if (
    input.proposed_class === null ||
    !INTEGRITY_ALLEGATION_CLASSES.includes(input.proposed_class)
  ) {
    return {
      admissible: false,
      code: "INVALID_INTEGRITY_INTAKE",
      allegation_class: null,
      recommended_scientific_path: null,
      reason: "Admissible integrity intake must name a typed allegation class.",
    };
  }

  const substantiveIndicators = input.deception_indicators.filter((s) => s.trim().length >= 8);
  if (substantiveIndicators.length === 0) {
    return {
      admissible: false,
      code: "INSUFFICIENT_DECEPTION_SIGNAL",
      allegation_class: null,
      recommended_scientific_path: "post-review-or-conflict",
      reason:
        "Integrity intake requires specific deception/fabrication evidence rather than bare disagreement.",
    };
  }

  return {
    admissible: true,
    code: "INTEGRITY_INTAKE_ADMITTED",
    allegation_class: input.proposed_class,
    recommended_scientific_path: null,
    reason: `Admitted under restricted visibility for typed integrity review (${input.proposed_class}).`,
  };
}

/**
 * Enforces structural impossibility of mutating or minting a scientific
 * disposition directly through any integrity-case action (recursively).
 */
export function assertNoDirectDispositionMutation(
  payload: unknown,
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (payload === null || typeof payload !== "object") return;
  if (seen.has(payload)) return;
  seen.add(payload);
  if (Array.isArray(payload)) {
    for (const item of payload) {
      assertNoDirectDispositionMutation(item, seen);
    }
    return;
  }
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (FORBIDDEN_DISPOSITION_OVERRIDE_KEYS.has(key.toLowerCase())) {
      throw new Error(
        `DIRECT_DISPOSITION_MUTATION_FORBIDDEN: integrity actions cannot set '${key}'; scientific dispositions remain computed solely from ledger events.`,
      );
    }
    assertNoDirectDispositionMutation(value, seen);
  }
}

function assertValidIsoTimestamp(nowIso: string): void {
  if (!Number.isFinite(Date.parse(nowIso))) {
    throw new RangeError("INVALID_INTEGRITY_TIMESTAMP");
  }
}

/**
 * Enforces restricted-visibility HTTP header policy on private integrity case
 * files (`private, no-store` + `X-Robots-Tag: noindex, nofollow`).
 */
export function assertRestrictedIntegrityHeaders(headers: Readonly<Record<string, string>>): {
  readonly ok: boolean;
  readonly violations: readonly string[];
} {
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(headers)) {
    lower.set(k.toLowerCase(), v);
  }
  const violations: string[] = [];
  const cc = lower.get("cache-control") ?? "";
  if (!/\bprivate\b/i.test(cc) || !/\bno-store\b/i.test(cc)) {
    violations.push("RESTRICTED_CASE_MISSING_PRIVATE_NO_STORE");
  }
  if (/\b(public|s-maxage)\b/i.test(cc)) {
    violations.push("RESTRICTED_CASE_PUBLIC_CACHE_FORBIDDEN");
  }
  const robots = lower.get("x-robots-tag") ?? "";
  if (!/\bnoindex\b/i.test(robots)) {
    violations.push("RESTRICTED_CASE_MISSING_NOINDEX");
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Produces the public-safe integrity notice for a case. Guarantees:
 *  - Neutral, non-accusatory language while under review/appeal.
 *  - Zero public notice after unsubstantiated dismissal or appeal overturn.
 *  - Discoverable correction/retraction linkage after confirmed resolution.
 *  - Never alters the claim's computed scientific disposition.
 */
export function buildPublicIntegrityNotice(record: IntegrityCaseRecord): PublicIntegrityNotice {
  const publicLinks = record.correction_links.map((link) => ({
    kind: link.kind,
    linked_object_ref: link.linked_object_ref,
    event_id: link.event_id,
  }));

  if (record.state === "dismissed-unsubstantiated" || record.state === "appeal-overturned") {
    return {
      case_id: record.case_id,
      target_ref: record.target_ref,
      visible: false,
      status_banner: "none",
      text: "",
      disposition_mutated: false,
      linked_corrections: publicLinks,
    };
  }

  if (record.state === "confirmed" || record.state === "appeal-upheld") {
    const notice: PublicIntegrityNotice = {
      case_id: record.case_id,
      target_ref: record.target_ref,
      visible: true,
      status_banner: "resolved-correction-linked",
      text:
        publicLinks.length > 0
          ? "Integrity review completed; linked correction or retraction records remain attached to this immutable entry without altering ledger history."
          : "Integrity review completed; see the public moderation log for coarse resolution category. Ledger history remains immutable.",
      disposition_mutated: false,
      linked_corrections: publicLinks,
    };
    return notice;
  }

  const showNeutral =
    record.visibility_action === "neutral-notice" || record.visibility_action === "quarantine";
  const text = showNeutral
    ? "Under integrity review. This neutral notice is not a finding of misconduct and does not alter the computed scientific disposition."
    : "";

  if (ACCUSATORY_PUBLIC_WORDS_RE.test(text)) {
    throw new Error("PREMATURE_ACCUSATION_FORBIDDEN");
  }

  return {
    case_id: record.case_id,
    target_ref: record.target_ref,
    visible: showNeutral,
    status_banner: showNeutral ? "under-integrity-review" : "none",
    text,
    disposition_mutated: false,
    linked_corrections: publicLinks,
  };
}

/**
 * In-memory / transactional W9.3c Scientific-Integrity Case engine enforcing
 * intake separation, conflict-of-interest checks, human-only sponsor response &
 * appeal, immutable correction linkage, minimization on dismissal, separately
 * reasoned strike handoff, and OPS.2a redacted telemetry.
 */
export class IntegrityCaseLedger {
  private readonly cases = new Map<string, IntegrityCaseRecord>();
  private readonly opsLogs: IntegrityOpsLogEvent[] = [];
  private seq = 0;

  private emitOpsLog(input: {
    readonly case_id: string;
    readonly action: string;
    readonly event_id: string | null;
    readonly coarse_class: IntegrityAllegationClass | "non-misconduct";
    readonly state: IntegrityCaseState | "refused";
    readonly result: "ok" | "refused";
    readonly duration_ms: number;
  }): void {
    const { payload } = prepareRedactedSinkEvent("ops2a", {
      facility: "OPS.2a",
      stage: "integrity-case",
      case_id: input.case_id,
      action: input.action,
      event_id: input.event_id,
      coarse_class: input.coarse_class,
      state: input.state,
      policy_digest: INTEGRITY_POLICY_DIGEST,
      result: input.result,
      duration_ms: Math.max(0, Math.round(input.duration_ms)),
    });
    this.opsLogs.push(payload as unknown as IntegrityOpsLogEvent);
  }

  getOpsLogs(): readonly IntegrityOpsLogEvent[] {
    return this.opsLogs;
  }

  getCase(caseId: string): IntegrityCaseRecord | null {
    return this.cases.get(caseId) ?? null;
  }

  /** Only the operator/investigator or the affected sponsor (never public/unrelated sponsors) may inspect restricted details. */
  readRestrictedCase(caseId: string, viewer: IntegrityActor): IntegrityCaseRecord {
    const existing = this.cases.get(caseId);
    if (!existing) {
      throw new Error("INTEGRITY_CASE_NOT_FOUND");
    }
    if (viewer.principal_class === "operator") {
      return existing;
    }
    if (
      viewer.principal_class === "sponsor" &&
      viewer.sponsor_id === existing.affected_sponsor_id
    ) {
      // Affected sponsor sees neutral explanation & anchor, never reporter identity.
      return {
        ...existing,
        reporter_sponsor_id: null,
      };
    }
    throw new Error("INTEGRITY_CASE_RESTRICTED_FORBIDDEN");
  }

  openCase(
    input: IntegrityIntakeInput,
    nowIso: string = new Date().toISOString(),
  ): {
    readonly classification: IntegrityClassificationResult;
    readonly record: IntegrityCaseRecord | null;
  } {
    const started = Date.now();
    assertValidIsoTimestamp(nowIso);
    assertNoDirectDispositionMutation(input);
    const classification = classifyIntegrityIntake(input);
    if (!classification.admissible || classification.allegation_class === null) {
      this.emitOpsLog({
        case_id: "IC-REFUSED",
        action: "intake",
        event_id: input.event_id ?? null,
        coarse_class: "non-misconduct",
        state: "refused",
        result: "refused",
        duration_ms: Date.now() - started,
      });
      return { classification, record: null };
    }

    this.seq += 1;
    const caseId = `IC-${String(this.seq).padStart(6, "0")}`;
    const initialAction = input.initial_action ?? "neutral-notice";
    const record: IntegrityCaseRecord = {
      case_id: caseId,
      problem_id: input.problem_id,
      target_ref: input.target_ref,
      affected_fellow_id: input.affected_fellow_id,
      affected_sponsor_id: input.affected_sponsor_id,
      intake_source: input.intake_source,
      reporter_sponsor_id: input.reporter_sponsor_id,
      allegation_class: classification.allegation_class,
      state: "intake",
      visibility_action: initialAction,
      evidence_anchor: input.evidence_anchor,
      evidence_digest: sha256Hex(input.restricted_evidence_body),
      restricted_evidence_body: input.restricted_evidence_body,
      minimized: false,
      sponsor_notified_at: nowIso,
      sponsor_response_digest: null,
      sponsor_response_submitted_by: null,
      investigator_id: null,
      conflicted_actors: [...(input.conflicted_actors ?? [])],
      decided_by: null,
      decided_at: null,
      decision_rationale_digest: null,
      appeal_submitted_by: null,
      appeal_digest: null,
      appeal_decided_by: null,
      appeal_decided_at: null,
      correction_links: [],
      strike_handoff: null,
      policy_version: INTEGRITY_POLICY_VERSION,
      created_at: nowIso,
      updated_at: nowIso,
    };
    this.cases.set(caseId, record);
    this.emitOpsLog({
      case_id: caseId,
      action: "intake",
      event_id: input.event_id ?? null,
      coarse_class: record.allegation_class,
      state: record.state,
      result: "ok",
      duration_ms: Date.now() - started,
    });
    return { classification, record };
  }

  assignInvestigator(
    caseId: string,
    operator: IntegrityActor,
    nowIso: string = new Date().toISOString(),
  ): IntegrityCaseRecord {
    const started = Date.now();
    const existing = this.cases.get(caseId);
    if (!existing) throw new Error("INTEGRITY_CASE_NOT_FOUND");
    if (operator.principal_class !== "operator") {
      throw new Error("OPERATOR_REQUIRED_FOR_INVESTIGATION");
    }
    if (
      operator.actor_id === existing.affected_sponsor_id ||
      operator.actor_id === existing.reporter_sponsor_id ||
      existing.conflicted_actors.includes(operator.actor_id)
    ) {
      this.emitOpsLog({
        case_id: caseId,
        action: "assign-investigator",
        event_id: null,
        coarse_class: existing.allegation_class,
        state: existing.state,
        result: "refused",
        duration_ms: Date.now() - started,
      });
      throw new Error("INVESTIGATOR_CONFLICT_OF_INTEREST");
    }

    const updated: IntegrityCaseRecord = {
      ...existing,
      investigator_id: operator.actor_id,
      state: "awaiting-response",
      updated_at: nowIso,
    };
    this.cases.set(caseId, updated);
    this.emitOpsLog({
      case_id: caseId,
      action: "assign-investigator",
      event_id: null,
      coarse_class: updated.allegation_class,
      state: updated.state,
      result: "ok",
      duration_ms: Date.now() - started,
    });
    return updated;
  }

  submitSponsorResponse(
    caseId: string,
    actor: IntegrityActor,
    responseText: string,
    nowIso: string = new Date().toISOString(),
  ): IntegrityCaseRecord {
    const started = Date.now();
    const existing = this.cases.get(caseId);
    if (!existing) throw new Error("INTEGRITY_CASE_NOT_FOUND");
    if (actor.principal_class !== "sponsor") {
      throw new Error("HUMAN_SPONSOR_REQUIRED_FOR_RESPONSE");
    }
    if (actor.sponsor_id !== existing.affected_sponsor_id) {
      throw new Error("WRONG_SPONSOR_FOR_INTEGRITY_RESPONSE");
    }
    if (responseText.trim().length < 10) {
      throw new Error("INTEGRITY_RESPONSE_TOO_SHORT");
    }
    if (!["intake", "under-review", "awaiting-response"].includes(existing.state)) {
      throw new Error("INTEGRITY_CASE_NOT_ACCEPTING_RESPONSE");
    }

    const updated: IntegrityCaseRecord = {
      ...existing,
      state: "under-review",
      sponsor_response_digest: sha256Hex(responseText),
      sponsor_response_submitted_by: actor.actor_id,
      updated_at: nowIso,
    };
    this.cases.set(caseId, updated);
    this.emitOpsLog({
      case_id: caseId,
      action: "sponsor-response",
      event_id: null,
      coarse_class: updated.allegation_class,
      state: updated.state,
      result: "ok",
      duration_ms: Date.now() - started,
    });
    return updated;
  }

  linkScientificCorrection(
    caseId: string,
    input: {
      readonly kind: IntegrityCorrectionLink["kind"];
      readonly linked_object_ref: string;
      readonly event_id: string;
    },
    nowIso: string = new Date().toISOString(),
  ): IntegrityCaseRecord {
    const started = Date.now();
    const existing = this.cases.get(caseId);
    if (!existing) throw new Error("INTEGRITY_CASE_NOT_FOUND");
    assertValidIsoTimestamp(nowIso);
    assertNoDirectDispositionMutation(input);
    if (!input.linked_object_ref.trim() || !input.event_id.trim()) {
      throw new Error("INVALID_CORRECTION_LINK");
    }
    if (existing.correction_links.some((l) => l.event_id === input.event_id)) {
      throw new Error("DUPLICATE_CORRECTION_LINK_EVENT");
    }
    const link: IntegrityCorrectionLink = {
      link_id: `CL-${existing.correction_links.length + 1}`,
      kind: input.kind,
      target_ref: existing.target_ref,
      linked_object_ref: input.linked_object_ref,
      event_id: input.event_id,
      linked_at: nowIso,
      preserves_immutable_envelopes: true,
    };
    const updated: IntegrityCaseRecord = {
      ...existing,
      correction_links: [...existing.correction_links, link],
      updated_at: nowIso,
    };
    this.cases.set(caseId, updated);
    this.emitOpsLog({
      case_id: caseId,
      action: "link-correction",
      event_id: input.event_id,
      coarse_class: updated.allegation_class,
      state: updated.state,
      result: "ok",
      duration_ms: Date.now() - started,
    });
    return updated;
  }

  resolveCase(
    caseId: string,
    operator: IntegrityActor,
    decision: {
      readonly outcome: "confirmed" | "dismissed-unsubstantiated";
      readonly rationale: string;
      readonly recommend_strike_review?: boolean;
      readonly event_id?: string | null;
    },
    nowIso: string = new Date().toISOString(),
  ): IntegrityCaseRecord {
    const started = Date.now();
    const existing = this.cases.get(caseId);
    if (!existing) throw new Error("INTEGRITY_CASE_NOT_FOUND");
    assertNoDirectDispositionMutation(decision as unknown as Record<string, unknown>);
    if (operator.principal_class !== "operator") {
      throw new Error("OPERATOR_REQUIRED_FOR_DECISION");
    }
    if (
      operator.actor_id === existing.affected_sponsor_id ||
      operator.actor_id === existing.reporter_sponsor_id ||
      existing.conflicted_actors.includes(operator.actor_id)
    ) {
      throw new Error("INVESTIGATOR_CONFLICT_OF_INTEREST");
    }
    if (decision.rationale.trim().length < 20) {
      throw new Error("INTEGRITY_DECISION_RATIONALE_TOO_SHORT");
    }
    if (!["intake", "under-review", "awaiting-response"].includes(existing.state)) {
      throw new Error("INTEGRITY_CASE_ALREADY_DECIDED");
    }

    const rationaleDigest = sha256Hex(decision.rationale);
    if (decision.outcome === "dismissed-unsubstantiated") {
      // Unsubstantiated: restore content and minimize restricted evidence body to audit digest only.
      const minimized: IntegrityCaseRecord = {
        ...existing,
        state: "dismissed-unsubstantiated",
        visibility_action: "restored",
        restricted_evidence_body: null,
        minimized: true,
        decided_by: operator.actor_id,
        decided_at: nowIso,
        decision_rationale_digest: rationaleDigest,
        strike_handoff: null,
        updated_at: nowIso,
      };
      this.cases.set(caseId, minimized);
      this.emitOpsLog({
        case_id: caseId,
        action: "resolve-dismissed",
        event_id: decision.event_id ?? null,
        coarse_class: minimized.allegation_class,
        state: minimized.state,
        result: "ok",
        duration_ms: Date.now() - started,
      });
      return minimized;
    }

    const strikeHandoff: SponsorStrikeHandoff | null = decision.recommend_strike_review
      ? {
          case_id: caseId,
          affected_sponsor_id: existing.affected_sponsor_id,
          coarse_class: existing.allegation_class,
          rationale_digest: rationaleDigest,
          created_at: nowIso,
          requires_separate_strike_review: true,
          auto_suspended: false,
        }
      : null;

    const confirmed: IntegrityCaseRecord = {
      ...existing,
      state: "confirmed",
      decided_by: operator.actor_id,
      decided_at: nowIso,
      decision_rationale_digest: rationaleDigest,
      strike_handoff: strikeHandoff,
      updated_at: nowIso,
    };
    this.cases.set(caseId, confirmed);
    this.emitOpsLog({
      case_id: caseId,
      action: "resolve-confirmed",
      event_id: decision.event_id ?? null,
      coarse_class: confirmed.allegation_class,
      state: confirmed.state,
      result: "ok",
      duration_ms: Date.now() - started,
    });
    return confirmed;
  }

  submitAppeal(
    caseId: string,
    actor: IntegrityActor,
    statement: string,
    nowIso: string = new Date().toISOString(),
  ): IntegrityCaseRecord {
    const started = Date.now();
    const existing = this.cases.get(caseId);
    if (!existing) throw new Error("INTEGRITY_CASE_NOT_FOUND");
    if (actor.principal_class !== "sponsor") {
      throw new Error("HUMAN_SPONSOR_REQUIRED_FOR_APPEAL");
    }
    if (actor.sponsor_id !== existing.affected_sponsor_id) {
      throw new Error("WRONG_SPONSOR_FOR_INTEGRITY_APPEAL");
    }
    if (existing.state !== "confirmed") {
      throw new Error("INTEGRITY_APPEAL_REQUIRES_CONFIRMED_CASE");
    }
    if (statement.trim().length < 20) {
      throw new Error("INTEGRITY_APPEAL_STATEMENT_TOO_SHORT");
    }

    const updated: IntegrityCaseRecord = {
      ...existing,
      state: "appealed",
      appeal_submitted_by: actor.actor_id,
      appeal_digest: sha256Hex(statement),
      updated_at: nowIso,
    };
    this.cases.set(caseId, updated);
    this.emitOpsLog({
      case_id: caseId,
      action: "appeal-submitted",
      event_id: null,
      coarse_class: updated.allegation_class,
      state: updated.state,
      result: "ok",
      duration_ms: Date.now() - started,
    });
    return updated;
  }

  decideAppeal(
    caseId: string,
    appellateOperator: IntegrityActor,
    decision: {
      readonly outcome: "appeal-upheld" | "appeal-overturned";
      readonly rationale: string;
    },
    nowIso: string = new Date().toISOString(),
  ): IntegrityCaseRecord {
    const started = Date.now();
    const existing = this.cases.get(caseId);
    if (!existing) throw new Error("INTEGRITY_CASE_NOT_FOUND");
    assertNoDirectDispositionMutation(decision as unknown as Record<string, unknown>);
    if (appellateOperator.principal_class !== "operator") {
      throw new Error("OPERATOR_REQUIRED_FOR_APPEAL_DECISION");
    }
    if (existing.state !== "appealed") {
      throw new Error("INTEGRITY_CASE_NOT_APPEALED");
    }
    // Appellate reviewer MUST be independent of the initial decision-maker, investigator, sponsor, and reporter.
    if (
      appellateOperator.actor_id === existing.decided_by ||
      appellateOperator.actor_id === existing.investigator_id ||
      appellateOperator.actor_id === existing.affected_sponsor_id ||
      appellateOperator.actor_id === existing.reporter_sponsor_id ||
      existing.conflicted_actors.includes(appellateOperator.actor_id)
    ) {
      throw new Error("APPELLATE_CONFLICT_OF_INTEREST");
    }
    if (decision.rationale.trim().length < 20) {
      throw new Error("INTEGRITY_DECISION_RATIONALE_TOO_SHORT");
    }

    const overturned = decision.outcome === "appeal-overturned";
    const updated: IntegrityCaseRecord = {
      ...existing,
      state: decision.outcome,
      visibility_action: overturned ? "restored" : existing.visibility_action,
      restricted_evidence_body: overturned ? null : existing.restricted_evidence_body,
      minimized: overturned ? true : existing.minimized,
      strike_handoff: overturned ? null : existing.strike_handoff,
      appeal_decided_by: appellateOperator.actor_id,
      appeal_decided_at: nowIso,
      updated_at: nowIso,
    };
    this.cases.set(caseId, updated);
    this.emitOpsLog({
      case_id: caseId,
      action: overturned ? "appeal-overturned" : "appeal-upheld",
      event_id: null,
      coarse_class: updated.allegation_class,
      state: updated.state,
      result: "ok",
      duration_ms: Date.now() - started,
    });
    return updated;
  }
}
