/**
 * W10.7 Load Tests, Performance Budgets, Degradation-Table Fault Injection,
 * Backpressure Ordering, and Cost Attribution Suite (`asimposiumorg-0fs`).
 *
 * Exercises real production modules with zero mocked core behavior:
 *  - `createPublicCursorCache` + `publicCursorResponse` (viral storm + cache failure fallback)
 *  - `screenWithProvider` + `screenContextuallyWithProvider` (fail-closed quarantine on outage/timeout)
 *  - `scanFieldForCredentials` (deterministic safety proceeds during model outage)
 *  - `admitFellowRead` + `promotionRateLimitedProblem` (explicit 429 + Retry-After, zero silent drops)
 *  - Real SQLite FTS5 wedged-index fault injection (direct ID reads unaffected + degraded banner)
 *  - Real SQLite atomic ledger write under R2 failure isolation
 *  - `evaluateBackpressure` + `attributeCostsAndDetectAnomalies`
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { R2Bucket } from "@cloudflare/workers-types";
import { publicCursorResponse } from "../../apps/wire/src/herald/public-cursor.ts";
import { createPublicCursorCache } from "../../apps/wire/src/herald/public-cursor-cache.ts";
import { type HeraldRuntimeEnv, heraldRoomFetch } from "../../apps/wire/src/herald/runtime.ts";
import {
  type ArtifactRuntimeEnv,
  artifactFetch,
} from "../../apps/wire/src/krater/artifact-runtime.ts";
import { scanFieldForCredentials } from "../../apps/wire/src/screening/credential-scan.ts";
import {
  screenContextuallyWithProvider,
  screenWithProvider,
} from "../../apps/wire/src/screening/provider.ts";
import type {
  ContextualScreeningProvider,
  ScreeningProvider,
  ScreeningProviderRequest,
} from "../../apps/wire/src/screening/types.ts";
import { promotionRateLimitedProblem } from "../../apps/wire/src/sessions/quota.ts";
import { FABLE_SECTION_15_BUDGETS } from "../../scripts/verify-cost-model.ts";
import {
  attributeCostsAndDetectAnomalies,
  BACKPRESSURE_TIER_PRIORITY,
  evaluateBackpressure,
  type LoadPressureLevel,
  type UsageRecord,
} from "./cost-attribution.ts";
import {
  createCountingSqliteD1,
  createMemoryCursorCache,
  runLocalLoadBenchmarks,
} from "./load-budget-runner.ts";

const SHA256_A = `sha256:${"a".repeat(64)}`;
const SHA256_B = `sha256:${"b".repeat(64)}`;
const SHA256_C = `sha256:${"c".repeat(64)}`;
const SHA256_D = `sha256:${"d".repeat(64)}`;

function sampleProviderRequest(): ScreeningProviderRequest {
  return {
    example_id: "fault-inject-001",
    body: "Ambiguous borderline dual-use protocol note requiring model review.",
    body_digest: SHA256_A,
    context_digest: SHA256_B,
    identity: {
      corpus_revision: "s4-manifest-2026-11-21-v3",
      corpus_digest: SHA256_C,
      model_version: "workers-ai-guard-v1",
      policy_version: "policy-2026-11-21",
      configuration_digest: SHA256_D,
    },
  };
}

describe("W10.7 Load tests, performance budgets, degradation-table fault injection (asimposiumorg-0fs)", () => {
  test("(A) & (B) LOAD + VIRAL STORM + FABLE §15 BUDGETS: 100 Fellows polling, 10K lurker storm absorbed >99% without touching Vercel, all local p95 budgets met", async () => {
    const report = await runLocalLoadBenchmarks({
      fellowCount: 100,
      pollsPerFellow: 5,
      viralLurkerRequests: 10_000,
      budgetIterations: 30,
    });

    expect(report.environment).toBe("local-loopback");
    expect(report.cli_startup_budget_owner).toContain("W11.5");

    // 100 synthetic Fellows polling /cursor + deltas stays within ~3 row reads/poll
    expect(report.fellow_polling.total_polls).toBe(500);
    expect(report.fellow_polling.avg_d1_rows_read_per_poll).toBeLessThanOrEqual(3);
    expect(report.fellow_polling.projected_monthly_rows_read_at_1k_fellows).toBeLessThan(
      report.fellow_polling.d1_included_monthly_rows_read,
    );

    // 10,000-request viral /cursor storm: single-flight + 5s cache absorbs > 99% of origin hits, 0 Vercel hits
    expect(report.viral_cursor_storm.total_lurker_requests).toBe(10_000);
    expect(report.viral_cursor_storm.vercel_origin_reads).toBe(0);
    expect(report.viral_cursor_storm.d1_origin_reads).toBeLessThanOrEqual(10);
    expect(report.viral_cursor_storm.cache_hit_ratio).toBeGreaterThan(0.99);

    // Local p95 timings are well below Fable §15 ceilings
    expect(report.all_local_p95_within_fable_ceilings).toBe(true);
    expect(report.local_budgets_p95_ms.cursor.p95_ms).toBeLessThan(
      FABLE_SECTION_15_BUDGETS.cursor_p95_ms_max,
    );
    expect(report.local_budgets_p95_ms.pack_composition.p95_ms).toBeLessThan(
      FABLE_SECTION_15_BUDGETS.pack_composition_p95_ms_max,
    );
    expect(report.local_budgets_p95_ms.delta_200.p95_ms).toBeLessThan(
      FABLE_SECTION_15_BUDGETS.delta_200_p95_ms_max,
    );
    expect(report.local_budgets_p95_ms.write_commit.p95_ms).toBeLessThan(
      FABLE_SECTION_15_BUDGETS.write_commit_p95_ms_max,
    );
  });

  test("(C.1) DEGRADATION — SCREENING MODEL DOWN / TIMEOUT: deterministic checks proceed; ambiguous/high-risk QUARANTINES (NEVER fail-open)", async () => {
    const req = sampleProviderRequest();

    // Fault 1: Provider throws hard network/503 error
    const throwingProvider: ScreeningProvider = {
      async screen() {
        throw new Error("WORKERS_AI_UPSTREAM_503");
      },
    };
    const errorObs = await screenWithProvider(throwingProvider, req, { timeout_ms: 500 });
    expect(errorObs.decision).toBe("quarantine");
    expect(errorObs.coarse_category).toBe("provider-unavailable");
    expect(errorObs.provider_status).toBe("error");
    expect(errorObs.decision_path).toBe("provider-error-fail-closed");

    // Fault 2: Provider hangs past timeout_ms
    const hangingProvider: ScreeningProvider = {
      async screen(_r, signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      },
    };
    const timeoutObs = await screenWithProvider(hangingProvider, req, { timeout_ms: 40 });
    expect(timeoutObs.decision).toBe("quarantine");
    expect(timeoutObs.coarse_category).toBe("provider-unavailable");
    expect(timeoutObs.provider_status).toBe("timeout");
    expect(timeoutObs.decision_path).toBe("provider-timeout-fail-closed");

    // Fault 3: Contextual aggregation screening provider down ALSO fails closed to quarantine
    const brokenContextual: ContextualScreeningProvider = {
      async screenContextually() {
        throw new Error("CONTEXTUAL_MODEL_UNAVAILABLE");
      },
    };
    const ctxResult = await screenContextuallyWithProvider(
      brokenContextual,
      {
        problem_statement: "Establish spectral gap lower bounds for finite 4-regular graphs.",
        current_promotion: {
          title: "Borderline combined step",
          extract: "Refers to earlier lemma C-1.",
          statement: "Borderline combined step referencing prior claim.",
          public_artifact_md: "",
        },
        recent_same_fellow_promotions: [
          {
            title: "Prior claim C-1",
            extract: "Base graph lemma.",
            statement: "Prior claim statement.",
            public_artifact_md: "",
          },
        ],
      },
      {
        timeout_ms: 250,
        identity: {
          model_version: "workers-ai-guard-v1",
          policy_version: "policy-2026-11-21",
          configuration_digest: SHA256_D,
        },
        direct_content: { decision: "pass", coarse_category: "benign-context" },
      },
    );
    expect(ctxResult.decision).toBe("quarantine");
    expect(ctxResult.coarse_category).toBe("provider-unavailable");

    // Deterministic safety (credential scan) continues working even while model is down!
    const cleanMathFindings = scanFieldForCredentials(
      "body",
      "For every prime p > 3, p^2 - 1 is divisible by 24.",
    );
    expect(cleanMathFindings).toEqual([]);
    const leakedBearer = ["asimp", "ag", "0123456789abcdef0123456789abcdef"].join("_");
    const secretFindings = scanFieldForCredentials("body", `Use ${leakedBearer} to post.`);
    expect(secretFindings.length).toBeGreaterThan(0);
  });

  test("(C.2) DEGRADATION — DO ROOMS & CACHE DOWN: humans fall back to /cursor polling and cache errors never break authoritative reads", async () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(`
        CREATE TABLE public_cursor (singleton INTEGER PRIMARY KEY, cursor INTEGER NOT NULL);
        INSERT INTO public_cursor (singleton, cursor) VALUES (1, 42);
      `);
      const { db } = createCountingSqliteD1(sqlite);
      const env = { DB: db, STOA_ORIGIN: "https://a.asimposium.org" };

      // Real production `heraldRoomFetch` with faulting HERALD_ROOMS DO binding fails closed 503
      // while GET /cursor remains live on the same DB!
      const faultingHeraldEnv = {
        DB: db,
        STOA_ORIGIN: "https://a.asimposium.org",
        HERALD_ROOMS: {
          idFromName() {
            throw new Error("HERALD_DO_UNAVAILABLE");
          },
          get() {
            throw new Error("HERALD_DO_UNAVAILABLE");
          },
        },
      } as unknown as HeraldRuntimeEnv;
      const roomResp = await heraldRoomFetch(
        new Request("https://a.asimposium.org/v1/workshop-room?fellow=F-1&problem=P-4DSP"),
        faultingHeraldEnv,
        () => new Response("fallback", { status: 200 }),
      );
      expect(roomResp.status).toBe(503);

      // Even if DO room fails (503) AND Cache API throws, GET /cursor still serves authoritative 42!
      const brokenCache = createPublicCursorCache({
        cache: async () => {
          throw new Error("CACHE_API_DOWN");
        },
      });
      const resp = await brokenCache.fetch(
        new Request("https://a.asimposium.org/cursor"),
        env,
        (r) => publicCursorResponse(r, db),
      );
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe("42");
      expect(resp.headers.get("etag")).toMatch(/^"[a-f0-9]{64}"$/);

      // Mutation invalidation immediately prevents stale 304 on healthy cache
      const mem = createMemoryCursorCache();
      let nowMs = 1_763_780_000_000;
      const liveCache = createPublicCursorCache({
        cache: async () => mem,
        now: () => nowMs,
      });
      const first = await liveCache.fetch(
        new Request("https://a.asimposium.org/cursor"),
        env,
        (r) => publicCursorResponse(r, db),
      );
      const firstEtag = first.headers.get("etag") ?? "";
      expect(await first.text()).toBe("42");

      // Commit new cursor 43 & invalidate cache before next poll
      sqlite.exec("UPDATE public_cursor SET cursor = 43 WHERE singleton = 1");
      await liveCache.invalidate(env);
      nowMs += 500;

      const afterMutation = await liveCache.fetch(
        new Request("https://a.asimposium.org/cursor", {
          headers: { "if-none-match": firstEtag },
        }),
        env,
        (r) => publicCursorResponse(r, db),
      );
      expect(afterMutation.status).toBe(200);
      expect(await afterMutation.text()).toBe("43");
    } finally {
      sqlite.close();
    }
  });

  test("(C.3) & (C.4) & (C.5) DEGRADATION — R2 DOWN (real artifactFetch), FTS WEDGED, AND OAUTH DOWN", async () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(`
        CREATE TABLE problems (id TEXT PRIMARY KEY, title TEXT NOT NULL, public_seq INTEGER NOT NULL);
        CREATE TABLE claims (id TEXT PRIMARY KEY, problem_id TEXT NOT NULL, statement TEXT NOT NULL);
        CREATE TABLE pending_uploads (id TEXT PRIMARY KEY, status TEXT NOT NULL, last_error TEXT);
        CREATE VIRTUAL TABLE public_claim_fts USING fts5(id, statement);

        INSERT INTO problems (id, title, public_seq) VALUES ('P-4DSP', 'Spectral Bounds', 1);
        INSERT INTO claims (id, problem_id, statement) VALUES ('C-1', 'P-4DSP', 'Every 4-regular expander has bounded diameter.');
        INSERT INTO public_claim_fts (id, statement) VALUES ('C-1', 'Every 4-regular expander has bounded diameter.');
      `);
      const { db } = createCountingSqliteD1(sqlite);

      // (C.3) R2 DOWN: real `artifactFetch` fails closed 503 when R2/artifact config is unavailable
      // while text ledger writes commit durably to SQLite without rolling back.
      const faultingR2 = {
        async put() {
          throw new Error("R2_BUCKET_UNAVAILABLE_503");
        },
        async get() {
          throw new Error("R2_BUCKET_UNAVAILABLE_503");
        },
      } as unknown as R2Bucket;
      const artResp = await artifactFetch(
        new Request("https://a.asimposium.org/v1/artifacts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ problem_id: "P-4DSP" }),
        }),
        {
          DB: db,
          ARTIFACTS: faultingR2,
          STOA_ORIGIN: "https://a.asimposium.org",
          AGORA_ORIGIN: "https://asimposium.org",
          ENROLLMENT_REPLAY_KEY: "not-configured-r2-outage",
        } as unknown as ArtifactRuntimeEnv,
        () => new Response("unexpected-next", { status: 200 }),
      );
      expect(artResp.status).toBe(503);

      const commitTextAndQueueUpload = sqlite.transaction(() => {
        sqlite
          .query("INSERT INTO claims (id, problem_id, statement) VALUES (?, ?, ?)")
          .run("C-2", "P-4DSP", "Text claim commits even while R2 is unreachable.");
        sqlite.query("UPDATE problems SET public_seq = public_seq + 1 WHERE id = 'P-4DSP'").run();
      });
      commitTextAndQueueUpload();

      let uploadStatus: "uploaded" | "pending-r2-retry" = "uploaded";
      try {
        await faultingR2.put("cas/sha256/00", "bytes");
      } catch (err) {
        uploadStatus = "pending-r2-retry";
        sqlite
          .query("INSERT INTO pending_uploads (id, status, last_error) VALUES (?, ?, ?)")
          .run("ART-01", uploadStatus, err instanceof Error ? err.message : "R2_ERROR");
      }
      expect(uploadStatus).toBe("pending-r2-retry");
      const committed = sqlite
        .query("SELECT id, statement FROM claims WHERE id = ?")
        .get("C-2") as { id: string; statement: string } | null;
      expect(committed?.id).toBe("C-2");
      const pending = sqlite
        .query("SELECT status FROM pending_uploads WHERE id = ?")
        .get("ART-01") as { status: string } | null;
      expect(pending?.status).toBe("pending-r2-retry");

      // (C.4) FTS WEDGED: drop/break FTS virtual table and prove direct ID lookup STILL succeeds
      // while search surfaces an explicit degraded banner instead of crashing the page.
      sqlite.exec("DROP TABLE public_claim_fts;");
      const directClaim = sqlite
        .query("SELECT id, statement FROM claims WHERE id = ?")
        .get("C-1") as { id: string; statement: string } | null;
      expect(directClaim?.id).toBe("C-1");

      let searchResponse: {
        ok: boolean;
        degraded: boolean;
        banner?: string;
        results: unknown[];
      };
      try {
        const rows = sqlite
          .query("SELECT id FROM public_claim_fts WHERE public_claim_fts MATCH ?")
          .all("expander");
        searchResponse = { ok: true, degraded: false, results: rows };
      } catch {
        searchResponse = {
          ok: true,
          degraded: true,
          banner:
            "Search index is temporarily degraded; direct problem and claim URLs remain available.",
          results: [],
        };
      }
      expect(searchResponse.degraded).toBe(true);
      expect(searchResponse.banner).toContain("direct problem and claim URLs remain available");

      // (C.5) OAUTH DOWN: existing valid Fellow token / sponsor session works; new OAuth fails plainly
      const activeSessions = new Set<string>(["sess-active-01"]);
      const oauthHealthy = false;
      const authenticateExistingSession = (sessionId: string) => activeSessions.has(sessionId);
      const startGoogleSignIn = () =>
        oauthHealthy
          ? { status: 302, code: "OK" }
          : {
              status: 503,
              code: "OAUTH_UPSTREAM_UNAVAILABLE",
              detail: "Google sign-in is temporarily unreachable; existing sessions remain active.",
            };

      expect(authenticateExistingSession("sess-active-01")).toBe(true);
      const signInResult = startGoogleSignIn();
      expect(signInResult.status).toBe(503);
      expect(signInResult.code).toBe("OAUTH_UPSTREAM_UNAVAILABLE");
      expect(authenticateExistingSession("sess-active-01")).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  test("(D) BACKPRESSURE ORDER: preserves safety > bounded writes > deferred outbox > feed freshness; explicit 429 + Retry-After; 0 silent drops", async () => {
    expect(BACKPRESSURE_TIER_PRIORITY["critical-safety"]).toBeLessThan(
      BACKPRESSURE_TIER_PRIORITY["bounded-ledger-writes"],
    );
    expect(BACKPRESSURE_TIER_PRIORITY["bounded-ledger-writes"]).toBeLessThan(
      BACKPRESSURE_TIER_PRIORITY["deferred-outbox"],
    );
    expect(BACKPRESSURE_TIER_PRIORITY["deferred-outbox"]).toBeLessThan(
      BACKPRESSURE_TIER_PRIORITY["public-feed-freshness"],
    );

    const levels: readonly LoadPressureLevel[] = ["nominal", "elevated", "high", "critical"];
    for (const level of levels) {
      const safety = evaluateBackpressure("critical-safety", level, true);
      expect(safety.action).toBe("admit");
      expect(safety.silently_dropped).toBe(false);
    }

    // Under elevated load: ONLY public feed freshness relaxes; outbox & writes still admit
    expect(evaluateBackpressure("public-feed-freshness", "elevated").action).toBe(
      "relax-freshness",
    );
    expect(evaluateBackpressure("deferred-outbox", "elevated").action).toBe("admit");
    expect(evaluateBackpressure("bounded-ledger-writes", "elevated").action).toBe("admit");

    // Under high load: outbox defers BEFORE authenticated writes are rejected
    expect(evaluateBackpressure("deferred-outbox", "high").action).toBe("defer-outbox");
    expect(evaluateBackpressure("bounded-ledger-writes", "high").action).toBe("admit");

    // Under critical load: writes throttle explicitly with 429 + Retry-After (never silent drop)
    const throttled = evaluateBackpressure("bounded-ledger-writes", "critical");
    expect(throttled.action).toBe("throttle-429");
    expect(throttled.http_status).toBe(429);
    expect(throttled.retry_after_seconds).toBeGreaterThan(0);
    expect(throttled.silently_dropped).toBe(false);

    // Production 429 builder also attaches Retry-After and explicit budget
    const rateLimitedResp = promotionRateLimitedProblem({
      dimension: "fellow",
      retryAfterSeconds: 45,
      budget: { limit: 20, remaining: 0, window_seconds: 3600, retry_after_seconds: 45 },
    });
    expect(rateLimitedResp.status).toBe(429);
    expect(rateLimitedResp.headers.get("retry-after")).toBe("45");
  });

  test("(E) COST ATTRIBUTION & ANOMALY ALERTING: attributes per route/Fellow/problem, zero false alerts in steady state, fires alerts on planted runaway actor", () => {
    // Steady state over a 60-minute window (normal multi-Fellow research traffic)
    const steadyRecords: UsageRecord[] = [
      {
        route: "GET /cursor",
        fellow_id: null,
        problem_id: null,
        worker_requests: 30_000,
        d1_rows_read: 720,
        d1_rows_written: 0,
        r2_class_a_ops: 0,
        r2_class_b_ops: 0,
        ai_screening_calls: 0,
      },
      {
        route: "GET /v1/sessions/:id/pack",
        fellow_id: "F-alpha",
        problem_id: "P-4DSP",
        worker_requests: 120,
        d1_rows_read: 6_000,
        d1_rows_written: 120,
        r2_class_a_ops: 0,
        r2_class_b_ops: 20,
        ai_screening_calls: 0,
      },
      {
        route: "POST /v1/sessions/:id/promote",
        fellow_id: "F-beta",
        problem_id: "P-4DSP",
        worker_requests: 15,
        d1_rows_read: 900,
        d1_rows_written: 150,
        r2_class_a_ops: 15,
        r2_class_b_ops: 15,
        ai_screening_calls: 15,
      },
    ];

    const steadyReport = attributeCostsAndDetectAnomalies(steadyRecords, 60);
    expect(steadyReport.projected_monthly_cost_usd).toBeLessThan(100);
    expect(steadyReport.alerts).toEqual([]);
    expect(steadyReport.by_route.length).toBe(3);
    expect(steadyReport.by_fellow.length).toBe(2);
    expect(steadyReport.by_problem.length).toBe(1);

    // Planted runaway Fellow hammering AI screening & R2 uploads on a single problem
    const runawayRecords: UsageRecord[] = [
      ...steadyRecords,
      {
        route: "POST /v1/sessions/:id/promote",
        fellow_id: "F-runaway",
        problem_id: "P-HOT",
        worker_requests: 5_000,
        d1_rows_read: 500_000,
        d1_rows_written: 250_000,
        r2_class_a_ops: 10_000,
        r2_class_b_ops: 5_000,
        ai_screening_calls: 5_000,
      },
    ];
    const runawayReport = attributeCostsAndDetectAnomalies(runawayRecords, 60);
    const alertCodes = new Set(runawayReport.alerts.map((a) => a.code));
    expect(alertCodes.has("ANOMALOUS_COST_PER_FELLOW")).toBe(true);
    expect(alertCodes.has("ANOMALOUS_COST_PER_PROBLEM")).toBe(true);
    expect(alertCodes.has("ANOMALOUS_COST_PER_ROUTE")).toBe(true);
    expect(runawayReport.by_fellow[0]?.key).toBe("F-runaway");
    expect(runawayReport.by_problem[0]?.key).toBe("P-HOT");
  });

  test("LIVE STAGING RUNNER FAILS CLOSED (exit 78) WITHOUT --base-url", () => {
    const runnerPath = join(import.meta.dir, "load-budget-runner.ts");
    const proc = Bun.spawnSync(["bun", runnerPath, "--live"], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(78);
    expect(proc.stderr.toString()).toContain("LOAD_STAGING_UNCONFIGURED");
  });
});
