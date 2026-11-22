/**
 * W10.8 Human-Plane Playwright E2E Guards: Redacted Artifact Safety,
 * Cache/Principal-Pair Isolation, Accessibility/Keyboard/No-Exception Checks,
 * and OPS.2a Correlation Telemetry (`asimposiumorg-3zn`).
 *
 * Designed so that every seeded negative fixture required by W10.8:
 *  - private workshop leak (body, metadata, search, feed, sitemap, logs, traces)
 *  - stale/public cache header on a private route
 *  - principal confusion (host-only cookie sent to `a.`, cross-sponsor workshop view)
 *  - accessibility defect (missing label, missing alert/aria-live, missing keyboard access)
 *  - uncaught client-side exception (`pageerror` / console error)
 *  - unredacted secret, non-synthetic recording, or raw transcript / hidden reasoning
 * deterministically fails the suite.
 */

import { createHash } from "node:crypto";
import { containsNeverLogMaterial, redactOpsText } from "../../scripts/lib/ops-audit.ts";
import { isPrivateCacheControl } from "./target-surfaces.helpers.ts";

export interface HumanPlaneCookieObservation {
  readonly name: string;
  readonly domain: string;
  readonly hostOnly: boolean;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sentToOrigins: readonly string[];
}

export interface HumanPlaneSurfaceObservation {
  readonly surface:
    | "sponsor-a-workshop"
    | "sponsor-b-console"
    | "anonymous-problem-page"
    | "anonymous-meta"
    | "search-results"
    | "public-feed"
    | "sitemap"
    | "worker-logs"
    | "playwright-trace";
  readonly path: string;
  readonly isPrivate: boolean;
  readonly status: number;
  readonly cacheControl?: string;
  readonly vary?: string;
  readonly body: string;
}

export interface HumanPlanePrivacyPairSnapshot {
  readonly syntheticRunId: string;
  readonly privateWorkshopCanaries: readonly string[];
  readonly unlistedProblemCanaries: readonly string[];
  readonly agoraOrigin: string;
  readonly stoaOrigin: string;
  readonly surfaces: readonly HumanPlaneSurfaceObservation[];
  readonly cookies: readonly HumanPlaneCookieObservation[];
  readonly revocationRace?: {
    readonly inFlightViewStatus: number;
    readonly inFlightWriteStatus: number;
    readonly postRevokeStatus: number;
  };
}

