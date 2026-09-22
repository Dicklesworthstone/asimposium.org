import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
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
  sql
    .prepare(
      "INSERT INTO events VALUES ('E-1','P-DEMO',1,'claim.created','claim','C-1',1,?,?, 'F-1','S-1','SES-1','model','harness','PRIVATE-CREDENTIAL-CANARY')",
    )
    .run("2026-09-15T00:00:00.000Z", digest);
  sql
    .prepare("INSERT INTO event_content VALUES ('E-1', ?, 'PRIVATE-CONTENT-CANARY', NULL)")
    .run(digest);
  let reads = 0;
  const db = {
    prepare(query: string) {
      reads++;
      return {
        bind(...values: (string | number | null)[]) {
          return { all: async <T>() => ({ results: sql.prepare(query).all(...values) as T[] }) };
        },
      };
    },
  };
  // No enrollment credentials: anonymous event reads must not construct that stack.
  const env = {
    DB: db,
    STOA_ORIGIN: "https://a.asimposium.org",
    AGORA_ORIGIN: "https://asimposium.org",
  } as unknown as Env;
  const app = createApp();
  return {
    sql,
    readCount: () => reads,
    call: (path: string, init: RequestInit = {}) =>
      app.request(`https://a.asimposium.org${path}`, init, env),
  };
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
      const lines = text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines.slice(0, -1)).toEqual(page.events);
      expect(lines.at(-1).control).toBe("page_end");
      expect(lines.at(-1).next_cursor).toBe(1);
      expect(f.readCount()).toBe(2);
    } finally {
      f.sql.close();
    }
  });
  test("invalid/repeated query parameters are refused before D1 without reflection", async () => {
    const f = fixture();
    try {
      for (const query of [
        "since=01",
        "since=0&since=1",
        "limit=201",
        "token=PRIVATE-QUERY-CANARY",
        "wait=26",
        "wait=01",
        "wait=1.5",
        "wait=1&wait=1",
      ]) {
        const response = await f.call(`/p/P-DEMO/events.json?${query}`);
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain("CURSOR_INVALID");
        expect(text).not.toContain("PRIVATE-QUERY-CANARY");
      }
      expect(f.readCount()).toBe(0);
    } finally {
      f.sql.close();
    }
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
    } finally {
      f.sql.close();
    }
  });
  test("HEAD and ETag work; a missing sequence is an error, never a completed page", async () => {
    const f = fixture();
    try {
      const first = await f.call("/p/P-DEMO/events.json");
      const head = await f.call("/p/P-DEMO/events.json", { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(head.headers.get("etag")).toBe(first.headers.get("etag"));
      const cached = await f.call("/p/P-DEMO/events.json", {
        headers: { "if-none-match": first.headers.get("etag") ?? "" },
      });
      expect(cached.status).toBe(304);
      f.sql.exec("UPDATE problems SET public_seq=2");
      const broken = await f.call("/p/P-DEMO/events.ndjson");
      expect(broken.status).toBe(500);
      const text = await broken.text();
      expect(text).toContain("INTERNAL_ERROR");
      expect(text).not.toContain('"control":"page_end"');
      expect(text).not.toContain("PRIVATE-");
    } finally {
      f.sql.close();
    }
  });
  test("unsupported nested spellings remain quarantined without reading D1", async () => {
    const f = fixture();
    try {
      for (const path of [
        "/p/P-DEMO/events.sse",
        "/p/P-DEMO/events.json/extra",
        "/p/P-DEMO%2Fprivate/events.json",
      ]) {
        const response = await f.call(path);
        expect(response.status).toBe(404);
        expect(await response.text()).toContain("ROUTE_NOT_FOUND");
      }
      expect(f.readCount()).toBe(0);
    } finally {
      f.sql.close();
    }
  });
  test("TOON format emits after lossless round-trip check", async () => {
    const f = fixture();
    try {
      const response = await f.call("/p/P-DEMO/events.toon");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      const text = await response.text();
      expect(text).toContain("id|seq|type|object_id|created_at\n");
      expect(text).toContain("E-1|1|claim.created|C-1|");
      expect(text).toContain("[control:page_end|next_cursor:1|has_more:false]\n");
    } finally {
      f.sql.close();
    }
  });
  test("negotiated /events route handles format param and Accept headers", async () => {
    const f = fixture();
    try {
      const toonRes = await f.call("/p/P-DEMO/events?format=toon");
      expect(toonRes.status).toBe(200);
      expect(toonRes.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      const ndjsonRes = await f.call("/p/P-DEMO/events", {
        headers: { accept: "application/x-ndjson" },
      });
      expect(ndjsonRes.status).toBe(200);
      expect(ndjsonRes.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
      const badRes = await f.call("/p/P-DEMO/events?format=yaml");
      expect(badRes.status).toBe(400);
      expect(await badRes.text()).toContain("UNKNOWN_FORMAT");
    } finally {
      f.sql.close();
    }
  });
  test("Last-Event-ID header resumes from cursor when since is omitted", async () => {
    const f = fixture();
    try {
      const res = await f.call("/p/P-DEMO/events.json", { headers: { "last-event-id": "1" } });
      expect(res.status).toBe(200);
      const page = EventTailResponseSchema.parse(await res.json());
      expect(page.events).toHaveLength(0);
      expect(page.page_end.since).toBe(1);
      expect(page.page_end.next_cursor).toBe(1);
    } finally {
      f.sql.close();
    }
  });
  test("feeds are served at exact suffixes and via Accept negotiation", async () => {
    const f = fixture();
    try {
      const rss = await f.call("/p/P-DEMO/feed.rss");
      expect(rss.status).toBe(200);
      expect(rss.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
      expect(await rss.text()).toContain('<rss version="2.0"');

      const atom = await f.call("/p/P-DEMO/feed.atom");
      expect(atom.status).toBe(200);
      expect(atom.headers.get("content-type")).toBe("application/atom+xml; charset=utf-8");
      expect(await atom.text()).toContain('<feed xmlns="http://www.w3.org/2005/Atom"');

      const jsonFeed = await f.call("/p/P-DEMO/feed.json");
      expect(jsonFeed.status).toBe(200);
      expect(jsonFeed.headers.get("content-type")).toBe("application/feed+json; charset=utf-8");
      expect(await jsonFeed.text()).toContain("https://jsonfeed.org/version/1.1");

      const neg = await f.call("/p/P-DEMO/feed", { headers: { accept: "application/atom+xml" } });
      expect(neg.status).toBe(200);
      expect(neg.headers.get("content-type")).toBe("application/atom+xml; charset=utf-8");
      expect(neg.headers.get("vary")).toBe("Accept");
    } finally {
      f.sql.close();
    }
  });
  test("capabilities, schema and OpenAPI disclose the mounted representations", async () => {
    const f = fixture();
    try {
      const capabilities = (await (await f.call("/capabilities")).json()) as { reads: string[] };
      expect(capabilities.reads).toContain("/p/{id}/events.json");
      expect(capabilities.reads).toContain("/p/{id}/events.ndjson");
      const schema = await f.call("/schemas/event-tail.v1.json");
      expect(schema.status).toBe(200);
      const schemaText = await schema.text();
      expect(schemaText).toContain('"ndjson_page_end"');
      expect(schemaText).toContain('"wait":{"type":"string"');
      expect(schemaText).toContain("Optional wait is 0-25 seconds");
      const openapi = await (await f.call("/openapi.json")).text();
      expect(openapi).toContain('"/p/{id}/events.ndjson"');
      expect(openapi).toContain("application/x-ndjson");
      expect(openapi).toContain("#/properties/query/properties/since");
      expect(f.readCount()).toBe(0);
    } finally {
      f.sql.close();
    }
  });
});

describe("W7.3 mounted event waits", () => {
  for (const route of [
    "events.json",
    "events.ndjson",
    "events.toon",
    "events",
    "events?format=ndjson",
  ]) {
    test(`${route} accepts wait while returning an existing event immediately`, async () => {
      const f = fixture();
      try {
        const separator = route.includes("?") ? "&" : "?";
        const result = await f.call(`/p/P-DEMO/${route}${separator}since=0&wait=25`);
        expect(result.status).toBe(200);
        expect(result.headers.get("x-asimposium-wait")).toBe("immediate");
        expect(result.headers.get("cache-control")).toBe("private, no-store");
        expect(await result.text()).not.toContain("PRIVATE-");
        expect(f.readCount()).toBe(1);
      } finally {
        f.sql.close();
      }
    });
  }
  test("Last-Event-ID plus wait expires with an exact NDJSON completion witness", async () => {
    const f = fixture();
    try {
      const result = await f.call("/p/P-DEMO/events.ndjson?wait=1", {
        headers: { "last-event-id": "1" },
      });
      expect(result.status).toBe(200);
      expect(result.headers.get("x-asimposium-wait")).toBe("timeout");
      expect(result.headers.get("retry-after")).toBe("5");
      const lines = (await result.text()).trim().split("\n");
      expect(lines).toHaveLength(1);
      const end = JSON.parse(lines[0] ?? "");
      expect(end.control).toBe("page_end");
      expect(end.next_cursor).toBe(1);
      expect(end.has_more).toBe(false);
      expect(end.poll).toBe("/p/P-DEMO/events.ndjson?since=1&limit=50&wait=1");
      expect(f.readCount()).toBe(2);
    } finally {
      f.sql.close();
    }
  });
  test("a problem becoming private during a mounted wait produces no cursor", async () => {
    const f = fixture();
    const timer = setTimeout(() => f.sql.exec("UPDATE problems SET status='private-draft'"), 20);
    try {
      const result = await f.call("/p/P-DEMO/events.json?since=1&wait=1");
      expect(result.status).toBe(404);
      const body = await result.text();
      expect(body).not.toContain('"page_end"');
      expect(body).not.toContain("PRIVATE-");
    } finally {
      clearTimeout(timer);
      f.sql.close();
    }
  });
  test("HEAD and a pinned empty snapshot never hold a connection", async () => {
    const f = fixture();
    try {
      const head = await f.call("/p/P-DEMO/events.json?since=1&wait=25", { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("x-asimposium-wait")).toBe("immediate");
      expect(await head.text()).toBe("");
      const pinned = await f.call("/p/P-DEMO/events.json?since=1&through=1&wait=25");
      expect(pinned.status).toBe(200);
      expect(pinned.headers.get("x-asimposium-wait")).toBe("immediate");
      const page = EventTailResponseSchema.parse(await pinned.json());
      expect(page.page_end.poll).toBe("/p/P-DEMO/events.json?since=1&limit=50&wait=25");
      expect(f.readCount()).toBe(2);
    } finally {
      f.sql.close();
    }
  });
});
