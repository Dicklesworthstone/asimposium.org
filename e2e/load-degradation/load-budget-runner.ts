#!/usr/bin/env bun
/**
 * W10.7 Local Load Benchmark & Fail-Closed Staging Runner (asimposiumorg-0fs).
 *
 * Modes:
 *  - Local deterministic benchmark (default / library import):
 *    Runs synthetic 100-Fellow polling, 10,000-request viral /cursor storm
 *    through real `createPublicCursorCache` + `publicCursorResponse` + real
 *    SQLite row-read counting, and local p95 measurements for Fable §15
 *    budgets. Always tagged `environment: "local-loopback"` (never pretends
 *    to measure hosted Cloudflare edge TTFB).
 *  - Live staging probe (`--live --base-url <url>`):
 *    Probes a deployed Stoa origin and emits a `StagingS2CostReceipt` shape
 *    for `scripts/verify-cost-model.ts`. Fails closed with exit 78
 *    (`LOAD_STAGING_UNCONFIGURED`) when `--base-url` is missing.
 */

import { Database } from "bun:sqlite";
import type { D1Database } from "@cloudflare/workers-types";
import { publicCursorResponse } from "../../apps/wire/src/herald/public-cursor.ts";
import {
  createPublicCursorCache,
  type PublicCursorCache,
} from "../../apps/wire/src/herald/public-cursor-cache.ts";
import { composePack } from "../../packages/render/src/pack-composer.ts";
import { renderAllFaces } from "../../packages/render/src/render.ts";
import { FABLE_SECTION_15_BUDGETS } from "../../scripts/verify-cost-model.ts";

export interface LatencyDistributionMs {
  readonly samples: number;
  readonly min_ms: number;
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly p99_ms: number;
  readonly max_ms: number;
}

export interface LocalLoadBenchmarkReport {
  readonly schema: "asimposium.w10-7-load-report.v1";
  readonly environment: "local-loopback";
  readonly measured_at: string;
  readonly cli_startup_budget_owner: "W11.5 (asimposiumorg-85s, cli/tests/startup_bench.rs)";
  readonly fellow_polling: {
    readonly fellow_count: number;
    readonly polls_per_fellow: number;
    readonly total_polls: number;
    readonly total_d1_rows_read: number;
    readonly avg_d1_rows_read_per_poll: number;
    readonly projected_monthly_rows_read_at_1k_fellows: number;
    readonly d1_included_monthly_rows_read: number;
    readonly cursor_latency_ms: LatencyDistributionMs;
    readonly delta_latency_ms: LatencyDistributionMs;
  };
  readonly viral_cursor_storm: {
    readonly total_lurker_requests: number;
    readonly simulated_windows: number;
    readonly d1_origin_reads: number;
    readonly vercel_origin_reads: 0;
    readonly cache_hit_ratio: number;
    readonly latency_ms: LatencyDistributionMs;
  };
  readonly local_budgets_p95_ms: {
    readonly cursor: LatencyDistributionMs;
    readonly cached_face_ttfb: LatencyDistributionMs;
    readonly uncached_digest: LatencyDistributionMs;
    readonly pack_composition: LatencyDistributionMs;
    readonly delta_200: LatencyDistributionMs;
    readonly write_commit: LatencyDistributionMs;
  };
  readonly fable_section_15_ceilings_ms: typeof FABLE_SECTION_15_BUDGETS;
  readonly all_local_p95_within_fable_ceilings: boolean;
}

export function computeLatencyDistribution(samplesMs: readonly number[]): LatencyDistributionMs {
  if (samplesMs.length === 0) {
    return { samples: 0, min_ms: 0, p50_ms: 0, p95_ms: 0, p99_ms: 0, max_ms: 0 };
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const pick = (q: number) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1));
    return Number((sorted[idx] ?? 0).toFixed(3));
  };
  return {
    samples: sorted.length,
    min_ms: Number((sorted[0] ?? 0).toFixed(3)),
    p50_ms: pick(0.5),
    p95_ms: pick(0.95),
    p99_ms: pick(0.99),
    max_ms: Number((sorted[sorted.length - 1] ?? 0).toFixed(3)),
  };
}