export interface GuardAuditResult {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

export function evaluateHumanPlaneCacheAndPrivacyPair(
  snapshot: HumanPlanePrivacyPairSnapshot,
): GuardAuditResult {
  const violations: string[] = [];
  const allCanaries = [...snapshot.privateWorkshopCanaries, ...snapshot.unlistedProblemCanaries];

  // 1. Owner workshop MUST carry the owner's private canary (guards against vacuous pass!).
  const ownerSurface = snapshot.surfaces.find((s) => s.surface === "sponsor-a-workshop");
  if (!ownerSurface) {
    violations.push("OWNER_WORKSHOP_SURFACE_MISSING");
  } else {
    if (ownerSurface.status !== 200) {
      violations.push(`OWNER_WORKSHOP_UNEXPECTED_STATUS:${ownerSurface.status}`);
    }
    for (const canary of snapshot.privateWorkshopCanaries) {
      if (!ownerSurface.body.includes(canary)) {
        violations.push("OWNER_WORKSHOP_CANARY_ABSENT");
      }
    }
  }

  // 2. Private cache-control & Vary hygiene + non-owner canary exclusion across ALL other surfaces.
  for (const surf of snapshot.surfaces) {
    if (surf.isPrivate) {
      if (!isPrivateCacheControl(surf.cacheControl)) {
        violations.push(`STALE_OR_SHARED_CACHE_ON_PRIVATE:${surf.surface}:${surf.path}`);
      }
      if (surf.cacheControl && /\b(public|s-maxage)\b/i.test(surf.cacheControl)) {
        violations.push(`PUBLIC_CACHE_DIRECTIVE_ON_PRIVATE:${surf.surface}:${surf.path}`);
      }
      if (surf.vary && surf.vary.trim() === "*") {
        violations.push(`WILDCARD_VARY_MISCONFIGURED:${surf.surface}`);
      }
    }

    if (surf.surface !== "sponsor-a-workshop") {
      for (const canary of allCanaries) {
        if (canary.length > 0 && surf.body.includes(canary)) {
          violations.push(`PRIVATE_CANARY_LEAKED:${surf.surface}:${surf.path}`);
        }
      }
    }
  }

  // 3. Host-only cookie boundary: `asimp.session` / Auth.js cookies MUST stay host-only on Agora
  //    and NEVER be sent to Stoa (`a.*`).
  const stoaHost = new URL(snapshot.stoaOrigin).hostname.toLowerCase();
  for (const cookie of snapshot.cookies) {
    if (
      cookie.name.includes("session") ||
      cookie.name.includes("authjs") ||
      cookie.name.includes("next-auth")
    ) {
      if (!cookie.hostOnly) {
        violations.push(`SESSION_COOKIE_NOT_HOST_ONLY:${cookie.name}`);
      }
      if (!cookie.httpOnly) {
        violations.push(`SESSION_COOKIE_NOT_HTTP_ONLY:${cookie.name}`);
      }
      for (const sentOrigin of cookie.sentToOrigins) {
        const sentHost = new URL(sentOrigin).hostname.toLowerCase();
        if (sentHost === stoaHost || sentHost.startsWith("a.") || sentHost.startsWith("a-")) {
          violations.push(`PRINCIPAL_CONFUSION_COOKIE_SENT_TO_STOA:${cookie.name}:${sentHost}`);
        }
      }
    }
  }

  // 4. Revocation race: post-revoke requests MUST fail closed (401/403/404), never 200.
  if (snapshot.revocationRace) {
    const { inFlightWriteStatus, postRevokeStatus } = snapshot.revocationRace;
    if (![200, 201, 401, 403].includes(inFlightWriteStatus)) {
      violations.push(`REVOCATION_RACE_UNEXPECTED_INFLIGHT_STATUS:${inFlightWriteStatus}`);
    }
    if (![401, 403, 404].includes(postRevokeStatus)) {
      violations.push(`REVOCATION_BYPASSED_AFTER_REVOKE:${postRevokeStatus}`);
    }
  }

  return { ok: violations.length === 0, violations };
}

export interface HumanPlaneAccessibilityAudit {
  readonly route: string;
  readonly hasMainLandmark: boolean;
  readonly hasNavLandmark: boolean;
  readonly headingCountH1: number;
  readonly unlabeledInteractiveControls: readonly string[];
  readonly keyboardTrapDetected: boolean;
  readonly errorAnnouncementHasLiveRegion: boolean;
  readonly axeSeriousOrCriticalViolations: readonly string[];
  readonly consoleErrors: readonly string[];
  readonly pageErrors: readonly string[];
}

export function evaluateHumanPlaneAccessibility(
  audit: HumanPlaneAccessibilityAudit,
): GuardAuditResult {
  const violations: string[] = [];
  if (!audit.hasMainLandmark) violations.push(`A11Y_MISSING_MAIN_LANDMARK:${audit.route}`);
  if (!audit.hasNavLandmark) violations.push(`A11Y_MISSING_NAV_LANDMARK:${audit.route}`);
  if (audit.headingCountH1 !== 1) {
    violations.push(`A11Y_H1_COUNT_INVALID:${audit.route}:${audit.headingCountH1}`);
  }
  for (const ctrl of audit.unlabeledInteractiveControls) {
    violations.push(`A11Y_UNLABELED_CONTROL:${audit.route}:${ctrl}`);
  }
  if (audit.keyboardTrapDetected) violations.push(`A11Y_KEYBOARD_TRAP:${audit.route}`);
  if (!audit.errorAnnouncementHasLiveRegion) {
    violations.push(`A11Y_MISSING_ERROR_LIVE_REGION:${audit.route}`);
  }
  for (const axeRule of audit.axeSeriousOrCriticalViolations) {
    violations.push(`A11Y_AXE_VIOLATION:${audit.route}:${axeRule}`);
  }
  for (const err of audit.consoleErrors) {
    violations.push(`CLIENT_CONSOLE_ERROR:${audit.route}:${err.slice(0, 80)}`);
  }
  for (const err of audit.pageErrors) {
    violations.push(`CLIENT_PAGE_EXCEPTION:${audit.route}:${err.slice(0, 80)}`);
  }
  return { ok: violations.length === 0, violations };
}

const SENSITIVE_HEADER_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-asimposium-service-signature",
  "x-csrf-token",
  "x-api-key",
]);

const FORBIDDEN_REASONING_KEYS = new Set([
  "chain_of_thought",
  "hidden_reasoning",
  "raw_transcript",
  "raw_harness_transcript",
  "thinking_trace",
]);

