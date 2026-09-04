import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type SearchResponse, SearchResponseSchema } from "@asimposium/contracts";
import { createApp } from "../../apps/wire/src/app.ts";
import type { Env } from "../../apps/wire/src/env.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const MIGRATIONS = resolve(REPO_ROOT, "db/migrations");

type LocalBinding = string | number | null;

function localD1(sqlite: Database): Env["DB"] {
  return {
    prepare(query: string) {
      return {
        bind(...values: LocalBinding[]) {
          return {
            async run() {
              if (/^\s*SELECT\b/i.test(query)) {
                const rows = sqlite.prepare<unknown, LocalBinding[]>(query).all(...values);
                return { results: rows, meta: { changes: 0 } };
              }
              const result = sqlite.prepare<unknown, LocalBinding[]>(query).run(...values);
              return { results: [], meta: { changes: result.changes } };
            },
            async first<T>(): Promise<T | null> {
              const row = sqlite.prepare<T, LocalBinding[]>(query).get(...values);
              return (row ?? null) as T | null;
            },
            async all<T>(): Promise<{ results: T[] }> {
              const rows = sqlite.prepare<T, LocalBinding[]>(query).all(...values) as T[];
              return { results: rows };
            },
          };
        },
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
  } as unknown as Env["DB"];
}

export function createSearchTestEnvironment(): {
  db: Env["DB"];
  raw: Database;
  app: ReturnType<typeof createApp>;
  env: Env;
  canaryWorkshopSecret: string;
} {
  const sqlite = new Database(":memory:", { strict: true });
  const migrationFiles = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    sqlite.run(sql);
  }

  const canaryWorkshopSecret = "CANARY_PRIVATE_WORKSHOP_SECRET_98765";

  // Seed public problems
  sqlite.run(`
    INSERT INTO problems (id, public_seq, created_at, updated_at)
    VALUES ('P-RIEMANN-01', 1, '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z');

    INSERT INTO problems (id, public_seq, created_at, updated_at)
    VALUES ('P-GOLDBACH-02', 2, '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z');
  `);

  // Seed public claims
  sqlite.run(`
    INSERT INTO claims (id, problem_id, statement, payload_sha256, source_seq, created_at)
    VALUES ('C-101', 'P-RIEMANN-01', 'All nontrivial zeros of the zeta function have real part equal to one half.', 'sha256:claim101', 1, '2026-08-20T00:00:00.000Z');

    INSERT INTO claims (id, problem_id, statement, payload_sha256, source_seq, created_at)
    VALUES ('C-202', 'P-GOLDBACH-02', 'Every even integer greater than 2 can be expressed as sum of two primes.', 'sha256:claim202', 2, '2026-08-21T00:00:00.000Z');
  `);

  // Seed public_claim_fts
  sqlite.run(`
    INSERT INTO public_claim_fts (claim_id, problem_id, statement)
    VALUES ('C-101', 'P-RIEMANN-01', 'All nontrivial zeros of the zeta function have real part equal to one half.');

    INSERT INTO public_claim_fts (claim_id, problem_id, statement)
    VALUES ('C-202', 'P-GOLDBACH-02', 'Every even integer greater than 2 can be expressed as sum of two primes.');
  `);

  // Seed sponsor first (required by trigger in migration 0015)
  sqlite.run(`
    INSERT INTO sponsors (sponsor_id, created_at, last_seen_at)
    VALUES ('sponsor-1', 1724198400000, 1724198400000);
  `);

  // Seed public fellow
  sqlite.run(`
    INSERT INTO enrollment_fellows (fellow_id, sponsor_id, name, model, harness, created_at)
    VALUES ('F-01JABCDEFGHJKMNPQRSTVWXYZ1', 'sponsor-1', 'euler-agent', 'claude-3-7-sonnet', 'fable-5', 1724198400000);
  `);

  // Seed public cursor
  sqlite.run(`
    INSERT OR REPLACE INTO public_cursor (singleton, cursor)
    VALUES (1, 42);
  `);

  // Seed session and PRIVATE workshop object (must never leak into search)
  sqlite.run(`
    INSERT INTO sessions (
      session_id, fellow_id, problem_id, intent, opened_at, last_heartbeat_at, idle_close_at
    ) VALUES (
      'sess-test-1', 'F-01JABCDEFGHJKMNPQRSTVWXYZ1', 'P-RIEMANN-01', 'prove', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z', '2026-08-20T01:00:00.000Z'
    );

    INSERT INTO workshop_objects (
      workshop_id, problem_id, fellow_id, session_id, workshop_seq, type, title, body_md, relates_to_json, force_note, created_at, cas_hash
    ) VALUES (
      'W-euler-agent-99', 'P-RIEMANN-01', 'F-01JABCDEFGHJKMNPQRSTVWXYZ1', 'sess-test-1', 1, 'draft', 'Secret Draft', 'Secret body containing ${canaryWorkshopSecret}', '[]', 0, '2026-08-20T00:00:00.000Z', NULL
    );
  `);

  const db = localD1(sqlite);
  const app = createApp();
  const env = {
    DB: db,
    STOA_ORIGIN: "https://a.asimposium.org",
    AGORA_ORIGIN: "https://asimposium.org",
    ENVIRONMENT: "test",
    AUTH_SECRET: "test-auth-secret-32-bytes-minimum-length!",
    KEYRING: JSON.stringify([
      {
        kid: "test-key-1",
        publicKey: "dummy",
        algorithm: "Ed25519",
        status: "active",
      },
    ]),
  } as unknown as Env;

  return { db, raw: sqlite, app, env, canaryWorkshopSecret };
}

export function queryDigest(q: string): string {
  return `sha256:${createHash("sha256").update(q).digest("hex")}`;
}

export interface SearchE2ETestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly error?: string;
  readonly query_digest?: string;
}

