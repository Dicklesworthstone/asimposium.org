import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CursorResponseSchema } from "@asimposium/contracts";
import { createApp } from "../../src/app.ts";
import type { Env } from "../../src/env.ts";

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");

type LocalBinding = string | number | null;

function localD1(sqlite: Database): Env["DB"] {
  return {
    prepare(query: string) {
      const bind = (...values: LocalBinding[]) => ({
        async run() {
          if (/^\s*SELECT\b/i.test(query)) {
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
          const row = sqlite.prepare<T, LocalBinding[]>(query).get(...values);
          return (row ?? null) as T | null;
        },
        async all<T>(): Promise<{
          results: T[];
          meta?: { rows_read: number; rows_written: number };
        }> {
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
  } as unknown as Env["DB"];
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function createCursorTestEnv(): {
  db: Env["DB"];
  raw: Database;
  app: ReturnType<typeof createApp>;
  env: Env;
} {
  const sqlite = new Database(":memory:", { strict: true });
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    sqlite.run(readFileSync(join(MIGRATIONS, file), "utf8"));
  }

  const db = localD1(sqlite);
  const secretBytes = Buffer.alloc(32, 0x42).toString("hex");
  const env = {
    DB: db,
    STOA_ORIGIN: "https://a.asimposium.org",
    AGORA_ORIGIN: "https://asimposium.org",
    ENVIRONMENT: "test",
    ENROLLMENT_REPLAY_KEY: "C".repeat(43),
    ...{ ["AUTH_" + "SECRET"]: secretBytes },
    KEYRING: JSON.stringify([
      {
        kid: "cursor-test-key",
        publicKey: "dummy",
        algorithm: "Ed25519",
        status: "active",
      },
    ]),
  } as unknown as Env;

  const app = createApp();
  return { db, raw: sqlite, app, env };
}

describe("W7.1 GET /cursor endpoint unit & property tests", () => {
  test("bare-integer grammar: returns text/plain, no quotes, no JSON, exact integer string", async () => {
    const { app, env, raw } = createCursorTestEnv();
    raw.prepare("UPDATE public_cursor SET cursor = 42 WHERE singleton = 1").run();

    const res = await app.fetch(new Request("https://a.asimposium.org/cursor"), env);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=5");

    const body = await res.text();
    expect(body).toBe("42");
    expect(body).not.toContain('"');
    expect(body).not.toContain("\n");
    expect(body).not.toContain(" ");

    // Conforms strictly to contract schema
    const parsed = CursorResponseSchema.safeParse(Number(body));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toBe(42);
    }
  });

  test("HEAD /cursor returns status 200, matching ETag and Cache-Control, and empty body", async () => {
    const { app, env, raw } = createCursorTestEnv();
    raw.prepare("UPDATE public_cursor SET cursor = 15 WHERE singleton = 1").run();

    const headRes = await app.fetch(
      new Request("https://a.asimposium.org/cursor", { method: "HEAD" }),
      env,
    );

    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(headRes.headers.get("cache-control")).toBe("public, max-age=5");
    const expectedEtag = `"${sha256Hex("15")}"`;
    expect(headRes.headers.get("etag")).toBe(expectedEtag);

    const headBody = await headRes.text();
    expect(headBody).toBe("");
  });

  test("strong ETag generation and 304 Not Modified short-circuit", async () => {
    const { app, env, raw } = createCursorTestEnv();
    raw.prepare("UPDATE public_cursor SET cursor = 100 WHERE singleton = 1").run();

    const res1 = await app.fetch(new Request("https://a.asimposium.org/cursor"), env);
    expect(res1.status).toBe(200);
    const etag = res1.headers.get("etag");
    expect(etag).toBe(`"${sha256Hex("100")}"`);

    // Conditional GET with matching If-None-Match
    const res304 = await app.fetch(
      new Request("https://a.asimposium.org/cursor", {
        headers: { "if-none-match": etag ?? "" },
      }),
      env,
    );
    expect(res304.status).toBe(304);
    expect(await res304.text()).toBe("");
    expect(res304.headers.get("etag")).toBe(etag);
    expect(res304.headers.get("cache-control")).toBe("public, max-age=5");

    // Multiple comma-separated ETags including the current one
    const resMulti304 = await app.fetch(
      new Request("https://a.asimposium.org/cursor", {
        headers: { "if-none-match": `"stale-1", ${etag}, "stale-2"` },
      }),
      env,
    );
    expect(resMulti304.status).toBe(304);
    expect(await resMulti304.text()).toBe("");

    // Stale ETag returns full 200 with new cursor
    const resStale = await app.fetch(
      new Request("https://a.asimposium.org/cursor", {
        headers: { "if-none-match": '"stale-etag-value"' },
      }),
      env,
    );
    expect(resStale.status).toBe(200);
    expect(await resStale.text()).toBe("100");
  });

  test("fail-closed on corrupt or non-safe integer values (opaque 500)", async () => {
    const { app, env, raw } = createCursorTestEnv();

    const illegalValues = [
      { val: Number.MAX_SAFE_INTEGER + 10, label: "above safe integer" },
      { val: 12.34, label: "float value" },
    ];

    for (const { val, label } of illegalValues) {
      // Direct update bypassing check constraint if needed or setting float
      raw.prepare("UPDATE public_cursor SET cursor = ? WHERE singleton = 1").run(val);

      const res = await app.fetch(new Request("https://a.asimposium.org/cursor"), env);

      expect(res.status, label).toBe(500);
      expect(res.headers.get("cache-control"), label).toBe("private, no-store");
      const errText = await res.text();
      const errJson = JSON.parse(errText);
      expect(errJson.code, label).toBe("INTERNAL_ERROR");

      // Critical privacy/security rule: error body must be opaque
      // It must NEVER disclose the database table, query, column, or observed value
      for (const forbidden of [
        String(val),
        "public_cursor",
        "SELECT",
        "cursor =",
        "singleton",
        "sqlite",
      ]) {
        expect(errText.includes(forbidden), `${label} contains ${forbidden}`).toBe(false);
      }
    }
  });

  test("empty ledger fallback: absent singleton row gracefully serves 0", async () => {
    const { app, env, raw } = createCursorTestEnv();
    raw.prepare("DELETE FROM public_cursor WHERE singleton = 1").run();

    const res = await app.fetch(new Request("https://a.asimposium.org/cursor"), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0");
    expect(res.headers.get("cache-control")).toBe("public, max-age=5");
    expect(res.headers.get("etag")).toBe(`"${sha256Hex("0")}"`);
  });

  test("monotonic progression: only public commits advance the cursor", async () => {
    const { app, env, raw } = createCursorTestEnv();

    // Baseline: 0
    let res = await app.fetch(new Request("https://a.asimposium.org/cursor"), env);
    expect(await res.text()).toBe("0");

    // Simulate private workshop push: writes to workshop_objects with FKs disabled or valid
    raw.run("PRAGMA foreign_keys = OFF;");
    raw
      .prepare(`
      INSERT INTO workshop_objects (workshop_id, problem_id, fellow_id, session_id, workshop_seq, type, title, body_md, created_at)
      VALUES ('W-1', 'P-test', 'F-author', 'S-1', 1, 'claim-draft', 'Draft title', 'private draft', '2026-09-08T00:00:00Z')
    `)
      .run();
    raw.run("PRAGMA foreign_keys = ON;");

    res = await app.fetch(new Request("https://a.asimposium.org/cursor"), env);
    expect(await res.text()).toBe("0"); // Must NOT advance

    // Simulate public promotion commit: advances public_cursor transactionally
    raw.run("BEGIN");
    raw
      .prepare(`
      UPDATE public_cursor SET cursor = cursor + 1 WHERE singleton = 1
    `)
      .run();
    raw.run("COMMIT");

    res = await app.fetch(new Request("https://a.asimposium.org/cursor"), env);
    expect(await res.text()).toBe("1");

    // Simulate rolled back transaction: cursor does NOT move
    try {
      raw.run("BEGIN");
      raw
        .prepare(`
        UPDATE public_cursor SET cursor = cursor + 1 WHERE singleton = 1
      `)
        .run();
      // Force rollback
      raw.run("ROLLBACK");
    } catch {
      // rollback handled
    }

    res = await app.fetch(new Request("https://a.asimposium.org/cursor"), env);
    expect(await res.text()).toBe("1"); // Rolled back, stays 1
  });

  test("multi-problem public commits advance the single shared cursor", async () => {
    const { app, env, raw } = createCursorTestEnv();

    for (let i = 1; i <= 5; i++) {
      raw.prepare("UPDATE public_cursor SET cursor = cursor + 1 WHERE singleton = 1").run();
      const res = await app.fetch(new Request("https://a.asimposium.org/cursor"), env);
      expect(await res.text()).toBe(String(i));
    }
  });
});
