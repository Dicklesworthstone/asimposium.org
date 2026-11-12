import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  SPONSOR_WORKSHOP_CURSOR_MAX_RESPONSE_BYTES,
  SponsorWorkshopCursorResponseSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../../src/env.ts";
import { createSponsorWorkshopCursorRouter } from "../../src/sessions/sponsor-workshop-cursor.ts";

const ROUTE = "/v1/sponsors/workshop/cursor";
const SCOPE = { problem_id: "P-AAA", fellow_id: "fellow-a" };
const PRIVATE_MARKERS = [
  "PRIVATE_BODY_CANARY",
  "PRIVATE_TITLE_CANARY",
  "PRIVATE_CAS_CANARY",
  "PRIVATE_SQL_DIAGNOSTIC",
  "PRIVATE_SEQUENCE_CANARY",
  "cas/sha256/",
  "workshop_objects",
];

/** Auth is modeled and queries run in bun:sqlite. These unit tests establish
 * SQL selection and response fencing; they are not signed Workerd evidence. */
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE sponsors(sponsor_id TEXT PRIMARY KEY, tombstoned_at TEXT);
    CREATE TABLE enrollment_fellows(fellow_id TEXT PRIMARY KEY, sponsor_id TEXT);
    CREATE TABLE private_draft_erasures(problem_id TEXT PRIMARY KEY);
    CREATE TABLE workshop_objects(workshop_id TEXT PRIMARY KEY, fellow_id TEXT, problem_id TEXT,
      workshop_seq INTEGER, state TEXT, title TEXT, body_md TEXT, cas_hash TEXT);
    INSERT INTO sponsors VALUES('usr_own',NULL),('usr_other',NULL);
    INSERT INTO enrollment_fellows VALUES
      ('fellow-a','usr_own'),('fellow-b','usr_own'),('fellow-other','usr_other');`);
  let reads = 0;
  let artifactAccesses = 0;
  let failRead: number | undefined;
  let afterCursor: (() => void) | undefined;
  const queries: string[] = [];
  const db = {
    prepare(text: string) {
      queries.push(text);
      let bindings: (string | number | null)[] = [];
      return {
        bind(...values: (string | number | null)[]) {
          bindings = values;
          return this;
        },
        async first() {
          reads += 1;
          if (reads === failRead)
            throw new Error(
              "PRIVATE_SQL_DIAGNOSTIC: workshop_objects contains PRIVATE_BODY_CANARY",
            );
          const row = sql.query(text).get(...bindings);
          if (text.includes("MAX(w.workshop_seq)")) {
            const hook = afterCursor;
            afterCursor = undefined;
            hook?.();
          }
          return row ?? null;
        },
      };
    },
  } as unknown as D1Database;
  const env = {
    DB: db,
    get ARTIFACTS() {
      artifactAccesses += 1;
      throw new Error("The cursor must not access private R2");
    },
  } as unknown as Env;
  const app = createSponsorWorkshopCursorRouter({
    verifiedSponsor: async (request, route, action) => {
      expect(route).toBe(ROUTE);
      expect(action).toBe("workshop.read");
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
  const requestRaw = (body: string, sponsor = "usr_own", query = "") =>
    app.request(
      `https://a.asimposium.org${ROUTE}${query}`,
      {
        method: "POST",
        headers: { "x-test-sponsor": sponsor, "content-type": "application/json" },
        body,
      },
      env,
    );
  return {
    sql,
    queries,
    get reads() {
      return reads;
    },
    get artifactAccesses() {
      return artifactAccesses;
    },
    add(
      fellow: string,
      problem: string,
      seq: string | number = 1,
      state: "open" | "discarded" | "archived" = "open",
    ) {
      const id = `${fellow}:${problem}:${seq}`;
      sql
        .query(`INSERT INTO workshop_objects VALUES(
          ?,?,?,?,?,'PRIVATE_TITLE_CANARY','PRIVATE_BODY_CANARY','PRIVATE_CAS_CANARY')`)
        .run(id, fellow, problem, seq, state);
      return id;
    },
    failAt(read: number) {
      failRead = read;
    },
    onCursorRead(callback: () => void) {
      afterCursor = callback;
    },
    request(body: unknown = SCOPE, sponsor = "usr_own", query = "") {
      return requestRaw(JSON.stringify(body), sponsor, query);
    },
    requestRaw,
  };
}

