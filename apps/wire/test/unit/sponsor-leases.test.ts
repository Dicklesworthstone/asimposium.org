import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  SPONSOR_LEASE_LIST_PAGE_LIMIT,
  SponsorLeaseListResponseSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { mintServiceEnvelope, serviceEnvelopeHeaders } from "../../../web/lib/service-envelope.ts";
import { createApp } from "../../src/app.ts";
import { toHex } from "../../src/auth/canonical.ts";
import type { Env } from "../../src/env.ts";
import { createSponsorLeasesRouter } from "../../src/sessions/sponsor-leases.ts";
import { migratedSqliteD1 } from "../support/migrated-sqlite.ts";

const ROUTE = "/v1/sponsors/leases";
const leaseId = (index: number) => `L-${String(index).padStart(26, "0")}`;

test("the production createApp dispatch reaches the signed lease list and enforces its action", async () => {
  const { db, sqlite } = migratedSqliteD1();
  try {
    sqlite
      .query("INSERT INTO sponsors(sponsor_id,created_at,last_seen_at) VALUES('usr_own',?,?)")
      .run(Date.now(), Date.now());
    const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    if (!("privateKey" in key)) throw new Error("Expected an Ed25519 key pair");
    const env = {
      DB: db,
      STOA_ORIGIN: "https://a.asimposium.org",
      AGORA_ORIGIN: "https://asimposium.org",
      ENROLLMENT_REPLAY_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      SERVICE_ENVELOPE_KEYS: JSON.stringify([
        {
          kid: "lease-mount",
          notBefore: 0,
          publicKeyHex: toHex(new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey))),
        },
      ]),
    } as Env;
    const app = createApp();
    for (const [action, status] of [
      ["lease.list", 200],
      ["lease.release", 401],
    ] as const) {
      const body = "{}";
      const envelope = await mintServiceEnvelope({
        privateKey: key.privateKey,
        kid: "lease-mount",
        now: Math.floor(Date.now() / 1000),
        method: "POST",
        route: ROUTE,
        action,
        principalId: "usr_own",
        body,
      });
      const response = await app.request(
        `https://a.asimposium.org${ROUTE}`,
        {
          method: "POST",
          headers: { ...serviceEnvelopeHeaders(envelope), "content-type": "application/json" },
          body,
        },
        env,
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      if (status === 200) {
        expect(SponsorLeaseListResponseSchema.parse(await response.json())).toMatchObject({
          sponsor_id: "usr_own",
          leases: [],
          next_cursor: null,
        });
      } else expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
    }
  } finally {
    sqlite.close();
  }
});