export interface RawPlaywrightArtifact {
  readonly synthetic_only: boolean;
  readonly run_id: string;
  readonly kind: "trace" | "screenshot-meta" | "network-log" | "console-log";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly storageEntries?: Readonly<Record<string, string>>;
  readonly bodyExcerpt?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface RedactedArtifactResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly artifact?: {
    readonly run_id: string;
    readonly kind: RawPlaywrightArtifact["kind"];
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly redacted_headers: readonly string[];
    readonly body_sha256: string | null;
    readonly redacted: true;
  };
}

function stripFragmentAndQuerySecrets(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/(token|secret|key|code|state|session|cookie|sig)/i.test(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    return parsed.toString();
  } catch {
    return rawUrl.replace(/#.*$/u, "");
  }
}

/**
 * Enforces W10.8 artifact safety before persistence:
 * - Refuses recording entirely on any non-synthetic/private run.
 * - Refuses any artifact carrying raw harness transcripts or hidden reasoning (Rule A11).
 * - Strips URL fragments (`#v1.<secret>`), sensitive headers, and browser storage values.
 * - Scans serialized output through the canonical never-log redactor/detector.
 */
export function redactHumanPlaneArtifact(raw: RawPlaywrightArtifact): RedactedArtifactResult {
  if (!raw.synthetic_only) {
    return { ok: false, reason: "ARTIFACT_RECORDING_DISABLED_ON_NON_SYNTHETIC_RUN" };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(raw.run_id)) {
    return { ok: false, reason: "INVALID_ARTIFACT_RUN_ID" };
  }
  if (raw.extra) {
    for (const key of Object.keys(raw.extra)) {
      if (FORBIDDEN_REASONING_KEYS.has(key.toLowerCase())) {
        return { ok: false, reason: `FORBIDDEN_HIDDEN_REASONING_FIELD:${key}` };
      }
    }
  }

  const cleanHeaders: Record<string, string> = {};
  const redactedHeaders: string[] = [];
  for (const [key, value] of Object.entries(raw.headers)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_HEADER_KEYS.has(lower)) {
      redactedHeaders.push(lower);
    } else {
      cleanHeaders[lower] = redactOpsText(value);
    }
  }
  redactedHeaders.sort();

  const cleanUrl = redactOpsText(stripFragmentAndQuerySecrets(raw.url));
  const bodySha =
    raw.bodyExcerpt !== undefined
      ? createHash("sha256").update(raw.bodyExcerpt).digest("hex")
      : null;

  const candidate = {
    run_id: raw.run_id,
    kind: raw.kind,
    url: cleanUrl,
    headers: cleanHeaders,
    redacted_headers: redactedHeaders,
    body_sha256: bodySha,
    redacted: true as const,
  };

  if (containsNeverLogMaterial(JSON.stringify(candidate))) {
    return { ok: false, reason: "NEVER_LOG_MATERIAL_REMAINED_AFTER_REDACTION" };
  }

  return { ok: true, artifact: candidate };
}

export interface HumanPlaneOpsRecord {
  readonly facility: "OPS.2a";
  readonly suite: "e2e-human-plane";
  readonly run_id: string;
  readonly route: string;
  readonly action: string;
  readonly principal: "anonymous" | "sponsor-a" | "sponsor-b" | "fellow-a" | "fellow-b";
  readonly synthetic_ids: Readonly<Record<string, string>>;
  readonly request_id: string | null;
  readonly event_id: string | null;
  readonly cursor: number | null;
  readonly render_digest: string;
  readonly cache_control: string | null;
  readonly status: "pass" | "fail" | "blocked";
  readonly duration_ms: number;
}

export function buildHumanPlaneOpsRecord(
  input: Omit<HumanPlaneOpsRecord, "facility" | "suite" | "render_digest"> & {
    readonly renderedText: string;
  },
): HumanPlaneOpsRecord {
  const record: HumanPlaneOpsRecord = {
    facility: "OPS.2a",
    suite: "e2e-human-plane",
    run_id: input.run_id,
    route: input.route,
    action: input.action,
    principal: input.principal,
    synthetic_ids: input.synthetic_ids,
    request_id: input.request_id,
    event_id: input.event_id,
    cursor: input.cursor,
    render_digest: createHash("sha256").update(input.renderedText).digest("hex"),
    cache_control: input.cache_control,
    status: input.status,
    duration_ms: Math.max(0, Math.round(input.duration_ms)),
  };
  if (containsNeverLogMaterial(JSON.stringify(record))) {
    throw new Error("OPS2A_HUMAN_PLANE_RECORD_CONTAINS_NEVER_LOG_MATERIAL");
  }
  return record;
}