async function privateError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const raw = await response.text();
  for (const marker of PRIVATE_MARKERS) expect(raw).not.toContain(marker);
  const data = JSON.parse(raw);
  expect(data.code).toBe(code);
  expect(data.workshop_cursor).toBeUndefined();
  expect(data.objects).toBeUndefined();
  return data;
}

test("an owned empty workshop returns bounded metadata and a stable zero without R2", async () => {
  const f = fixture();
  try {
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const raw = await response.text();
    const bytes = new TextEncoder().encode(raw).byteLength;
    expect(bytes).toBeLessThanOrEqual(SPONSOR_WORKSHOP_CURSOR_MAX_RESPONSE_BYTES);
    expect(response.headers.get("content-length")).toBe(String(bytes));
    expect(SponsorWorkshopCursorResponseSchema.parse(JSON.parse(raw))).toEqual({
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      sponsor_id: "usr_own",
      ...SCOPE,
      workshop_cursor: 0,
    });
    expect(await (await f.request()).text()).toBe(raw);
    expect(f.reads).toBe(4);
    expect(f.artifactAccesses).toBe(0);
    expect(f.queries.join("\n")).not.toMatch(/\b(?:body_md|cas_hash|title)\b/);
  } finally {
    f.sql.close();
  }
});

test("private cursors isolate the exact Fellow/problem tuple", async () => {
  const f = fixture();
  try {
    f.add("fellow-a", "P-AAA", 2);
    f.add("fellow-a", "P-AAA", 7);
    f.add("fellow-a", "P-BBB", 90);
    f.add("fellow-b", "P-AAA", 900);
    f.add("fellow-other", "P-AAA", 9000);
    const raw = await (await f.request()).text();
    expect(SponsorWorkshopCursorResponseSchema.parse(JSON.parse(raw)).workshop_cursor).toBe(7);
    for (const marker of PRIVATE_MARKERS) expect(raw).not.toContain(marker);
    expect(raw).not.toContain("P-BBB");
    expect(raw).not.toContain("fellow-b");
    expect(raw).not.toContain("fellow-other");
    // The shared exact-byte decoder uses JSON's last-key semantics. The
    // selected Fellow must still pass current sponsorship; duplicate spelling
    // cannot borrow authority from the earlier, owned Fellow.
    await privateError(
      await f.requestRaw(
        '{"problem_id":"P-AAA","fellow_id":"fellow-a","fellow_id":"fellow-other"}',
      ),
      404,
      "WORKSHOP_NOT_FOUND",
    );
    expect(
      SponsorWorkshopCursorResponseSchema.parse(
        await (await f.request({ ...SCOPE, problem_id: "P-NONE" })).json(),
      ).workshop_cursor,
    ).toBe(0);
    expect(f.artifactAccesses).toBe(0);
    expect(f.queries.join("\n")).not.toMatch(/\b(?:body_md|cas_hash|title)\b/);
  } finally {
    f.sql.close();
  }
});

test("private edits, discard and archive advance the cursor", async () => {
  const f = fixture();
  try {
    const id = f.add("fellow-a", "P-AAA", 1);
    for (const [seq, state] of [
      [1, "open"],
      [4, "open"],
      [8, "discarded"],
      [11, "archived"],
    ] as const) {
      f.sql
        .query("UPDATE workshop_objects SET workshop_seq=?, state=? WHERE workshop_id=?")
        .run(seq, state, id);
      const response = await f.request();
      expect(response.status).toBe(200);
      const raw = await response.text();
      expect(SponsorWorkshopCursorResponseSchema.parse(JSON.parse(raw)).workshop_cursor).toBe(seq);
      expect(await (await f.request()).text()).toBe(raw);
    }
    expect(f.artifactAccesses).toBe(0);
  } finally {
    f.sql.close();
  }
});

