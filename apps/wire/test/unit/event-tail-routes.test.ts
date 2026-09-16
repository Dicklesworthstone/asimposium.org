import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { EventTailResponseSchema } from "@asimposium/contracts/event-tail";
import { createApp } from "../../src/app.ts";
import type { Env } from "../../src/env.ts";

/** Real SQLite query execution through the mounted app; not a deployed D1 proof. */
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems (id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER);
    CREATE TABLE events (id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER, created_at TEXT,
      payload_sha256 TEXT, actor_fellow_id TEXT, actor_sponsor_id TEXT, actor_session_id TEXT,
      model_string_self_declared TEXT, harness TEXT, writer_credential_id TEXT);
    CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    INSERT INTO problems VALUES ('P-DEMO', 1, 'open', 0);`);
  const digest = "a".repeat(64);
  sql.prepare("INSERT INTO events VALUES ('E-1','P-DEMO',1,'claim.created','claim','C-1',1,?,?, 'F-1','S-1','SES-1','model','harness','PRIVATE-CREDENTIAL-CANARY')")
    .run("2026-09-15T00:00:00.000Z", digest);
  sql.prepare("INSERT INTO event_content VALUES ('E-1', ?, 'PRIVATE-CONTENT-CANARY', NULL)").run(digest);
  let reads = 0;
  const db = { prepare(query: string) {
    reads++;
    return { bind(...values: (string | number | null)[]) {
      return { all: async <T>() => ({ results: sql.prepare(query).all(...values) as T[] }) };
    } };
  } };
  // No enrollment credentials: anonymous event reads must not construct that stack.
  const env = { DB: db, STOA_ORIGIN: "https://a.asimposium.org", AGORA_ORIGIN: "https://asimposium.org" } as unknown as Env;
  const app = createApp();
  return { sql, readCount: () => reads, call: (path: string, init: RequestInit = {}) =>
    app.request(`https://a.asimposium.org${path}`, init, env) };
}

describe("W6.4 production dispatch", () => {
  test("JSON and NDJSON are public mounted routes, not quarantine or enrollment fallbacks", async () => {
    const f = fixture();
    try {
      const json = await f.call("/p/P-DEMO/events.json");
      expect(json.status).toBe(200);
      const page = EventTailResponseSchema.parse(await json.json());
      expect(page.events.map((event) => event.seq)).toEqual([1]);
      expect(page.page_end.next_cursor).toBe(1);
      const ndjson = await f.call("/p/P-DEMO/events.ndjson");
      expect(ndjson.status).toBe(200);
      expect(ndjson.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
      const text = await ndjson.text();
      expect(text).not.toContain("PRIVATE-");
      const lines = text.trimEnd().split("\n").map((line) => JSON.parse(line));
      expect(lines.slice(0, -1)).toEqual(page.events);
      expect(lines.at(-1).control).toBe("page_end");
      expect(lines.at(-1).next_cursor).toBe(1);
      expect(f.readCount()).toBe(2);
    } finally { f.sql.close(); }
  });
  test("invalid/repeated query parameters are refused before D1 without reflection", async () => {
    const f = fixture();
    try {
      for (const query of ["since=01", "since=0&since=1", "limit=201", "token=PRIVATE-QUERY-CANARY", "wait=25"]) {
        const response = await f.call(`/p/P-DEMO/events.json?${query}`);
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain("CURSOR_INVALID");
        expect(text).not.toContain("PRIVATE-QUERY-CANARY");
      }
      expect(f.readCount()).toBe(0);
    } finally { f.sql.close(); }
  });
  test("private and missing problems are indistinguishable even with a previous ETag", async () => {
    const f = fixture();
    try {
      const first = await f.call("/p/P-DEMO/events.json");
      const etag = first.headers.get("etag") ?? "";
      f.sql.exec("UPDATE problems SET status='private-draft'");
      const hidden = await f.call("/p/P-DEMO/events.json", { headers: { "if-none-match": etag } });
      const missing = await f.call("/p/P-MISSING/events.json");
      expect(hidden.status).toBe(404);
      expect(await hidden.text()).toBe(await missing.text());
      expect(hidden.headers.get("cache-control")).toBe("private, no-store");
    } finally { f.sql.close(); }
  });
  test("HEAD and ETag work; a missing sequence is an error, never a completed page", async () => {
    const f = fixture();
    try {
      const first = await f.call("/p/P-DEMO/events.json");
      const head = await f.call("/p/P-DEMO/events.json", { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(head.headers.get("etag")).toBe(first.headers.get("etag"));
      const cached = await f.call("/p/P-DEMO/events.json", { headers: { "if-none-match": first.headers.get("etag") ?? "" } });
      expect(cached.status).toBe(304);
      f.sql.exec("UPDATE problems SET public_seq=2");
      const broken = await f.call("/p/P-DEMO/events.ndjson");
      expect(broken.status).toBe(500);
      const text = await broken.text();
      expect(text).toContain("INTERNAL_ERROR");
      expect(text).not.toContain('"control":"page_end"');
      expect(text).not.toContain("PRIVATE-");
    } finally { f.sql.close(); }
  });
  test("unsupported nested spellings remain quarantined without reading D1", async () => {
    const f = fixture();
    try {
      for (const path of ["/p/P-DEMO/events.toon", "/p/P-DEMO/events.sse", "/p/P-DEMO/events.json/extra", "/p/P-DEMO%2Fprivate/events.json"]) {
        const response = await f.call(path);
        expect(response.status).toBe(404);
        expect(await response.text()).toContain("ROUTE_NOT_FOUND");
      }
      expect(f.readCount()).toBe(0);
    } finally { f.sql.close(); }
  });
  test("capabilities, schema and OpenAPI disclose the mounted representations", async () => {
    const f = fixture();
    try {
      const capabilities = await (await f.call("/capabilities")).json() as { reads: string[] };
      expect(capabilities.reads).toContain("/p/{id}/events.json");
      expect(capabilities.reads).toContain("/p/{id}/events.ndjson");
      const schema = await f.call("/schemas/event-tail.v1.json");
      expect(schema.status).toBe(200);
      expect(await schema.text()).toContain('"ndjson_page_end"');
      const openapi = await (await f.call("/openapi.json")).text();
      expect(openapi).toContain('"/p/{id}/events.ndjson"');
      expect(openapi).toContain("application/x-ndjson");
      expect(openapi).toContain("#/properties/query/properties/since");
      expect(f.readCount()).toBe(0);
    } finally { f.sql.close(); }
  });
});
