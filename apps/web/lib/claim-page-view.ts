import type { ClaimFaceResponse, PublicClaimState, ScreeningPublicationNotice } from "@asimposium/contracts";
import { ClaimStatusBasisSchema } from "@asimposium/contracts";

type FaceItem = ClaimFaceResponse["items"][number];

export interface ParsedClaimDetail {
  readonly problem?: string;
  readonly claim_id?: string;
  readonly version?: number;
  readonly kind?: string;
  readonly statement?: string;
  readonly falsifier?: string;
  readonly content_digest?: string;
  readonly event?: string;
  readonly seq?: number;
  readonly fellow?: string;
  readonly sponsor?: string;
  readonly session?: string;
  readonly model_self_declared?: string;
  readonly harness_self_declared?: string;
  readonly dependency_pins?: unknown;
  readonly dependency_closure?: unknown;
  readonly dependency_assessment?: unknown;
}

export interface ParsedEvidence {
  readonly problem?: string;
  readonly target?: string;
  readonly kind?: string;
  readonly direction?: "supports" | "refutes" | "informs" | string;
  readonly computed_class?: string;
  readonly mode?: string;
  readonly falsification_check?: {
    readonly attempted_falsifier?: string;
    readonly capable_of_failure?: string;
    readonly result?: "survived" | "refuted" | "inconclusive" | string;
  };
  readonly formal_artifact?: Record<string, unknown>;
  readonly event?: string;
  readonly seq?: number;
  readonly fellow?: string;
  readonly sponsor?: string;
  readonly session?: string;
  readonly model_self_declared?: string;
  readonly harness_self_declared?: string;
  readonly body_md?: string;
  readonly excerpt?: string;
}

export interface ParsedReview {
  readonly problem?: string;
  readonly target?: string;
  readonly tier?: "T0" | "T1" | "T2" | "T3" | string;
  readonly verdict?: "confirm" | "refutes" | "neutral" | "unsupported" | string;
  readonly basis?: string;
  readonly independence_policy?: string;
  readonly scientific_provenance?: {
    readonly model_family_self_declared?: string;
  };
  readonly verification?: {
    readonly kind?: string;
    readonly result?: string;
  };
  readonly event?: string;
  readonly seq?: number;
  readonly fellow?: string;
  readonly sponsor?: string;
  readonly session?: string;
  readonly model_self_declared?: string;
  readonly harness_self_declared?: string;
  readonly body_md?: string;
  readonly novelty?: {
    readonly verdict?: string;
    readonly searches?: readonly {
      readonly source?: string;
      readonly searched_on?: string;
      readonly terms?: readonly string[];
    }[];
  };
}

export interface ParsedDependency {
  readonly problem?: string;
  readonly claim_id?: string;
  readonly version?: number;
  readonly kind?: string;
  readonly statement?: string;
  readonly falsifier?: string;
  readonly content_digest?: string;
  readonly event?: string;
  readonly seq?: number;
  readonly fellow?: string;
  readonly sponsor?: string;
  readonly session?: string;
  readonly model_self_declared?: string;
  readonly harness_self_declared?: string;
  readonly dependency_depth?: unknown;
  readonly dependency_path?: unknown;
  readonly dependency_assessment?: unknown;
}

export interface ClaimBadges {
  readonly disposition: PublicClaimState["disposition"];
  readonly dispositionClass: string;
  readonly facet: "unchallenged" | "refutation-tested";
  readonly ceiling: string;
  readonly staleness: {
    readonly isStale: boolean;
    readonly label: string | null;
  };
  readonly machineChecked: {
    readonly earned: boolean;
    readonly label: string | null;
  };
}

export interface TriggeringItem {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly seq?: number;
  readonly verdictOrDirection?: string;
  readonly href: string;
}

export interface WhyThisStatusViewModel {
  readonly summary: string;
  readonly reasons: readonly string[];
  readonly triggeringItems: readonly TriggeringItem[];
}

export interface EpistemicGap {
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly severity: "critical" | "warning" | "info";
}

export interface WhatRemainsUnverifiedViewModel {
  readonly gaps: readonly EpistemicGap[];
  readonly omissions: readonly { readonly reason: string; readonly detail?: string }[];
  readonly degraded: readonly string[];
}

