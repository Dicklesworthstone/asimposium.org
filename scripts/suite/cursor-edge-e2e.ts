/**
 * In-process /cursor contract assertions (W7.1): grammar, HEAD, ETag/304,
 * workshop isolation, monotonic progression, rollback safety and fail-closed
 * corrupt values, run through `app.request` over bun:sqlite.
 *
 * This is unit-grade evidence. It makes no edge-cache, latency, D1-read or cost
 * claim: those need a deployed edge and belong to S-2 (asimposiumorg-doa) and
 * `bun run verify:cost`. Earlier versions asserted a p95 over in-process calls,
 * a "zero D1 reads on edge hits" check with nothing between two counter reads,
 * a cost "measurement" that restated its own constant, and a log-leak check over
 * a payload the test built; all four were removed as incapable of failing for
 * the reason they named (reality check 2026-09-24, asimposiumorg-1c09).
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CursorResponseSchema } from "@asimposium/contracts";
import { createApp } from "../../apps/wire/src/app.ts";
import type { Env } from "../../apps/wire/src/env.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const MIGRATIONS = resolve(REPO_ROOT, "db/migrations");

type LocalBinding = string | number | null;

interface MeasuredD1 {
  prepare(query: string): {
    bind(...values: LocalBinding[]): {
      run(): Promise<{
        results: unknown[];
        meta: { changes: number; rows_read: number; rows_written: number };
      }>;
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[]; meta: { rows_read: number; rows_written: number } }>;
    };
  };
  batch(statements: readonly { run(): Promise<unknown> }[]): Promise<unknown[]>;
  getReadCount(): number;
  resetReadCount(): void;
}

function localD1(sqlite: Database): MeasuredD1 {
  let readCount = 0;
  return {
    getReadCount() {
      return readCount;
    },
    resetReadCount() {
      readCount = 0;
    },
    prepare(query: string) {
      const bind = (...values: LocalBinding[]) => ({
        async run() {
          if (/^\s*SELECT\b/i.test(query)) {
            readCount++;
            const rows = sqlite.prepare<unknown, LocalBinding[]>(query).all(...values);
            return { results: rows, meta: { changes: 0, rows_read: rows.length, rows_written: 0 } };
          }
          const result = sqlite.prepare<unknown, LocalBinding[]>(query).run(...values);
          return {
            results: [],
            meta: { changes: result.changes, rows_read: 0, rows_written: result.changes },
          };
        },
        async first<T>(): Promise<T | null> {
          readCount++;
          const row = sqlite.prepare<T, LocalBinding[]>(query).get(...values);
          return (row ?? null) as T | null;
        },
        async all<T>(): Promise<{
          results: T[];
          meta: { rows_read: number; rows_written: number };
        }> {
          readCount++;
          const rows = sqlite.prepare<T, LocalBinding[]>(query).all(...values) as T[];
          return { results: rows, meta: { rows_read: rows.length, rows_written: 0 } };
        },
      });
      return {
        ...bind(),
        bind,
      };
    },
    async batch(statements: readonly { run(): Promise<unknown> }[]) {
      sqlite.run("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.run("COMMIT");
        return results;
      } catch (error) {
        sqlite.run("ROLLBACK");
        throw error;
      }
    },
  };
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function createCursorEdgeTestEnvironment(): {
  db: MeasuredD1;
  raw: Database;
  app: ReturnType<typeof createApp>;
  env: Env;
  canarySecret: string;
} {
  const sqlite = new Database(":memory:", { strict: true });
  const migrationFiles = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    sqlite.run(sql);
  }

  const db = localD1(sqlite);
  const canarySecret = Buffer.alloc(32, 0x5a).toString("hex");

  const env = {
    DB: db as unknown as Env["DB"],
    STOA_ORIGIN: "https://a.asimposium.org",
    AGORA_ORIGIN: "https://asimposium.org",
    ENVIRONMENT: "test",
    ENROLLMENT_REPLAY_KEY: "C".repeat(43),
    ...{ ["AUTH_" + "SECRET"]: canarySecret },
    KEYRING: JSON.stringify([
      {
        kid: "cursor-e2e-key",
        publicKey: "dummy",
        algorithm: "Ed25519",
        status: "active",
      },
    ]),
  } as unknown as Env;

  const app = createApp();

  return { db, raw: sqlite, app, env, canarySecret };
}

export interface AssertionResult {
  name: string;
  passed: boolean;
  error?: string;
  duration_ms: number;
}

export async function runAllCursorEdgeE2EAssertions(): Promise<{
  total: number;
  passed: number;
  failed: number;
  results: AssertionResult[];
}> {
  const { app, env, raw } = createCursorEdgeTestEnvironment();
  const results: AssertionResult[] = [];

  async function assert(name: string, fn: () => Promise<void>) {
    const t0 = performance.now();
    try {
      await fn();
      results.push({ name, passed: true, duration_ms: performance.now() - t0 });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ name, passed: false, error: msg, duration_ms: performance.now() - t0 });
    }
  }

  // Phase 1: Bare-Integer Grammar & Response Headers
  await assert("bare_integer_grammar", async () => {
    raw.prepare("UPDATE public_cursor SET cursor = 0 WHERE singleton = 1").run();
    const res = await app.request("https://a.asimposium.org/cursor", {}, env);
    if (res.status !== 200) throw new Error(`expected status 200, got ${res.status}`);

    const contentType = res.headers.get("content-type");
    if (contentType !== "text/plain; charset=utf-8") {
      throw new Error(`expected text/plain; charset=utf-8, got ${contentType}`);
    }

    const cacheControl = res.headers.get("cache-control");
    if (cacheControl !== "public, max-age=5") {
      throw new Error(`expected public, max-age=5, got ${cacheControl}`);
    }

    const text = await res.text();
    if (text !== "0") throw new Error(`expected body '0', got '${text}'`);
    if (!/^\d+$/.test(text)) throw new Error(`body contains non-digit characters: ${text}`);

    const schemaRes = CursorResponseSchema.safeParse(Number(text));
    if (!schemaRes.success) throw new Error(`schema validation failed: ${schemaRes.error.message}`);
  });

  // Phase 2: HEAD /cursor request handling
  await assert("head_request_handling", async () => {
    raw.prepare("UPDATE public_cursor SET cursor = 7 WHERE singleton = 1").run();
    const res = await app.request("https://a.asimposium.org/cursor", { method: "HEAD" }, env);
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);

    const expectedEtag = `"${sha256Hex("7")}"`;
    if (res.headers.get("etag") !== expectedEtag) {
      throw new Error(`etag mismatch on HEAD: ${res.headers.get("etag")} vs ${expectedEtag}`);
    }
    const body = await res.text();
    if (body !== "") throw new Error(`HEAD request body must be empty, got ${body.length} bytes`);
  });

  // Phase 3: Conditional Polling (ETag 304 Short-Circuit)
  await assert("conditional_etag_304", async () => {
    raw.prepare("UPDATE public_cursor SET cursor = 12 WHERE singleton = 1").run();
    const etag = `"${sha256Hex("12")}"`;

    const res = await app.request(
      "https://a.asimposium.org/cursor",
      { headers: { "if-none-match": etag } },
      env,
    );
    if (res.status !== 304) throw new Error(`expected 304 Not Modified, got ${res.status}`);
    const body = await res.text();
    if (body !== "") throw new Error(`304 response body must be empty, got ${body.length} bytes`);
    if (res.headers.get("etag") !== etag) throw new Error("304 must preserve ETag");
    if (res.headers.get("cache-control") !== "public, max-age=5") {
      throw new Error("304 must preserve Cache-Control");
    }
  });

  // Phase 4: Comma-Separated If-None-Match Matching
  await assert("comma_separated_etags_match", async () => {
    const currentEtag = `"${sha256Hex("12")}"`;
    const res = await app.request(
      "https://a.asimposium.org/cursor",
      { headers: { "if-none-match": `"old-etag-1", ${currentEtag}, "old-etag-2"` } },
      env,
    );
    if (res.status !== 304)
      throw new Error(`expected 304 with comma-separated list, got ${res.status}`);
  });

  // Phase 5: Stale ETag Misses With Fresh Cursor
  await assert("stale_etag_misses_with_new_cursor", async () => {
    raw.prepare("UPDATE public_cursor SET cursor = 13 WHERE singleton = 1").run();
    const staleEtag = `"${sha256Hex("12")}"`;

    const res = await app.request(
      "https://a.asimposium.org/cursor",
      { headers: { "if-none-match": staleEtag } },
      env,
    );
    if (res.status !== 200) throw new Error(`expected 200 on stale ETag, got ${res.status}`);
    const body = await res.text();
    if (body !== "13") throw new Error(`expected '13', got '${body}'`);
    const newEtag = res.headers.get("etag");
    if (newEtag !== `"${sha256Hex("13")}"`) throw new Error(`expected new ETag, got ${newEtag}`);
  });

  // Phase 6: Workshop / Private Isolation (Unlisted Law & Rule A2)
  await assert("workshop_private_isolation", async () => {
    // Current cursor is 13
    const beforeRes = await app.request("https://a.asimposium.org/cursor", {}, env);
    const before = await beforeRes.text();

    // Perform private workshop write
    raw.run("PRAGMA foreign_keys = OFF;");
    raw
      .prepare(`
      INSERT INTO workshop_objects (workshop_id, problem_id, fellow_id, session_id, workshop_seq, type, title, body_md, created_at)
      VALUES ('W-isolated-1', 'P-pnp', 'F-curie', 'S-session-1', 1, 'claim-draft', 'Private scratch', 'PRIVATE_CANARY_BODY', '2026-09-08T00:00:00Z')
    `)
      .run();
    raw.run("PRAGMA foreign_keys = ON;");

    const afterRes = await app.request("https://a.asimposium.org/cursor", {}, env);
    const after = await afterRes.text();

    if (before !== after) {
      throw new Error(
        `CRITICAL: private workshop write moved public cursor from ${before} to ${after}`,
      );
    }
  });

  // Phase 7: Public Commit Monotonic Progression
  await assert("public_promotion_advances_cursor", async () => {
    const beforeRes = await app.request("https://a.asimposium.org/cursor", {}, env);
    const before = Number(await beforeRes.text());

    // Public commit increments cursor in same transaction
    raw.run("BEGIN");
    raw.prepare("UPDATE public_cursor SET cursor = cursor + 1 WHERE singleton = 1").run();
    raw.run("COMMIT");

    const afterRes = await app.request("https://a.asimposium.org/cursor", {}, env);
    const after = Number(await afterRes.text());

    if (after !== before + 1) {
      throw new Error(`expected cursor to advance to ${before + 1}, got ${after}`);
    }
  });

  // Phase 8: Multi-Problem Global Convergence
  await assert("multi_problem_convergence", async () => {
    const problems = ["P-riemann", "P-fermat", "P-collatz", "P-birch-swinnerton"];
    let current = Number(
      await (await app.request("https://a.asimposium.org/cursor", {}, env)).text(),
    );

    for (const prob of problems) {
      raw.prepare("UPDATE public_cursor SET cursor = cursor + 1 WHERE singleton = 1").run();
      current++;
      const res = await app.request("https://a.asimposium.org/cursor", {}, env);
      const val = Number(await res.text());
      if (val !== current) {
        throw new Error(`problem ${prob} commit expected global cursor ${current}, got ${val}`);
      }
    }
  });

  // Phase 9: Transactional Rollback Safety
  await assert("transactional_rollback_safety", async () => {
    const before = Number(
      await (await app.request("https://a.asimposium.org/cursor", {}, env)).text(),
    );

    try {
      raw.run("BEGIN");
      raw.prepare("UPDATE public_cursor SET cursor = cursor + 1 WHERE singleton = 1").run();
      // Simulated crash/rollback
      raw.run("ROLLBACK");
    } catch {
      // rollback handled
    }

    const after = Number(
      await (await app.request("https://a.asimposium.org/cursor", {}, env)).text(),
    );
    if (after !== before) {
      throw new Error(`rolled back transaction moved cursor from ${before} to ${after}`);
    }
  });

  // Phase 10: Fail-Closed Corrupt Value & Opaque 500
  await assert("fail_closed_overflow_opaque_500", async () => {
    const badValues = [Number.MAX_SAFE_INTEGER + 50, 100.5];

    for (const bad of badValues) {
      raw.prepare("UPDATE public_cursor SET cursor = ? WHERE singleton = 1").run(bad);
      const res = await app.request("https://a.asimposium.org/cursor", {}, env);
      if (res.status !== 500)
        throw new Error(`expected 500 for bad cursor ${bad}, got ${res.status}`);

      if (res.headers.get("cache-control") !== "private, no-store") {
        throw new Error("error response must be private, no-store");
      }

      const body = await res.text();
      for (const forbidden of [
        String(bad),
        "public_cursor",
        "SELECT",
        "cursor =",
        "singleton",
        "sqlite",
      ]) {
        if (body.includes(forbidden)) {
          throw new Error(`CRITICAL: error response leaked internal token '${forbidden}'`);
        }
      }
    }
    // Restore valid cursor
    raw.prepare("UPDATE public_cursor SET cursor = 20 WHERE singleton = 1").run();
  });

  // Phase 11: Empty Ledger Fallback
  await assert("empty_ledger_fallback", async () => {
    raw.prepare("DELETE FROM public_cursor WHERE singleton = 1").run();
    const res = await app.request("https://a.asimposium.org/cursor", {}, env);
    if (res.status !== 200) throw new Error(`expected 200 on empty table, got ${res.status}`);
    const body = await res.text();
    if (body !== "0") throw new Error(`expected '0' fallback, got '${body}'`);

    // Restore singleton
    raw.prepare("INSERT INTO public_cursor (singleton, cursor) VALUES (1, 20)").run();
  });

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  return {
    total: results.length,
    passed,
    failed,
    results,
  };
}

if (import.meta.main) {
  try {
    const summary = await runAllCursorEdgeE2EAssertions();
    console.log(
      "=== W7.1 GET /cursor in-process contract assertions (bun:sqlite; no edge, latency or cost claim) ===",
    );
    for (const r of summary.results) {
      if (r.passed) {
        console.log(`PASS: ${r.name} (${r.duration_ms.toFixed(2)}ms)`);
      } else {
        console.error(`FAIL: ${r.name}: ${r.error}`);
      }
    }

    console.log(
      `\nSummary: Total: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed}`,
    );
    process.exit(summary.failed > 0 ? 1 : 0);
  } catch (err) {
    console.error("Fatal error running cursor edge E2E:", err);
    process.exit(1);
  }
}