test("denied verification and invalid signed bodies cannot query private metadata", async () => {
  const f = fixture();
  try {
    await privateError(await f.request(SCOPE, "deny"), 403, "WRONG_PRINCIPAL");
    for (const body of [
      null,
      [],
      {},
      { problem_id: "P-AAA" },
      { ...SCOPE, sponsor_id: "usr_other" },
      { ...SCOPE, before_workshop_seq: 1 },
      { ...SCOPE, fellow_id: "" },
    ]) {
      const data = await privateError(await f.request(body), 422, "WORKSHOP_READ_BODY_INVALID");
      expect(data.rule).toBe("A5");
    }
    for (const raw of [
      "{",
      '{"problem_id":"P-AAA","fellow_id":"fellow-a",}',
      `${" ".repeat(2049)}${JSON.stringify(SCOPE)}`,
    ])
      await privateError(await f.requestRaw(raw), 422, "WORKSHOP_READ_BODY_INVALID");
    await privateError(
      await f.request(SCOPE, "usr_own", "?problem_id=P-BBB"),
      422,
      "WORKSHOP_READ_BODY_INVALID",
    );
    expect(f.reads).toBe(0);
    expect(f.queries).toEqual([]);
    expect(f.artifactAccesses).toBe(0);
  } finally {
    f.sql.close();
  }
});

test("missing, foreign, tombstoned and erased authority have one private 404 face", async () => {
  let missing: unknown;
  for (const mode of ["missing", "foreign", "tombstoned", "erased"]) {
    const f = fixture();
    try {
      f.add("fellow-a", "P-AAA", 77);
      if (mode === "tombstoned")
        f.sql.exec("UPDATE sponsors SET tombstoned_at='2026-11-12' WHERE sponsor_id='usr_own'");
      if (mode === "erased") f.sql.exec("INSERT INTO private_draft_erasures VALUES('P-AAA')");
      const response = await f.request(
        mode === "missing" ? { ...SCOPE, fellow_id: "fellow-missing" } : SCOPE,
        mode === "foreign" ? "usr_other" : "usr_own",
      );
      const data = await privateError(response, 404, "WORKSHOP_NOT_FOUND");
      if (mode === "missing") missing = data;
      else expect(data).toEqual(missing);
      expect(f.reads).toBe(1);
      expect(f.artifactAccesses).toBe(0);
    } finally {
      f.sql.close();
    }
  }
});

test("authority changes after cursor capture produce the same private 404", async () => {
  for (const change of [
    "UPDATE enrollment_fellows SET sponsor_id='usr_other' WHERE fellow_id='fellow-a'",
    "UPDATE sponsors SET tombstoned_at='2026-11-12' WHERE sponsor_id='usr_own'",
    "INSERT INTO private_draft_erasures VALUES('P-AAA')",
  ]) {
    const f = fixture();
    try {
      f.add("fellow-a", "P-AAA", 77);
      const foreign = await privateError(
        await f.request(SCOPE, "usr_other"),
        404,
        "WORKSHOP_NOT_FOUND",
      );
      let changed = false;
      f.onCursorRead(() => {
        f.sql.exec(change);
        changed = true;
      });
      const before = f.reads;
      const data = await privateError(await f.request(), 404, "WORKSHOP_NOT_FOUND");
      expect(changed).toBe(true);
      expect(f.reads - before).toBe(2);
      expect(data).toEqual(foreign);
      expect(f.artifactAccesses).toBe(0);
    } finally {
      f.sql.close();
    }
  }
});

test("capture and final authority database failures return private 503s", async () => {
  for (const failedRead of [1, 2]) {
    const f = fixture();
    try {
      f.add("fellow-a", "P-AAA", 77);
      f.failAt(failedRead);
      const response = await f.request();
      expect(response.headers.get("retry-after")).toBe("5");
      await privateError(response, 503, "INTERNAL_ERROR");
      expect(f.reads).toBe(failedRead);
      expect(f.artifactAccesses).toBe(0);
    } finally {
      f.sql.close();
    }
  }
});

test("unsafe sequences fail closed and the maximum safe cursor succeeds", async () => {
  for (const sequence of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "PRIVATE_SEQUENCE_CANARY"]) {
    const f = fixture();
    try {
      f.add("fellow-a", "P-AAA", sequence);
      const response = await f.request();
      expect(response.headers.get("retry-after")).toBe("5");
      await privateError(response, 503, "INTERNAL_ERROR");
      expect(f.artifactAccesses).toBe(0);
    } finally {
      f.sql.close();
    }
  }
  const f = fixture();
  try {
    f.add("fellow-a", "P-AAA", Number.MAX_SAFE_INTEGER);
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(SponsorWorkshopCursorResponseSchema.parse(await response.json()).workshop_cursor).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(f.artifactAccesses).toBe(0);
  } finally {
    f.sql.close();
  }
});