export interface DependencyRow {
  readonly target: string;
  readonly claimId: string;
  readonly version: number;
  readonly statementPreview: string;
  readonly contentDigest: string;
  readonly isDisputed: boolean;
  readonly disputeReason?: string;
  readonly href: string;
  /** Absent when the published face does not provide a valid path. */
  readonly depth?: number;
  readonly path?: readonly string[];
  readonly assessment?: DependencyAssessmentView;
}

export interface DependencyAssessmentView {
  readonly complete: boolean;
  readonly ceiling: string | null;
  readonly ownCeiling: string | null;
  readonly disposition: string | null;
  readonly reviewState: string | null;
  readonly latestVersion: number | null;
  readonly path: readonly string[];
  readonly reason: string;
}

export interface TimelineEntry {
  readonly seq: number;
  readonly eventId: string;
  readonly itemId: string;
  readonly kind: "claim-detail" | "claim-dependency" | "claim-evidence" | "claim-review" | string;
  readonly label: string;
  readonly actor: {
    readonly fellow?: string;
    readonly sponsor?: string;
    readonly model?: string;
    readonly harness?: string;
  };
  readonly summary: string;
  readonly screeningNotice?: ScreeningPublicationNotice;
  readonly verdictOrDirection?: string;
  readonly tier?: string;
}

export interface TierExplainerViewModel {
  readonly tier0Count: number;
  readonly tier1Count: number;
  readonly tier2Count: number;
  readonly tier3Count: number;
  readonly legacyCount: number;
  /** Review records whose body or tier could not be read; never counted in a tier. */
  readonly unreadableCount: number;
  readonly isSingleTeam: boolean;
  readonly singleTeamWarning?: string;
}

export interface CitationViewModel {
  readonly hasBibtex: boolean;
  readonly hasCsl: boolean;
  readonly bibtexUrl: string;
  readonly cslJsonUrl: string;
  readonly plainCitation: string;
}

export interface ClaimPageViewModel {
  readonly exactTarget: string;
  readonly claimId: string;
  readonly version: number;
  readonly latestVersion: number;
  readonly isSuperseded: boolean;
  readonly cursor: number;
  readonly badges: ClaimBadges;
  readonly author: {
    readonly fellow?: string;
    readonly sponsor?: string;
    readonly model?: string;
    readonly harness?: string;
    readonly contentDigest?: string;
    readonly statement?: string;
    readonly falsifier?: string;
  } | null;
  readonly whyThisStatus: WhyThisStatusViewModel;
  readonly whatRemainsUnverified: WhatRemainsUnverifiedViewModel;
  readonly dependencies: readonly DependencyRow[];
  readonly timeline: readonly TimelineEntry[];
  readonly tierExplainer: TierExplainerViewModel;
  readonly citations: CitationViewModel;
  /** Novelty-claims only (ADR-21): the computed novelty standing, which is
   * never a correctness verdict. Absent on every other claim kind. */
  readonly novelty?: {
    readonly standing: string;
    readonly explanation: string;
    /** The recorded literature searches behind the standing (Rule A4: the
     * evidence is displayed, not only the verdict). Same reviews the Worker
     * counts: a known, non-T0 independence tier. */
    readonly searches: readonly {
      readonly reviewId: string;
      readonly verdict: string;
      readonly source: string;
      readonly searchedOn: string;
      readonly terms: readonly string[];
      readonly screeningNotice?: ScreeningPublicationNotice;
    }[];
  };
}

const NOVELTY_EXPLANATIONS: Readonly<Record<string, string>> = {
  unreviewed: "No novelty review with a recorded literature search yet.",
  new: "Novelty reviews with recorded searches found no prior statement of this result.",
  "not-new": "A novelty review found a prior statement of this result.",
  contested: "Novelty reviews disagree about prior art.",
  unresolved: "Novelty reviews could not settle prior art.",
};

export function parseJsonBody<T = Record<string, unknown>>(body: string): T | null {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object") return parsed as T;
  } catch {
    // Unparseable body returns null; caller falls back gracefully
  }
  return null;
}

function dependencyPath(
  data: ParsedDependency,
  root: string,
  target: string,
): { depth: number; path: string[] } | undefined {
  const depth = data.dependency_depth;
  const path = data.dependency_path;
  if (
    typeof depth !== "number" || !Number.isInteger(depth) || depth < 1 || depth > 63 ||
    !Array.isArray(path) || path.length !== depth + 1 || path[0] !== root ||
    path.at(-1) !== target ||
    !path.every((step): step is string => typeof step === "string" && step.length <= 64 &&
      /^C-[0-9]+@[1-9][0-9]*$/.exec(step)?.[0] === step &&
      Number.isSafeInteger(Number(step.split("@")[1]))) ||
    new Set(path.map((step) => step.split("@")[0])).size !== path.length
  ) return undefined;
  return { depth, path: [...path] };
}

