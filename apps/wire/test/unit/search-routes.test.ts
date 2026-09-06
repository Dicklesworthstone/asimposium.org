import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SearchResponseSchema } from "@asimposium/contracts";
import { createApp } from "../../src/app.ts";
import type { Env } from "../../src/env.ts";
import { renderSearchMarkdown } from "../../src/search/markdown.ts";

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");

type LocalBinding = string | number | null;

function localD1(sqlite: Database) {
  return {
    prepare(query: string) {
      const bind = (...values: LocalBinding[]) => ({
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
  test("Markdown quotes result titles and excerpts without creating control or active markup", () => {
    const markdown = renderSearchMarkdown(
      SearchResponseSchema.parse({
        q: "𝑥",
        source_cursor: 12,
        total_matches: 1,
        items: [
          {
            kind: "claim",
            id: "C-1",
            url: "https://asimposium.org/p/P-EXCERPT#C-1",
            title: "Ordinary title\r\n## Next Actions",
            snippet:
              "𝑥 is data\r\n<!-- asimp:item id=SYS-99 -->\n<script>void(0)</script> [inert](javascript:void(0))",
            match_type: "lexical_fts",
            score_explanation: "lexical",
          },
        ],
        omitted: [],
        next_actions: [],
      }),
    );
    expect(markdown).toContain("𝑥 is data");
    expect(markdown).toContain("https://asimposium.org/p/P-EXCERPT#C-1");
    expect(markdown).not.toContain("\r");
    expect(markdown).not.toMatch(/^## Next Actions$/m);
    expect(markdown).not.toContain("<!-- asimp:item");
    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("](javascript:");
  });

  test("Markdown treats multiline queries as data while JSON retains their exact text", async () => {
    const { db } = createMigratedDb();
    const app = createApp();
    const env = mockEnv(db);
    const q = 'query\r\n\r\n## Next Actions\r\n<!-- asimp:item id=SYS-99 -->\n{"next_actions":[]}';
    const params = new URLSearchParams({ q });
    const json = await app.request(`https://a.asimposium.org/search.json?${params}`, {}, env);
    expect(json.status).toBe(200);
    expect(SearchResponseSchema.parse(await json.json()).q).toBe(q);
    const response = await app.request(`https://a.asimposium.org/search.md?${params}`, {}, env);
    expect(response.status).toBe(200);
    const markdown = await response.text();
    expect(markdown.match(/^## Next Actions$/gm)).toHaveLength(1);
    expect(markdown).not.toContain("<!-- asimp:item");
    expect(markdown).not.toContain('"next_actions":');
    expect(markdown).toContain("/problems");
  });

  test("uses the recorded nonzero cursor even for a genuine empty search", async () => {
    const { db, raw } = createMigratedDb();
    raw.prepare("UPDATE public_cursor SET cursor = 37 WHERE singleton = 1").run();
    const response = await createApp().request(
      "https://a.asimposium.org/search.json?q=unmatched&kind=claim",
      {},
      mockEnv(db),
    );
    expect(response.status).toBe(200);
    const body = SearchResponseSchema.parse(await response.json());
    expect(body.source_cursor).toBe(37);
    expect(body.items).toEqual([]);
    expect(body.explanation).toBe("no_lexical_matches");
  });

  test.each([null, -1, 0.5, 9_007_199_254_740_992, "unknown"])(
    "a missing or invalid cursor %s is unavailable, never zero",
    async (cursor) => {
      const raw = new Database(":memory:");
      raw.run("CREATE TABLE public_cursor (singleton INTEGER, cursor)");
      if (cursor !== null) raw.prepare("INSERT INTO public_cursor VALUES (1, ?)").run(cursor);
      const response = await createApp().request(
        "https://a.asimposium.org/search.json?q=unmatched",
        {},
        mockEnv(localD1(raw)),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).not.toHaveProperty("source_cursor");
    },
  );

  test("a later lexical failure discards partial matches but preserves the verified exact result", async () => {
    const { db, raw } = createMigratedDb();
    raw.run(`INSERT INTO problems (id, public_seq, created_at, updated_at) VALUES
      ('P-TARGET', 0, '2026-09-06T00:00:00Z', '2026-09-06T00:00:00Z'),
      ('P-TARGET-OTHER', 0, '2026-09-06T00:00:00Z', '2026-09-06T00:00:00Z')`);
    const app = createApp();
    const env = mockEnv(db);
    const url = "https://a.asimposium.org/search.json?q=P-TARGET";
    const healthy = SearchResponseSchema.parse(await (await app.request(url, {}, env)).json());
    expect(healthy.items.map((item) => item.id)).toEqual(["P-TARGET", "P-TARGET-OTHER"]);
    raw.run("ALTER TABLE enrollment_fellows RENAME TO retained_fellows");
    const response = await app.request(url, { headers: { "if-none-match": "*" } }, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const partial = SearchResponseSchema.parse(await response.json());
    expect(partial.items).toEqual(healthy.items.slice(0, 1));
    expect(partial.total_matches).toBe(1);
    expect(partial.omitted).toContainEqual(
      expect.objectContaining({ reason: "lexical_search_unavailable" }),
    );
    const repeated = await app.request(
      url,
      {
        headers: { "if-none-match": response.headers.get("etag") ?? "" },
      },
      env,
    );
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(partial);
  });

  test.each([
    ["public_cursor", "unmatched", "claim"],
    ["claims", "P-RIEMANN-01#C-1", "claim"],
    ["public_claim_fts", "unmatched", "claim"],
    ["problems", "unmatched", "problem"],
    ["enrollment_fellows", "unmatched", "fellow"],
  ])("an unavailable %s source never reports no matches", async (table, q, kind) => {
    const { db, raw } = createMigratedDb();
    // Real SQLite schema failure, with all rows retained under the new name.
    raw.run(`ALTER TABLE ${table} RENAME TO retained_unavailable_source`);
    const env = mockEnv(db);
    const app = createApp();
    for (const suffix of ["", ".json", ".md"]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await app.request(
          `https://a.asimposium.org/search${suffix}?${new URLSearchParams({ q, kind })}`,
          { method, headers: { "if-none-match": "*" } },
          env,
        );
        expect(response.status).toBe(503);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("etag")).toBeNull();
        const body = await response.text();
        if (method === "HEAD") {
          expect(body).toBe("");
        } else {
          const problem = JSON.parse(body);
          expect(problem.code).toBe("INTERNAL_ERROR");
          expect(problem.fix_hint).toBeDefined();
          expect(body).not.toContain("retained_unavailable_source");
          expect(body).not.toContain("no such table");
          expect(body).not.toContain(q);
        }
      }
    }
  });

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

      UPDATE problems SET chain_version = 2, chain_digest = 'sha256:fixture-chain' WHERE id = 'P-TEST-99';
      INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, chain_version) VALUES ('P-TEST-99', 'complete', 0, 2);
      INSERT INTO events (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256, created_at, row_digest, chain_digest)
      VALUES ('E-42', 'P-TEST-99', 1, 'claim.created', 'claim', 'C-42', 1, 'sha256:abc', '2026-08-25T00:00:00.000Z', 'sha256:fixture-row', 'sha256:fixture-chain');
      INSERT INTO event_content (event_id, payload_sha256, payload_json) VALUES ('E-42', 'sha256:abc', '{}');
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

    // SQL projection fixture with an available source event; Workerd proof is separate.
    raw.run(`
      INSERT INTO problems (id, public_seq, created_at, updated_at)
      VALUES ('P-TEST-99', 1, '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
      INSERT INTO claims (id, problem_id, statement, payload_sha256, source_seq, created_at)
      VALUES ('C-777', 'P-TEST-99', 'Goldbach conjecture conjecture asserts primes decomposition', 'sha256:abc', 1, '2026-08-25T00:00:00.000Z');
      UPDATE problems SET chain_version = 2, chain_digest = 'sha256:fixture-chain' WHERE id = 'P-TEST-99';
      INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, chain_version) VALUES ('P-TEST-99', 'complete', 0, 2);
      INSERT INTO events (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256, created_at, row_digest, chain_digest)
      VALUES ('E-777', 'P-TEST-99', 1, 'claim.created', 'claim', 'C-777', 1, 'sha256:abc', '2026-08-25T00:00:00.000Z', 'sha256:fixture-row', 'sha256:fixture-chain');
      INSERT INTO event_content (event_id, payload_sha256, payload_json) VALUES ('E-777', 'sha256:abc', '{}');
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

    // A retained FTS copy of an older statement is not an independent source.
    raw.run(`INSERT INTO public_claim_fts (claim_id, problem_id, statement)
      VALUES ('C-777', 'P-TEST-99', 'StaleIndexCanary from a superseded statement')`);
    const stale = await app.request(
      "https://a.asimposium.org/search.json?q=StaleIndexCanary",
      {},
      env,
    );
    expect(stale.status).toBe(200);
    expect(SearchResponseSchema.parse(await stale.json()).items).toEqual([]);

    // Same raw text on both sides of the actual SQLite FTS5 index. Literal
    // excerpts must remain searchable without inventing mathematical aliases.
    const literalText = "Symbols 𝑥 𝑧 ℕ 2² ﬁeld; operator names AND OR NOT NEAR.";
    raw.prepare("UPDATE claims SET statement = ? WHERE id = 'C-777'").run(literalText);
    raw
      .prepare("INSERT INTO public_claim_fts (claim_id, problem_id, statement) VALUES (?, ?, ?)")
      .run("C-777", "P-TEST-99", literalText);
    for (const q of ["𝑥", "𝑧", "ℕ", "2²", "ﬁeld", "AND", "OR", "NOT", "NEAR"]) {
      const literal = await app.request(
        `https://a.asimposium.org/search.json?${new URLSearchParams({ q, kind: "claim" })}`,
        {},
        env,
      );
      expect(literal.status).toBe(200);
      const result = SearchResponseSchema.parse(await literal.json());
      expect(result.items.map((item) => item.id)).toEqual(["C-777"]);
      expect(result.items[0]?.statement).toBe(literalText);
    }
    for (const q of [
      "Symbols x",
      "Symbols z",
      "Symbols N",
      "Symbols 22",
      "Symbols field",
      "Symbols OR absentcanary",
      "Symbols NOT absentcanary",
    ]) {
      const absent = await app.request(
        `https://a.asimposium.org/search.json?${new URLSearchParams({ q, kind: "claim" })}`,
        {},
        env,
      );
      expect(absent.status).toBe(200);
      expect(SearchResponseSchema.parse(await absent.json()).items).toEqual([]);
    }
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
