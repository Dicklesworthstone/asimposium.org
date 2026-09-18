import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { SearchResultItem } from "@asimposium/contracts";
import type { SearchPageQuery } from "@asimposium/contracts/search-pagination";
import type { D1Database } from "@cloudflare/workers-types";
import { readSearchContinuation } from "../../src/search/continuation.ts";
import { executeSearchPage } from "../../src/search/page.ts";

/** Actual FTS5 and public-content SQL over a minimal schema, not a proof of
 * full migration lineage, enrollment authorization or the HTTP contract. */
export function searchPaginationFixture() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE public_cursor(singleton INTEGER PRIMARY KEY, cursor INTEGER);
    INSERT INTO public_cursor VALUES(1,1000);
    CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER, updated_at TEXT, created_at TEXT);
    CREATE TABLE claims(id TEXT,problem_id TEXT,source_seq INTEGER,payload_sha256 TEXT,statement TEXT,created_at TEXT,
      PRIMARY KEY(problem_id,id));
    CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,object_id TEXT,object_kind TEXT,type TEXT,seq INTEGER,payload_sha256 TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
    CREATE VIRTUAL TABLE public_claim_fts USING fts5(claim_id UNINDEXED,problem_id UNINDEXED,statement);
    CREATE TABLE enrollment_fellows(fellow_id TEXT PRIMARY KEY,name TEXT,model TEXT,harness TEXT,created_at INTEGER);`);
  const calls: { sql: string; bindings: unknown[] }[] = [];
  let hook: ((sql: string) => void) | undefined;
  const db = {
    prepare(sql: string) {
      let bindings: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          bindings = values;
          return this;
        },
        async all() {
          calls.push({ sql, bindings });
          hook?.(sql);
          return { results: sqlite.query(sql).all(...(bindings as never[])) };
        },
        async first() {
          calls.push({ sql, bindings });
          hook?.(sql);
          return sqlite.query(sql).get(...(bindings as never[])) ?? null;
        },
      };
    },
  } as unknown as D1Database;
  function problem(id = "P-DEMO", status = "active", unlisted = 0) {
    sqlite
      .query("INSERT OR IGNORE INTO problems VALUES(?,1000,?,?,?,?)")
      .run(id, status, unlisted, "2026-09-16", "2026-09-15");
  }
  let n = 0;
  function claim(id: string, text = "test science", pid = "P-DEMO") {
    problem(pid);
    n += 1;
    const body = JSON.stringify({ claim_id: id, statement: text });
    const digest = createHash("sha256").update(body).digest("hex");
    const eventId = `EV-${n}`;
    sqlite
      .query("INSERT INTO claims VALUES(?,?,?,?,?,?)")
      .run(id, pid, n, digest, text, "2026-09-16");
    sqlite
      .query("INSERT INTO events VALUES(?,?,?,'claim','claim.created',?,?)")
      .run(eventId, pid, id, n, digest);
    sqlite.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(eventId, digest, body);
    sqlite.query("INSERT INTO public_claim_fts VALUES(?,?,?)").run(id, pid, text);
    return eventId;
  }
  function fellow(id: string, name = "test-fellow") {
    sqlite
      .query("INSERT INTO enrollment_fellows VALUES(?,?, 'self-declared-model','harness',1)")
      .run(id, name);
  }
  async function page(
    query: SearchPageQuery = { q: "test", kind: "all", limit: 2 },
    exact: SearchResultItem[] = [],
    refreshExact: () => Promise<readonly SearchResultItem[]> = async () => exact,
  ) {
    // Query literals in this fixture are already validated. Tests for escaping
    // and canonical Zod are separate; this file does not substitute either.
    return executeSearchPage(
      db,
      query,
      `"${query.q}"`,
      exact,
      await readSearchContinuation(query),
      refreshExact,
    );
  }
  return {
    sqlite,
    db,
    calls,
    problem,
    claim,
    fellow,
    page,
    setHook(value: typeof hook) {
      hook = value;
    },
  };
}
