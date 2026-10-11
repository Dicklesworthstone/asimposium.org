import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  SPONSOR_WORKSHOP_INDEX_PAGE_LIMIT,
  SponsorWorkshopIndexResponseSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../../src/env.ts";
import { createSponsorWorkshopIndexRouter } from "../../src/sessions/sponsor-workshop-index.ts";

const ROUTE = "/v1/sponsors/workshops";

/** Modeled auth and bun:sqlite are unit evidence; the mounted signed route
 * has a separate real Workerd journey. No grants table is present on purpose. */
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE sponsors(sponsor_id TEXT PRIMARY KEY, tombstoned_at TEXT);
    CREATE TABLE enrollment_fellows(fellow_id TEXT PRIMARY KEY, sponsor_id TEXT, name TEXT);
    CREATE TABLE workshop_objects(workshop_id TEXT PRIMARY KEY, fellow_id TEXT, problem_id TEXT,
      workshop_seq INTEGER, body_md TEXT, state TEXT);
    INSERT INTO sponsors VALUES('usr_own',NULL),('usr_other',NULL);
    INSERT INTO enrollment_fellows VALUES
      ('fellow-a','usr_own','redshift'),('fellow-b','usr_own','blueshift'),
      ('fellow-other','usr_other','private-fellow');`);
  sql.exec(
    readFileSync(
      new URL("../../../../db/migrations/0095_sponsor_workshop_index.sql", import.meta.url),
      "utf8",
    ),
  );
  let reads = 0;
  let afterPageRead: (() => void) | undefined;
  const db = {
    prepare(text: string) {
      let bindings: (string | number | null)[] = [];
      const execute = () => {
        reads += 1;
        const result = sql.query(text).all(...bindings);
        if (text.includes("MAX(w.workshop_seq)")) afterPageRead?.();
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
  const app = createSponsorWorkshopIndexRouter({
    verifiedSponsor: async (request, route, action) => {
      expect(route).toBe(ROUTE);
      expect(action).toBe("workshop.list");
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
  const add = (fellow: string, problem: string, seq = 1) =>
    sql
      .query("INSERT INTO workshop_objects VALUES(?,?,?,?,?,'discarded')")
      .run(`${fellow}:${problem}:${seq}`, fellow, problem, seq, "PRIVATE_BODY_CANARY");
  return {
    sql,
    add,
    get reads() {
      return reads;
    },
    onPageRead(callback: () => void) {
      afterPageRead = callback;
    },
    request(body: unknown = {}, sponsor = "usr_own", query = "") {
      return app.request(
        `https://a.asimposium.org${ROUTE}${query}`,
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

test("unbound Fellows expose actual problem pairs and one current private cursor per pair", async () => {
  const f = fixture();
  try {
    f.add("fellow-a", "P-AAA", 1);
    f.add("fellow-a", "P-AAA", 7);
    f.add("fellow-a", "P-BBB");
    f.add("fellow-b", "P-AAA");
    f.add("fellow-other", "P-SECRET");
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const raw = await response.text();
    const page = SponsorWorkshopIndexResponseSchema.parse(JSON.parse(raw));
    expect(page.workshops).toEqual([
      { fellow_id: "fellow-a", fellow_name: "redshift", problem_id: "P-AAA", workshop_cursor: 7 },
      { fellow_id: "fellow-a", fellow_name: "redshift", problem_id: "P-BBB", workshop_cursor: 1 },
      { fellow_id: "fellow-b", fellow_name: "blueshift", problem_id: "P-AAA", workshop_cursor: 1 },
    ]);
    expect(page.next_cursor).toBeNull();
    expect(raw).not.toContain("PRIVATE_BODY_CANARY");
    expect(raw).not.toContain("P-SECRET");
    expect(raw).not.toContain("private-fellow");
  } finally {
    f.sql.close();
  }
});

