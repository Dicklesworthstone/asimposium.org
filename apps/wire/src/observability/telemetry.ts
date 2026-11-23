/**
 * OPS.4 Observability, Pre-Egress Sentry/Analytics Redaction, Launch Alerts,
 * Balanced Health-Metric Catalog, and Anti-Metric / Token Boundary Enforcement
 * (`asimposiumorg-286`, Fable §13.3 & §14.3, Rule A4 & Rule A10 / ADR-19 / ADR-26).
 *
 * Design principles:
 *  - Observability shares `request_id` / `event_id` / `scope_cursor` / `outbox_id`
 *    correlation without becoming a second event store.
 *  - Structured logs name route template, principal CLASS (never concrete identity),
 *    command/event kind, status/error code, degraded reason, D1/DO/R2/outbox timings,
 *    and retries; raw queries, bodies, credentials, fragments, cookies, directives,
 *    workshop drafts, detector internals, and hidden reasoning NEVER cross egress.
 *  - Every metric names its consumer and the decision it changes (Rule A10).
 *  - Gauntlet-only token totals (`tokens_per_useful_action`) are isolated strictly
 *    to controlled usability runs and refused from production analytics, `/stats`,
 *    projections, calibration, ranking, or honors.
 */

import {
  containsCredentialShape,
  REDACTED_TOKEN,
  redactCredentials,
} from "../../../../packages/contracts/src/diagnostic-safety.ts";
import { assertNoStatsAntiMetrics } from "../../../../packages/contracts/src/stats.ts";
import { redactPathname } from "../http/redact.ts";

export const OPS_TELEMETRY_SCHEMA = "asimposium.ops2a.telemetry.v1" as const;

export type ObservabilityPlane = "stoa" | "agora" | "cli";
export type PrincipalClass = "anonymous" | "fellow" | "sponsor" | "operator" | "system";
export type MetricVisibility = "public-stats" | "operator-only" | "gauntlet-only";
export type HealthMetricFamily =
  | "COLLABORATION"
  | "QUALITY"
  | "ERGONOMICS"
  | "COMPREHENSION"
  | "SAFETY"
  | "OPERATOR_INFRA";

export interface TelemetryTimingMs {
  readonly total: number;
  readonly d1?: number;
  readonly do?: number;
  readonly r2?: number;
  readonly outbox?: number;
}

export interface OpsTelemetryCorrelation {
  readonly request_id: string;
  readonly event_id: string | null;
  readonly scope_cursor: number | null;
  readonly outbox_id: string | null;
}

export interface OpsTelemetryRecord {
  readonly facility: "OPS.2a";
  readonly schema_version: typeof OPS_TELEMETRY_SCHEMA;
  readonly recorded_at: string;
  readonly revision: string;
  readonly plane: ObservabilityPlane;
  readonly route_template: string;
  readonly principal_class: PrincipalClass;
  readonly command_or_event_kind: string;
  readonly status_code: number;
  readonly error_code: string | null;
  readonly degraded_reason: string | null;
  readonly correlation: OpsTelemetryCorrelation;
  readonly timing_ms: TelemetryTimingMs;
  readonly retries: number;
  readonly sink_ack: boolean;
}

const SENSITIVE_KEY_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "set_cookie",
  "x-asimposium-service-signature",
  "x-asimp-signature",
  "x-asimp-service-sig",
  "x-csrf-token",
  "x-api-key",
  "secret",
  "enrollment_secret",
  "token",
  "bearer_token",
  "access_token",
  "refresh_token",
  "id_token",
  "authorization_code",
  "flow_handle",
  "device_code",
  "user_code",
  "signature",
  "signing_key",
  "private_key",
  "private_key_pem",
  "seed_hex",
  "directive_body",
  "workshop_body",
  "private_body",
  "body_md",
  "raw_body",
  "raw_query",
  "candidate_json",
  "presigned_url",
  "detector_name",
  "detector_detail",
  "pattern_name",
  "pattern_id",
  "raw_score",
  "category_scores_raw",
  "screening_reasoning",
  "chain_of_thought",
  "hidden_reasoning",
  "raw_transcript",
  "raw_harness_transcript",
  "thinking_trace",
  "email",
  "sponsor_email",
  "recipient_email",
  "ip",
  "ip_address",
  "client_ip",
  "remote_addr",
]);