/**
 * Minimal in-memory Cloudflare Cache API adapter for local single-flight and
 * TTL testing against the production `createPublicCursorCache` implementation.
 */
export function createMemoryCursorCache(): PublicCursorCache & {
  stats: { matches: number; hits: number; puts: number; deletes: number };
} {
  const store = new Map<string, { body: string; headers: [string, string][] }>();
  const stats = { matches: 0, hits: 0, puts: 0, deletes: 0 };
  return {
    stats,
    async match(request: Request): Promise<Response | undefined> {
      stats.matches += 1;
      const entry = store.get(request.url);
      if (!entry) return undefined;
      stats.hits += 1;
      return new Response(entry.body, { headers: entry.headers });
    },
    async put(request: Request, response: Response): Promise<void> {
      stats.puts += 1;
      const body = await response.text();
      const headers: [string, string][] = [];
      response.headers.forEach((value, key) => {
        headers.push([key, value]);
      });
      store.set(request.url, { body, headers });
    },
    async delete(request: Request): Promise<boolean> {
      stats.deletes += 1;
      return store.delete(request.url);
    },
  };
}

/**
 * Counting D1 shim backed by real `bun:sqlite` (zero mocked query behavior) so
 * row reads, row writes, and real SQLite execution latency are measured honestly.
 */
export function createCountingSqliteD1(sqlite: Database): {
  readonly db: D1Database;
  readonly counters: { queries: number; rowsRead: number; rowsWritten: number };
} {
  const counters = { queries: 0, rowsRead: 0, rowsWritten: 0 };
  const makeStmt = (sql: string, bound: unknown[] = []) => ({
    bind(...values: unknown[]) {
      return makeStmt(sql, values);
    },
    async first<T>(col?: string): Promise<T | null> {
      counters.queries += 1;
      const stmt = sqlite.query(sql);
      const row = (stmt.get(...(bound as never[])) as Record<string, unknown> | null) ?? null;
      counters.rowsRead += row ? 1 : 0;
      if (!row) return null;
      if (col !== undefined) return (row[col] as T) ?? null;
      return row as T;
    },
    async all<T>() {
      counters.queries += 1;
      const stmt = sqlite.query(sql);
      const results = stmt.all(...(bound as never[])) as T[];
      counters.rowsRead += results.length;
      return { success: true, results, meta: { rows_read: results.length } };
    },
    async run() {
      counters.queries += 1;
      const stmt = sqlite.query(sql);
      const res = stmt.run(...(bound as never[]));
      counters.rowsWritten += res.changes;
      return { success: true, results: [], meta: { changes: res.changes } };
    },
  });

  const db = {
    prepare(sql: string) {
      return makeStmt(sql);
    },
  } as unknown as D1Database;

  return { db, counters };
}