/** Modeled auth and SQLite unit evidence. The mounted signed route also has
 * a separate real Workerd/D1 journey in session-presence-real-bindings.mjs. */
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE sponsors(sponsor_id TEXT PRIMARY KEY, tombstoned_at TEXT);
    CREATE TABLE enrollment_fellows(fellow_id TEXT PRIMARY KEY, sponsor_id TEXT, name TEXT, status TEXT);
    CREATE TABLE leases(lease_id TEXT PRIMARY KEY, problem_id TEXT, fellow_id TEXT,
      sponsor_id TEXT, object_ref TEXT, object_kind TEXT, parallel_safe INTEGER, status TEXT,
      leased_at TEXT, leased_until TEXT, objective TEXT, deliverable TEXT);
    CREATE TABLE private_draft_erasures(problem_id TEXT PRIMARY KEY);
    INSERT INTO sponsors VALUES('usr_own',NULL),('usr_other',NULL);
    INSERT INTO enrollment_fellows VALUES
      ('fellow-a','usr_own','redshift','active'),
      ('fellow-paused','usr_own','blueshift','paused'),
      ('fellow-other','usr_other','private-fellow','active');`);
  let reads = 0;
  let afterPageRead: (() => void) | undefined;
  const db = {
    prepare(text: string) {
      let bindings: (string | number | null)[] = [];
      const execute = () => {
        reads += 1;
        const rows = sql.query(text).all(...bindings);
        if (text.includes(`LIMIT ${SPONSOR_LEASE_LIST_PAGE_LIMIT + 1}`)) afterPageRead?.();
        return rows;
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
  const app = createSponsorLeasesRouter({
    verifiedSponsor: async (request, route, action) => {
      expect(route).toBe(ROUTE);
      expect(action).toBe("lease.list");
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
    add(index: number, fellow = "fellow-a", problem = "P-OWN", status = "active") {
      sql
        .query("INSERT INTO leases VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          leaseId(index),
          problem,
          fellow,
          "usr_historical_sponsor",
          `C-${index}`,
          "claim",
          0,
          status,
          "2026-11-14T12:00:00.000Z",
          "2026-11-14T14:00:00.000Z",
          "PRIVATE_OBJECTIVE_CANARY",
          "PRIVATE_DELIVERABLE_CANARY",
        );
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

test("current ownership discovers paused Fellow reservations without another sponsor's text or work", async () => {
  const f = fixture();
  try {
    f.add(1);
    f.add(2, "fellow-paused", "P-UNLISTED");
    f.add(3, "fellow-other", "P-SECRET");
    f.add(4, "fellow-a", "P-ERASED");
    f.add(5, "fellow-a", "P-OWN", "released");
    f.sql.query("INSERT INTO private_draft_erasures VALUES(?)").run("P-ERASED");
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const text = await response.text();
    const page = SponsorLeaseListResponseSchema.parse(JSON.parse(text));
    expect(page.leases.map((lease) => lease.lease_id)).toEqual([leaseId(1), leaseId(2)]);
    expect(page.leases[1]?.fellow_name).toBe("blueshift");
    expect(page.next_cursor).toBeNull();
    for (const hidden of ["PRIVATE_", "P-SECRET", "P-ERASED", "usr_historical_sponsor"])
      expect(text).not.toContain(hidden);
    f.sql
      .query("UPDATE enrollment_fellows SET sponsor_id = 'usr_other' WHERE fellow_id = 'fellow-a'")
      .run();
    const old = SponsorLeaseListResponseSchema.parse(await (await f.request()).json());
    expect(old.leases.map((lease) => lease.lease_id)).toEqual([leaseId(2)]);
    const current = SponsorLeaseListResponseSchema.parse(
      await (await f.request({}, "usr_other")).json(),
    );
    expect(current.leases.map((lease) => lease.lease_id)).toEqual([leaseId(1), leaseId(3)]);
  } finally {
    f.sql.close();
  }
});

test("challenged reservations remain recoverable without exposing the challenge narrative", async () => {
  const f = fixture();
  try {
    f.add(1, "fellow-a", "P-OWN", "challenged");
    f.add(2, "fellow-paused", "P-OWN", "challenged");
    f.add(3, "fellow-other", "P-SECRET", "challenged");
    f.add(4, "fellow-a", "P-OWN", "released");
    const response = await f.request();
    expect(response.status).toBe(200);
    const body = await response.text();
    const page = SponsorLeaseListResponseSchema.parse(JSON.parse(body));
    expect(page.leases.map((lease) => [lease.lease_id, lease.status])).toEqual([
      [leaseId(1), "challenged"],
      [leaseId(2), "challenged"],
    ]);
    expect(body).not.toContain("PRIVATE_OBJECTIVE_CANARY");
    expect(body).not.toContain("PRIVATE_DELIVERABLE_CANARY");
    expect(body).not.toContain("P-SECRET");
  } finally {
    f.sql.close();
  }
});

test("the bounded immutable-ID cursor survives heartbeat renewal and released earlier rows", async () => {
  const f = fixture();
  try {
    for (let index = 1; index <= SPONSOR_LEASE_LIST_PAGE_LIMIT + 3; index += 1) f.add(index);
    const first = SponsorLeaseListResponseSchema.parse(await (await f.request()).json());
    expect(first.leases).toHaveLength(SPONSOR_LEASE_LIST_PAGE_LIMIT);
    expect(first.next_cursor).toBe(leaseId(20));
    f.sql
      .query("UPDATE leases SET leased_until = ? WHERE lease_id = ?")
      .run("2026-11-14T15:00:00.000Z", leaseId(1));
    f.sql.query("UPDATE leases SET status = 'released' WHERE lease_id = ?").run(leaseId(2));
    const second = SponsorLeaseListResponseSchema.parse(
      await (await f.request({ after: first.next_cursor })).json(),
    );
    expect(second.leases.map((lease) => lease.lease_id)).toEqual([
      leaseId(21),
      leaseId(22),
      leaseId(23),
    ]);
    expect(second.next_cursor).toBeNull();
  } finally {
    f.sql.close();
  }
});

test("wrong principals and malformed signed requests never reach private rows", async () => {
  const f = fixture();
  try {
    expect((await f.request({}, "deny")).status).toBe(403);
    for (const body of [
      null,
      [],
      { after: "C-1" },
      { sponsor_id: "usr_other" },
      { after: "x".repeat(3000) },
    ]) {
      const response = await f.request(body);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "SCHEMA_INVALID", rule: "A5" });
    }
    expect((await f.request({}, "usr_own", "?after=unsigned")).status).toBe(422);
    expect(f.reads).toBe(0);
  } finally {
    f.sql.close();
  }
});

test("transfer of the lookahead, account deletion, release or erasure during a read exposes no page", async () => {
  for (const mutation of ["transfer-lookahead", "delete-sponsor", "release", "erase"]) {
    const f = fixture();
    try {
      for (let index = 1; index <= 20; index += 1) f.add(index);
      f.add(21, "fellow-paused", "P-LOOKAHEAD");
      f.onPageRead(() => {
        if (mutation === "transfer-lookahead")
          f.sql
            .query(
              "UPDATE enrollment_fellows SET sponsor_id = 'usr_other' WHERE fellow_id = 'fellow-paused'",
            )
            .run();
        else if (mutation === "delete-sponsor")
          f.sql
            .query("UPDATE sponsors SET tombstoned_at = 'now' WHERE sponsor_id = 'usr_own'")
            .run();
        else if (mutation === "release")
          f.sql.query("UPDATE leases SET status = 'released' WHERE lease_id = ?").run(leaseId(1));
        else f.sql.query("INSERT INTO private_draft_erasures VALUES('P-LOOKAHEAD')").run();
      });
      const response = await f.request();
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const body = await response.text();
      expect(body).not.toContain("P-OWN");
      expect(body).not.toContain("P-LOOKAHEAD");
      expect(body).not.toContain("redshift");
    } finally {
      f.sql.close();
    }
  }
});

test("invalid stored data fails closed instead of silently dropping a reservation", async () => {
  const f = fixture();
  try {
    f.add(1);
    f.sql.query("UPDATE leases SET parallel_safe = 4").run();
    const response = await f.request();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("P-OWN");
  } finally {
    f.sql.close();
  }
});
