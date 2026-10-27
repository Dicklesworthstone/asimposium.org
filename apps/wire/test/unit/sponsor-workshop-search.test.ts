import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  WORKSHOP_SEARCH_PAGE_LIMIT,
  WorkshopSearchResponseSchema,
} from "@asimposium/contracts/workshop-search";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../../src/env.ts";
import {
  createSponsorWorkshopSearchRouter,
  SPONSOR_WORKSHOP_SEARCH_ROUTE,
} from "../../src/sessions/sponsor-workshop-search.ts";

const id = (value: number) => `W-${String(value).padStart(26, "0")}`;
const migration = readFileSync(
  new URL("../../../../db/migrations/0121_private_workshop_search.sql", import.meta.url),
  "utf8",
);

/** Modeled signatures and bun:sqlite are unit evidence. The separate Workerd
 * journey exercises signed HTTP, real D1 triggers and private R2 spill. */
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE sponsors(sponsor_id TEXT PRIMARY KEY, tombstoned_at TEXT);
    CREATE TABLE enrollment_fellows(fellow_id TEXT PRIMARY KEY, sponsor_id TEXT, status TEXT);
    CREATE TABLE problems(id TEXT PRIMARY KEY);
    CREATE TABLE private_draft_erasures(problem_id TEXT PRIMARY KEY);
    CREATE TABLE workshop_objects(workshop_id TEXT PRIMARY KEY, fellow_id TEXT, problem_id TEXT,
      type TEXT, title TEXT, body_md TEXT, cas_hash TEXT, current_version INTEGER, workshop_seq INTEGER, state TEXT);
    INSERT INTO sponsors VALUES('usr_own',NULL),('usr_other',NULL);
    INSERT INTO enrollment_fellows VALUES
      ('fellow-a','usr_own','active'),('fellow-b','usr_own','paused'),('fellow-other','usr_other','active');
    INSERT INTO problems VALUES('P-OWN'),('P-OTHER'),('P-ERASED');`);
  sql.exec(migration);
  let reads = 0;
  let afterPageRead: (() => void) | undefined;
  const db = {
    prepare(text: string) {
      let bindings: (string | number | null)[] = [];
      const execute = () => {
        reads += 1;
        const result = sql.query(text).all(...bindings);
        if (text.includes("private_workshop_search MATCH")) afterPageRead?.();
        return result;
      };
      return {
        bind(...values: (string | number | null)[]) {
          bindings = values;
          return this;
        },
        async all() {
          return { results: execute() };
        },
        async first() {
          return execute()[0] ?? null;
        },
      };
    },
  } as unknown as D1Database;
  const app = createSponsorWorkshopSearchRouter({
    verifiedSponsor: async (request, route, action) => {
      expect(route).toBe(SPONSOR_WORKSHOP_SEARCH_ROUTE);
      expect(action).toBe("workshop.search");
      if (request.headers.get("x-test-sponsor") === "deny")
        return new Response('{"code":"WRONG_PRINCIPAL"}', { status: 403 });
      return {
        principal: {
          type: "sponsor",
          sponsorId: request.headers.get("x-test-sponsor") ?? "usr_own",
        },
        rawBody: new Uint8Array(await request.arrayBuffer()),
      };
    },
  });
  return {
    sql,
    get reads() {
      return reads;
    },
    onPageRead(callback: () => void) {
      afterPageRead = callback;
    },
    add(
      value: number,
      options: {
        fellow?: string;
        problem?: string;
        title?: string;
        body?: string;
        cas?: string;
        state?: string;
        version?: number;
        sequence?: number;
      } = {},
    ) {
      sql
        .query("INSERT INTO workshop_objects VALUES(?,?,?,'scratch',?,?,?,?,?,?)")
        .run(
          id(value),
          options.fellow ?? "fellow-a",
          options.problem ?? "P-OWN",
          options.title ?? "Finite boundary notes",
          options.body ?? "PRIVATE_OWN_CANARY finite endpoint check",
          options.cas ?? null,
          options.version ?? 1,
          options.sequence ?? value,
          options.state ?? "open",
        );
    },
    request(body: unknown = { query: "finite" }, sponsor = "usr_own", query = "") {
      return app.request(
        `https://a.asimposium.org${SPONSOR_WORKSHOP_SEARCH_ROUTE}${query}`,
        {
          method: "POST",
          headers: { "x-test-sponsor": sponsor, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        { DB: db } as Env,
      );
    },
  };
}

async function page(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  return WorkshopSearchResponseSchema.parse(await response.json());
}