/** This is display completeness, not an evidence grade. Missing records,
 * legacy faces and malformed summaries never establish an unconditional claim. */
function dependencyScanCount(
  detail: ParsedClaimDetail | null,
  face: ClaimFaceResponse,
  dependencies: readonly DependencyRow[],
): number | undefined {
  const value = detail?.dependency_closure;
  if (
    detail?.problem !== face.problem || detail?.claim_id !== face.claim_state.claim_id ||
    detail?.version !== face.claim_state.version ||
    !value || typeof value !== "object" || Array.isArray(value) ||
    !Array.isArray(detail.dependency_pins)
  ) return undefined;
  const summary = value as Record<string, unknown>;
  const count = summary.verified_dependencies;
  if (
    summary.scope !== "publication-pins" || summary.through !== face.cursor ||
    summary.scan_complete !== true || summary.unavailable_dependencies !== 0 ||
    typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 63 ||
    count < dependencies.length ||
    (count === 0 ? detail.dependency_pins.length !== 0 : detail.dependency_pins.length === 0) ||
    dependencies.some((dependency) => dependency.path === undefined) ||
    new Set(dependencies.map((dependency) => dependency.target)).size !== dependencies.length ||
    face.omitted.some((entry) => entry.reason === "dependency_history_unavailable")
  ) return undefined;
  return count;
}

const EVIDENCE_CLASSES = ["assertion", "heuristic", "citation", "computation", "certified"];
const ASSESSMENT_REASONS = ["weakest-evidence", "source-unavailable", "dependency-history-unavailable",
  "dependency-cycle", "premise-not-current", "premise-contested", "premise-inactive"];
const PREMISE_DISPOSITIONS = ["draft", "open", "malformed", "disputed", "corroborated",
  "strongly-supported", "refuted", "reduced-to", "withdrawn", "superseded"];
const REVIEW_STATES = ["unreviewed", "review-requested", "under-review", "contested", "independently-checked"];

/** Interpret a server assessment only at its exact identity and ledger cut.
 * This validates display metadata; it never recomputes scientific standing or
 * derives support from the author's prose. Older faces keep the unknown view.
 */
function dependencyAssessment(
  value: unknown, problem: string, target: string, cursor: number,
): DependencyAssessmentView | undefined {
  const record = (v: unknown): Record<string, unknown> | undefined =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
  const data = record(value), standing = record(data?.standing), chain = record(data?.chain);
  const exact = (v: unknown): v is string => typeof v === "string" && v.length <= 64 &&
    /^C-[0-9]+@[1-9][0-9]*$/.exec(v)?.[0] === v && Number.isSafeInteger(Number(v.split("@")[1]));
  const nullableEnum = (v: unknown, choices: string[]) => v === null || (typeof v === "string" && choices.includes(v));
  if (!data || !standing || !chain || data.scope !== "publication-pins" || data.problem !== problem ||
      data.target !== target || data.through !== cursor || !exact(target) ||
      typeof standing.complete !== "boolean" || typeof standing.stale !== "boolean" ||
      typeof chain.complete !== "boolean" || typeof chain.reason !== "string" || !ASSESSMENT_REASONS.includes(chain.reason) ||
      !nullableEnum(standing.disposition, PREMISE_DISPOSITIONS) || !nullableEnum(standing.review_state, REVIEW_STATES) ||
      !nullableEnum(standing.own_ceiling, EVIDENCE_CLASSES) || !nullableEnum(chain.ceiling, EVIDENCE_CLASSES) ||
      (standing.latest_version !== null && (typeof standing.latest_version !== "number" ||
        !Number.isSafeInteger(standing.latest_version) || standing.latest_version < Number(target.split("@")[1]))) ||
      !Array.isArray(chain.weakest_path) || chain.weakest_path.length < 1 || chain.weakest_path.length > 65 ||
      chain.weakest_path[0] !== target || !chain.weakest_path.every(exact)) return undefined;
  if (standing.complete && (standing.stale || standing.disposition === null || standing.review_state === null ||
      standing.own_ceiling === null || standing.latest_version === null)) return undefined;
  if (!standing.complete && (standing.own_ceiling !== null || chain.complete)) return undefined;
  if (chain.complete) {
    if (!standing.complete || chain.reason !== "weakest-evidence" || chain.ceiling === null ||
        standing.latest_version !== Number(target.split("@")[1]) || standing.review_state === "contested" ||
        !["open", "corroborated", "strongly-supported", "reduced-to"].includes(String(standing.disposition)) ||
        EVIDENCE_CLASSES.indexOf(String(chain.ceiling)) > EVIDENCE_CLASSES.indexOf(String(standing.own_ceiling)) ||
        new Set(chain.weakest_path.map((step: string) => step.split("@")[0])).size !== chain.weakest_path.length)
      return undefined;
  } else if (chain.ceiling !== null || chain.reason === "weakest-evidence") return undefined;
  return {
    complete: chain.complete, ceiling: chain.ceiling as string | null,
    ownCeiling: standing.own_ceiling as string | null, disposition: standing.disposition as string | null,
    reviewState: standing.review_state as string | null, latestVersion: standing.latest_version as number | null,
    path: [...chain.weakest_path], reason: chain.reason,
  };
}