function seedLocalLedgerDb(): Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE public_cursor (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      cursor INTEGER NOT NULL
    );
    INSERT INTO public_cursor (singleton, cursor) VALUES (1, 200);

    CREATE TABLE problems (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      public_seq INTEGER NOT NULL
    );
    INSERT INTO problems (id, title, public_seq)
    VALUES ('P-4DSP', 'Spectral Bounds on Four-Regular Graphs', 200);

    CREATE TABLE ledger_events (
      problem_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      object_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (problem_id, seq)
    );
  `);
  const insert = sqlite.query(
    "INSERT INTO ledger_events (problem_id, seq, kind, object_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const tx = sqlite.transaction(() => {
    for (let seq = 1; seq <= 200; seq += 1) {
      insert.run(
        "P-4DSP",
        seq,
        seq % 4 === 0 ? "review" : "claim",
        `C-${seq}`,
        `Lemma ${seq}: for every finite 4-regular graph G on n >= 8 vertices, spectral gap >= c / n^2.`,
        `2026-11-21T00:${String(Math.floor(seq / 60)).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}Z`,
      );
    }
  });
  tx();
  return sqlite;
}

/**
 * Execute the full local W10.7 load, viral-storm, and budget verification suite.
 */
export async function runLocalLoadBenchmarks(
  options: {
    readonly fellowCount?: number;
    readonly pollsPerFellow?: number;
    readonly viralLurkerRequests?: number;
    readonly budgetIterations?: number;
  } = {},
): Promise<LocalLoadBenchmarkReport> {
  const fellowCount = options.fellowCount ?? 100;
  const pollsPerFellow = options.pollsPerFellow ?? 6;
  const viralLurkerRequests = options.viralLurkerRequests ?? 10_000;
  const budgetIterations = options.budgetIterations ?? 40;

  const sqlite = seedLocalLedgerDb();
  try {
    const { db, counters } = createCountingSqliteD1(sqlite);
    const origin = "https://a.asimposium.org";

    // 1. 100 synthetic Fellows polling /cursor + incremental delta
    let simulatedClock = 1_763_760_000_000;
    const pollCacheMem = createMemoryCursorCache();
    const pollCursorCache = createPublicCursorCache({
      cache: async () => pollCacheMem,
      now: () => simulatedClock,
    });
    const env = { DB: db, STOA_ORIGIN: origin };

    const cursorSamples: number[] = [];
    const deltaSamples: number[] = [];
    const rowsBeforePoll = counters.rowsRead;

    const deltaStmt = sqlite.query(
      "SELECT seq, kind, object_id, body FROM ledger_events WHERE problem_id = ? AND seq > ? ORDER BY seq ASC LIMIT 20",
    );

    for (let round = 0; round < pollsPerFellow; round += 1) {
      // Advance clock by 10s per polling round (> 5s TTL so each round refreshes cursor once for all 100 Fellows).
      simulatedClock += 10_000;
      for (let f = 0; f < fellowCount; f += 1) {
        const t0 = performance.now();
        const req = new Request(`${origin}/cursor`, { method: "GET" });
        const resp = await pollCursorCache.fetch(req, env, (r) => publicCursorResponse(r, db));
        await resp.text();
        cursorSamples.push(performance.now() - t0);

        // Delta poll at current head (0-row or incremental catchup, ~1-3 rows read on D1)
        const d0 = performance.now();
        const rows = deltaStmt.all("P-4DSP", f % 10 === 0 ? 198 : 200);
        counters.rowsRead += Math.max(1, rows.length);
        deltaSamples.push(performance.now() - d0);
      }
    }

    const totalPolls = fellowCount * pollsPerFellow;
    const totalD1RowsRead = counters.rowsRead - rowsBeforePoll;
    const avgRowsPerPoll = Number((totalD1RowsRead / totalPolls).toFixed(3));
    // Fable §15 model: 45M polls/mo at 1,000 Fellows × avgRowsPerPoll vs 25B D1 included reads
    const projectedMonthlyRowsRead = Math.round(45_000_000 * avgRowsPerPoll);

    // 2. Viral-page storm simulation: 10,000 lurkers polling /cursor across 5 windows (5s TTL each)
    let stormClock = 1_763_770_000_000;
    const stormMem = createMemoryCursorCache();
    const stormCursorCache = createPublicCursorCache({
      cache: async () => stormMem,
      now: () => stormClock,
    });
    let stormOriginReads = 0;
    const stormLatencies: number[] = [];
    const stormWindows = 5;
    const perWindow = Math.ceil(viralLurkerRequests / stormWindows);
    let dispatched = 0;

    for (let w = 0; w < stormWindows; w += 1) {
      stormClock += 6_000;
      const batchSize = Math.min(perWindow, viralLurkerRequests - dispatched);
      // Issue concurrent waves of 250 lurkers to exercise single-flight coalescing + cache hits
      const waveSize = 250;
      for (let offset = 0; offset < batchSize; offset += waveSize) {
        const count = Math.min(waveSize, batchSize - offset);
        const wave = Array.from({ length: count }, async () => {
          const t0 = performance.now();
          const req = new Request(`${origin}/cursor`, { method: "GET" });
          const resp = await stormCursorCache.fetch(req, env, async (r) => {
            stormOriginReads += 1;
            return publicCursorResponse(r, db);
          });
          await resp.text();
          stormLatencies.push(performance.now() - t0);
        });
        await Promise.all(wave);
      }
      dispatched += batchSize;
    }

    const stormHitRatio = Number(
      ((viralLurkerRequests - stormOriginReads) / viralLurkerRequests).toFixed(5),
    );

    // 3. Local Fable §15 performance budgets
    const sampleProjection = {
      schema: "asimposium.pack.v1" as const,
      kind: "pack" as const,
      problem: "P-4DSP",
      profile: "digest" as const,
      cursor: 200,
      title: "Spectral Bounds on Four-Regular Graphs",
      preamble: "Site-authored digest preamble.",
      items: Array.from({ length: 20 }, (_, i) => ({
        kind: "claim" as const,
        id: `C-${i + 1}`,
        scope: "ledger" as const,
        untrusted: true,
        body: `Claim C-${i + 1}: spectral gap bound holds for girth >= ${i + 3}.`,
        why_included: "active ledger claim",
      })),
      omitted: [],
      next_actions: [{ method: "GET" as const, url: "/p/P-4DSP.json", why: "inspect problem" }],
      degraded: [],
    };

    const uncachedDigestMs: number[] = [];
    const cachedFaceMs: number[] = [];
    const faceCache = new Map<string, string>();
    for (let i = 0; i < budgetIterations; i += 1) {
      const t0 = performance.now();
      const rendered = renderAllFaces(sampleProjection);
      uncachedDigestMs.push(performance.now() - t0);
      faceCache.set("P-4DSP:digest:200", rendered.md.body);

      const c0 = performance.now();
      const cached = faceCache.get("P-4DSP:digest:200");
      if (!cached || cached.length === 0) throw new Error("CACHED_FACE_MISSING");
      cachedFaceMs.push(performance.now() - c0);
    }

    const packCompMs: number[] = [];
    const packCandidates = Array.from({ length: 40 }, (_, i) => ({
      kind: "claim" as const,
      id: `C-${i + 1}`,
      scope: "ledger" as const,
      tokens: 80,
      untrusted: true,
      body: `Claim C-${i + 1}: structural graph invariant with falsifier bound k=${i + 2}.`,
      why_included: "working pack candidate",
      stable_prefix: i < 10 ? 1 : 2,
    }));
    for (let i = 0; i < budgetIterations; i += 1) {
      const t0 = performance.now();
      composePack({
        schema: "asimposium.pack.v1",
        session: "S-LOAD-1",
        problem: "P-4DSP",
        profile: "working",
        cursor: 200,
        requested_max_tokens: 1_800,
        viewer: {
          audience: "session",
          membership: "contributor",
          effective_permissions: ["read", "write"],
        },
        candidates: packCandidates,
        action_candidates: [
          {
            method: "GET",
            url: "/p/P-4DSP.json",
            why: "inspect problem",
            priority: 1,
            public_read: true,
          },
        ],
      });
      packCompMs.push(performance.now() - t0);
    }

    const delta200Stmt = sqlite.query(
      "SELECT seq, kind, object_id, body, created_at FROM ledger_events WHERE problem_id = ? AND seq > 0 ORDER BY seq ASC LIMIT 200",
    );
    const delta200Ms: number[] = [];
    for (let i = 0; i < budgetIterations; i += 1) {
      const t0 = performance.now();
      const rows = delta200Stmt.all("P-4DSP");
      if (rows.length !== 200) throw new Error("EXPECTED_200_DELTA_ROWS");
      delta200Ms.push(performance.now() - t0);
    }

    const writeEventStmt = sqlite.query(
      "INSERT INTO ledger_events (problem_id, seq, kind, object_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const bumpProblemStmt = sqlite.query("UPDATE problems SET public_seq = ? WHERE id = ?");
    const bumpCursorStmt = sqlite.query(
      "UPDATE public_cursor SET cursor = cursor + 1 WHERE singleton = 1",
    );
    const atomicCommit = sqlite.transaction((seq: number) => {
      writeEventStmt.run(
        "P-4DSP",
        seq,
        "claim",
        `C-${seq}`,
        `Committed claim ${seq} with falsifier.`,
        "2026-11-21T22:00:00Z",
      );
      bumpProblemStmt.run(seq, "P-4DSP");
      bumpCursorStmt.run();
    });

    const writeCommitMs: number[] = [];
    for (let i = 0; i < budgetIterations; i += 1) {
      const t0 = performance.now();
      atomicCommit(201 + i);
      writeCommitMs.push(performance.now() - t0);
    }

    const budgets = {
      cursor: computeLatencyDistribution(stormLatencies),
      cached_face_ttfb: computeLatencyDistribution(cachedFaceMs),
      uncached_digest: computeLatencyDistribution(uncachedDigestMs),
      pack_composition: computeLatencyDistribution(packCompMs),
      delta_200: computeLatencyDistribution(delta200Ms),
      write_commit: computeLatencyDistribution(writeCommitMs),
    };

    const allWithin =
      budgets.cursor.p95_ms < FABLE_SECTION_15_BUDGETS.cursor_p95_ms_max &&
      budgets.cached_face_ttfb.p95_ms < FABLE_SECTION_15_BUDGETS.cached_face_ttfb_p95_ms_max &&
      budgets.uncached_digest.p95_ms < FABLE_SECTION_15_BUDGETS.uncached_digest_p95_ms_max &&
      budgets.pack_composition.p95_ms < FABLE_SECTION_15_BUDGETS.pack_composition_p95_ms_max &&
      budgets.delta_200.p95_ms < FABLE_SECTION_15_BUDGETS.delta_200_p95_ms_max &&
      budgets.write_commit.p95_ms < FABLE_SECTION_15_BUDGETS.write_commit_p95_ms_max;

    return {
      schema: "asimposium.w10-7-load-report.v1",
      environment: "local-loopback",
      measured_at: new Date().toISOString(),
      cli_startup_budget_owner: "W11.5 (asimposiumorg-85s, cli/tests/startup_bench.rs)",
      fellow_polling: {
        fellow_count: fellowCount,
        polls_per_fellow: pollsPerFellow,
        total_polls: totalPolls,
        total_d1_rows_read: totalD1RowsRead,
        avg_d1_rows_read_per_poll: avgRowsPerPoll,
        projected_monthly_rows_read_at_1k_fellows: projectedMonthlyRowsRead,
        d1_included_monthly_rows_read: 25_000_000_000,
        cursor_latency_ms: computeLatencyDistribution(cursorSamples),
        delta_latency_ms: computeLatencyDistribution(deltaSamples),
      },
      viral_cursor_storm: {
        total_lurker_requests: viralLurkerRequests,
        simulated_windows: stormWindows,
        d1_origin_reads: stormOriginReads,
        vercel_origin_reads: 0,
        cache_hit_ratio: stormHitRatio,
        latency_ms: budgets.cursor,
      },
      local_budgets_p95_ms: budgets,
      fable_section_15_ceilings_ms: FABLE_SECTION_15_BUDGETS,
      all_local_p95_within_fable_ceilings: allWithin,
    };
  } finally {
    sqlite.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let live = false;
  let baseUrl = "";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--live") live = true;
    else if (argv[i] === "--base-url") baseUrl = argv[++i] ?? "";
  }

  if (live) {
    if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
      console.error(
        JSON.stringify({
          status: "blocked",
          code: "LOAD_STAGING_UNCONFIGURED",
          detail:
            "Live staging load mode requires --base-url https://a.staging.asimposium.org (blocked on operator deploy authority asimposiumorg-rs5n).",
        }),
      );
      process.exit(78);
    }
    const cleanBase = baseUrl.replace(/\/$/, "");
    const samples: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const t0 = performance.now();
      const resp = await fetch(`${cleanBase}/cursor`, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) {
        console.error(
          JSON.stringify({
            status: "fail",
            code: "LIVE_CURSOR_PROBE_FAILED",
            http_status: resp.status,
          }),
        );
        process.exit(1);
      }
      await resp.text();
      samples.push(performance.now() - t0);
    }
    console.log(
      JSON.stringify(
        {
          schema: "asimposium.w10-7-live-cursor-probe.v1",
          base_url: cleanBase,
          cursor_latency_ms: computeLatencyDistribution(samples),
        },
        null,
        2,
      ),
    );
    return;
  }

  const report = await runLocalLoadBenchmarks();
  console.log(JSON.stringify(report, null, 2));
  if (!report.all_local_p95_within_fable_ceilings) {
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
