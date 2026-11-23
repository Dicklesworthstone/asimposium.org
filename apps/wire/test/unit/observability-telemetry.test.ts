import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertObservabilityBoundary,
  buildOpsTelemetryRecord,
  LAUNCH_ALERT_DEFINITIONS,
  LaunchAlertEvaluator,
  METRIC_CONSUMER_CATALOG,
  prepareRedactedSinkEvent,
  scrubObservabilityPayload,
} from "../../src/observability/telemetry.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");

describe("OPS.4 Observability: correlation, pre-egress scrubbing, launch alerts, & metric boundaries (asimposiumorg-286)", () => {
  test("OPS.2a structured telemetry correlates request_id/event_id/scope_cursor/outbox_id without raw queries or identities", () => {
    const rec = buildOpsTelemetryRecord({
      revision: "ee310d5b",
      plane: "stoa",
      route_template: "/v1/sessions/:id/promote",
      principal_class: "fellow",
      command_or_event_kind: "claim.created",
      status_code: 422,
      error_code: "MISSING_FALSIFIER",
      degraded_reason: null,
      correlation: {
        request_id: "req-ops4-001",
        event_id: "EV-01OPS4000000000000000001",
        scope_cursor: 42,
        outbox_id: "OB-991",
      },
      timing_ms: { total: 41.7, d1: 18.2, do: 5.1, outbox: 3.4 },
      retries: 1,
    });

    expect(rec.facility).toBe("OPS.2a");
    expect(rec.principal_class).toBe("fellow");
    expect(rec.correlation.scope_cursor).toBe(42);
    expect(rec.timing_ms.total).toBe(42);

    // Raw query string or fragment on route_template is refused fail-closed.
    expect(() =>
      buildOpsTelemetryRecord({
        revision: "ee310d5b",
        plane: "stoa",
        route_template: "/search?q=secret_workshop_text",
        principal_class: "anonymous",
        command_or_event_kind: "search.read",
        status_code: 200,
        correlation: { request_id: "req-2", event_id: null, scope_cursor: null, outbox_id: null },
        timing_ms: { total: 10 },
      }),
    ).toThrow(/OPS2A_RAW_QUERY_OR_FRAGMENT_FORBIDDEN/);
  });

  test("CANARY PROPERTY SUITE: injects 12 secret/PII/private-body/CoT/detector canaries across every header, URL, query, error & stack path and proves ZERO survive to Sentry or Analytics", () => {
    const canaries = {
      fellowToken: ["asimp", "ag", "01JXYZ4K6QABCDEFGHJKMNPQRS", "S".repeat(43)].join("_"),
      joinFragment: "v1.superSecretEnrollmentFragment998877",
      flowHandle: `flow_v1.${"F".repeat(43)}`,
      sessionCookie: "__Host-asimp.session=cookieSecretValue887766",
      serviceSig: "x-asimposium-service-signature=hmacSecretHex11223344",
      presignedSig: "X-Amz-Signature=deadbeefcafebabe0011223344556677",
      jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzcG9uc29yIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      email: "sponsor.private.canary@example.org",
      ip: "203.0.113.42",
      workshopCanary: "PRIVATE_WORKSHOP_CANARY_OPS4_NEVER_EGRESS",
      detectorDetail: "ACIP_INTERNAL_REGEX_RULE_42",
      hiddenCoT: "SECRET_CHAIN_OF_THOUGHT_CANARY",
    };

    const rawSentryEvent: Record<string, unknown> = {
      request_id: "req-canary-001",
      url: `https://a.asimposium.org/join/ASIMP-EN-01/${canaries.fellowToken}?code=oauthSecret123&${canaries.presignedSig}#${canaries.joinFragment}`,
      headers: {
        Authorization: `Bearer ${canaries.fellowToken}`,
        Cookie: canaries.sessionCookie,
        "X-Asimposium-Service-Signature": canaries.serviceSig,
      },
      error_message: `Failed for ${canaries.email} from ${canaries.ip} with ${canaries.flowHandle} and ${canaries.jwt}`,
      stack: `Error: ${canaries.sessionCookie}\n  at handle (https://a.asimposium.org/v1/sessions/${canaries.flowHandle}#${canaries.joinFragment})`,
      nested: {
        workshop_body: canaries.workshopCanary,
        directive_body: "PRIVATE_DIRECTIVE_CANARY",
        detector_name: canaries.detectorDetail,
        chain_of_thought: canaries.hiddenCoT,
        raw_transcript: "RAW_HARNESS_TRANSCRIPT_CANARY",
        actor_ref: "F-01JXYZ4K6QABCDEFGHJKMNPQRS",
        sponsor_ref: "usr_sponsor_canary_001",
      },
    };

    const sentryOut = prepareRedactedSinkEvent("sentry", rawSentryEvent);
    const analyticsOut = prepareRedactedSinkEvent("analytics", rawSentryEvent);

    for (const sinkResult of [sentryOut, analyticsOut]) {
      const serialized = JSON.stringify(sinkResult.payload);
      expect(serialized).not.toContain(canaries.fellowToken);
      expect(serialized).not.toContain("superSecretEnrollmentFragment998877");
      expect(serialized).not.toContain(canaries.flowHandle);
      expect(serialized).not.toContain("cookieSecretValue887766");
      expect(serialized).not.toContain("hmacSecretHex11223344");
      expect(serialized).not.toContain("deadbeefcafebabe0011223344556677");
      expect(serialized).not.toContain(canaries.jwt);
      expect(serialized).not.toContain(canaries.email);
      expect(serialized).not.toContain(canaries.ip);
      expect(serialized).not.toContain(canaries.workshopCanary);
      expect(serialized).not.toContain("PRIVATE_DIRECTIVE_CANARY");
      expect(serialized).not.toContain(canaries.detectorDetail);
      expect(serialized).not.toContain(canaries.hiddenCoT);
      expect(serialized).not.toContain("RAW_HARNESS_TRANSCRIPT_CANARY");
      expect(serialized).not.toContain("F-01JXYZ4K6QABCDEFGHJKMNPQRS");
      expect(serialized).not.toContain("usr_sponsor_canary_001");
      expect(serialized).not.toContain("oauthSecret123");
      // Correlation ID survives cleanly.
      expect(sinkResult.payload.request_id).toBe("req-canary-001");
    }

    // Cyclic payload must not stack-overflow the scrubber.
    const cyclic: Record<string, unknown> = { ok: true };
    cyclic.self = cyclic;
    const scrubbedCyclic = scrubObservabilityPayload(cyclic) as Record<string, unknown>;
    expect(scrubbedCyclic.self).toBe("[CIRCULAR]");

    // Fresh-eyes Pass 5 regressions:
    // 1. Embedded URLs with percent-encoded email + IPv6 + generic Bearer tokens scrub cleanly.
    const embeddedCheck = prepareRedactedSinkEvent("sentry", {
      request_id: "req-canary-002",
      error_message:
        "Upstream error from 2001:db8::42 with Bearer external_provider_secret_987654 at https://a.asimposium.org/p/1?note=alice%40example.org",
    });
    const embeddedJson = JSON.stringify(embeddedCheck.payload);
    expect(embeddedJson).not.toContain("2001:db8::42");
    expect(embeddedJson).not.toContain("external_provider_secret_987654");
    expect(embeddedJson).not.toContain("alice");

    // 2. Non-finite timings, out-of-range status codes, and actor IDs in buildOpsTelemetryRecord fail closed.
    expect(() =>
      buildOpsTelemetryRecord({
        revision: "f713b555",
        plane: "stoa",
        route_template: "/stats.json",
        principal_class: "anonymous",
        command_or_event_kind: "stats.read",
        status_code: 200,
        correlation: { request_id: "req-nan", event_id: null, scope_cursor: null, outbox_id: null },
        timing_ms: { total: Number.NaN },
      }),
    ).toThrow(/OPS2A_INVALID_TIMING_MS/);

    expect(() =>
      buildOpsTelemetryRecord({
        revision: "f713b555",
        plane: "stoa",
        route_template: "/stats.json",
        principal_class: "anonymous",
        command_or_event_kind: "stats.read",
        status_code: 999,
        correlation: {
          request_id: "req-bad-st",
          event_id: null,
          scope_cursor: null,
          outbox_id: null,
        },
        timing_ms: { total: 5 },
      }),
    ).toThrow(/OPS2A_INVALID_STATUS_CODE/);

    expect(() =>
      buildOpsTelemetryRecord({
        revision: "f713b555",
        plane: "stoa",
        route_template: "/stats.json",
        principal_class: "fellow",
        command_or_event_kind: "stats.read",
        status_code: 200,
        error_code: "usr_leaked_sponsor_id",
        correlation: {
          request_id: "req-actor",
          event_id: null,
          scope_cursor: null,
          outbox_id: null,
        },
        timing_ms: { total: 5 },
      }),
    ).toThrow(/OPS2A_TELEMETRY_CREDENTIAL_LEAK_REFUSED/);

    // 3. NaN / negative alert metrics fail closed instead of silently suppressing alerts.
    const alertEval = new LaunchAlertEvaluator();
    expect(() =>
      alertEval.evaluate({
        observed_at_ms: 1_763_760_000_000,
        request_count: Number.NaN,
        error_5xx_count: 5,
        post_revocation_acceptances: 0,
        quarantine_backlog_count: 0,
        outbox_oldest_age_seconds: 0,
        d1_storage_pct: 10,
        consecutive_backup_failures: 0,
      }),
    ).toThrow(/ALERT_SNAPSHOT_INVALID_METRIC:request_count/);
  });

  test("all 6 launch alerts fire on threshold breach, dedupe inside window, recover cleanly, and link to real existing runbooks", () => {
    expect(LAUNCH_ALERT_DEFINITIONS.length).toBe(6);
    for (const def of LAUNCH_ALERT_DEFINITIONS) {
      expect(existsSync(resolve(REPO_ROOT, def.runbook_path)), `missing ${def.runbook_path}`).toBe(
        true,
      );
      expect(def.consumer.length).toBeGreaterThan(3);
      expect(def.decision_changed.length).toBeGreaterThan(10);
    }

    const evaluator = new LaunchAlertEvaluator();
    const t0 = 1_763_760_000_000;

    // 1. All 6 breach simultaneously -> all 6 fire with correlation IDs.
    const fired = evaluator.evaluate({
      observed_at_ms: t0,
      request_count: 100,
      error_5xx_count: 10,
      post_revocation_acceptances: 1,
      quarantine_backlog_count: 25,
      outbox_oldest_age_seconds: 450,
      d1_storage_pct: 68,
      consecutive_backup_failures: 1,
      correlation_request_id: "req-alert-001",
      correlation_outbox_id: "OB-DELAYED-1",
    });
    expect(fired.notifications.length).toBe(6);
    expect(fired.notifications.every((n) => n.state === "firing")).toBe(true);
    expect(fired.active_alerts.length).toBe(6);

    // 2. 10 seconds later, still breached -> all 6 are deduped (0 duplicate pages!).
    const dup = evaluator.evaluate({
      observed_at_ms: t0 + 10_000,
      request_count: 100,
      error_5xx_count: 12,
      post_revocation_acceptances: 1,
      quarantine_backlog_count: 26,
      outbox_oldest_age_seconds: 460,
      d1_storage_pct: 69,
      consecutive_backup_failures: 1,
    });
    expect(dup.notifications.length).toBe(0);
    expect(dup.deduped.length).toBe(6);

    // 3. Metrics return to healthy -> all 6 emit clean recovery transitions.
    const recovered = evaluator.evaluate({
      observed_at_ms: t0 + 60_000,
      request_count: 100,
      error_5xx_count: 1,
      post_revocation_acceptances: 0,
      quarantine_backlog_count: 3,
      outbox_oldest_age_seconds: 12,
      d1_storage_pct: 32,
      consecutive_backup_failures: 0,
    });
    expect(recovered.notifications.length).toBe(6);
    expect(recovered.notifications.every((n) => n.state === "recovered")).toBe(true);
    expect(recovered.active_alerts).toEqual([]);
  });

  test("metric consumer catalog names consumer & decision per Rule A10 and blocks leaderboards, per-problem volume, and gauntlet-token leaks", () => {
    const families = new Set(METRIC_CONSUMER_CATALOG.map((m) => m.family));
    expect(families.has("COLLABORATION")).toBe(true);
    expect(families.has("QUALITY")).toBe(true);
    expect(families.has("ERGONOMICS")).toBe(true);
    expect(families.has("COMPREHENSION")).toBe(true);
    expect(families.has("SAFETY")).toBe(true);
    expect(families.has("OPERATOR_INFRA")).toBe(true);

    for (const entry of METRIC_CONSUMER_CATALOG) {
      expect(entry.consumer.trim().length).toBeGreaterThan(3);
      expect(entry.decision_changed.trim().length).toBeGreaterThan(10);
    }

    // Valid public /stats structure passes.
    expect(() =>
      assertObservabilityBoundary("public-stats", {
        kind: "stats",
        ergonomics: { tokens_per_useful_action: "unavailable_until_deployed" },
      }),
    ).not.toThrow();

    // Numeric gauntlet token totals MUST NOT enter production analytics, public stats, or calibration/honors.
    for (const target of [
      "public-stats",
      "production-analytics",
      "calibration-or-honors",
    ] as const) {
      expect(() =>
        assertObservabilityBoundary(target, {
          ergonomics: { tokens_per_useful_action: 19_400 },
        }),
      ).toThrow(/GAUNTLET_TOKEN_BOUNDARY_VIOLATION/);
    }

    // Actor/model rankings and per-problem volume breakdowns are refused.
    expect(() =>
      assertObservabilityBoundary("public-stats", { model_rankings: [{ model: "x", score: 1 }] }),
    ).toThrow(/STATS_RULE_A10_VIOLATION/);
    expect(() =>
      assertObservabilityBoundary("public-stats", {
        per_problem_contribution_volume: { "P-1": 42 },
      }),
    ).toThrow(/OBSERVABILITY_BOUNDARY_VIOLATION/);
  });
});