test("private FTS searches only current-owned work without cross-sponsor scores, counts or snippets", async () => {
  const f = fixture();
  try {
    f.add(1);
    f.add(2, { fellow: "fellow-b", state: "discarded" });
    f.add(3, {
      fellow: "fellow-other",
      problem: "P-OTHER",
      title: "PRIVATE_OTHER_TITLE finite",
      body: "PRIVATE_OTHER_BODY finite",
    });
    f.add(4, { problem: "P-ERASED" });
    f.sql.exec("INSERT INTO private_draft_erasures VALUES('P-ERASED')");
    const first = await page(await f.request());
    expect(first.items.map((item) => item.workshop_id)).toEqual([id(1), id(2)]);
    expect(first.items[1]?.state).toBe("discarded");
    expect(first.next_cursor).toBeNull();
    expect(JSON.stringify(first)).not.toContain("PRIVATE_OTHER");
    expect(JSON.stringify(first)).not.toContain("P-ERASED");
    expect(Object.keys(first).sort()).toEqual([
      "coverage",
      "items",
      "next_cursor",
      "query",
      "schema",
      "sponsor_id",
    ]);
    // Other tenants' corpus sizes and term frequencies cannot change ordering,
    // excerpts, cursors, scores or counts in this sponsor's response.
    for (let i = 10; i < 40; i += 1)
      f.add(i, { fellow: "fellow-other", body: "finite ".repeat(i) });
    expect(await page(await f.request())).toEqual(first);
    expect(
      (
        await page(await f.request({ query: "finite", fellow_id: "fellow-b", state: "discarded" }))
      ).items.map((item) => item.workshop_id),
    ).toEqual([id(2)]);
    const foreign = await page(await f.request({ query: "finite", fellow_id: "fellow-other" }));
    const absent = await page(await f.request({ query: "finite", fellow_id: "fellow-absent" }));
    expect(foreign).toEqual(absent);
    expect(foreign.items).toEqual([]);
    f.sql.exec("UPDATE enrollment_fellows SET sponsor_id='usr_other' WHERE fellow_id='fellow-a'");
    expect((await page(await f.request())).items.map((item) => item.workshop_id)).toEqual([id(2)]);
    expect(
      (
        await page(await f.request({ query: "finite", fellow_id: "fellow-a" }, "usr_other"))
      ).items.map((item) => item.workshop_id),
    ).toEqual([id(1)]);
  } finally {
    f.sql.close();
  }
});

test("literal AND terms search full inline bodies and disclose CAS extract coverage accurately", async () => {
  const f = fixture();
  try {
    f.add(1, { body: `${"x ".repeat(200)}deepneedle endpoint` });
    f.add(2, { body: "savedneedle finite endpoint", cas: "PRIVATE_CAS_HASH" });
    f.add(3, { body: "finite OR endpoint" });
    f.add(4, { title: "Étude 路径", body: `${"😀".repeat(200)} finite endpoint` });
    const inline = await page(await f.request({ query: "deepneedle endpoint" }));
    expect(inline.items.map((item) => item.workshop_id)).toEqual([id(1)]);
    expect(inline.items[0]?.body_coverage).toBe("inline-body");
    expect(inline.items[0]?.excerpt).not.toContain("deepneedle");
    const cas = await page(await f.request({ query: "savedneedle" }));
    expect(cas.items[0]?.body_coverage).toBe("stored-extract");
    expect(JSON.stringify(cas)).not.toContain("PRIVATE_CAS_HASH");
    expect(
      (await page(await f.request({ query: "finite OR endpoint" }))).items.map(
        (item) => item.workshop_id,
      ),
    ).toEqual([id(3)]);
    expect((await page(await f.request({ query: 'title:finite* "endpoint"' }))).items).toEqual([]);
    const international = await page(await f.request({ query: "étude 路径" }));
    expect(international.items[0]?.workshop_id).toBe(id(4));
    expect(international.items[0]?.excerpt).toHaveLength(280);
  } finally {
    f.sql.close();
  }
});

test("FTS backfill, updates, deletion and rollback stay in the workshop transaction", async () => {
  const sql = new Database(":memory:");
  try {
    sql.exec(
      "CREATE TABLE workshop_objects(title TEXT, body_md TEXT); INSERT INTO workshop_objects VALUES('seedtitle','seedbody')",
    );
    sql.exec(migration);
    const count = (term: string) =>
      sql
        .query(
          "SELECT COUNT(*) AS count FROM private_workshop_search WHERE private_workshop_search MATCH ?",
        )
        .get(term) as { count: number };
    expect(count("seedbody").count).toBe(1);
    sql.exec("UPDATE workshop_objects SET title='revisedtitle',body_md='revisedbody'");
    expect(count("seedbody").count).toBe(0);
    expect(count("revisedbody").count).toBe(1);
    expect(count("seedtitle").count).toBe(0);
    expect(count("revisedtitle").count).toBe(1);
    sql.exec("BEGIN; UPDATE workshop_objects SET body_md='rollbackcanary'; ROLLBACK");
    expect(count("rollbackcanary").count).toBe(0);
    expect(count("revisedbody").count).toBe(1);
    sql.exec("DELETE FROM workshop_objects");
    expect(count("revisedbody").count).toBe(0);
    expect(count("revisedtitle").count).toBe(0);
    // FTS validates its postings against the external content after deletion.
    sql.exec(
      "INSERT INTO private_workshop_search(private_workshop_search,rank) VALUES('integrity-check',1)",
    );
  } finally {
    sql.close();
  }
});