const SENSITIVE_QUERY_PARAM_RE =
  /(token|secret|key|code|state|session|cookie|sig|auth|pass|cred|jwt|email|ip|handle|fragment)/i;

const EXTRA_EGRESS_SCRUB_PATTERNS: readonly RegExp[] = [
  // Presigned S3/R2 query params
  /([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|X-Amz-Algorithm)=)[^&#\s]+/gi,
  // Host-only / Secure session cookies (scrub entire name=value so cookie names don't trip detectors)
  /(?:__Host-|__Secure-)?(?:authjs|next-auth|asimp)\.session(?:-token)?\s*=\s*[^;\s,"']+/gi,
  // Generic Bearer tokens (OAuth, Resend, Cloudflare, Sentry, etc.)
  /(\bBearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi,
  // Service envelope & key assignments
  /(\b(?:x-asimposium-service-signature|x-asimp-service-sig|x-asimp-signature|authorization|cookie|set-cookie|signing_key|seed_hex|private_key_pem)"?\s*(?:=|:)\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&]+)/gi,
  // JWT shape (three base64url segments starting with eyJ)
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Email addresses (PII)
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  // IPv4-mapped IPv6 addresses (redact full ::ffff:a.b.c.d token before IPv4 split)
  /(?<![A-Za-z0-9_:])::(?:ffff:)?(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![A-Za-z0-9_:.])/gi,
  // IPv4 addresses (bounded security need excluded from routine sinks)
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  // IPv6 addresses: full 8-group (7 colons) OR :: compressed (prefix+::+suffix or ::+suffix),
  // never matching 2-colon SQLite/ISO timestamps like 05:44:03 or Rust/C++ paths like std::io.
  /(?<![A-Za-z0-9_:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?|::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}))(?![A-Za-z0-9_:])/gi,
  // Concrete actor identities (Fellow/Sponsor IDs must not leak into routine sinks)
  /\bF-[0-9A-HJKMNP-TV-Z]{10,}\b/gi,
  /\busr_[A-Za-z0-9_-]{6,}\b/g,
];

export function containsExtraSensitivePattern(text: string): boolean {
  for (const pattern of EXTRA_EGRESS_SCRUB_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      pattern.lastIndex = 0;
      return true;
    }
    pattern.lastIndex = 0;
  }
  return false;
}

const IPV4_HOSTNAME_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

function sanitizeParsedUrl(parsed: URL): string {
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  if (parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]") {
    parsed.hostname = "loopback.local";
  } else if (IPV4_HOSTNAME_RE.test(parsed.hostname) || parsed.hostname.startsWith("[")) {
    parsed.hostname = "ip-redacted.invalid";
  }
  parsed.pathname = redactPathname(parsed.pathname);
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_QUERY_PARAM_RE.test(key)) {
      parsed.searchParams.delete(key);
    } else {
      const val = parsed.searchParams.get(key) ?? "";
      if (containsCredentialShape(val) || containsExtraSensitivePattern(val)) {
        parsed.searchParams.delete(key);
      }
    }
  }
  return parsed.toString();
}

/**
 * Redacts a URL for observability egress: strips credentials, fragments (`#v1.<secret>`),
 * passes pathname through the canonical Worker `redactPathname`, and removes
 * secret/PII query parameters.
 */
