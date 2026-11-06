import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SponsorInboxResponseSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../../src/env.ts";
import { createSponsorInboxRouter, readSponsorInbox } from "../../src/inbox/sponsor-inbox.ts";
import { sponsorMutationRefusal } from "../../src/moderation/sponsor-suspension.ts";

const NOW = 1_800_000_000_000;
const FELLOW = "fellow-alice";
const SPONSOR = "usr_alice";

// Run the production predicates against SQLite; the separate mounted Worker
// journey exercises real service-envelope authentication and D1 bindings.
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE sponsors(sponsor_id TEXT PRIMARY KEY, tombstoned_at TEXT);
    CREATE TABLE enrollment_fellows(fellow_id TEXT PRIMARY KEY, sponsor_id TEXT, name TEXT);
    CREATE TABLE problems(id TEXT PRIMARY KEY, status TEXT, public_seq INTEGER);
    CREATE TABLE problem_memberships(problem_id TEXT, fellow_id TEXT);
    CREATE TABLE events(id TEXT,problem_id TEXT,seq INTEGER,type TEXT,object_kind TEXT,
      object_id TEXT,object_version INTEGER,payload_sha256 TEXT,actor_fellow_id TEXT);
    CREATE TABLE event_content(event_id TEXT,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
    CREATE TABLE content_controls(problem_id TEXT,target_ref TEXT,version INTEGER,visibility TEXT);
    CREATE TABLE scientific_withdrawals(event_id TEXT,problem_id TEXT,seq INTEGER,event_sha256 TEXT,
      retraction_id TEXT,target_kind TEXT,target_object TEXT,source_event_id TEXT,source_sha256 TEXT);
    CREATE TABLE sponsor_directives(notice_id TEXT, sponsor_id TEXT, fellow_id TEXT);
    CREATE TABLE sponsor_suspension_events(event_id TEXT, sponsor_id TEXT);
    CREATE TABLE fellow_inbox_notices(id TEXT PRIMARY KEY, fellow_id TEXT, problem_id TEXT,
      notice_type TEXT, seq INTEGER, title TEXT, detail TEXT, impact_kind TEXT,
      caused_by_event_id TEXT, target_id TEXT, acknowledged_at INTEGER, expires_at INTEGER,
      created_at INTEGER);
    INSERT INTO sponsors VALUES ('usr_alice',NULL),('usr_bob',NULL);
    INSERT INTO enrollment_fellows VALUES
      ('fellow-alice','usr_alice','alice-fellow'),('fellow-bob','usr_bob','bob-fellow');
    INSERT INTO problems VALUES ('P-PUBLIC','active',0),('P-PRIVATE','private-draft',0);
  `);
  let afterPageRead: (() => void) | undefined;
  let reads = 0;
  const db = {
    prepare(query: string) {
      let values: (string | number | null)[] = [];
      return {
        bind(...bindings: (string | number | null)[]) {
          values = bindings;
          return this;
        },
        async first() {
          reads++;
          const result = sql.query(query).get(...values);
          if (query.includes("AS notices_json")) afterPageRead?.();
          return result ?? null;
        },
      };
    },
  } as unknown as D1Database;
  const router = createSponsorInboxRouter({
    db,
    verifiedSponsor: async (request, route, action) => {
      expect(route).toBe("/v1/sponsors/inbox");
      expect(action).toBe("inbox.read");
      const sponsorId = request.headers.get("x-test-sponsor") ?? SPONSOR;
      if (sponsorId === "deny") return new Response('{"code":"WRONG_PRINCIPAL"}', { status: 403 });
      return {
        principal: { type: "sponsor", sponsorId },
        rawBody: new Uint8Array(await request.arrayBuffer()),
      };
    },
  });
  return {
    sql,
    db,
    get reads() {
      return reads;
    },
    onPageRead(callback: () => void) {
      afterPageRead = callback;
    },
    add(
      seq: number,
      options: {
        fellow?: string;
        problem?: string | null;
        type?: string;
        acknowledged?: number | null;
        expires?: number | null;
        target?: string | null;
        detail?: string;
      } = {},
    ) {
      const id = `${options.fellow ?? FELLOW}-${seq}`;
      sql
        .query(`INSERT INTO fellow_inbox_notices VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          id,
          options.fellow ?? FELLOW,
          options.problem ?? null,
          options.type ?? "impact_echo",
          seq,
          `Notice ${seq}`,
          options.detail ?? "PRIVATE_OWN_NOTICE",
          options.type ? null : "gap_closed",
          null,
          options.target ?? null,
          options.acknowledged ?? null,
          options.expires ?? null,
          NOW,
        );
      return id;
    },
    request(body: unknown = { fellow_id: FELLOW }, sponsor = SPONSOR, query = "") {
      return router.request(
        `https://a.asimposium.org/v1/sponsors/inbox${query}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-test-sponsor": sponsor },
          body: typeof body === "string" ? body : JSON.stringify(body),
        },
        { DB: db } as Env,
      );
    },
    read(
      input: { since?: number; limit?: number; unacknowledged_only?: boolean } = {},
      sponsor = SPONSOR,
    ) {
      return readSponsorInbox(db, sponsor, { fellow_id: FELLOW, ...input }, NOW);
    },
  };
}

async function page(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  return SponsorInboxResponseSchema.parse(await response.json());
}

describe("sponsor inbox reads currently owned Fellow notices", () => {
  test("chronological continuation and Fellow acknowledgement filter never consume notices", async () => {
    const f = fixture();
    try {
      f.add(3);
      f.add(1, { acknowledged: NOW });
      f.add(2);
      f.add(1, { fellow: "fellow-bob", detail: "OTHER_SPONSOR_PRIVATE_CANARY" });
      const before = f.sql.query("SELECT * FROM fellow_inbox_notices ORDER BY id").all();
      const first = await page(await f.request({ fellow_id: FELLOW, limit: 2 }));
      expect(first.items.map((item) => item.seq)).toEqual([1, 2]);
      expect(first.fellow_unacknowledged_count).toBe(2);
      expect(first.next_cursor).toBe(2);
      expect(first.has_more).toBe(true);
      expect(first.omitted).toEqual(["limit_reached"]);
      expect(first.items.every((item) => !("next_actions" in item))).toBe(true);
      expect(JSON.stringify(first)).not.toContain("OTHER_SPONSOR_PRIVATE_CANARY");
      const next = await f.read({ since: first.next_cursor ?? 0, limit: 2 });
      expect(next?.items.map((item) => item.seq)).toEqual([3]);
      expect(next?.next_cursor).toBe(3);
      expect(next?.has_more).toBe(false);
      const unack = await f.read({ unacknowledged_only: true });
      expect(unack?.items.map((item) => item.seq)).toEqual([2, 3]);
      expect((await f.read({ since: 3 }))?.next_cursor).toBeNull();
      expect(f.sql.query("SELECT * FROM fellow_inbox_notices ORDER BY id").all()).toEqual(before);
    } finally {
      f.sql.close();
    }
  });

  test("expiry and problem/hypothesis visibility filter both pages and counts before LIMIT", async () => {
    const f = fixture();
    try {
      f.add(1, { expires: NOW });
      f.add(2, { problem: "P-PRIVATE", detail: "PRIVATE_DRAFT_CANARY" });
      f.add(3, { problem: "P-PUBLIC", type: "object_critique", target: "H-hidden" });
      f.add(4);
      f.add(5);
      const first = await f.read({ limit: 1 });
      expect(first?.items.map((item) => item.seq)).toEqual([4]);
      expect(first?.fellow_unacknowledged_count).toBe(2);
      expect(first?.has_more).toBe(true);
      f.sql.query("INSERT INTO problem_memberships VALUES ('P-PRIVATE',?)").run(FELLOW);
      expect((await f.read())?.items.map((item) => item.seq)).toEqual([2, 4, 5]);
      expect((await f.read())?.fellow_unacknowledged_count).toBe(3);
    } finally {
      f.sql.close();
    }
  });

  test("a transfer carries research notices but excludes former sponsor instructions and counts", async () => {
    const f = fixture();
    try {
      f.add(1);
      const old = f.add(2, { type: "sponsor_directive", detail: "FORMER_SPONSOR_PRIVATE_CANARY" });
      const current = f.add(3, { type: "sponsor_directive", detail: "NEW_SPONSOR_PRIVATE_CANARY" });
      const mismatched = f.add(4, { type: "sponsor_directive", detail: "WRONG_FELLOW_DIRECTIVE" });
      f.sql
        .query("INSERT INTO sponsor_directives VALUES (?,?,?),(?,?,?),(?,?,?)")
        .run(old, SPONSOR, FELLOW, current, "usr_bob", FELLOW, mismatched, "usr_bob", "fellow-bob");
      expect((await f.read())?.items.map((item) => item.seq)).toEqual([1, 2]);
      f.sql
        .query("UPDATE enrollment_fellows SET sponsor_id='usr_bob' WHERE fellow_id=?")
        .run(FELLOW);
      expect(await f.read()).toBeUndefined();
      const transferred = await f.read({}, "usr_bob");
      expect(transferred?.items.map((item) => item.seq)).toEqual([1, 3]);
      expect(transferred?.fellow_unacknowledged_count).toBe(2);
      expect(JSON.stringify(transferred)).not.toContain("FORMER_SPONSOR_PRIVATE_CANARY");
      expect(JSON.stringify(transferred)).not.toContain("WRONG_FELLOW_DIRECTIVE");
    } finally {
      f.sql.close();
    }
  });

  test("wrong sponsor, missing Fellow and tombstoned owner return the same private refusal", async () => {
    const f = fixture();
    try {
      f.add(1);
      const foreign = await f.request({ fellow_id: FELLOW }, "usr_bob");
      const missing = await f.request({ fellow_id: "fellow-missing" });
      f.sql.exec("UPDATE sponsors SET tombstoned_at='2026-01-01' WHERE sponsor_id='usr_alice'");
      const deleted = await f.request();
      for (const response of [foreign, missing, deleted]) {
        expect(response.status).toBe(404);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
      }
      expect(await foreign.json()).toEqual(await missing.json());
      expect(await deleted.text()).not.toContain("PRIVATE_OWN_NOTICE");
    } finally {
      f.sql.close();
    }
  });

  test("transfer or account deletion between selection and release withholds the entire page", async () => {
    for (const change of [
      "UPDATE enrollment_fellows SET sponsor_id='usr_bob' WHERE fellow_id='fellow-alice'",
      "UPDATE sponsors SET tombstoned_at='2026-01-01' WHERE sponsor_id='usr_alice'",
    ]) {
      const f = fixture();
      try {
        f.add(1);
        f.onPageRead(() => f.sql.exec(change));
        const response = await f.request();
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain("PRIVATE_OWN_NOTICE");
      } finally {
        f.sql.close();
      }
    }
  });

  test("lost problem visibility cannot leak a selected notice or a stale unacknowledged count", async () => {
    const f = fixture();
    try {
      f.add(1);
      f.add(2, { problem: "P-PUBLIC", detail: "WITHHELD_NOTICE" });
      f.onPageRead(() =>
        f.sql.exec("UPDATE problems SET status='private-draft' WHERE id='P-PUBLIC'"),
      );
      const response = await f.request();
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("WITHHELD_NOTICE");
      const current = await f.read({ limit: 1 });
      expect(current?.fellow_unacknowledged_count).toBe(1);
    } finally {
      f.sql.close();
    }
  });

  test("signed input rejects caller authority, coercion, invalid cursors and query parameters", async () => {
    const f = fixture();
    try {
      for (const body of [
        { fellow_id: FELLOW, sponsor_id: SPONSOR },
        { fellow_id: FELLOW, since: -1 },
        { fellow_id: FELLOW, since: Number.MAX_SAFE_INTEGER + 1 },
        { fellow_id: FELLOW, limit: 51 },
        { fellow_id: FELLOW, limit: "1" },
        { fellow_id: FELLOW, unacknowledged_only: "true" },
        "{broken",
      ])
        expect((await f.request(body)).status).toBe(422);
      expect((await f.request({ fellow_id: FELLOW }, SPONSOR, "?since=0")).status).toBe(400);
      expect((await f.request({ fellow_id: FELLOW, detail: "x".repeat(2048) })).status).toBe(400);
      const denied = await f.request({ fellow_id: FELLOW }, "deny");
      expect(denied.status).toBe(403);
      expect(denied.headers.get("cache-control")).toBe("private, no-store");
      expect(f.reads).toBe(0);
    } finally {
      f.sql.close();
    }
  });

  test("suspended sponsors retain read access while their mutations remain refused", async () => {
    const f = fixture();
    try {
      f.add(1);
      f.sql.exec("INSERT INTO sponsor_suspension_events VALUES ('SS-test','usr_alice')");
      expect(await sponsorMutationRefusal(f.db, SPONSOR, "POST", "inbox.read")).toBeUndefined();
      expect((await f.read())?.items.length).toBe(1);
      expect((await sponsorMutationRefusal(f.db, SPONSOR, "POST", "workshop.action"))?.status).toBe(
        403,
      );
    } finally {
      f.sql.close();
    }
  });
});