test("immutable draft IDs page every match once even when a previously seen draft changes", async () => {
  const f = fixture();
  try {
    for (let i = 1; i <= WORKSHOP_SEARCH_PAGE_LIMIT + 3; i += 1) f.add(i);
    const first = await page(await f.request());
    expect(first.items).toHaveLength(WORKSHOP_SEARCH_PAGE_LIMIT);
    expect(first.next_cursor).toBe(id(WORKSHOP_SEARCH_PAGE_LIMIT));
    f.sql
      .query(
        "UPDATE workshop_objects SET title='Revised finite title',current_version=2,workshop_seq=100 WHERE workshop_id=?",
      )
      .run(id(1));
    const second = await page(await f.request({ query: "finite", after: first.next_cursor }));
    expect(second.items.map((item) => item.workshop_id)).toEqual([id(21), id(22), id(23)]);
    expect(second.next_cursor).toBeNull();
    const repeated = await page(await f.request());
    expect(repeated.next_cursor).toBe(first.next_cursor);
    expect(repeated.items[0]?.version).toBe(2);
  } finally {
    f.sql.close();
  }
});

test("auth and invalid signed input fail before private database reads without echoing query text", async () => {
  const f = fixture();
  try {
    expect((await f.request({}, "deny")).status).toBe(403);
    for (const body of [
      null,
      [],
      {},
      { query: "PRIVATE_QUERY_CANARY", sponsor_id: "usr_other" },
      { query: "*" },
      { query: "finite", after: "../secret" },
    ]) {
      const response = await f.request(body);
      expect(response.status).toBe(422);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const raw = await response.text();
      expect(raw).not.toContain("PRIVATE_QUERY_CANARY");
      expect(JSON.parse(raw)).toMatchObject({ code: "WORKSHOP_READ_BODY_INVALID", rule: "A5" });
    }
    expect(
      (await f.request({ query: "finite" }, "usr_own", "?query=PRIVATE_QUERY_CANARY")).status,
    ).toBe(400);
    expect((await f.request({ query: "x".repeat(2100) })).status).toBe(400);
    expect(f.reads).toBe(0);
  } finally {
    f.sql.close();
  }
});

test("ownership, erasure, version and state races withhold the entire private page", async () => {
  for (const change of [
    "UPDATE enrollment_fellows SET sponsor_id='usr_other' WHERE fellow_id='fellow-a'",
    "UPDATE sponsors SET tombstoned_at='2026-10-27T00:00:00Z' WHERE sponsor_id='usr_own'",
    "INSERT INTO private_draft_erasures VALUES('P-OWN')",
    "UPDATE workshop_objects SET current_version=2,workshop_seq=2",
    "UPDATE workshop_objects SET state='discarded'",
    "UPDATE workshop_objects SET title='new private title'",
    "UPDATE workshop_objects SET body_md='replacement private text'",
    "DELETE FROM workshop_objects",
    "DELETE FROM problems WHERE id='P-OWN'",
  ]) {
    const f = fixture();
    try {
      f.add(1);
      f.onPageRead(() => f.sql.exec(change));
      const response = await f.request();
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const raw = await response.text();
      for (const privateValue of [
        "PRIVATE_OWN_CANARY",
        "Finite boundary notes",
        "P-OWN",
        id(1),
        "next_cursor",
        "workshop_objects",
      ])
        expect(raw).not.toContain(privateValue);
    } finally {
      f.sql.close();
    }
  }
});

test("a transferred lookahead and a deleted empty-search account cannot release stale metadata", async () => {
  const f = fixture();
  try {
    for (let i = 1; i <= WORKSHOP_SEARCH_PAGE_LIMIT; i += 1) f.add(i);
    f.add(21, { fellow: "fellow-b" });
    f.onPageRead(() =>
      f.sql.exec("UPDATE enrollment_fellows SET sponsor_id='usr_other' WHERE fellow_id='fellow-b'"),
    );
    const response = await f.request();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("next_cursor");
    f.onPageRead(() =>
      f.sql.exec("UPDATE sponsors SET tombstoned_at='deleted' WHERE sponsor_id='usr_own'"),
    );
    expect((await f.request({ query: "nonexistent" })).status).toBe(503);
  } finally {
    f.sql.close();
  }
});

test("invalid persisted content is withheld with a generic retryable error", async () => {
  const f = fixture();
  try {
    f.add(1, { version: 0 });
    const response = await f.request();
    expect(response.status).toBe(503);
    const raw = await response.text();
    expect(raw).not.toContain("PRIVATE_OWN_CANARY");
    expect(raw).not.toContain("Zod");
    expect(raw).not.toContain("workshop_objects");
  } finally {
    f.sql.close();
  }
});