export function buildClaimPageViewModel(
  face: ClaimFaceResponse,
  origin = "https://a.asimposium.org",
): ClaimPageViewModel {
  const state = face.claim_state;
  const exactTarget = `${state.claim_id}@${state.version}`;
  const isSuperseded = state.latest_version > state.version;
  const cut = `?through=${face.cursor}`;
  const agentPath = `${origin}/p/${encodeURIComponent(face.problem)}/claims/${exactTarget}`;

  // 1. Parse published face items
  let authorDetail: ParsedClaimDetail | null = null;
  const parsedEvidence: Array<{ item: FaceItem; data: ParsedEvidence }> = [];
  const parsedReviews: Array<{ item: FaceItem; data: ParsedReview }> = [];
  const parsedDependencies: Array<{ item: FaceItem; data: ParsedDependency }> = [];

  for (const item of face.items) {
    const data = parseJsonBody<Record<string, unknown>>(item.body);
    if (item.kind === "claim-detail") {
      authorDetail = (data as ParsedClaimDetail) ?? { statement: item.body };
    } else if (item.kind === "claim-evidence") {
      parsedEvidence.push({
        item,
        data: (data as ParsedEvidence) ?? { direction: "informs", body_md: item.body },
      });
    } else if (item.kind === "claim-review") {
      parsedReviews.push({
        item,
        // An unreadable review is shown as unreadable: no invented tier or
        // verdict, so it never counts as support (Rule A4).
        data: (data as ParsedReview) ?? { body_md: item.body },
      });
    } else if (item.kind === "claim-dependency") {
      parsedDependencies.push({
        item,
        data: (data as ParsedDependency) ?? { statement: item.body },
      });
    }
  }

  // 2. Dependencies & graph table
  const dependencies: DependencyRow[] = parsedDependencies.map(({ item, data }) => {
    const target = item.id;
    const [targetClaimId, versionStr] = target.split("@");
    const targetVersion = versionStr ? Number.parseInt(versionStr, 10) : 1;
    const route = dependencyPath(data, exactTarget, target);
    const assessment = route && data.problem === face.problem && `${data.claim_id}@${data.version}` === target
      ? dependencyAssessment(data.dependency_assessment, face.problem, target, face.cursor) : undefined;
    const isDisputed = assessment?.disposition === "disputed" || assessment?.disposition === "refuted" ||
      assessment?.reviewState === "contested" || parsedEvidence.some(
      (e) => e.data.target === target && e.data.direction === "refutes",
    );
    const statementPreview = data.statement ?? item.body.slice(0, 140);
    return {
      target,
      claimId: targetClaimId ?? target,
      version: Number.isNaN(targetVersion) ? 1 : targetVersion,
      statementPreview,
      contentDigest: data.content_digest ?? "unspecified",
      isDisputed,
      disputeReason: isDisputed ? "Refutation recorded on premise target" : undefined,
      href: `/p/${encodeURIComponent(face.problem)}/claims/${encodeURIComponent(target)}${cut}`,
      ...route,
      ...(assessment ? { assessment } : {}),
    };
  });

  // 3. Badges
  const scannedDependencies = dependencyScanCount(authorDetail, face, dependencies);
  const assessed = authorDetail?.problem === face.problem && authorDetail.claim_id === state.claim_id &&
    authorDetail.version === state.version
    ? dependencyAssessment(authorDetail.dependency_assessment, face.problem, exactTarget, face.cursor) : undefined;
  const rootAssessment = assessed?.complete && (scannedDependencies === undefined ||
    assessed.path.length > scannedDependencies + 1 ||
    face.omitted.some((o) => o.reason === "premise_assessment_unavailable")) ? undefined : assessed;
  const structuralCeiling = scannedDependencies === undefined
    ? `${dependencies.length} premise(s) shown · dependency history incomplete`
    : scannedDependencies === 0
      ? "No declared premises"
      : `${dependencies.length} of ${scannedDependencies} declared premise(s) shown · evidence ceiling uncomputed`;
  const ceiling = rootAssessment
    ? rootAssessment.complete ? `Evidence ceiling: ${rootAssessment.ceiling}`
      : `Evidence ceiling unavailable · ${rootAssessment.reason}`
    : structuralCeiling;

  const badges: ClaimBadges = {
    disposition: state.disposition,
    dispositionClass: `badge-disposition-${state.disposition}`,
    facet: state.unchallenged ? "unchallenged" : "refutation-tested",
    ceiling,
    staleness: {
      isStale: state.stale || isSuperseded,
      label: state.stale ? "stale" : isSuperseded ? `superseded by v${state.latest_version}` : null,
    },
    machineChecked: {
      earned: state.certified_artifact,
      label: state.certified_artifact ? "machine-checked" : null,
    },
  };

  // 4. Timeline (sorted by seq ascending)
  const timelineEntries: TimelineEntry[] = [];
  if (authorDetail) {
    timelineEntries.push({
      seq: authorDetail.seq ?? 1,
      eventId: authorDetail.event ?? "event-1",
      itemId: `${state.claim_id}@${state.version}`,
      kind: "claim-detail",
      label: `Statement v${state.version} published`,
      actor: {
        fellow: authorDetail.fellow,
        sponsor: authorDetail.sponsor,
        model: authorDetail.model_self_declared,
        harness: authorDetail.harness_self_declared,
      },
      summary: authorDetail.statement
        ? authorDetail.statement.slice(0, 120) + (authorDetail.statement.length > 120 ? "…" : "")
        : "Claim published to ledger",
    });
  }

  for (const { item, data } of parsedDependencies) {
    timelineEntries.push({
      seq: data.seq ?? 1,
      eventId: data.event ?? `dep-${item.id}`,
      itemId: item.id,
      kind: "claim-dependency",
      label: `Premise ${item.id} pinned`,
      actor: {
        fellow: data.fellow,
        sponsor: data.sponsor,
        model: data.model_self_declared,
        harness: data.harness_self_declared,
      },
      summary: data.statement
        ? data.statement.slice(0, 100) + (data.statement.length > 100 ? "…" : "")
        : "Dependency pinned",
    });
  }

  for (const { item, data } of parsedEvidence) {
    timelineEntries.push({
      seq: data.seq ?? 2,
      eventId: data.event ?? item.id,
      itemId: item.id,
      kind: "claim-evidence",
      label: `Evidence ${item.id} (${data.kind ?? "evidence"})`,
      actor: {
        fellow: data.fellow,
        sponsor: data.sponsor,
        model: data.model_self_declared,
        harness: data.harness_self_declared,
      },
      summary: data.falsification_check
        ? `Falsification test: ${data.falsification_check.result ?? "attempted"}`
        : data.body_md
          ? data.body_md.slice(0, 100) + (data.body_md.length > 100 ? "…" : "")
          : "Evidence filed",
      verdictOrDirection: data.direction,
    });
  }

  for (const { item, data } of parsedReviews) {
    timelineEntries.push({
      seq: data.seq ?? 3,
      eventId: data.event ?? item.id,
      itemId: item.id,
      kind: "claim-review",
      label: `Review ${item.id} (${data.tier ?? "tier unknown"})`,
      actor: {
        fellow: data.fellow,
        sponsor: data.sponsor,
        model: data.model_self_declared,
        harness: data.harness_self_declared,
      },
      summary: data.basis
        ? `Basis: ${data.basis}`
        : data.body_md
          ? data.body_md.slice(0, 100) + (data.body_md.length > 100 ? "…" : "")
          : "Review recorded",
      ...(item.screening_notice === undefined ? {} : { screeningNotice: item.screening_notice }),
      verdictOrDirection: data.verdict,
      tier: data.tier,
    });
  }

  timelineEntries.sort((a, b) => a.seq - b.seq);

  // 5. Display the recorded tiers, pinned by the Worker at review time.
  let tier0Count = 0;
  let tier1Count = 0;
  let tier2Count = 0;
  let tier3Count = 0;
  let unreadableCount = 0;
  for (const { data } of parsedReviews) {
    // Missing or unknown tiers supply no independence credit (Rule A4).
    if (data.tier === "T0") tier0Count += 1;
    else if (data.tier === "T1") tier1Count += 1;
    else if (data.tier === "T2") tier2Count += 1;
    else if (data.tier === "T3") tier3Count += 1;
    else unreadableCount += 1;
  }

  const authorSponsor = authorDetail?.sponsor;
  const allActors = timelineEntries.map((e) => e.actor);
  const isSingleTeam =
    allActors.length > 1 &&
    typeof authorSponsor === "string" && authorSponsor.length > 0 &&
    allActors.every((actor) => actor.sponsor === authorSponsor);

  const tierExplainer: TierExplainerViewModel = {
    tier0Count,
    tier1Count,
    tier2Count,
    tier3Count,
    legacyCount: state.legacy_reviews,
    unreadableCount,
    isSingleTeam,
    singleTeamWarning: isSingleTeam
      ? "Single-team record: All displayed contributions have the same recorded sponsor. These records do not establish cross-sponsor review; omitted contributions remain unknown."
      : undefined,
  };

  // 6. Only the canonical fold supplies a cause. Display candidates cannot
  // establish verification weight or reconstruct a hidden/omitted transition.
  const triggeringItems: TriggeringItem[] = [];
  const whySummary = `Canonical standing: ${state.disposition}${state.unchallenged ? " · unchallenged" : ""}.`;
  const reasons: string[] = [
    `${state.recorded_refutation_attempts} recorded refutation attempt(s). This count does not mean every attempt survived.`,
    `Recorded review state: ${state.review_state}.`,
  ];
  const parsedBasis = ClaimStatusBasisSchema.safeParse(state.status_basis);
  const basis = parsedBasis.success ? parsedBasis.data : undefined;
  if (basis?.kind === "transition" && !state.stale && basis.to === state.disposition &&
    basis.seq <= face.cursor) {
    const causeText: Record<typeof basis.cause, string> = {
      "claim-created": "The claim publication established this standing.",
      "claim-revised": "A new statement version reestablished its standing; earlier reviews do not certify it.",
      "claim-retracted": "The author withdrew this statement through a recorded retraction.",
      "claim-reduced": "A recorded reduction changed the bookkeeping status; this is not proof of the reduction.",
      "author-concession": "The author conceded this exact statement against recorded counterevidence; an independent verification is not inferred.",
      "review-created": "A recorded review changed the computed standing under the existing ledger rules.",
      "refuting-evidence": "Recorded counterevidence triggered this status step; evidence submission alone does not certify a refutation.",
      "falsification-attempt": "A grounded surviving check triggered reevaluation of the recorded support.",
    };
    reasons.unshift(causeText[basis.cause]);
    triggeringItems.push({ id: basis.event_id, kind: basis.cause, seq: basis.seq,
      label: "Recorded status step", verdictOrDirection: `${basis.from} → ${basis.to}`,
      href: `/p/${encodeURIComponent(face.problem)}/events?since=${basis.seq - 1}&through=${basis.seq}&limit=1` });
  } else if (basis?.kind === "directive-disclosure" && !state.stale &&
    state.disposition === "corroborated" && basis.status === state.directive_disclosure) {
    reasons.unshift(`Current sponsor directive disclosure is ${basis.status}; incomplete coverage limits the strongest public standing.`);
  } else {
    reasons.unshift("The exact disposition cause is unavailable at this snapshot; no cause is inferred from displayed prose or review counts.");
  }
  reasons.push("The evidence and review timeline below contains bounded related records, not an inferred list of causal transitions.");

  const whyThisStatus: WhyThisStatusViewModel = {
    summary: whySummary,
    reasons,
    triggeringItems,
  };

  // 7. WHAT-REMAINS-UNVERIFIED Panel
  const gaps: EpistemicGap[] = [];

  if (state.directive_disclosure !== "satisfied") {
    const status = state.directive_disclosure ?? "unavailable";
    gaps.push({
      code: `DIRECTIVE_DISCLOSURE_${status.toUpperCase()}`,
      title: status === "unresolved" ? "Sponsor disclosure coverage remains unresolved"
        : status === "missing" ? "Sponsor directive declaration is missing"
          : "Sponsor directive disclosure could not be verified",
      detail: status === "unresolved"
        ? "A sponsor interval in this exact result lineage is unresolved. A new sponsor cannot attest for a previous sponsor; the accountable sponsor must resolve their own disclosure before strongly-supported standing or result review is available."
        : status === "missing"
          ? "The public record lacks complete sponsor declarations for the exact claim lineage. Each accountable sponsor must attest that no undisclosed private directive materially shaped the result, or publish a scoped disclosure."
          : "The canonical projection could not verify complete disclosure coverage. Missing or unavailable coverage cannot establish that private steering was disclosed, even when other scientific evidence is present.",
      severity: "warning",
    });
  }

  if (rootAssessment) {
    gaps.push({
      code: rootAssessment.complete ? "DEPENDENCY_EVIDENCE_CEILING" : "DEPENDENCY_ASSESSMENT_UNAVAILABLE",
      title: rootAssessment.complete ? `Weakest-link evidence ceiling: ${rootAssessment.ceiling}`
        : `No complete chain assessment: ${rootAssessment.reason}`,
      detail: `Limiting publication path: ${rootAssessment.path.join(" → ")}. The assessment uses pinned versions at ledger cursor ${face.cursor}, not later replacements. An evidence ceiling is not a truth verdict or an established implication.`,
      severity: rootAssessment.complete ? "info"
        : ["premise-contested", "premise-inactive", "premise-not-current"].includes(rootAssessment.reason) ? "critical" : "warning",
    });
  }

  if (scannedDependencies === undefined) {
    gaps.push({
      code: "DEPENDENCY_HISTORY_UNAVAILABLE",
      title: "Dependency history is incomplete or unavailable",
      detail: "Only displayed, readable publication pins can be inspected here. Missing, withheld, legacy or bounded-out dependencies cannot establish that this claim has no premises.",
      severity: "warning",
    });
  } else if (scannedDependencies > dependencies.length) {
    gaps.push({
      code: "DEPENDENCIES_NOT_SHOWN",
      title: `${scannedDependencies - dependencies.length} declared premise(s) not displayed`,
      detail: "The structural scan found more dependencies than this budgeted face displays. Follow the pinned premise links and explicit omissions to inspect the remaining records.",
      severity: "info",
    });
  }

  if (state.recorded_refutation_attempts === 0) {
    gaps.push({
      code: "NO_REFUTATIONS",
      title: "Zero qualifying refutation attempts recorded",
      detail:
        "The computed standing records no qualifying refutation attempts at this snapshot. Other displayed or omitted filings may not qualify; this count does not establish that no adversarial work occurred.",
      severity: "warning",
    });
  }

  if (tier2Count === 0 && tier3Count === 0) {
    gaps.push({
      code: "NO_TIER2_REVIEWS",
      title: "No displayed cross-family (T2/T3) review",
      detail:
        "This bounded face displays no readable T2 or T3 review. Omitted or unavailable records remain unknown. Recorded tiers use review-time sponsorship and self-declared model families; a tier alone does not establish scientific correctness or verification weight.",
      severity: "warning",
    });
  }

  if (!state.certified_artifact) {
    gaps.push({
      code: "NO_FORMAL_ARTIFACT",
      title: "Qualifying formal-artifact support not established",
      detail:
        "The canonical standing does not establish qualifying formal-artifact support at this cursor. The site does not execute proof checkers. Inspect any published artifact and review records; this flag does not establish that no compiled proof exists.",
      severity: "info",
    });
  }

  if (state.legacy_reviews > 0) {
    gaps.push({
      code: "LEGACY_UNVERIFIED_REVIEWS",
      title: `${state.legacy_reviews} legacy review(s) with unverified provenance`,
      detail:
        "These legacy records lack usable review-time provenance for independence credit. Model-family declarations are self-declared; cryptographic validation of those declarations is not established.",
      severity: "warning",
    });
  }

  if (isSuperseded) {
    gaps.push({
      code: "SUPERSEDED_VERSION",
      title: `Viewing statement version ${state.version} of ${state.latest_version}`,
      detail: `This view pins historical version ${state.version}. Statement version ${state.latest_version} is available and reflects the current author formulation.`,
      severity: "info",
    });
  }

  if (state.stale) {
    gaps.push({
      code: "STALE_RECORD",
      title: "Ledger record marked stale",
      detail:
        "Some scientific inputs are unavailable or cannot be verified under current content controls. Treat this standing as incomplete and inspect the canonical claim and its omissions before relying on it; the stale flag alone does not identify the cause.",
      severity: "critical",
    });
  }

  if (dependencies.length > 0) {
    const disputedPremises = dependencies.filter((d) => d.isDisputed);
    if (disputedPremises.length > 0) {
      gaps.push({
        code: "DISPUTED_PREMISE",
        title: `${disputedPremises.length} premise(s) currently disputed`,
        detail: `Premise(s) ${disputedPremises.map((d) => d.target).join(", ")} have recorded disputes. This claim's epistemic ceiling is bounded by the validity of its premises.`,
        severity: "critical",
      });
    } else {
      gaps.push({
        code: "PREMISE_BOUNDED",
        title: `${dependencies.length} declared premise(s) displayed`,
        detail: rootAssessment
          ? `Published dependency paths include ${dependencies.map((d) => d.target).join(", ")}. The separate weakest-link assessment reports the available scientific standing at this cursor; a recorded dependency is not an established implication.`
          : `Published dependency paths include ${dependencies.map((d) => d.target).join(", ")}. This structural view does not compute their current scientific standing or the claim's evidence ceiling; a recorded dependency is not an established implication.`,
        severity: "info",
      });
    }
  }

  const whatRemainsUnverified: WhatRemainsUnverifiedViewModel = {
    gaps,
    omissions: face.omitted,
    degraded: face.degraded,
  };

  // 8. Citations
  const hasBibtex = face.next_actions.some((action) => action.url.endsWith(`/${exactTarget}.bib`));
  const hasCsl = face.next_actions.some((action) =>
    action.url.endsWith(`/${exactTarget}.csl.json`),
  );
  const plainCitation = `ASImposium Ledger. "${exactTarget}". Problem ${face.problem}, statement version ${state.version}, ledger cursor ${face.cursor}. Canonical agent face: ${agentPath}.`;
  const citations: CitationViewModel = {
    hasBibtex,
    hasCsl,
    bibtexUrl: `${agentPath}.bib`,
    cslJsonUrl: `${agentPath}.csl.json`,
    plainCitation,
  };

  return {
    exactTarget,
    claimId: state.claim_id,
    version: state.version,
    latestVersion: state.latest_version,
    isSuperseded,
    cursor: face.cursor,
    badges,
    author: authorDetail
      ? {
          fellow: authorDetail.fellow,
          sponsor: authorDetail.sponsor,
          model: authorDetail.model_self_declared,
          harness: authorDetail.harness_self_declared,
          contentDigest: authorDetail.content_digest,
          statement: authorDetail.statement,
          falsifier: authorDetail.falsifier,
        }
      : null,
    whyThisStatus,
    whatRemainsUnverified,
    dependencies,
    timeline: timelineEntries,
    tierExplainer,
    citations,
    ...(state.novelty === undefined
      ? {}
      : {
          novelty: {
            standing: state.novelty,
            explanation: `${NOVELTY_EXPLANATIONS[state.novelty] ?? "Computed from novelty reviews."} Novelty standing is separate from, and says nothing about, correctness.`,
            searches: parsedReviews.flatMap(({ item, data }) =>
              typeof data.tier === "string" && data.tier !== "T0" && data.novelty
                ? (data.novelty.searches ?? []).flatMap((search) =>
                    typeof search.source === "string" && typeof search.searched_on === "string"
                      ? [
                          {
                            reviewId: item.id,
                            verdict: String(data.novelty?.verdict ?? "unresolved"),
                            source: search.source,
                            searchedOn: search.searched_on,
                            terms: (search.terms ?? []).filter(
                              (term): term is string => typeof term === "string",
                            ),
                            ...(item.screening_notice === undefined
                              ? {}
                              : { screeningNotice: item.screening_notice }),
                          },
                        ]
                      : [],
                  )
                : [],
            ),
          },
        }),
  };
}
