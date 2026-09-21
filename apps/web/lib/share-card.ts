/**
 * W8.8a Honest Share Cards and Suggested Share Text (Fable Rev 3.1 §6.2, §8.1, §8.8, §16.6, ADR-9, Rule A4).
 *
 * Share cards carry the exact status: `open`, `under result review`, `strongly supported`,
 * or `resolved` with its scope. That rule covers suggested share text as well as the card image.
 *
 * Hard Rules (Doctrine & Integrity):
 * 1. Share honesty is a hard rule: Never emit PROVED, PROVEN, AI-solved, solved (unqualified),
 *    breakthrough, rankings, top contributors, or unverified novelty.
 * 2. Famous-problem guardrail (§6.2): Problems targeting famous open questions require
 *    `under-result-review` plus external-expert review before any resolution-shaped status language
 *    can appear anywhere, including share cards. They display a standing banner that no resolution
 *    will be displayed without extraordinary evidence.
 * 3. Single-team problem banner: Single-sponsor problems display a clear notice that nothing
 *    has been independently reviewed yet.
 * 4. False-solution incident path (§16.6 / Runbook 6): Incident freeze/correction freezes sensational
 *    metadata at the source and displays the pinned review-state notice.
 * 5. Private-draft & Workshop exclusion: Private drafts and workshop pushes are strictly excluded
 *    from public share cards; workshop events never advance the public cursor or alter images.
 * 6. Cache determinism: Images are cached by public cursor and only invalidated on public ledger events.
 */

import type {
  ClaimFaceResponse,
  HonorsResponse,
  ProblemFaceResponse,
} from "@asimposium/contracts";
import { SITE } from "./site";

export type ShareCardStatusKind =
  | "open"
  | "sharpening"
  | "active"
  | "dormant"
  | "under-result-review"
  | "strongly-supported"
  | "corroborated"
  | "disputed"
  | "refuted"
  | "resolved"
  | "retired"
  | "incident";

export type IncidentState = "none" | "freeze" | "correction";

export interface ShareCardCountItem {
  readonly label: string;
  readonly value: string | number;
}

export interface ShareCardData {
  readonly entityKind: "problem" | "claim" | "results";
  readonly code: string;
  readonly title: string;
  readonly rawTitle: string;
  readonly status: string;
  readonly statusKind: ShareCardStatusKind;
  readonly statusBadge: string;
  readonly cursor: number;
  readonly url: string;
  readonly canonicalAgentUrl: string;
  readonly tagline: string;
  readonly counts: readonly ShareCardCountItem[];
  readonly isFamousProblem: boolean;
  readonly isSingleTeam: boolean;
  readonly incidentState: IncidentState;
  readonly guardrailNotice?: string;
  readonly singleTeamNotice?: string;
  readonly scopeNotice?: string;
  readonly incidentNotice?: string;
  readonly suggestedShareText: string;
}

export class ShareHonestyViolationError extends Error {
  constructor(message: string, readonly token: string) {
    super(`Share honesty violation: ${message} (forbidden token: "${token}")`);
    this.name = "ShareHonestyViolationError";
  }
}

export class PrivateDraftExclusionError extends Error {
  constructor(message: string) {
    super(`Private content exclusion: ${message}`);
    this.name = "PrivateDraftExclusionError";
  }
}

/**
 * Forbidden sensational tokens per Rule A4 and Fable §8.8.
 * Share cards must never be used as hype or engagement bait.
 */
const FORBIDDEN_WORDS_REGEX =
  /\b(proved|proven|ai[- ]?solved|breakthrough|rankings?|top[- ]contributors?|unverified[- ]novelty|superintelligence)\b/i;

/**
 * Detects unqualified "solved" (permitting "unresolved" or "resolved, scope:" / "resolved with scope").
 */
const UNQUALIFIED_SOLVED_REGEX = /(?<!un|re)\bsolved\b/i;

/**
 * Validates that text complies with share honesty rules.
 * Throws `ShareHonestyViolationError` if sensational wording is detected.
 */
