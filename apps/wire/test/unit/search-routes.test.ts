import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SearchResponseSchema } from "@asimposium/contracts";
import { createApp } from "../../src/app.ts";
import type { Env } from "../../src/env.ts";

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");

type LocalBinding = string | number | null;

function localD1(sqlite: Database) {
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

function createMigratedDb(): { db: Env["DB"]; raw: Database } {
  const sqlite = new Database(":memory:", { strict: true });
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    sqlite.run(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  return { db: localD1(sqlite), raw: sqlite };
}

function mockEnv(db: Env["DB"]): Env {
  return {
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
}

describe("W6.8 Public Search Routes", () => {
  test("GET /search without query returns 400 SCHEMA_INVALID problem document", async () => {
    const { db } = createMigratedDb();
    const app = createApp();
    const env = mockEnv(db);

    const res = await app.request("https://a.asimposium.org/search", {}, env);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("SCHEMA_INVALID");
    expect(body.fix_hint).toBeDefined();
  });

  test("GET /search returns Markdown by default with ETag and Cache-Control", async () => {
    const { db } = createMigratedDb();
    const app = createApp();
    const env = mockEnv(db);

    const res = await app.request("https://a.asimposium.org/search?q=riemann", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("etag")).toBeDefined();
    expect(res.headers.get("cache-control")).toContain("public");

    const body = await res.text();
    expect(body).toContain('# ASImposium Search: "riemann"');
    expect(body).toContain("No public ledger objects matched");
    expect(body).toContain("## Next Actions");
  });

  test("GET /search.json returns JSON response adhering to SearchResponseSchema", async () => {
    const { db } = createMigratedDb();
    const app = createApp();
    const env = mockEnv(db);

    const res = await app.request("https://a.asimposium.org/search.json?q=riemann", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const json = await res.json();
    const parsed = SearchResponseSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.q).toBe("riemann");
      expect(parsed.data.total_matches).toBe(0);
      expect(parsed.data.explanation).toBe("no_lexical_matches");
      expect(parsed.data.omitted.length).toBeGreaterThan(0);
    }
  });

  test("GET /search.md returns Markdown face explicitly", async () => {
    const { db } = createMigratedDb();
    const app = createApp();
    const env = mockEnv(db);

    const res = await app.request("https://a.asimposium.org/search.md?q=riemann", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const body = await res.text();
    expect(body).toContain('# ASImposium Search: "riemann"');
  });

  test("resolves exact problem ID with exact_reference precedence", async () => {
    const { db, raw } = createMigratedDb();
    const app = createApp();
    const env = mockEnv(db);

    // Seed a public problem
    raw.run(`
      INSERT INTO problems (id, public_seq, created_at, updated_at)
      VALUES ('P-RIEMANN-01', 5, '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z')
    `);

    const res = await app.request("https://a.asimposium.org/search.json?q=P-RIEMANN-01", {}, env);
    expect(res.status).toBe(200);

    const json = await res.json();
    const parsed = SearchResponseSchema.parse(json);
    expect(parsed.total_matches).toBe(1);
    expect(parsed.items[0]?.kind).toBe("problem");
    expect(parsed.items[0]?.id).toBe("P-RIEMANN-01");
    expect(parsed.items[0]?.match_type).toBe("exact_reference");
    expect(parsed.items[0]?.url).toBe("https://asimposium.org/p/P-RIEMANN-01");
  });

  test("resolves exact claim ID and composite problem#claim ref", async () => {
    const { db, raw } = createMigratedDb();
    const app = createApp();
    const env = mockEnv(db);

    // Seed problem and claim
    raw.run(`
      INSERT INTO problems (id, public_seq, created_at, updated_at)
      VALUES ('P-TEST-99', 1, '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');

      INSERT INTO claims (id, problem_id, statement, payload_sha256, source_seq, created_at)
      VALUES ('C-42', 'P-TEST-99', 'Every even integer greater than 2 is sum of two primes', 'sha256:abc', 1, '2026-08-25T00:00:00.000Z');
    `);

    // Search by composite ref
    const resComposite = await app.request(
      "https://a.asimposium.org/search.json?q=P-TEST-99%23C-42",
      {},
      env,
    );
    expect(resComposite.status).toBe(200);
    const jsonComposite = await resComposite.json();
    const parsedComposite = SearchResponseSchema.parse(jsonComposite);
    expect(parsedComposite.total_matches).toBe(1);
    expect(parsedComposite.items[0]?.id).toBe("C-42");
    expect(parsedComposite.items[0]?.problem_id).toBe("P-TEST-99");
    expect(parsedComposite.items[0]?.match_type).toBe("exact_reference");

    // Search by bare claim ID
    const resBare = await app.request("https://a.asimposium.org/search.json?q=C-42", {}, env);
    expect(resBare.status).toBe(200);
    const jsonBare = await resBare.json();
    const parsedBare = SearchResponseSchema.parse(jsonBare);
    expect(parsedBare.total_matches).toBe(1);
    expect(parsedBare.items[0]?.id).toBe("C-42");
  });

  test("executes FTS5 lexical match on public_claim_fts", async () => {
    const { db, raw } = createMigratedDb();
    const app = createApp();
    const env = mockEnv(db);

    // Seed FTS5 index
    raw.run(`
      INSERT INTO public_claim_fts (claim_id, problem_id, statement)
      VALUES ('C-777', 'P-TEST-99', 'Goldbach conjecture conjecture asserts primes decomposition');
    `);

    const res = await app.request(
      "https://a.asimposium.org/search.json?q=Goldbach+conjecture",
      {},
      env,
    );
    expect(res.status).toBe(200);

    const json = await res.json();
    const parsed = SearchResponseSchema.parse(json);
    expect(parsed.total_matches).toBe(1);
    expect(parsed.items[0]?.id).toBe("C-777");
    expect(parsed.items[0]?.match_type).toBe("lexical_fts");
    expect(parsed.items[0]?.snippet).toBeDefined();
  });

  test("honors unlisted exact-reference law: absent ID never leaks or confirms", async () => {
    const { db } = createMigratedDb();
    const app = createApp();
    const env = mockEnv(db);

    const res = await app.request("https://a.asimposium.org/search.json?q=P-NONEXISTENT", {}, env);
    expect(res.status).toBe(200);

    const json = await res.json();
    const parsed = SearchResponseSchema.parse(json);
    expect(parsed.total_matches).toBe(0);
    expect(parsed.explanation).toBe("exact_reference_not_found");
    expect(parsed.items).toHaveLength(0);
  });

  test("supports ETag and conditional If-None-Match with 304 Not Modified", async () => {
    const { db } = createMigratedDb();
    const app = createApp();
    const env = mockEnv(db);

    const initial = await app.request("https://a.asimposium.org/search.json?q=riemann", {}, env);
    expect(initial.status).toBe(200);
    const etag = initial.headers.get("etag");
    expect(etag).toBeDefined();

    const conditional = await app.request(
      "https://a.asimposium.org/search.json?q=riemann",
      {
        headers: { "if-none-match": etag ?? "" },
      },
      env,
    );
    expect(conditional.status).toBe(304);
    const text = await conditional.text();
    expect(text).toBe("");
  });
});
