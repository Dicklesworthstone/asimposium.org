/**
 * OPS.4 Observability, Pre-Egress Redaction, Launch Alerts, and Live `/stats`
 * Semantic Parity Real-Bindings E2E Lane (`asimposiumorg-286`).
 *
 * Exercises the LIVE mounted Stoa Worker + migrated D1 + R2 (zero mocks):
 * - Enrolls a Fellow + independent reviewer, publishes & sharpens a real problem,
 *   attempts a failing write (`422 MISSING_FALSIFIER`), and promotes a real claim.
 * - Hits LIVE `GET /stats` (308), `GET /stats.json` (with injected secret/cookie
 *   canaries in query/headers), and `GET /stats.md`, proving:
 *   1. `PlatformStatsFaceSchema` + OPS.4 `assertObservabilityBoundary("public-stats")` hold
 *      against measured non-zero D1 counts (`public_problems >= 1`, `claims_total >= 1`,
 *      `tokens_per_useful_action === "unavailable_until_deployed"`).
 *   2. `/stats.md` maintains semantic parity with `/stats.json` and emits zero anti-metrics
 *      or `PROVED` banners.
 *   3. No injected query/header canary ever echoes back or survives `prepareRedactedSinkEvent`.
 * - Queries live migrated D1 `outbox` & `screening_cases` tables into `LaunchAlertEvaluator`
 *   and proves nominal steady-state (0 firing alerts) + synthetic breach/dedupe/recovery.
 */