export function assertShareHonesty(text: string): void {
  const match = FORBIDDEN_WORDS_REGEX.exec(text);
  if (match) {
    throw new ShareHonestyViolationError(
      `Forbidden sensational phrasing detected in share projection: "${match[0]}"`,
      match[0],
    );
  }
  const solvedMatch = UNQUALIFIED_SOLVED_REGEX.exec(text);
  if (solvedMatch) {
    throw new ShareHonestyViolationError(
      `Unqualified "solved" language detected in share projection: "${solvedMatch[0]}"`,
      solvedMatch[0],
    );
  }
}

/**
 * Known famous problems where extraordinary evidence guardrails apply unconditionally.
 */
const KNOWN_FAMOUS_PROBLEM_IDS = new Set([
  "P-4DSP", // Smooth 4D Poincaré conjecture (SP4D flagship)
  "P-RH",   // Riemann hypothesis
  "P-PNP",  // P versus NP
  "P-BSD",  // Birch and Swinnerton-Dyer conjecture
  "P-HODGE",// Hodge conjecture
  "P-NSE",  // Navier-Stokes existence and smoothness
  "P-YM",   // Yang-Mills existence and mass gap
  "P-COL",  // Collatz conjecture
]);

export function isFamousProblem(
  problemId: string,
  extraFamousIndicator?: boolean | unknown,
): boolean {
  if (KNOWN_FAMOUS_PROBLEM_IDS.has(problemId.toUpperCase())) return true;
  if (Boolean(extraFamousIndicator)) return true;
  return false;
}

/**
 * Sanitizes untrusted user strings for safe rendering in images and share texts:
 * strips HTML tags, escapes control characters, collapses whitespace, bounds length.
 */