export function sanitizeObservabilityUrl(rawUrl: string): string {
  try {
    return sanitizeParsedUrl(new URL(rawUrl));
  } catch {
    return scrubObservabilityText(rawUrl.replace(/#.*$/u, ""));
  }
}

/**
 * Scrubs free-form text (error messages, stack lines, log strings) prior to
 * Sentry or Analytics egress.
 */
export function scrubObservabilityText(input: string): string {
  // Strip any embedded URL fragments carrying enrollment secrets before running regexes.
  let out = input.replace(/#v1\.[A-Za-z0-9._-]+/gi, `#${REDACTED_TOKEN}`);
  // Sanitize embedded http(s) URLs so path segments, basic-auth, and query params get scrubbed too.
  out = out.replace(/https?:\/\/[^\s"'<>)\]]+/gi, (match) => {
    try {
      return sanitizeParsedUrl(new URL(match));
    } catch {
      return match;
    }
  });
  out = redactCredentials(out);
  for (const pattern of EXTRA_EGRESS_SCRUB_PATTERNS) {
    out = out.replace(pattern, (_full, prefix?: string) =>
      typeof prefix === "string" ? `${prefix}${REDACTED_TOKEN}` : REDACTED_TOKEN,
    );
  }
  return out;
}

/**
 * Pre-egress recursive scrubber for Sentry events and Workers Analytics payloads.
 * Removes every forbidden secret/PII/body/detector/CoT field and verifies zero
 * credential shapes survive serialization.
 */
export function scrubObservabilityPayload(
  payload: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof payload === "string") {
    return scrubObservabilityText(payload);
  }
  if (payload === null || typeof payload !== "object") {
    return payload;
  }
  if (seen.has(payload)) {
    return "[CIRCULAR]";
  }
  seen.add(payload);

  if (Array.isArray(payload)) {
    return payload.map((item) => scrubObservabilityPayload(item, seen));
  }
  if (payload instanceof Date) {
    return Number.isNaN(payload.getTime()) ? "Invalid Date" : payload.toISOString();
  }
  if (payload instanceof URL) {
    return sanitizeObservabilityUrl(payload.toString());
  }
  if (payload instanceof Set) {
    return [...payload].map((item) => scrubObservabilityPayload(item, seen));
  }
  if (payload instanceof Map) {
    const mapOut: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const omittedMapKeys: string[] = [];
    for (const [rawKey, val] of payload.entries()) {
      const key = String(rawKey);
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        omittedMapKeys.push(key);
        continue;
      }
      if (SENSITIVE_KEY_NAMES.has(key.toLowerCase())) {
        omittedMapKeys.push(key);
        continue;
      }
      Object.defineProperty(mapOut, scrubObservabilityText(key), {
        value: scrubObservabilityPayload(val, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    if (omittedMapKeys.length > 0) {
      Object.defineProperty(mapOut, "_omitted_sensitive_fields", {
        value: omittedMapKeys.sort(),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return mapOut;
  }
  if (payload instanceof Error) {
    const errOut: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(errOut, "name", {
      value: scrubObservabilityText(payload.name),
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(errOut, "message", {
      value: scrubObservabilityText(payload.message),
      enumerable: true,
      configurable: true,
      writable: true,
    });
    if (typeof payload.stack === "string") {
      Object.defineProperty(errOut, "stack", {
        value: scrubObservabilityText(payload.stack),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    const omittedErrFields: string[] = [];
    for (const [key, val] of Object.entries(payload as unknown as Record<string, unknown>)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        omittedErrFields.push(key);
        continue;
      }
      if (SENSITIVE_KEY_NAMES.has(key.toLowerCase())) {
        omittedErrFields.push(key);
        continue;
      }
      Object.defineProperty(errOut, key, {
        value: scrubObservabilityPayload(val, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    if (omittedErrFields.length > 0) {
      Object.defineProperty(errOut, "_omitted_sensitive_fields", {
        value: omittedErrFields.sort(),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return errOut;
  }

  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const omittedFields: string[] = [];
  for (const [key, val] of Object.entries(payload as Record<string, unknown>)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      omittedFields.push(key);
      continue;
    }
    const lower = key.toLowerCase();
    if (SENSITIVE_KEY_NAMES.has(lower)) {
      omittedFields.push(key);
      continue;
    }
    const safeVal =
      (lower === "url" || lower === "request_url" || lower === "href") && typeof val === "string"
        ? sanitizeObservabilityUrl(val)
        : scrubObservabilityPayload(val, seen);
    Object.defineProperty(out, key, {
      value: safeVal,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  if (omittedFields.length > 0) {
    Object.defineProperty(out, "_omitted_sensitive_fields", {
      value: omittedFields.sort(),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

/**
 * Final fail-closed egress check before emitting to Sentry, Analytics, or OPS.2a logs.
 */
export function prepareRedactedSinkEvent(
  sink: "sentry" | "analytics" | "ops2a",
  rawEvent: Record<string, unknown>,
): { readonly sink: "sentry" | "analytics" | "ops2a"; readonly payload: Record<string, unknown> } {
  const scrubbed = scrubObservabilityPayload(rawEvent) as Record<string, unknown>;
  const serialized = JSON.stringify(scrubbed);
  if (containsCredentialShape(serialized) || containsExtraSensitivePattern(serialized)) {
    throw new Error(
      `OBSERVABILITY_EGRESS_LEAK_REFUSED: ${sink} payload still matched forbidden secret/PII shape after redaction`,
    );
  }
  return { sink, payload: scrubbed };
}

function safeNonNegativeMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      "OPS2A_INVALID_TIMING_MS: timing_ms values must be finite non-negative numbers",
    );
  }
  return Math.round(value);
}

/**
 * Builds one validated, redacted OPS.2a structured telemetry record carrying
 * `request_id` / `event_id` / `scope_cursor` / `outbox_id` correlation.
 */
export function buildOpsTelemetryRecord(input: {
  readonly revision: string;
  readonly plane: ObservabilityPlane;
  readonly route_template: string;
  readonly principal_class: PrincipalClass;
  readonly command_or_event_kind: string;
  readonly status_code: number;
  readonly error_code?: string | null;
  readonly degraded_reason?: string | null;
  readonly correlation: OpsTelemetryCorrelation;
  readonly timing_ms: TelemetryTimingMs;
  readonly retries?: number;
  readonly sink_ack?: boolean;
  readonly recorded_at?: string;
}): OpsTelemetryRecord {
  if (!input.route_template.startsWith("/")) {
    throw new Error("OPS2A_INVALID_ROUTE_TEMPLATE: route_template must start with '/'");
  }
  if (input.route_template.includes("?") || input.route_template.includes("#")) {
    throw new Error(
      "OPS2A_RAW_QUERY_OR_FRAGMENT_FORBIDDEN: route_template must omit raw query strings and fragments",
    );
  }
  if (!Number.isInteger(input.status_code) || input.status_code < 100 || input.status_code > 599) {
    throw new RangeError("OPS2A_INVALID_STATUS_CODE: status_code must be an integer in 100..599");
  }
  if (
    !input.correlation.request_id ||
    containsCredentialShape(input.correlation.request_id) ||
    containsExtraSensitivePattern(input.correlation.request_id)
  ) {
    throw new Error("OPS2A_INVALID_REQUEST_ID");
  }
  const safeTiming: TelemetryTimingMs = {
    total: safeNonNegativeMs(input.timing_ms.total),
    ...(input.timing_ms.d1 !== undefined ? { d1: safeNonNegativeMs(input.timing_ms.d1) } : {}),
    ...(input.timing_ms.do !== undefined ? { do: safeNonNegativeMs(input.timing_ms.do) } : {}),
    ...(input.timing_ms.r2 !== undefined ? { r2: safeNonNegativeMs(input.timing_ms.r2) } : {}),
    ...(input.timing_ms.outbox !== undefined
      ? { outbox: safeNonNegativeMs(input.timing_ms.outbox) }
      : {}),
  };
  const safeRetries = input.retries ?? 0;
  if (!Number.isFinite(safeRetries) || safeRetries < 0) {
    throw new RangeError("OPS2A_INVALID_RETRIES: retries must be finite and non-negative");
  }

  const recordedAt = input.recorded_at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(recordedAt))) {
    throw new RangeError("OPS2A_INVALID_RECORDED_AT: recorded_at must be a valid timestamp");
  }

  const record: OpsTelemetryRecord = {
    facility: "OPS.2a",
    schema_version: OPS_TELEMETRY_SCHEMA,
    recorded_at: recordedAt,
    revision: input.revision,
    plane: input.plane,
    route_template: redactPathname(input.route_template),
    principal_class: input.principal_class,
    command_or_event_kind: input.command_or_event_kind,
    status_code: input.status_code,
    error_code: input.error_code ?? null,
    degraded_reason: input.degraded_reason ?? null,
    correlation: input.correlation,
    timing_ms: safeTiming,
    retries: Math.trunc(safeRetries),
    sink_ack: input.sink_ack ?? true,
  };

  const serialized = JSON.stringify(record);
  if (containsCredentialShape(serialized) || containsExtraSensitivePattern(serialized)) {
    throw new Error("OPS2A_TELEMETRY_CREDENTIAL_LEAK_REFUSED");
  }
  return record;
}

// -----------------------------------------------------------------------------
// Launch Alerting (Fable §13.3 / OPS.4: 6 mandatory launch alerts)
// -----------------------------------------------------------------------------

export type LaunchAlertId =
  | "ALERT_ERROR_SPIKE"
  | "ALERT_REVOCATION_NOT_EFFECTIVE"
  | "ALERT_QUARANTINE_BACKLOG"
  | "ALERT_OUTBOX_OLDEST_AGE"
  | "ALERT_D1_STORAGE_CEILING"
  | "ALERT_BACKUP_FAILURE";

export interface LaunchAlertDefinition {
  readonly id: LaunchAlertId;
  readonly severity: "critical" | "high";
  readonly threshold_description: string;
  readonly runbook_path: string;
  readonly dedupe_window_seconds: number;
  readonly consumer: string;
  readonly decision_changed: string;
}

export const LAUNCH_ALERT_DEFINITIONS: readonly LaunchAlertDefinition[] = [
  {
    id: "ALERT_ERROR_SPIKE",
    severity: "high",
    threshold_description: "5xx / internal error rate > 5% over trailing window (min 20 requests)",
    runbook_path: "docs/runbooks/outbox-backlog.md",
    dedupe_window_seconds: 300,
    consumer: "on-call operator",
    decision_changed:
      "Trigger immediate rollback or degraded-mode shedding before user impact widens.",
  },
  {
    id: "ALERT_REVOCATION_NOT_EFFECTIVE",
    severity: "critical",
    threshold_description: "Any post-revocation token or session acceptance (> 0 occurrences)",
    runbook_path: "docs/runbooks/credential-compromise.md",
    dedupe_window_seconds: 60,
    consumer: "security operator",
    decision_changed: "Freeze write plane immediately and rotate signing/revocation state.",
  },
  {
    id: "ALERT_QUARANTINE_BACKLOG",
    severity: "high",
    threshold_description: "Open screening quarantine backlog > 20 items",
    runbook_path: "docs/runbooks/screening-provider-outage.md",
    dedupe_window_seconds: 900,
    consumer: "moderation operator",
    decision_changed: "Prioritize quarantine review or evaluate OQ-5 trusted-sponsor relief valve.",
  },
  {
    id: "ALERT_OUTBOX_OLDEST_AGE",
    severity: "high",
    threshold_description: "Oldest pending D1 outbox row age > 300 seconds",
    runbook_path: "docs/runbooks/outbox-backlog.md",
    dedupe_window_seconds: 300,
    consumer: "krater operator",
    decision_changed: "Run ops-outbox-reconcile and inspect KraterOutboxDrainer DO alarm health.",
  },
  {
    id: "ALERT_D1_STORAGE_CEILING",
    severity: "high",
    threshold_description: "D1 database utilization > 60% of 10GB ceiling",
    runbook_path: "docs/runbooks/nightly-ledger-backups.md",
    dedupe_window_seconds: 3600,
    consumer: "infrastructure operator",
    decision_changed: "Verify R2 body offloading and schedule R-7 scope-based sharding plan.",
  },
  {
    id: "ALERT_BACKUP_FAILURE",
    severity: "critical",
    threshold_description: "Consecutive nightly backup or deletion-journal failures >= 1",
    runbook_path: "docs/runbooks/nightly-ledger-backups.md",
    dedupe_window_seconds: 900,
    consumer: "backup operator",
    decision_changed:
      "Re-run nightly-ledger-backup manually and verify R2/checkpoint health before G1/G2.",
  },
];

export interface LaunchAlertMetricsSnapshot {
  readonly observed_at_ms: number;
  readonly request_count: number;
  readonly error_5xx_count: number;
  readonly post_revocation_acceptances: number;
  readonly quarantine_backlog_count: number;
  readonly outbox_oldest_age_seconds: number;
  readonly d1_storage_pct: number;
  readonly consecutive_backup_failures: number;
  readonly correlation_request_id?: string | null;
  readonly correlation_outbox_id?: string | null;
}

export interface AlertTransitionEvent {
  readonly alert_id: LaunchAlertId;
  readonly state: "firing" | "recovered";
  readonly severity: "critical" | "high";
  readonly runbook_path: string;
  readonly observed_value: number;
  readonly threshold_description: string;
  readonly observed_at_ms: number;
  readonly correlation_request_id: string | null;
  readonly correlation_outbox_id: string | null;
}

interface ActiveAlertState {
  firing: boolean;
  lastNotifiedMs: number;
}

function assertFiniteNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`ALERT_SNAPSHOT_INVALID_METRIC:${name}`);
  }
}

function extractAlertObservation(
  id: LaunchAlertId,
  m: LaunchAlertMetricsSnapshot,
): { readonly breached: boolean; readonly value: number } {
  switch (id) {
    case "ALERT_ERROR_SPIKE": {
      const rate = m.request_count >= 20 ? Math.min(1, m.error_5xx_count / m.request_count) : 0;
      return { breached: rate > 0.05, value: Math.round(rate * 10_000) / 100 };
    }
    case "ALERT_REVOCATION_NOT_EFFECTIVE":
      return {
        breached: m.post_revocation_acceptances > 0,
        value: m.post_revocation_acceptances,
      };
    case "ALERT_QUARANTINE_BACKLOG":
      return {
        breached: m.quarantine_backlog_count > 20,
        value: m.quarantine_backlog_count,
      };
    case "ALERT_OUTBOX_OLDEST_AGE":
      return {
        breached: m.outbox_oldest_age_seconds > 300,
        value: m.outbox_oldest_age_seconds,
      };
    case "ALERT_D1_STORAGE_CEILING":
      return {
        breached: m.d1_storage_pct > 60,
        value: m.d1_storage_pct,
      };
    case "ALERT_BACKUP_FAILURE":
      return {
        breached: m.consecutive_backup_failures >= 1,
        value: m.consecutive_backup_failures,
      };
  }
}

/**
 * Stateful launch-alert evaluator with threshold firing, dedupe-window
 * suppression, and automatic recovery transitions.
 */
export class LaunchAlertEvaluator {
  private readonly states = new Map<LaunchAlertId, ActiveAlertState>();

  evaluate(snapshot: LaunchAlertMetricsSnapshot): {
    readonly notifications: readonly AlertTransitionEvent[];
    readonly deduped: readonly LaunchAlertId[];
    readonly active_alerts: readonly LaunchAlertId[];
  } {
    assertFiniteNonNegative("observed_at_ms", snapshot.observed_at_ms);
    assertFiniteNonNegative("request_count", snapshot.request_count);
    assertFiniteNonNegative("error_5xx_count", snapshot.error_5xx_count);
    assertFiniteNonNegative("post_revocation_acceptances", snapshot.post_revocation_acceptances);
    assertFiniteNonNegative("quarantine_backlog_count", snapshot.quarantine_backlog_count);
    assertFiniteNonNegative("outbox_oldest_age_seconds", snapshot.outbox_oldest_age_seconds);
    assertFiniteNonNegative("d1_storage_pct", snapshot.d1_storage_pct);
    assertFiniteNonNegative("consecutive_backup_failures", snapshot.consecutive_backup_failures);

    const notifications: AlertTransitionEvent[] = [];
    const deduped: LaunchAlertId[] = [];

    for (const def of LAUNCH_ALERT_DEFINITIONS) {
      const obs = extractAlertObservation(def.id, snapshot);
      const prev = this.states.get(def.id) ?? { firing: false, lastNotifiedMs: 0 };

      if (obs.breached) {
        const dedupeMs = def.dedupe_window_seconds * 1_000;
        const elapsed = snapshot.observed_at_ms - prev.lastNotifiedMs;
        // If clock stepped backwards (elapsed < 0), treat as expired dedupe rather than suppressing alerts.
        const withinDedupe = prev.firing && elapsed >= 0 && elapsed < dedupeMs;
        if (withinDedupe) {
          deduped.push(def.id);
        } else {
          this.states.set(def.id, { firing: true, lastNotifiedMs: snapshot.observed_at_ms });
          notifications.push({
            alert_id: def.id,
            state: "firing",
            severity: def.severity,
            runbook_path: def.runbook_path,
            observed_value: obs.value,
            threshold_description: def.threshold_description,
            observed_at_ms: snapshot.observed_at_ms,
            correlation_request_id: snapshot.correlation_request_id ?? null,
            correlation_outbox_id: snapshot.correlation_outbox_id ?? null,
          });
        }
      } else if (prev.firing) {
        this.states.set(def.id, { firing: false, lastNotifiedMs: snapshot.observed_at_ms });
        notifications.push({
          alert_id: def.id,
          state: "recovered",
          severity: def.severity,
          runbook_path: def.runbook_path,
          observed_value: obs.value,
          threshold_description: def.threshold_description,
          observed_at_ms: snapshot.observed_at_ms,
          correlation_request_id: snapshot.correlation_request_id ?? null,
          correlation_outbox_id: snapshot.correlation_outbox_id ?? null,
        });
      }
    }

    const activeAlerts = [...this.states.entries()]
      .filter(([, s]) => s.firing)
      .map(([id]) => id)
      .sort();

    return { notifications, deduped, active_alerts: activeAlerts };
  }
}

// -----------------------------------------------------------------------------
// Rule A10 Metric Consumer Catalog & Public vs Operator / Gauntlet Isolation
// -----------------------------------------------------------------------------

export interface MetricConsumerEntry {
  readonly id: string;
  readonly family: HealthMetricFamily;
  readonly visibility: MetricVisibility;
  readonly consumer: string;
  readonly decision_changed: string;
}

export const METRIC_CONSUMER_CATALOG: readonly MetricConsumerEntry[] = [
  {
    id: "collaboration.median_hours_to_first_external_sponsor",
    family: "COLLABORATION",
    visibility: "public-stats",
    consumer: "Symposiarch curation & G1/G3 review",
    decision_changed:
      "Detect isolated single-sponsor boards and adjust discovery/matchmaking visibility.",
  },
  {
    id: "collaboration.multi_sponsor_active_problem_share",
    family: "COLLABORATION",
    visibility: "public-stats",
    consumer: "Platform stewards & public readers",
    decision_changed: "Verify whether cross-sponsor independence holds across active problems.",
  },
  {
    id: "collaboration.handback_completion_rate",
    family: "COLLABORATION",
    visibility: "public-stats",
    consumer: "Agent-ergonomics maintainer",
    decision_changed:
      "Identify friction in session-close handbacks and refine capsule/skill instructions.",
  },
  {
    id: "quality.consequential_claims_independent_review_coverage",
    family: "QUALITY",
    visibility: "public-stats",
    consumer: "Review matchmaking & launch gates",
    decision_changed:
      "Prioritize review-queue surfacing when consequential claims lack T2+ review.",
  },
  {
    id: "quality.reproduction_pass_rate",
    family: "QUALITY",
    visibility: "public-stats",
    consumer: "Seed-ladder & artifact maintainers",
    decision_changed:
      "Diagnose brittle artifact/environment specs in computational reproduction problems.",
  },
  {
    id: "quality.dead_ends_with_retry_predicate",
    family: "QUALITY",
    visibility: "public-stats",
    consumer: "Protocol validator (P6) maintainer",
    decision_changed: "Confirm dead-end quality gate prevents low-substance null farming.",
  },
  {
    id: "ergonomics.idempotent_writes_recorded",
    family: "ERGONOMICS",
    visibility: "public-stats",
    consumer: "Stoa API & CLI maintainer",
    decision_changed: "Verify agents and asimp spool use Idempotency-Key safely across retries.",
  },
  {
    id: "ergonomics.tokens_per_useful_action",
    family: "ERGONOMICS",
    visibility: "gauntlet-only",
    consumer: "Cold-Agent Gauntlet (R-22) ceremony trend gate",
    decision_changed:
      "Compress packs/schemas when cold-agent median tokens drift toward 25K budget.",
  },
  {
    id: "comprehension.false_solved_reports_recorded",
    family: "COMPREHENSION",
    visibility: "public-stats",
    consumer: "Agora UI & Rule A4 honesty review",
    decision_changed: "Tighten status banners and disclaimers if readers misread claims as PROVED.",
  },
  {
    id: "safety.screening_appeal_reversal_rate",
    family: "SAFETY",
    visibility: "public-stats",
    consumer: "Symposiarch screening policy owner",
    decision_changed:
      "Recalibrate L1/L2 false-positive boundary when legitimate math is over-quarantined.",
  },
  {
    id: "operator.writes_by_kind_and_error_code",
    family: "OPERATOR_INFRA",
    visibility: "operator-only",
    consumer: "Workers Analytics & Stoa maintainer",
    decision_changed:
      "Spot protocol error spikes or pack-profile pressure without exposing actor counts.",
  },
  {
    id: "operator.outbox_and_backup_health",
    family: "OPERATOR_INFRA",
    visibility: "operator-only",
    consumer: "OPS.4 alert evaluator & backup runbook",
    decision_changed:
      "Trigger outbox drain reconciliation or backup recovery before data-plane lag compounds.",
  },
];

const FORBIDDEN_GAUNTLET_OR_DERIVABLE_KEYS = new Set([
  "tokens_per_fellow",
  "fellow_token_totals",
  "per_problem_activity",
  "per_problem_contribution_volume",
  "problem_activity_ranking",
  "model_token_efficiency",
  "model_win_rate",
  "gauntlet_token_total",
  "gauntlet_tokens_per_action",
  "tokens_used_by_fellow",
]);

/**
 * Enforces OPS.4 metric visibility & token boundary across production sinks:
 * - Public `/stats` payloads MUST pass Rule A10 `assertNoStatsAntiMetrics` AND
 *   contain zero per-problem activity breakdowns or numeric gauntlet token counts.
 * - Production analytics, projections, calibration, and honors MUST NOT ingest
 *   gauntlet-only token totals or actor/model rankings.
 */
export function assertObservabilityBoundary(
  target: "public-stats" | "production-analytics" | "calibration-or-honors",
  payload: unknown,
  path = "$",
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (target === "public-stats" || target === "calibration-or-honors") {
    assertNoStatsAntiMetrics(payload, path);
  }
  if (payload === null || typeof payload !== "object") return;
  if (seen.has(payload)) return;
  seen.add(payload);

  if (Array.isArray(payload)) {
    for (let i = 0; i < payload.length; i += 1) {
      assertObservabilityBoundary(target, payload[i], `${path}[${i}]`, seen);
    }
    return;
  }

  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/-/g, "_");
    if (FORBIDDEN_GAUNTLET_OR_DERIVABLE_KEYS.has(normalized)) {
      throw new Error(
        `OBSERVABILITY_BOUNDARY_VIOLATION at ${path}.${key}: forbidden key '${key}' in ${target}`,
      );
    }
    if (
      normalized === "tokens_per_useful_action" &&
      typeof value === "number" &&
      (target === "public-stats" ||
        target === "production-analytics" ||
        target === "calibration-or-honors")
    ) {
      throw new Error(
        `GAUNTLET_TOKEN_BOUNDARY_VIOLATION at ${path}.${key}: numeric gauntlet token totals cannot enter ${target}`,
      );
    }
    assertObservabilityBoundary(target, value, `${path}.${key}`, seen);
  }
}