export async function runAllSearchE2EAssertions(): Promise<{
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly SearchE2ETestResult[];
}> {
  const { app, env, canaryWorkshopSecret } = createSearchTestEnvironment();
  const results: SearchE2ETestResult[] = [];

  const assert = async (name: string, query: string, fn: () => Promise<void>) => {
    try {
      await fn();
      results.push({ name, passed: true, query_digest: queryDigest(query) });
    } catch (err) {
      results.push({
        name,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        query_digest: queryDigest(query),
      });
    }
  };

  // Phase 1: Semantic Parity Proof (.md vs .json)
  await assert("semantic_parity_md_and_json", "zeta function", async () => {
    const jsonRes = await app.request(
      "https://a.asimposium.org/search.json?q=zeta+function",
      {},
      env,
    );
    if (jsonRes.status !== 200) throw new Error(`json status ${jsonRes.status}`);
    const json = (await jsonRes.json()) as SearchResponse;
    SearchResponseSchema.parse(json);

    const mdRes = await app.request("https://a.asimposium.org/search.md?q=zeta+function", {}, env);
    if (mdRes.status !== 200) throw new Error(`md status ${mdRes.status}`);
    const md = await mdRes.text();

    if (json.total_matches !== 1) {
      throw new Error(`expected 1 match, got ${json.total_matches}`);
    }
    if (!md.includes("Matches: 1")) {
      throw new Error("markdown missing matches count 1");
    }
    if (!md.includes("`C-101`")) {
      throw new Error("markdown missing claim C-101");
    }
    if (!md.includes("## Deliberate Omissions")) {
      throw new Error("markdown missing deliberate omissions section");
    }
    if (!md.includes("## Next Actions")) {
      throw new Error("markdown missing next actions section");
    }
  });

  // Phase 2: Exact Problem ID Precedence
  await assert("exact_problem_id_precedence", "P-RIEMANN-01", async () => {
    const res = await app.request("https://a.asimposium.org/search.json?q=P-RIEMANN-01", {}, env);
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const json = (await res.json()) as SearchResponse;
    SearchResponseSchema.parse(json);

    const first = json.items[0];
    if (!first) throw new Error("no items returned");
    if (first.id !== "P-RIEMANN-01") throw new Error(`expected P-RIEMANN-01, got ${first.id}`);
    if (first.kind !== "problem") throw new Error(`expected kind problem, got ${first.kind}`);
    if (first.match_type !== "exact_reference") {
      throw new Error(`expected match_type exact_reference, got ${first.match_type}`);
    }
  });

  // Phase 3: Exact Claim ID Precedence (bare and composite)
  await assert("exact_claim_id_precedence", "P-RIEMANN-01#C-101", async () => {
    const res = await app.request(
      "https://a.asimposium.org/search.json?q=P-RIEMANN-01%23C-101",
      {},
      env,
    );
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const json = (await res.json()) as SearchResponse;
    SearchResponseSchema.parse(json);

    const first = json.items[0];
    if (!first) throw new Error("no items returned");
    if (first.id !== "C-101") throw new Error(`expected C-101, got ${first.id}`);
    if (first.problem_id !== "P-RIEMANN-01") {
      throw new Error(`expected problem_id P-RIEMANN-01, got ${first.problem_id}`);
    }
    if (first.match_type !== "exact_reference") {
      throw new Error(`expected match_type exact_reference, got ${first.match_type}`);
    }
  });

  // Phase 4: Exact Fellow ID Resolution
  await assert("exact_fellow_id_precedence", "F-01JABCDEFGHJKMNPQRSTVWXYZ1", async () => {
    const res = await app.request(
      "https://a.asimposium.org/search.json?q=F-01JABCDEFGHJKMNPQRSTVWXYZ1",
      {},
      env,
    );
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const json = (await res.json()) as SearchResponse;
    SearchResponseSchema.parse(json);

    const first = json.items[0];
    if (!first) throw new Error("no items returned");
    if (first.id !== "F-01JABCDEFGHJKMNPQRSTVWXYZ1") {
      throw new Error(`expected F-01JABCDEFGHJKMNPQRSTVWXYZ1, got ${first.id}`);
    }
    if (first.kind !== "fellow") throw new Error(`expected kind fellow, got ${first.kind}`);
    if (first.match_type !== "exact_reference") {
      throw new Error(`expected match_type exact_reference, got ${first.match_type}`);
    }
  });

  // Phase 4b: Fellow Name Lexical Search
  await assert("fellow_name_lexical_search", "euler-agent", async () => {
    const res = await app.request("https://a.asimposium.org/search.json?q=euler-agent", {}, env);
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const json = (await res.json()) as SearchResponse;
    SearchResponseSchema.parse(json);

    const first = json.items[0];
    if (!first) throw new Error("no items returned");
    if (first.title !== "euler-agent")
      throw new Error(`expected title euler-agent, got ${first.title}`);
    if (first.kind !== "fellow") throw new Error(`expected kind fellow, got ${first.kind}`);
    if (first.match_type !== "lexical_fts") {
      throw new Error(`expected match_type lexical_fts, got ${first.match_type}`);
    }
  });

  // Phase 5: Useful Zero-Result Recovery (Exact Reference Not Found)
  await assert("zero_result_exact_not_found", "P-NONEXISTENT-99", async () => {
    const res = await app.request(
      "https://a.asimposium.org/search.json?q=P-NONEXISTENT-99",
      {},
      env,
    );
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const json = (await res.json()) as SearchResponse;
    SearchResponseSchema.parse(json);

    if (json.total_matches !== 0) throw new Error(`expected 0 matches, got ${json.total_matches}`);
    if (json.explanation !== "exact_reference_not_found") {
      throw new Error(`expected explanation exact_reference_not_found, got ${json.explanation}`);
    }
    const hasBrowseAction = json.next_actions.some((a) => a.href === "/problems");
    if (!hasBrowseAction) throw new Error("missing /problems next action");
  });

  // Phase 6: Useful Zero-Result Recovery (No Lexical Matches)
  await assert(
    "zero_result_no_lexical_matches",
    "nonexistentunmatchedquantumteleportation",
    async () => {
      const res = await app.request(
        "https://a.asimposium.org/search.json?q=nonexistentunmatchedquantumteleportation",
        {},
        env,
      );
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const json = (await res.json()) as SearchResponse;
      SearchResponseSchema.parse(json);

      if (json.total_matches !== 0)
        throw new Error(`expected 0 matches, got ${json.total_matches}`);
      if (json.explanation !== "no_lexical_matches") {
        throw new Error(`expected explanation no_lexical_matches, got ${json.explanation}`);
      }
      const hasExplore = json.next_actions.some((a) => a.href === "/explore");
      if (!hasExplore) throw new Error("missing /explore next action");
    },
  );

  // Phase 7: SQL & FTS5 Injection Resistance
  const adversarialQueries = [
    "' OR '1'='1",
    '"; DROP TABLE problems; --',
    "UNION SELECT 1, 2, 3, 4",
    "NEAR(zeros, half, 5)",
    "MATCH 'riemann'",
    "AND OR NOT *",
    "(unbalanced parenthesis",
    '"unclosed quote',
    ":::colons::: ~tilde~ ^caret^ {curly} [brackets]",
  ];

  for (const maliciousQuery of adversarialQueries) {
    await assert(
      `injection_resistance_${maliciousQuery.slice(0, 16)}`,
      maliciousQuery,
      async () => {
        const url = `https://a.asimposium.org/search.json?q=${encodeURIComponent(maliciousQuery)}`;
        const res = await app.request(url, {}, env);
        if (res.status !== 200) {
          throw new Error(`adversarial query crashed with status ${res.status}`);
        }
        const json = await res.json();
        const parsed = SearchResponseSchema.safeParse(json);
        if (!parsed.success) {
          throw new Error(`response failed schema validation: ${parsed.error.message}`);
        }
      },
    );
  }

  // Phase 8: ETag and 304 Not Modified
  await assert("etag_and_304_handling", "primes", async () => {
    const initial = await app.request("https://a.asimposium.org/search.json?q=primes", {}, env);
    if (initial.status !== 200) throw new Error(`initial status ${initial.status}`);
    const etag = initial.headers.get("etag");
    if (!etag?.startsWith('"') || !etag.endsWith('"')) {
      throw new Error(`missing or invalid etag header: ${etag}`);
    }

    const conditional = await app.request(
      "https://a.asimposium.org/search.json?q=primes",
      {
        headers: { "if-none-match": etag },
      },
      env,
    );
    if (conditional.status !== 304) {
      throw new Error(`expected 304 Not Modified, got ${conditional.status}`);
    }
    const text = await conditional.text();
    if (text !== "") {
      throw new Error(`expected empty 304 body, got ${text.length} bytes`);
    }
  });

  // Phase 9: Absence of Workshop / Private / Unlisted Bytes (Airtight Privacy Split)
  await assert("workshop_privacy_split_absence", canaryWorkshopSecret, async () => {
    // 1. Search by exact canary secret word: must yield 0 matches and 0 items
    const searchRes = await app.request(
      `https://a.asimposium.org/search.json?q=${encodeURIComponent(canaryWorkshopSecret)}`,
      {},
      env,
    );
    if (searchRes.status !== 200) throw new Error(`status ${searchRes.status}`);
    const json = (await searchRes.json()) as SearchResponse;
    SearchResponseSchema.parse(json);

    if (json.total_matches !== 0 || json.items.length !== 0) {
      throw new Error(`expected 0 matches for private canary, got ${json.total_matches}`);
    }
    for (const item of json.items) {
      if (
        item.snippet.includes(canaryWorkshopSecret) ||
        item.title?.includes(canaryWorkshopSecret)
      ) {
        throw new Error("CRITICAL: private workshop canary secret leaked in JSON item!");
      }
    }

    // 2. Search for common words ("draft", "secret"): must never return the private workshop object
    const draftRes = await app.request("https://a.asimposium.org/search.json?q=draft", {}, env);
    if (draftRes.status !== 200) throw new Error(`status ${draftRes.status}`);
    const draftJson = (await draftRes.json()) as SearchResponse;
    SearchResponseSchema.parse(draftJson);
    for (const item of draftJson.items) {
      if (
        item.id === "W-euler-agent-99" ||
        item.snippet.includes(canaryWorkshopSecret) ||
        item.title?.includes(canaryWorkshopSecret)
      ) {
        throw new Error("CRITICAL: private workshop data returned for general search query!");
      }
    }

    // 3. Search by workshop ID: Unlisted Exact-Reference Law
    const workshopIdRes = await app.request(
      "https://a.asimposium.org/search.json?q=W-euler-agent-99",
      {},
      env,
    );
    if (workshopIdRes.status !== 200) throw new Error(`status ${workshopIdRes.status}`);
    const workshopIdText = await workshopIdRes.text();
    if (workshopIdText.includes("Secret Draft") || workshopIdText.includes(canaryWorkshopSecret)) {
      throw new Error("CRITICAL: private workshop draft leaked through workshop ID search!");
    }
    const workshopJson = JSON.parse(workshopIdText) as SearchResponse;
    if (workshopJson.total_matches !== 0 || workshopJson.items.length !== 0) {
      throw new Error("expected 0 matches for private workshop ID (Unlisted Law)");
    }

    // 4. Markdown face for general search: verify canary secret is absent
    const mdRes = await app.request("https://a.asimposium.org/search.md?q=draft", {}, env);
    const mdText = await mdRes.text();
    if (mdText.includes(canaryWorkshopSecret) || mdText.includes("W-euler-agent-99")) {
      throw new Error("CRITICAL: private workshop data leaked in Markdown response!");
    }
  });

  // Phase 10: Deliberate Omissions Declaration
  await assert("deliberate_omissions_present", "zeros", async () => {
    const res = await app.request("https://a.asimposium.org/search.json?q=zeros", {}, env);
    const json = (await res.json()) as SearchResponse;
    const privateOmission = json.omitted.find((o) => o.reason === "private_content_excluded");
    if (!privateOmission) {
      throw new Error("missing mandatory private_content_excluded omission declaration");
    }
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
  const summary = await runAllSearchE2EAssertions();
  for (const r of summary.results) {
    if (r.passed) {
      console.log(`PASS: ${r.name} (${r.query_digest})`);
    } else {
      console.error(`FAIL: ${r.name} (${r.query_digest}): ${r.error}`);
    }
  }
  console.log(`\nTotal: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed}`);
  process.exit(summary.failed > 0 ? 1 : 0);
}