test("edits cannot move unseen pairs across the bounded keyset page", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < SPONSOR_WORKSHOP_INDEX_PAGE_LIMIT + 3; i += 1)
      f.add("fellow-a", `P-${String(i).padStart(3, "0")}`);
    f.add("fellow-b", "P-END");
    const first = SponsorWorkshopIndexResponseSchema.parse(await (await f.request()).json());
    expect(first.workshops).toHaveLength(SPONSOR_WORKSHOP_INDEX_PAGE_LIMIT);
    expect(first.next_cursor).toEqual({ fellow_id: "fellow-a", problem_id: "P-019" });
    f.add("fellow-a", "P-000", 100);
    const second = SponsorWorkshopIndexResponseSchema.parse(
      await (await f.request({ after: first.next_cursor })).json(),
    );
    expect(second.workshops.map((item) => `${item.fellow_id}:${item.problem_id}`)).toEqual([
      "fellow-a:P-020",
      "fellow-a:P-021",
      "fellow-a:P-022",
      "fellow-b:P-END",
    ]);
    expect(second.next_cursor).toBeNull();
    const firstAgain = SponsorWorkshopIndexResponseSchema.parse(await (await f.request()).json());
    expect(firstAgain.workshops[0]?.workshop_cursor).toBe(100);
    expect(firstAgain.next_cursor).toEqual(first.next_cursor);
  } finally {
    f.sql.close();
  }
});

test("wrong principals, cursors and unsigned query parameters never query private work", async () => {
  const f = fixture();
  try {
    expect((await f.request({}, "deny")).status).toBe(403);
    for (const body of [
      null,
      [],
      { sponsor_id: "usr_other" },
      { after: { fellow_id: "fellow-a" } },
    ]) {
      const response = await f.request(body);
      expect(response.status).toBe(422);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toMatchObject({
        code: "WORKSHOP_READ_BODY_INVALID",
        rule: "A5",
      });
    }
    expect((await f.request({}, "usr_own", "?after=untrusted")).status).toBe(400);
    expect(f.reads).toBe(0);
  } finally {
    f.sql.close();
  }
});

test("transfer or sponsor deletion during an index read withholds former private metadata", async () => {
  for (const change of [
    "UPDATE enrollment_fellows SET sponsor_id='usr_other' WHERE fellow_id='fellow-a'",
    "UPDATE sponsors SET tombstoned_at='2026-10-11T00:00:00Z' WHERE sponsor_id='usr_own'",
  ]) {
    const f = fixture();
    try {
      f.add("fellow-a", "P-PRIVATE");
      f.onPageRead(() => f.sql.exec(change));
      const response = await f.request();
      expect(response.status).toBe(503);
      const raw = await response.text();
      expect(raw).not.toContain("P-PRIVATE");
      expect(raw).not.toContain("redshift");
      expect(raw).not.toContain("PRIVATE_BODY_CANARY");
    } finally {
      f.sql.close();
    }
  }
});

test("malformed persisted directory metadata fails closed with no SQL diagnostic", async () => {
  const f = fixture();
  try {
    f.add("fellow-a", "P-PRIVATE", 0);
    const response = await f.request();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.text();
    expect(body).not.toContain("P-PRIVATE");
    expect(body).not.toContain("workshop_objects");
    expect(body).not.toContain("PRIVATE_BODY_CANARY");
  } finally {
    f.sql.close();
  }
});

test("a transferred lookahead cannot disclose that former Fellow has another page", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < SPONSOR_WORKSHOP_INDEX_PAGE_LIMIT; i += 1)
      f.add("fellow-a", `P-${String(i).padStart(3, "0")}`);
    f.add("fellow-b", "P-PRIVATE");
    f.onPageRead(() =>
      f.sql.exec("UPDATE enrollment_fellows SET sponsor_id='usr_other' WHERE fellow_id='fellow-b'"),
    );
    const response = await f.request();
    expect(response.status).toBe(503);
    const raw = await response.text();
    expect(raw).not.toContain("next_cursor");
    expect(raw).not.toContain("P-PRIVATE");
  } finally {
    f.sql.close();
  }
});