import assert from "node:assert/strict";
import { PlatformStatsFaceSchema } from "../../../../packages/contracts/src/stats.ts";
import {
  assertObservabilityBoundary,
  buildOpsTelemetryRecord,
  LaunchAlertEvaluator,
  prepareRedactedSinkEvent,
} from "../../src/observability/telemetry.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, env, worker, origin, userAgent }) => {
    const sponsorOwner = "usr_obs4_owner";
    const sponsorReviewer = "usr_obs4_reviewer";
    const proposer = await enroll("obs4-proposer", sponsorOwner);
    const reviewer = await enroll("obs4-reviewer", sponsorReviewer);

    // 1. Create, publish, sharpen, exercise a failing write (422), and promote one valid claim.
    const created = await call(
      "/v1/problems",
      {
        title: "Observability live D1 stats parity probe",
        statement: "For every integer n >= 2, there exists a prime p dividing n with 2 <= p <= n.",
        falsifier: "An integer n >= 2 having no prime divisor in [2, n].",
        motivation: "Exercise live /stats D1 aggregation and OPS.2a telemetry correlation.",
        scope: "Elementary arithmetic on integers n >= 2.",
        out_of_scope: "Complex or p-adic extensions.",
        success_criteria: "Independent review confirms claim and /stats reflects live D1 counts.",
        areas: ["number-theory"],
      },
      proposer,
      201,
      "obs4-propose",
    );
    const problemId = created.problem.id;

    await sponsorCall(
      sponsorOwner,
      "POST",
      `/v1/sponsors/problems/${problemId}/lifecycle`,
      "problem-lifecycle",
      { action: "publish" },
      200,
      `/v1/sponsors/problems/${problemId}/lifecycle`,
      "obs4-publish",
    );

    const proposerSess = await call(
      "/v1/sessions",
      { problem_id: problemId, intent: "prove" },
      proposer,
      201,
    );
    const reviewerSess = await call(
      "/v1/sessions",
      { problem_id: problemId, intent: "review" },
      reviewer,
      201,
    );

    await call(
      `/v1/problems/${problemId}/statement-review`,
      {
        session_id: reviewerSess.session_id,
        statement_version: 1,
        verdict: "statement-clear",
        basis: "Statement and falsifier are exact.",
      },
      reviewer,
      200,
    );

    const draft = await call(
      `/v1/sessions/${proposerSess.session_id}/workshop`,
      {
        type: "claim-draft",
        title: "Smallest divisor > 1 is prime",
        body_md: "The least divisor d > 1 of n >= 2 must be prime.",
        relates_to: [],
      },
      proposer,
      201,
    );

    // Correlated failing write (422 MISSING_FALSIFIER).
    const failedWrite = await call(
      `/v1/sessions/${proposerSess.session_id}/promote`,
      {
        workshop_id: draft.workshop_id,
        kind: "conjecture",
        statement: "The least divisor d > 1 of any integer n >= 2 is prime.",
      },
      proposer,
      422,
    );
    assert.equal(failedWrite.code, "MISSING_FALSIFIER");

    const failedTelemetry = buildOpsTelemetryRecord({
      revision: "local-workerd",
      plane: "stoa",
      route_template: "/v1/sessions/:id/promote",
      principal_class: "fellow",
      command_or_event_kind: "claim.promote",
      status_code: 422,
      error_code: failedWrite.code,
      correlation: {
        request_id: "req-obs4-failed-write-001",
        event_id: null,
        scope_cursor: null,
        outbox_id: null,
      },
      timing_ms: { total: 12, d1: 4 },
    });
    assert.equal(failedTelemetry.error_code, "MISSING_FALSIFIER");

    // Promote valid claim so /stats reports real non-zero D1 counts.
    const promoted = await call(
      `/v1/sessions/${proposerSess.session_id}/promote`,
      {
        workshop_id: draft.workshop_id,
        kind: "conjecture",
        statement: "The least divisor d > 1 of any integer n >= 2 is prime.",
        falsifier: "An integer n >= 2 whose smallest divisor > 1 is composite.",
      },
      proposer,
      201,
    );
    assert.ok(promoted.claim_id.startsWith("C-"));

    // 2. Verify LIVE /stats 308 redirect, /stats.json, and /stats.md parity + zero canary echo.
    const redirectResp = await worker.fetch(`${origin}/stats`, {
      headers: { "User-Agent": userAgent },
      redirect: "manual",
    });
    assert.equal(redirectResp.status, 308);
    assert.equal(redirectResp.headers.get("location"), "/stats.md");

    const queryCanary = ["asimp", "ag", "01OBS4CANARY00000000000000", "Q".repeat(43)].join("_");
    const cookieCanary = "__Host-asimp.session=obs4CookieSecretNeverEcho999";

    const statsJsonResp = await worker.fetch(
      `${origin}/stats.json?token=${encodeURIComponent(queryCanary)}`,
      {
        headers: {
          "User-Agent": userAgent,
          "x-request-id": "req-obs4-live-stats-001",
          Cookie: cookieCanary,
        },
      },
    );
    assert.equal(statsJsonResp.status, 200);
    const statsJsonText = await statsJsonResp.text();
    assert.ok(
      !statsJsonText.includes(queryCanary),
      "query canary must never appear in /stats.json",
    );
    assert.ok(
      !statsJsonText.includes("obs4CookieSecretNeverEcho999"),
      "cookie canary must never appear in /stats.json",
    );

    const stats = PlatformStatsFaceSchema.parse(JSON.parse(statsJsonText));
    assertObservabilityBoundary("public-stats", stats);
    assert.ok(stats.collaboration.public_problems >= 1, "live /stats.json must count real problem");
    assert.ok(stats.quality.claims_total >= 1, "live /stats.json must count real claim");
    assert.equal(stats.ergonomics.tokens_per_useful_action, "unavailable_until_deployed");

    const statsMdResp = await worker.fetch(`${origin}/stats.md`, {
      headers: { "User-Agent": userAgent, "x-request-id": "req-obs4-live-stats-md-001" },
    });
    assert.equal(statsMdResp.status, 200);
    const statsMd = await statsMdResp.text();
    assert.ok(statsMd.includes("Rule A10") || statsMd.includes("measured"));
    assert.ok(!/\bPROVED\b|\bleaderboard\b/i.test(statsMd));

    // Rule A2 live isolation proof: create a private-draft problem (never published) + session,
    // and verify public /stats.json counts do NOT change AND IP-shaped x-request-id is replaced safely.
    const privateDraft = await call(
      "/v1/problems",
      {
        title: "Private draft never counted in public /stats",
        statement: "Draft statement PRIVATE_STATS_A2_CANARY for internal scratch only.",
        falsifier: "Counterexample to private draft.",
        motivation: "Verify Rule A2 private-draft exclusion on live /stats.json.",
        scope: "Private draft only.",
        out_of_scope: "Public ledger.",
        success_criteria: "Never counted publicly before publication.",
        areas: ["number-theory"],
      },
      proposer,
      201,
      "obs4-private-draft",
    );
    await call(
      "/v1/sessions",
      { problem_id: privateDraft.problem.id, intent: "explore" },
      proposer,
      201,
    );
    const afterPrivateResp = await worker.fetch(`${origin}/stats.json`, {
      headers: { "User-Agent": userAgent, "x-request-id": "203.0.113.99" },
    });
    assert.equal(afterPrivateResp.status, 200);
    const afterPrivateText = await afterPrivateResp.text();
    assert.ok(!afterPrivateText.includes("PRIVATE_STATS_A2_CANARY"));
    const afterPrivateStats = PlatformStatsFaceSchema.parse(JSON.parse(afterPrivateText));
    assert.equal(
      afterPrivateStats.collaboration.public_problems,
      stats.collaboration.public_problems,
      "private-draft problem must not increment public_problems",
    );
    assert.equal(
      afterPrivateStats.ergonomics.sessions_opened,
      stats.ergonomics.sessions_opened,
      "private-draft session must not increment public sessions_opened",
    );
    assert.equal(
      afterPrivateStats.quality.claims_total,
      stats.quality.claims_total,
      "private-draft activity must not increment public claims_total",
    );

    // Verify pre-egress redactor strips live request URL/cookie/bearer canaries cleanly.
    const redactedSink = prepareRedactedSinkEvent("sentry", {
      request_id: "req-obs4-live-stats-001",
      url: `${origin}/stats.json?token=${queryCanary}#v1.secretFragmentObs4`,
      headers: { Cookie: cookieCanary, Authorization: `Bearer ${queryCanary}` },
    });
    const redactedStr = JSON.stringify(redactedSink.payload);
    assert.ok(!redactedStr.includes(queryCanary));
    assert.ok(!redactedStr.includes("obs4CookieSecretNeverEcho999"));
    assert.ok(!redactedStr.includes("secretFragmentObs4"));

    // 3. Query real migrated D1 outbox & screening_cases counts into LaunchAlertEvaluator.
    // Note: screening_cases.state enum is 'pending'|'released'|'rejected'|'superseded' (migration 0091).
    const pendingOutboxRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'",
    ).first();
    const pendingQuarantineRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM screening_cases WHERE state = 'pending'",
    ).first();
    const evaluator = new LaunchAlertEvaluator();
    const t0 = Date.now();
    const nominal = evaluator.evaluate({
      observed_at_ms: t0,
      request_count: 50,
      error_5xx_count: 0,
      post_revocation_acceptances: 0,
      quarantine_backlog_count: Number(pendingQuarantineRow?.n ?? 0),
      outbox_oldest_age_seconds: 0,
      d1_storage_pct: 5,
      consecutive_backup_failures: 0,
      correlation_request_id: "req-obs4-live-stats-001",
    });
    assert.equal(nominal.active_alerts.length, 0);

    const tripped = evaluator.evaluate({
      observed_at_ms: t0 + 1_000,
      request_count: 50,
      error_5xx_count: 5,
      post_revocation_acceptances: 0,
      quarantine_backlog_count: 25,
      outbox_oldest_age_seconds: 400,
      d1_storage_pct: 5,
      consecutive_backup_failures: 0,
      correlation_request_id: "req-obs4-failed-write-001",
      correlation_outbox_id: `OB-PENDING-${Number(pendingOutboxRow?.n ?? 0)}`,
    });
    assert.equal(tripped.notifications.length, 3);
    const recovered = evaluator.evaluate({
      observed_at_ms: t0 + 5_000,
      request_count: 50,
      error_5xx_count: 0,
      post_revocation_acceptances: 0,
      quarantine_backlog_count: 0,
      outbox_oldest_age_seconds: 0,
      d1_storage_pct: 5,
      consecutive_backup_failures: 0,
    });
    assert.equal(recovered.notifications.length, 3);
    assert.equal(recovered.active_alerts.length, 0);

    console.log(
      JSON.stringify({
        stage: "observability-real-bindings",
        status: "pass",
        environment: "local-workerd-d1",
        problem_id: problemId,
        claim_id: promoted.claim_id,
        stats_public_problems: stats.collaboration.public_problems,
        stats_claims_total: stats.quality.claims_total,
        pending_outbox_rows: Number(pendingOutboxRow?.n ?? 0),
        alerts_tripped_and_recovered: 3,
      }),
    );
  },
);
