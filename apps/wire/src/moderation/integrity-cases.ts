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
export interface IntegrityD1PreparedStatement {
  bind(...values: unknown[]): IntegrityD1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ readonly results?: T[] }>;
  run(): Promise<{ readonly success?: boolean; readonly meta?: { readonly changes?: number } }>;
}

export interface IntegrityD1Database {
  prepare(query: string): IntegrityD1PreparedStatement;
}

const PUBLIC_LEDGER_REF_RE =
  /^(?:C-[0-9]+(?:@[1-9][0-9]{0,8})?|(?:R|E|H|G|L|DE|Q|CF|SYNTH)-[A-Za-z0-9-]{1,78})$/;
const SAFE_EVENT_ID_RE = /^[A-Za-z0-9._-]{4,64}$/;

function assertNonEmptyActor(actor: IntegrityActor): void {
  if (!actor.actor_id || actor.actor_id.trim().length === 0) {
    throw new Error("INTEGRITY_ACTOR_ID_REQUIRED");
  }
}

export function classifyIntegrityIntake(
  input: IntegrityIntakeInput,
): IntegrityClassificationResult {
  if (
    !input.problem_id.trim() ||
    !input.target_ref.trim() ||
    !input.evidence_anchor.trim() ||
    !input.affected_fellow_id.trim() ||
    !input.affected_sponsor_id.trim() ||
    !input.restricted_evidence_body.trim()
  ) {
    return {
      admissible: false,
      code: "INVALID_INTEGRITY_INTAKE",
      allegation_class: null,
      recommended_scientific_path: null,
      reason:
        "Integrity intake requires problem_id, target_ref, affected_fellow_id, affected_sponsor_id, safe evidence_anchor, and restricted_evidence_body.",
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

  /** Only an unconflicted operator/investigator or the affected sponsor (never public/unrelated sponsors) may inspect restricted details. */
  readRestrictedCase(caseId: string, viewer: IntegrityActor): IntegrityCaseRecord {
    assertNonEmptyActor(viewer);
    const existing = this.cases.get(caseId);
    if (!existing) {
      throw new Error("INTEGRITY_CASE_NOT_FOUND");
    }
    if (viewer.principal_class === "operator") {
      if (
        viewer.actor_id === existing.affected_sponsor_id ||
        existing.conflicted_actors.includes(viewer.actor_id)
      ) {
        throw new Error("INVESTIGATOR_CONFLICT_OF_INTEREST");
      }
      return existing;
    }
    if (
      viewer.principal_class === "sponsor" &&
      viewer.sponsor_id === existing.affected_sponsor_id
    ) {
      // Affected sponsor receives neutral status & safe evidence anchor/digest only —
      // NEVER reporter identity or raw restricted evidence body.
      return {
        ...existing,
        reporter_sponsor_id: null,
        restricted_evidence_body: null,
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
    assertValidIsoTimestamp(nowIso);
    assertNonEmptyActor(operator);
    const existing = this.cases.get(caseId);
    if (!existing) throw new Error("INTEGRITY_CASE_NOT_FOUND");
    if (operator.principal_class !== "operator") {
      throw new Error("OPERATOR_REQUIRED_FOR_INVESTIGATION");
    }
    if (!["intake", "under-review", "awaiting-response"].includes(existing.state)) {
      throw new Error("INTEGRITY_CASE_ALREADY_DECIDED");
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
    assertValidIsoTimestamp(nowIso);
    assertNonEmptyActor(actor);
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
    if (
      !PUBLIC_LEDGER_REF_RE.test(input.linked_object_ref) ||
      !SAFE_EVENT_ID_RE.test(input.event_id)
    ) {
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
    assertValidIsoTimestamp(nowIso);
    assertNonEmptyActor(operator);
    const existing = this.cases.get(caseId);
    if (!existing) throw new Error("INTEGRITY_CASE_NOT_FOUND");
    assertNoDirectDispositionMutation(decision);
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
    assertValidIsoTimestamp(nowIso);
    assertNonEmptyActor(actor);
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
    assertValidIsoTimestamp(nowIso);
    assertNonEmptyActor(appellateOperator);
    const existing = this.cases.get(caseId);
    if (!existing) throw new Error("INTEGRITY_CASE_NOT_FOUND");
    assertNoDirectDispositionMutation(decision);
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

interface RawIntegrityCaseRow {
  case_id: string;
  problem_id: string;
  target_ref: string;
  affected_fellow_id: string;
  affected_sponsor_id: string;
  intake_source: IntegrityIntakeSource;
  reporter_sponsor_id: string | null;
  allegation_class: IntegrityAllegationClass;
  state: IntegrityCaseState;
  visibility_action: IntegrityCaseRecord["visibility_action"];
  evidence_anchor: string;
  evidence_digest: string;
  restricted_evidence_body: string | null;
  minimized: number;
  sponsor_notified_at: string;
  sponsor_response_digest: string | null;
  sponsor_response_submitted_by: string | null;
  investigator_id: string | null;
  conflicted_actors_json: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_rationale_digest: string | null;
  appeal_submitted_by: string | null;
  appeal_digest: string | null;
  appeal_decided_by: string | null;
  appeal_decided_at: string | null;
  strike_handoff_json: string | null;
  policy_version: typeof INTEGRITY_POLICY_VERSION;
  created_at: string;
  updated_at: string;
}

interface RawCorrectionLinkRow {
  link_id: string;
  kind: IntegrityCorrectionLink["kind"];
  target_ref: string;
  linked_object_ref: string;
  event_id: string;
  linked_at: string;
}

/**
 * Real Cloudflare D1 transactional store for W9.3c Scientific-Integrity Cases.
 * Uses conditional SQL state guards (`WHERE case_id = ? AND state IN (...)`)
 * checking `meta.changes === 1` so racing operators/appeals fail closed with
 * `INTEGRITY_CASE_CONCURRENT_CONFLICT` and never double-decide or leak data.
 */
export class D1IntegrityCaseStore {
  private readonly db: IntegrityD1Database;
  private readonly opsLogs: IntegrityOpsLogEvent[] = [];

  constructor(db: IntegrityD1Database) {
    this.db = db;
  }

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

  async ensureSchema(): Promise<void> {
    await this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS scientific_integrity_cases (
          case_id TEXT PRIMARY KEY CHECK (case_id GLOB 'IC-*'),
          problem_id TEXT NOT NULL REFERENCES problems(id),
          target_ref TEXT NOT NULL,
          affected_fellow_id TEXT NOT NULL,
          affected_sponsor_id TEXT NOT NULL,
          intake_source TEXT NOT NULL CHECK (intake_source IN ('report', 'screening-signal', 'operator-review')),
          reporter_sponsor_id TEXT,
          allegation_class TEXT NOT NULL CHECK (allegation_class IN (
            'fabricated-citation', 'forged-verifier-output', 'plagiarism',
            'identity-model-misrepresentation', 'coordinated-review-manipulation'
          )),
          state TEXT NOT NULL CHECK (state IN (
            'intake', 'under-review', 'awaiting-response', 'confirmed',
            'dismissed-unsubstantiated', 'appealed', 'appeal-upheld', 'appeal-overturned'
          )),
          visibility_action TEXT NOT NULL CHECK (visibility_action IN ('none', 'neutral-notice', 'quarantine', 'restored')),
          evidence_anchor TEXT NOT NULL,
          evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
          restricted_evidence_body TEXT,
          minimized INTEGER NOT NULL DEFAULT 0 CHECK (minimized IN (0, 1)),
          sponsor_notified_at TEXT NOT NULL,
          sponsor_response_digest TEXT,
          sponsor_response_submitted_by TEXT,
          investigator_id TEXT,
          conflicted_actors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(conflicted_actors_json)),
          decided_by TEXT,
          decided_at TEXT,
          decision_rationale_digest TEXT,
          appeal_submitted_by TEXT,
          appeal_digest TEXT,
          appeal_decided_by TEXT,
          appeal_decided_at TEXT,
          strike_handoff_json TEXT CHECK (strike_handoff_json IS NULL OR json_valid(strike_handoff_json)),
          policy_version TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
      )
      .run();

    await this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS scientific_integrity_correction_links (
          case_id TEXT NOT NULL REFERENCES scientific_integrity_cases(case_id),
          link_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('retraction', 'correction', 'superseding-claim')),
          target_ref TEXT NOT NULL,
          linked_object_ref TEXT NOT NULL,
          event_id TEXT NOT NULL,
          linked_at TEXT NOT NULL,
          PRIMARY KEY (case_id, link_id),
          UNIQUE (case_id, event_id)
        )`,
      )
      .run();
  }

  private async hydrate(row: RawIntegrityCaseRow): Promise<IntegrityCaseRecord> {
    const linkRows = await this.db
      .prepare(
        `SELECT link_id, kind, target_ref, linked_object_ref, event_id, linked_at
         FROM scientific_integrity_correction_links
         WHERE case_id = ?
         ORDER BY link_id ASC`,
      )
      .bind(row.case_id)
      .all<RawCorrectionLinkRow>();
    const correctionLinks: IntegrityCorrectionLink[] = (linkRows.results ?? []).map((l) => ({
      link_id: l.link_id,
      kind: l.kind,
      target_ref: l.target_ref,
      linked_object_ref: l.linked_object_ref,
      event_id: l.event_id,
      linked_at: l.linked_at,
      preserves_immutable_envelopes: true,
    }));
    return {
      case_id: row.case_id,
      problem_id: row.problem_id,
      target_ref: row.target_ref,
      affected_fellow_id: row.affected_fellow_id,
      affected_sponsor_id: row.affected_sponsor_id,
      intake_source: row.intake_source,
      reporter_sponsor_id: row.reporter_sponsor_id,
      allegation_class: row.allegation_class,
      state: row.state,
      visibility_action: row.visibility_action,
      evidence_anchor: row.evidence_anchor,
      evidence_digest: row.evidence_digest,
      restricted_evidence_body: row.restricted_evidence_body,
      minimized: row.minimized !== 0,
      sponsor_notified_at: row.sponsor_notified_at,
      sponsor_response_digest: row.sponsor_response_digest,
      sponsor_response_submitted_by: row.sponsor_response_submitted_by,
      investigator_id: row.investigator_id,
      conflicted_actors: JSON.parse(row.conflicted_actors_json) as string[],
      decided_by: row.decided_by,
      decided_at: row.decided_at,
      decision_rationale_digest: row.decision_rationale_digest,
      appeal_submitted_by: row.appeal_submitted_by,
      appeal_digest: row.appeal_digest,
      appeal_decided_by: row.appeal_decided_by,
      appeal_decided_at: row.appeal_decided_at,
      correction_links: correctionLinks,
      strike_handoff: row.strike_handoff_json
        ? (JSON.parse(row.strike_handoff_json) as SponsorStrikeHandoff)
        : null,
      policy_version: row.policy_version,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async getCase(caseId: string): Promise<IntegrityCaseRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM scientific_integrity_cases WHERE case_id = ?")
      .bind(caseId)
      .first<RawIntegrityCaseRow>();
    if (!row) return null;
    return this.hydrate(row);
  }

  async readRestrictedCase(caseId: string, viewer: IntegrityActor): Promise<IntegrityCaseRecord> {
    assertNonEmptyActor(viewer);
    const existing = await this.getCase(caseId);
    if (!existing) throw new Error("INTEGRITY_CASE_NOT_FOUND");
    if (viewer.principal_class === "operator") {
      if (
        viewer.actor_id === existing.affected_sponsor_id ||
        existing.conflicted_actors.includes(viewer.actor_id)
      ) {
        throw new Error("INVESTIGATOR_CONFLICT_OF_INTEREST");
      }
      return existing;
    }
    if (
      viewer.principal_class === "sponsor" &&
      viewer.sponsor_id === existing.affected_sponsor_id
    ) {
      return {
        ...existing,
        reporter_sponsor_id: null,
        restricted_evidence_body: null,
      };
    }
    throw new Error("INTEGRITY_CASE_RESTRICTED_FORBIDDEN");
  }

  async openCase(
    input: IntegrityIntakeInput,
    nowIso: string = new Date().toISOString(),
  ): Promise<{
    readonly classification: IntegrityClassificationResult;
    readonly record: IntegrityCaseRecord | null;
  }> {
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

    const caseId = `IC-${crypto.randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`;
    const initialAction = input.initial_action ?? "neutral-notice";
    const evidenceDigest = sha256Hex(input.restricted_evidence_body);
    const conflictedJson = JSON.stringify([...(input.conflicted_actors ?? [])]);

    await this.db
      .prepare(
        `INSERT INTO scientific_integrity_cases (
          case_id, problem_id, target_ref, affected_fellow_id, affected_sponsor_id,
          intake_source, reporter_sponsor_id, allegation_class, state, visibility_action,
          evidence_anchor, evidence_digest, restricted_evidence_body, minimized,
          sponsor_notified_at, conflicted_actors_json, policy_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'intake', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      )
      .bind(
        caseId,
        input.problem_id,
        input.target_ref,
        input.affected_fellow_id,
        input.affected_sponsor_id,
        input.intake_source,
        input.reporter_sponsor_id,
        classification.allegation_class,
        initialAction,
        input.evidence_anchor,
        evidenceDigest,
        input.restricted_evidence_body,
        nowIso,
        conflictedJson,
        INTEGRITY_POLICY_VERSION,
        nowIso,
        nowIso,
      )
      .run();

    const record = await this.getCase(caseId);
    if (!record) throw new Error("INTEGRITY_CASE_PERSIST_FAILED");
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

  async assignInvestigator(
    caseId: string,
    operator: IntegrityActor,
    nowIso: string = new Date().toISOString(),
  ): Promise<IntegrityCaseRecord> {
    const started = Date.now();
    assertValidIsoTimestamp(nowIso);
    assertNonEmptyActor(operator);
    const existing = await this.getCase(caseId);
    if (!existing) throw new Error("INTEGRITY_CASE_NOT_FOUND");
    if (operator.principal_class !== "operator") {
      throw new Error("OPERATOR_REQUIRED_FOR_INVESTIGATION");
    }
    if (!["intake", "under-review", "awaiting-response"].includes(existing.state)) {
      throw new Error("INTEGRITY_CASE_ALREADY_DECIDED");
    }
    if (
      operator.actor_id === existing.affected_sponsor_id ||
      operator.actor_id === existing.reporter_sponsor_id ||
      existing.conflicted_actors.includes(operator.actor_id)
    ) {
      throw new Error("INVESTIGATOR_CONFLICT_OF_INTEREST");
    }

    const res = await this.db
      .prepare(
        `UPDATE scientific_integrity_cases
         SET investigator_id = ?, state = 'awaiting-response', updated_at = ?
         WHERE case_id = ? AND state IN ('intake', 'under-review', 'awaiting-response')`,
      )
      .bind(operator.actor_id, nowIso, caseId)
      .run();
    if ((res.meta?.changes ?? 0) !== 1) {
      throw new Error("INTEGRITY_CASE_CONCURRENT_CONFLICT");
    }
    const updated = await this.getCase(caseId);
    if (!updated) throw new Error("INTEGRITY_CASE_NOT_FOUND");
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

  async submitSponsorResponse(
    caseId: string,
    actor: IntegrityActor,
    responseText: string,
    nowIso: string = new Date().toISOString(),
  ): Promise<IntegrityCaseRecord> {
    const started = Date.now();
    assertValidIsoTimestamp(nowIso);
    assertNonEmptyActor(actor);
    const existing = await this.getCase(caseId);
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

    const res = await this.db
      .prepare(
        `UPDATE scientific_integrity_cases
         SET state = 'under-review', sponsor_response_digest = ?, sponsor_response_submitted_by = ?, updated_at = ?
         WHERE case_id = ? AND state IN ('intake', 'under-review', 'awaiting-response')`,
      )
      .bind(sha256Hex(responseText), actor.actor_id, nowIso, caseId)
      .run();
    if ((res.meta?.changes ?? 0) !== 1) {
      throw new Error("INTEGRITY_CASE_CONCURRENT_CONFLICT");
    }
    const updated = await this.getCase(caseId);
    if (!updated) throw new Error("INTEGRITY_CASE_NOT_FOUND");
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

  async linkScientificCorrection(
    caseId: string,
    input: {
      readonly kind: IntegrityCorrectionLink["kind"];
      readonly linked_object_ref: string;
      readonly event_id: string;
    },
    nowIso: string = new Date().toISOString(),
  ): Promise<IntegrityCaseRecord> {
    const started = Date.now();
    assertValidIsoTimestamp(nowIso);
    assertNoDirectDispositionMutation(input);
    const existing = await this.getCase(caseId);
    if (!existing) throw new Error("INTEGRITY_CASE_NOT_FOUND");
    if (
      !PUBLIC_LEDGER_REF_RE.test(input.linked_object_ref) ||
      !SAFE_EVENT_ID_RE.test(input.event_id)
    ) {
      throw new Error("INVALID_CORRECTION_LINK");
    }
    if (existing.correction_links.some((l) => l.event_id === input.event_id)) {
      throw new Error("DUPLICATE_CORRECTION_LINK_EVENT");
    }
    const linkId = `CL-${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    try {
      await this.db
        .prepare(
          `INSERT INTO scientific_integrity_correction_links (
            case_id, link_id, kind, target_ref, linked_object_ref, event_id, linked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          caseId,
          linkId,
          input.kind,
          existing.target_ref,
          input.linked_object_ref,
          input.event_id,
          nowIso,
        )
        .run();
    } catch {
      throw new Error("DUPLICATE_CORRECTION_LINK_EVENT");
    }
    await this.db
      .prepare("UPDATE scientific_integrity_cases SET updated_at = ? WHERE case_id = ?")
      .bind(nowIso, caseId)
      .run();
    const updated = await this.getCase(caseId);
    if (!updated) throw new Error("INTEGRITY_CASE_NOT_FOUND");
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

  async resolveCase(
    caseId: string,
    operator: IntegrityActor,
    decision: {
      readonly outcome: "confirmed" | "dismissed-unsubstantiated";
      readonly rationale: string;
      readonly recommend_strike_review?: boolean;
      readonly event_id?: string | null;
    },
    nowIso: string = new Date().toISOString(),
  ): Promise<IntegrityCaseRecord> {
    const started = Date.now();
    assertValidIsoTimestamp(nowIso);
    assertNonEmptyActor(operator);
    assertNoDirectDispositionMutation(decision);
    const existing = await this.getCase(caseId);
    if (!existing) throw new Error("INTEGRITY_CASE_NOT_FOUND");
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
      const res = await this.db
        .prepare(
          `UPDATE scientific_integrity_cases
           SET state = 'dismissed-unsubstantiated',
               visibility_action = 'restored',
               restricted_evidence_body = NULL,
               minimized = 1,
               decided_by = ?,
               decided_at = ?,
               decision_rationale_digest = ?,
               strike_handoff_json = NULL,
               updated_at = ?
           WHERE case_id = ? AND state IN ('intake', 'under-review', 'awaiting-response')`,
        )
        .bind(operator.actor_id, nowIso, rationaleDigest, nowIso, caseId)
        .run();
      if ((res.meta?.changes ?? 0) !== 1) {
        throw new Error("INTEGRITY_CASE_CONCURRENT_CONFLICT");
      }
      const minimized = await this.getCase(caseId);
      if (!minimized) throw new Error("INTEGRITY_CASE_NOT_FOUND");
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

    const res = await this.db
      .prepare(
        `UPDATE scientific_integrity_cases
         SET state = 'confirmed',
             decided_by = ?,
             decided_at = ?,
             decision_rationale_digest = ?,
             strike_handoff_json = ?,
             updated_at = ?
         WHERE case_id = ? AND state IN ('intake', 'under-review', 'awaiting-response')`,
      )
      .bind(
        operator.actor_id,
        nowIso,
        rationaleDigest,
        strikeHandoff ? JSON.stringify(strikeHandoff) : null,
        nowIso,
        caseId,
      )
      .run();
    if ((res.meta?.changes ?? 0) !== 1) {
      throw new Error("INTEGRITY_CASE_CONCURRENT_CONFLICT");
    }
    const confirmed = await this.getCase(caseId);
    if (!confirmed) throw new Error("INTEGRITY_CASE_NOT_FOUND");
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

  async submitAppeal(
    caseId: string,
    actor: IntegrityActor,
    statement: string,
    nowIso: string = new Date().toISOString(),
  ): Promise<IntegrityCaseRecord> {
    const started = Date.now();
    assertValidIsoTimestamp(nowIso);
    assertNonEmptyActor(actor);
    const existing = await this.getCase(caseId);
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

    const res = await this.db
      .prepare(
        `UPDATE scientific_integrity_cases
         SET state = 'appealed', appeal_submitted_by = ?, appeal_digest = ?, updated_at = ?
         WHERE case_id = ? AND state = 'confirmed'`,
      )
      .bind(actor.actor_id, sha256Hex(statement), nowIso, caseId)
      .run();
    if ((res.meta?.changes ?? 0) !== 1) {
      throw new Error("INTEGRITY_CASE_CONCURRENT_CONFLICT");
    }
    const updated = await this.getCase(caseId);
    if (!updated) throw new Error("INTEGRITY_CASE_NOT_FOUND");
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

  async decideAppeal(
    caseId: string,
    appellateOperator: IntegrityActor,
    decision: {
      readonly outcome: "appeal-upheld" | "appeal-overturned";
      readonly rationale: string;
    },
    nowIso: string = new Date().toISOString(),
  ): Promise<IntegrityCaseRecord> {
    const started = Date.now();
    assertValidIsoTimestamp(nowIso);
    assertNonEmptyActor(appellateOperator);
    assertNoDirectDispositionMutation(decision);
    const existing = await this.getCase(caseId);
    if (!existing) throw new Error("INTEGRITY_CASE_NOT_FOUND");
    if (appellateOperator.principal_class !== "operator") {
      throw new Error("OPERATOR_REQUIRED_FOR_APPEAL_DECISION");
    }
    if (existing.state !== "appealed") {
      throw new Error("INTEGRITY_CASE_NOT_APPEALED");
    }
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
    const res = overturned
      ? await this.db
          .prepare(
            `UPDATE scientific_integrity_cases
             SET state = 'appeal-overturned',
                 visibility_action = 'restored',
                 restricted_evidence_body = NULL,
                 minimized = 1,
                 strike_handoff_json = NULL,
                 appeal_decided_by = ?,
                 appeal_decided_at = ?,
                 updated_at = ?
             WHERE case_id = ? AND state = 'appealed'`,
          )
          .bind(appellateOperator.actor_id, nowIso, nowIso, caseId)
          .run()
      : await this.db
          .prepare(
            `UPDATE scientific_integrity_cases
             SET state = 'appeal-upheld',
                 appeal_decided_by = ?,
                 appeal_decided_at = ?,
                 updated_at = ?
             WHERE case_id = ? AND state = 'appealed'`,
          )
          .bind(appellateOperator.actor_id, nowIso, nowIso, caseId)
          .run();
    if ((res.meta?.changes ?? 0) !== 1) {
      throw new Error("INTEGRITY_CASE_CONCURRENT_CONFLICT");
    }
    const updated = await this.getCase(caseId);
    if (!updated) throw new Error("INTEGRITY_CASE_NOT_FOUND");
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