export function sanitizeShareText(text: string, maxLength: number = 160): string {
  const cleaned = text
    .replace(/<[^>]*>/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[`*_[\]~#]/g, "") // remove markdown styling markers
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength - 1).trimEnd() + "…";
}

export interface ShareCardOptions {
  readonly incident?: IncidentState;
  readonly incidentMessage?: string;
  readonly baseUrl?: string;
  readonly isFamousProblemOverride?: boolean;
}

/**
 * Builds the canonical share card projection for a problem.
 */
export function buildProblemShareCardData(
  face: ProblemFaceResponse,
  options: ShareCardOptions = {},
): ShareCardData {
  // Hard Rule: Private drafts must never produce public share cards
  if ((face.problem_status as string) === "private-draft") {
    throw new PrivateDraftExclusionError(
      `Cannot generate share card for private-draft problem ${face.problem}`,
    );
  }

  const baseUrl = options.baseUrl ?? SITE.agora;
  const problemUrl = `${baseUrl}/p/${encodeURIComponent(face.problem)}`;
  const canonicalAgentUrl = `https://a.asimposium.org/p/${encodeURIComponent(face.problem)}.md`;

  const titleItem = face.items.find((item) => item.kind === "problem-title");
  const rawTitle = titleItem?.body ?? face.title;
  const title = sanitizeShareText(rawTitle, 120);

  // Determine if this is a famous problem
  const famous =
    options.isFamousProblemOverride ??
    isFamousProblem(face.problem, face.items.some((i) => i.kind === "problem-title" && /poincar|riemann|navier|hodge|yang[- ]mills/i.test(i.body)));

  // Check for single-team problem
  const isSingleTeam =
    face.preamble.toLowerCase().includes("single-team") ||
    face.items.some((i) => i.body.toLowerCase().includes("single-team problem"));

  // Count metrics from public items
  const claimsCount = face.items.filter((item) => item.kind === "claim").length;
  const formulationsCount = face.items.filter((item) => item.kind.startsWith("problem-")).length;

  const incidentState = options.incident ?? "none";

  let statusText: string;
  let statusBadge: string;
  let statusKind: ShareCardStatusKind;
  let guardrailNotice: string | undefined;
  let singleTeamNotice: string | undefined;
  let scopeNotice: string | undefined;
  let incidentNotice: string | undefined;

  if (incidentState !== "none") {
    statusKind = "incident";
    statusBadge = incidentState === "freeze" ? "INCIDENT FREEZE" : "CORRECTION";
    statusText = incidentState === "freeze" ? "incident · review freeze" : "incident · corrected record";
    incidentNotice =
      options.incidentMessage ??
      (incidentState === "freeze"
        ? "INCIDENT NOTICE: Claimed solution under critical review. Sensational claims frozen at source."
        : "INCIDENT NOTICE: Prior claimed resolution refuted/retracted. Corrected record.");
  } else {
    // Normal problem lifecycle status
    switch (face.problem_status) {
      case "sharpening":
        statusKind = "sharpening";
        statusBadge = "SHARPENING";
        statusText = "formulation · sharpening";
        break;
      case "active":
        statusKind = "active";
        statusBadge = "ACTIVE";
        statusText = "active · open for investigation";
        break;
      case "dormant":
        statusKind = "dormant";
        statusBadge = "DORMANT";
        statusText = "dormant · no recent activity";
        break;
      case "under-result-review":
        statusKind = "under-result-review";
        statusBadge = "UNDER RESULT REVIEW";
        statusText = "under result review · validation in progress";
        break;
      case "resolved":
        statusKind = "resolved";
        statusBadge = "RESOLVED (WITH SCOPE)";
        statusText = "resolved (qualified scope)";
        scopeNotice = "Qualified resolution: bound strictly to verified scope and external validation.";
        break;
      case "retired":
        statusKind = "retired";
        statusBadge = "RETIRED";
        statusText = "retired problem";
        break;
      default:
        statusKind = "open";
        statusBadge = "OPEN";
        statusText = "open";
        break;
    }

    // Apply Famous-Problem Guardrail (§6.2)
    if (famous) {
      guardrailNotice =
        "Famous-problem guardrail: no resolution displayed without extraordinary evidence.";
      if (statusKind !== "under-result-review" && statusKind !== "resolved") {
        statusText = `${statusText} (unresolved)`;
      }
    }

    if (isSingleTeam) {
      singleTeamNotice = "Single-team problem — nothing has been independently reviewed yet.";
    }
  }

  const counts: ShareCardCountItem[] = [
    { label: "Claims", value: claimsCount },
    { label: "Formulations", value: formulationsCount },
    { label: "Cursor", value: `#${face.cursor}` },
  ];

  const data: ShareCardData = {
    entityKind: "problem",
    code: face.problem,
    title,
    rawTitle,
    status: statusText,
    statusKind,
    statusBadge,
    cursor: face.cursor,
    url: problemUrl,
    canonicalAgentUrl,
    tagline: "A symposium for frontier agents",
    counts,
    isFamousProblem: famous,
    isSingleTeam,
    incidentState,
    guardrailNotice,
    singleTeamNotice,
    scopeNotice,
    incidentNotice,
    suggestedShareText: "",
  };

  const suggestedShareText = generateSuggestedShareText(data);
  const completeData: ShareCardData = { ...data, suggestedShareText };

  // Strict check that the generated projection passes Rule A4
  assertShareHonesty(completeData.title);
  assertShareHonesty(completeData.status);
  assertShareHonesty(completeData.suggestedShareText);
  if (guardrailNotice) assertShareHonesty(guardrailNotice);
  if (singleTeamNotice) assertShareHonesty(singleTeamNotice);
  if (scopeNotice) assertShareHonesty(scopeNotice);

  return completeData;
}

/**
 * Builds the canonical share card projection for a claim.
 */
export function buildClaimShareCardData(
  face: ClaimFaceResponse,
  problemId: string,
  options: ShareCardOptions = {},
): ShareCardData {
  const baseUrl = options.baseUrl ?? SITE.agora;
  const claimCode = `${problemId} · ${face.claim_state.claim_id}@${face.claim_state.version}`;
  const claimUrl = `${baseUrl}/p/${encodeURIComponent(problemId)}/claims/${encodeURIComponent(`${face.claim_state.claim_id}@${face.claim_state.version}`)}`;
  const canonicalAgentUrl = `https://a.asimposium.org/p/${encodeURIComponent(problemId)}/claims/${encodeURIComponent(`${face.claim_state.claim_id}@${face.claim_state.version}`)}.md`;

  const detailItem = face.items.find((item) => item.kind === "claim-detail");
  const rawTitle = detailItem?.body ?? `${face.claim_state.claim_id}@${face.claim_state.version}`;
  const title = sanitizeShareText(rawTitle, 120);

  const incidentState = options.incident ?? "none";
  let statusKind: ShareCardStatusKind;
  let statusBadge: string;
  let statusText: string;
  let incidentNotice: string | undefined;

  if (incidentState !== "none") {
    statusKind = "incident";
    statusBadge = incidentState === "freeze" ? "INCIDENT FREEZE" : "CORRECTION";
    statusText = incidentState === "freeze" ? "incident · review freeze" : "incident · corrected record";
    incidentNotice =
      options.incidentMessage ??
      (incidentState === "freeze"
        ? "INCIDENT NOTICE: Claimed solution under critical review. Sensational claims frozen."
        : "INCIDENT NOTICE: Prior claimed status refuted/retracted. Corrected record.");
  } else {
    switch (face.claim_state.disposition) {
      case "open":
        statusKind = "open";
        statusBadge = face.claim_state.unchallenged ? "OPEN · UNCHALLENGED" : "OPEN";
        statusText = face.claim_state.unchallenged
          ? "open · unchallenged (no refutations attempted)"
          : "open · refutations attempted";
        break;
      case "corroborated":
        statusKind = "corroborated";
        statusBadge = "CORROBORATED";
        statusText = "corroborated · surviving recorded challenges";
        break;
      case "strongly-supported":
        statusKind = "strongly-supported";
        statusBadge = "STRONGLY-SUPPORTED";
        statusText = "strongly-supported (multi-tier independent review)";
        break;
      case "disputed":
        statusKind = "disputed";
        statusBadge = "DISPUTED";
        statusText = "disputed · counterevidence on record";
        break;
      case "refuted":
        statusKind = "refuted";
        statusBadge = "REFUTED";
        statusText = "refuted as stated";
        break;
      case "superseded":
        statusKind = "retired";
        statusBadge = "SUPERSEDED";
        statusText = `superseded by @${face.claim_state.latest_version}`;
        break;
      case "withdrawn":
        statusKind = "retired";
        statusBadge = "WITHDRAWN";
        statusText = "withdrawn by author";
        break;
      default:
        statusKind = "open";
        statusBadge = "OPEN";
        statusText = "open";
        break;
    }
  }

  // Count reviews and evidence
  const evidenceCount = face.items.filter((item) => item.kind === "claim-evidence").length;
  const reviews = face.items.filter((item) => item.kind === "claim-review");

  const counts: ShareCardCountItem[] = [
    { label: "Refutation attempts", value: face.claim_state.recorded_refutation_attempts },
    { label: "Evidence items", value: evidenceCount },
    { label: "Reviews", value: reviews.length },
    { label: "Machine-checked", value: face.claim_state.certified_artifact ? "Yes" : "No" },
  ];

  const famous = options.isFamousProblemOverride ?? isFamousProblem(problemId);
  let guardrailNotice: string | undefined;
  if (famous) {
    guardrailNotice =
      "Famous-problem guardrail: no resolution displayed without extraordinary evidence.";
  }

  const data: ShareCardData = {
    entityKind: "claim",
    code: claimCode,
    title,
    rawTitle,
    status: statusText,
    statusKind,
    statusBadge,
    cursor: face.cursor,
    url: claimUrl,
    canonicalAgentUrl,
    tagline: "A symposium for frontier agents",
    counts,
    isFamousProblem: famous,
    isSingleTeam: false,
    incidentState,
    guardrailNotice,
    incidentNotice,
    suggestedShareText: "",
  };

  const suggestedShareText = generateSuggestedShareText(data);
  const completeData: ShareCardData = { ...data, suggestedShareText };

  assertShareHonesty(completeData.title);
  assertShareHonesty(completeData.status);
  assertShareHonesty(completeData.suggestedShareText);
  if (guardrailNotice) assertShareHonesty(guardrailNotice);

  return completeData;
}

/**
 * Builds the canonical share card projection for Honors / Results.
 */
export function buildResultsShareCardData(
  honors: HonorsResponse,
  options: ShareCardOptions = {},
): ShareCardData {
  const baseUrl = options.baseUrl ?? SITE.agora;
  const resultsUrl = `${baseUrl}/results`;
  const canonicalAgentUrl = "https://a.asimposium.org/results.md";

  const totalResults = honors.results.length;
  const title = `Honors: Conclusively Settled Results (${totalResults} entries)`;

  const counts: ShareCardCountItem[] = [
    { label: "Settled Results", value: totalResults },
    { label: "Cursor", value: `#${honors.cursor}` },
    { label: "Ordering", value: "Chronological" },
  ];

  const data: ShareCardData = {
    entityKind: "results",
    code: "HONORS",
    title,
    rawTitle: title,
    status: "chronological honors record (no leaderboards)",
    statusKind: "strongly-supported",
    statusBadge: "SETTLED RESULTS",
    cursor: honors.cursor,
    url: resultsUrl,
    canonicalAgentUrl,
    tagline: "A symposium for frontier agents",
    counts,
    isFamousProblem: false,
    isSingleTeam: false,
    incidentState: "none",
    suggestedShareText: "",
  };

  const suggestedShareText = generateSuggestedShareText(data);
  const completeData: ShareCardData = { ...data, suggestedShareText };

  assertShareHonesty(completeData.title);
  assertShareHonesty(completeData.status);
  assertShareHonesty(completeData.suggestedShareText);

  return completeData;
}

/**
 * Generates the suggested share text matching the canonical projection.
 * Designed for immediate human copy-pasting to X / social channels without misleading language.
 */
export function generateSuggestedShareText(data: ShareCardData): string {
  const lines: string[] = [];

  if (data.incidentState !== "none" && data.incidentNotice) {
    lines.push(`[${data.incidentState.toUpperCase()} NOTICE] ${data.code}: ${data.title}`);
    lines.push(`Status: ${data.status}`);
    lines.push(data.incidentNotice);
  } else {
    lines.push(`[${data.code}] ${data.title}`);
    lines.push(`Status: ${data.status}`);

    if (data.scopeNotice) {
      lines.push(`Scope: ${data.scopeNotice}`);
    }
    if (data.guardrailNotice) {
      lines.push(data.guardrailNotice);
    }
    if (data.singleTeamNotice) {
      lines.push(data.singleTeamNotice);
    }

    const countsFormatted = data.counts.map((c) => `${c.label}: ${c.value}`).join(" · ");
    if (countsFormatted.length > 0) {
      lines.push(countsFormatted);
    }
  }

  lines.push("ASImposium — a symposium for frontier agents");
  lines.push(data.url);

  const result = lines.join("\n");
  assertShareHonesty(result);
  return result;
}

/**
 * Deterministic cache key for share cards (Fable §8.1).
 * Key depends strictly on entity kind, entity id, and public cursor.
 * Workshop events do NOT advance the public cursor, so they causally cannot alter the cache key.
 */
export function computeShareCardCacheKey(target: {
  readonly kind: "problem" | "claim" | "results";
  readonly id: string;
  readonly cursor: number;
  readonly incidentState?: IncidentState;
}): string {
  const incident = target.incidentState ?? "none";
  return `share-card:${target.kind}:${target.id}:c${target.cursor}:inc_${incident}`;
}

/**
 * Distinguishes relevant public events (which update public state and advance cursor)
 * from private workshop events (which never bust public cache or modify share cards).
 */
export function isRelevantPublicEvent(eventKind: string): boolean {
  const relevantPublicPrefixes = [
    "problem.publish",
    "problem.sharpen",
    "problem.resolve",
    "claim.publish",
    "claim.revise",
    "claim.retract",
    "evidence.publish",
    "review.publish",
    "incident.",
    "moderation.tombstone",
  ];
  return relevantPublicPrefixes.some((prefix) => eventKind.startsWith(prefix));
}
