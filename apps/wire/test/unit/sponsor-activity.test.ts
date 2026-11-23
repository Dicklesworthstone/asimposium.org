import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ProblemDocumentSchema, SponsorActivityResponseSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../../src/env.ts";
import {
  createSponsorActivityRouter,
  SPONSOR_ACTIVITY_ROUTE,
} from "../../src/sessions/sponsor-activity.ts";

const NOW = "2026-11-22T12:00:00.000Z";
const SCOPE = { fellow_id: "fellow-activity" };
const sessionId = (id: number) => `S-${String(id).padStart(26, "0")}`;
const DIGEST = "a".repeat(64);

/** SQL selection and modeled signature boundaries are unit evidence.
 * The separate sponsor-inbox Workerd journey exercises real signed requests,
 * D1 migrations, custody transfer, private handbacks and content controls. */
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE sponsors(sponsor_id TEXT PRIMARY KEY, tombstoned_at TEXT);
    CREATE TABLE enrollment_fellows(fellow_id TEXT PRIMARY KEY, sponsor_id TEXT, name TEXT, status TEXT);
    CREATE TABLE problems(id TEXT PRIMARY KEY, title TEXT, status TEXT, public_seq INTEGER);
    CREATE TABLE problem_memberships(problem_id TEXT, fellow_id TEXT, role TEXT, PRIMARY KEY(problem_id,fellow_id));
    CREATE TABLE private_draft_erasures(problem_id TEXT PRIMARY KEY);
    CREATE TABLE sessions(session_id TEXT PRIMARY KEY, fellow_id TEXT, problem_id TEXT, intent TEXT,
      opened_at TEXT, last_heartbeat_at TEXT, idle_close_at TEXT, closed_at TEXT, handback TEXT);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT, object_kind TEXT,
      object_id TEXT, object_version INTEGER, created_at TEXT, payload_sha256 TEXT, actor_fellow_id TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_sha256 TEXT, redacted_at TEXT, payload_json TEXT);
    CREATE TABLE scientific_withdrawals(source_event_id TEXT PRIMARY KEY);
    CREATE TABLE content_controls(problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    INSERT INTO sponsors VALUES('usr_owner',NULL),('usr_other',NULL);
    INSERT INTO enrollment_fellows VALUES
      ('fellow-activity','usr_owner','activity-fellow','active'),
      ('fellow-other','usr_other','other-fellow','active');`);
  let reads = 0;
  let afterSnapshot: (() => void) | undefined;
  let failedRead: number | undefined;
  const db = {
    prepare(text: string) {
      let bindings: (string | number | null)[] = [];
      return {
        bind(...values: (string | number | null)[]) {
          bindings = values;
          return this;
        },
        async first() {
          reads++;
          if (reads === failedRead) throw new Error("PRIVATE_SQL_DIAGNOSTIC");
          const row = sql.query(text).get(...bindings);
          const hook = afterSnapshot;
          afterSnapshot = undefined;
          hook?.();
          return row ?? null;
        },
      };
    },
  } as unknown as D1Database;
  const app = createSponsorActivityRouter({
    verifiedSponsor: async (request, route, action) => {
      expect(route).toBe(SPONSOR_ACTIVITY_ROUTE);
      expect(action).toBe("fellow.activity.read");
      if (request.headers.get("x-test-sponsor") === "deny")
        return new Response('{"code":"WRONG_PRINCIPAL"}', { status: 403 });
      return {
        principal: {
          type: "sponsor",
          sponsorId: request.headers.get("x-test-sponsor") ?? "usr_owner",
        },
        rawBody: new Uint8Array(await request.arrayBuffer()),
      };
    },
  });
  const env = {
    DB: db,
    get ARTIFACTS() {
      throw new Error("Work summaries must not read private R2");
    },
  } as unknown as Env;
  const raw = (body: string, sponsor = "usr_owner", query = "") =>
    app.request(
      `https://a.asimposium.org${SPONSOR_ACTIVITY_ROUTE}${query}`,
      {
        method: "POST",
        headers: { "x-test-sponsor": sponsor, "content-type": "application/json" },
        body,
      },
      env,
    );
  return {
    sql,
    get reads() {
      return reads;
    },
    onSnapshot(callback: () => void) {
      afterSnapshot = callback;
    },
    failAt(read: number) {
      failedRead = read;
    },
    problem(id: string, status = "active", fellow = SCOPE.fellow_id, title = "Finite boundary") {
      sql.query("INSERT INTO problems VALUES(?,?,?,0)").run(id, title, status);
      sql.query("INSERT INTO problem_memberships VALUES(?,?,'contributor')").run(id, fellow);
    },
    session(
      id: number,
      options: { problem?: string; fellow?: string; handback?: string; closedAt?: string } = {},
    ) {
      sql
        .query("INSERT INTO sessions VALUES(?,?,?,'explore',?,?,?,?,?)")
        .run(
          sessionId(id),
          options.fellow ?? SCOPE.fellow_id,
          options.problem ?? "P-ALPHA",
          NOW,
          NOW,
          "2026-11-23T00:00:00.000Z",
          options.closedAt ?? (options.handback === undefined ? null : NOW),
          options.handback ?? null,
        );
    },
    event(
      seq: number,
      options: {
        problem?: string;
        type?: string;
        kind?: string;
        object?: string;
        version?: number;
        fellow?: string;
        payload?: unknown;
      } = {},
    ) {
      const problem = options.problem ?? "P-ALPHA";
      const type = options.type ?? "claim.created";
      const id = `event-${problem}-${seq}`;
      sql
        .query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(
          id,
          problem,
          seq,
          type,
          options.kind ?? type.split(".")[0]!,
          options.object ?? `C-${seq}`,
          options.version ?? 1,
          NOW,
          DIGEST,
          options.fellow ?? SCOPE.fellow_id,
        );
      sql
        .query("INSERT INTO event_content VALUES(?,?,NULL,?)")
        .run(
          id,
          DIGEST,
          JSON.stringify(options.payload ?? { statement: "PUBLIC_BODY_NOT_IN_SUMMARY" }),
        );
      sql.query("UPDATE problems SET public_seq=MAX(public_seq,?) WHERE id=?").run(seq, problem);
      return id;
    },
    control(target: string, visibility = "hidden", version = 1, problem = "P-ALPHA") {
      sql
        .query("INSERT INTO content_controls VALUES(?,?,?,?)")
        .run(problem, target, visibility, version);
    },
    request(body: unknown = SCOPE, sponsor = "usr_owner", query = "") {
      return raw(JSON.stringify(body), sponsor, query);
    },
    raw,
  };
}

async function page(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  return SponsorActivityResponseSchema.parse(await response.json());
}

async function privateError(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const raw = await response.text();
  for (const text of [
    "PRIVATE_HANDBACK",
    "PRIVATE_OTHER",
    "PRIVATE_SQL_DIAGNOSTIC",
    "PUBLIC_BODY_NOT_IN_SUMMARY",
  ])
    expect(raw).not.toContain(text);
  expect(JSON.parse(raw).assignments).toBeUndefined();
  return JSON.parse(raw);
}

test("current sponsorship sees actual memberships, open sessions and its Fellow's own latest handback", async () => {
  const f = fixture();
  try {
    f.problem("P-ALPHA");
    f.problem("P-PRIVATE", "private-draft", SCOPE.fellow_id, "PRIVATE_TITLE");
    f.problem("P-OTHER", "active", "fellow-other", "PRIVATE_OTHER_TITLE");
    f.problem("P-ERASED", "private-draft");
    f.sql.exec("INSERT INTO private_draft_erasures VALUES('P-ERASED')");
    f.session(1);
    f.session(2, { handback: "Older handback", closedAt: "2026-11-21T12:00:00.000Z" });
    f.session(3, { handback: "PRIVATE_HANDBACK latest own work" });
    f.session(4, { fellow: "fellow-other", handback: "PRIVATE_OTHER_HANDBACK" });
    f.session(5, { problem: "P-PRIVATE", handback: "PRIVATE_HANDBACK draft" });
    f.session(6, { problem: "P-ERASED", handback: "PRIVATE_HANDBACK erased" });
    f.session(7, { problem: "P-ERASED" });
    f.event(1);
    f.event(2, { type: "synthesis.created", kind: "synthesis" });
    const result = await page(await f.request());
    expect(result.assignments.map((item) => item.problem_id)).toEqual(["P-ALPHA", "P-PRIVATE"]);
    expect(result.open_sessions.map((item) => item.session_id)).toEqual([sessionId(1)]);
    expect(result.assignments[0]?.latest_handback?.text).toBe("PRIVATE_HANDBACK latest own work");
    expect(result.assignments[0]?.last_public_increment?.seq).toBe(1);
    expect(result.assignments[1]?.public_problem).toBeNull();
    expect(result.assignments[1]?.latest_handback?.text).toBe("PRIVATE_HANDBACK draft");
    expect(result.omitted).toEqual(["public_activity_unavailable"]);
    const raw = JSON.stringify(result);
    for (const marker of [
      "PRIVATE_OTHER",
      "PRIVATE_TITLE",
      "P-ERASED",
      "PUBLIC_BODY_NOT_IN_SUMMARY",
    ])
      expect(raw).not.toContain(marker);
    expect(f.reads).toBe(2);
    f.sql.exec("UPDATE enrollment_fellows SET status='paused' WHERE fellow_id='fellow-activity'");
    expect((await page(await f.request())).fellow_status).toBe("paused");
  } finally {
    f.sql.close();
  }
});

test("explicit aggregate ordering keeps paginated assignments and session limits deterministic", async () => {
  const f = fixture();
  try {
    f.sql.exec("PRAGMA reverse_unordered_selects=ON");
    for (const id of ["P-DELTA", "P-BETA", "P-ALPHA", "P-CHARLIE"]) f.problem(id);
    for (let id = 1; id <= 6; id++) f.session(id);
    f.event(1);
    f.event(2, { type: "session.closed", kind: "session" });
    f.event(3);
    const first = await page(await f.request({ ...SCOPE, limit: 2 }));
    expect(first.assignments.map((item) => item.problem_id)).toEqual(["P-ALPHA", "P-BETA"]);
    expect(first.assignments[0]?.last_public_increment?.seq).toBe(3);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toBe("P-BETA");
    expect(first.open_sessions.map((item) => item.session_id)).toEqual([6, 5, 4, 3].map(sessionId));
    expect(first.omitted).toEqual(["assignment_limit", "session_limit"]);
    const second = await page(
      await f.request({ ...SCOPE, limit: 2, after_problem_id: first.next_cursor }),
    );
    expect(second.assignments.map((item) => item.problem_id)).toEqual(["P-CHARLIE", "P-DELTA"]);
    expect(second.next_cursor).toBeNull();
    expect(second.has_more).toBe(false);
  } finally {
    f.sql.close();
  }
});

test("materiality ignores ceremony and thin dead ends, using only bounded recorded sharpening status", async () => {
  const f = fixture();
  try {
    f.problem("P-ALPHA");
    f.event(1);
    f.event(2, { type: "synthesis.created", kind: "synthesis" });
    f.event(3, {
      type: "dead_end.recorded",
      kind: "dead-end",
      payload: { flag: "low-substance-dead-end" },
    });
    f.event(4, {
      type: "problem.statement-revised",
      kind: "problem",
      payload: { previous_status: "active" },
    });
    expect((await page(await f.request())).assignments[0]?.last_public_increment?.seq).toBe(1);
    f.event(5, {
      type: "problem.statement-reviewed",
      kind: "problem",
      payload: { previous_status: "sharpening" },
    });
    expect((await page(await f.request())).assignments[0]?.last_public_increment?.seq).toBe(5);
    f.event(6, {
      type: "problem.statement-revised",
      kind: "problem",
      payload: { previous_status: { body: "PRIVATE_STATUS_PAYLOAD" } },
    });
    const result = await page(await f.request());
    expect(result.assignments[0]?.last_public_increment?.seq).toBe(5);
    expect(result.assignments[0]?.increment_history_limited).toBe(true);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_STATUS_PAYLOAD");
  } finally {
    f.sql.close();
  }
});

test("a review increment follows current exact-version target visibility, restore, redaction and withdrawal", async () => {
  for (const target of ["C-1", "C-1@1", "#1"]) {
    const f = fixture();
    try {
      f.problem("P-ALPHA");
      const claim = f.event(1, { fellow: "fellow-other", object: "C-1" });
      const review = f.event(2, {
        type: "review.created",
        kind: "review",
        object: "R-2",
        payload: { target_claim_id: "C-1", target_version: 1 },
      });
      expect((await page(await f.request())).assignments[0]?.last_public_increment?.seq).toBe(2);
      f.control(target);
      const hidden = await page(await f.request());
      expect(hidden.assignments[0]?.last_public_increment).toBeNull();
      expect(hidden.assignments[0]?.increment_history_limited).toBe(true);
      f.control(target, "visible", 2);
      expect((await page(await f.request())).assignments[0]?.last_public_increment?.seq).toBe(2);
      f.sql.query("UPDATE event_content SET redacted_at=? WHERE event_id=?").run(NOW, claim);
      expect((await page(await f.request())).assignments[0]?.last_public_increment).toBeNull();
      f.sql.query("UPDATE event_content SET redacted_at=NULL WHERE event_id=?").run(claim);
      f.sql.query("INSERT INTO scientific_withdrawals VALUES(?)").run(review);
      expect((await page(await f.request())).assignments[0]?.last_public_increment).toBeNull();
    } finally {
      f.sql.close();
    }
  }
});

test("evidence activity requires the exact target kind and version, including unversioned hypotheses", async () => {
  for (const [kind, version, expected] of [
    ["claim", 1, true],
    ["claim", 2, false],
    ["hypothesis", null, false],
  ] as const) {
    const f = fixture();
    try {
      f.problem("P-ALPHA");
      f.event(1, { fellow: "fellow-other", object: "C-1" });
      f.event(2, {
        type: "evidence.created",
        kind: "evidence",
        object: "E-2",
        payload: { bears_on_kind: kind, bears_on_id: "C-1", bears_on_version: version },
      });
      expect(
        (await page(await f.request())).assignments[0]?.last_public_increment?.seq ?? null,
      ).toBe(expected ? 2 : null);
    } finally {
      f.sql.close();
    }
  }
  const f = fixture();
  try {
    f.problem("P-ALPHA");
    f.event(1, {
      type: "hypothesis.created",
      kind: "hypothesis",
      object: "H-1",
      fellow: "fellow-other",
    });
    f.event(2, {
      type: "evidence.created",
      kind: "evidence",
      object: "E-2",
      payload: { bears_on_kind: "hypothesis", bears_on_id: "H-1", bears_on_version: null },
    });
    expect((await page(await f.request())).assignments[0]?.last_public_increment?.seq).toBe(2);
    f.control("H-1");
    expect((await page(await f.request())).assignments[0]?.last_public_increment).toBeNull();
  } finally {
    f.sql.close();
  }
});

test("a bounded materiality window reports unknown older work without inventing inactivity", async () => {
  const f = fixture();
  try {
    f.problem("P-ALPHA");
    f.event(1);
    for (let seq = 2; seq <= 52; seq++)
      f.event(seq, { type: "session.heartbeat", kind: "session" });
    const result = await page(await f.request());
    expect(result.assignments[0]?.last_public_increment).toBeNull();
    expect(result.assignments[0]?.increment_history_limited).toBe(true);
    expect(result.omitted).toEqual(["increment_history_limited"]);
  } finally {
    f.sql.close();
  }
});

test("missing, foreign and deleted sponsor authority use one non-enumerating private response", async () => {
  const f = fixture();
  try {
    f.problem("P-ALPHA");
    f.session(1, { handback: "PRIVATE_HANDBACK retained" });
    const missing = await privateError(await f.request({ fellow_id: "fellow-missing" }), 404);
    expect(ProblemDocumentSchema.parse(missing).code).toBe("ROUTE_NOT_FOUND");
    expect(await privateError(await f.request(SCOPE, "usr_other"), 404)).toEqual(missing);
    f.sql.exec("UPDATE sponsors SET tombstoned_at='deleted' WHERE sponsor_id='usr_owner'");
    expect(await privateError(await f.request(), 404)).toEqual(missing);
  } finally {
    f.sql.close();
  }
});

test("changes to custody, erasure, membership, content and handbacks withhold the captured page", async () => {
  for (const [change, status] of [
    ["UPDATE enrollment_fellows SET sponsor_id='usr_other' WHERE fellow_id='fellow-activity'", 404],
    ["UPDATE sponsors SET tombstoned_at='deleted' WHERE sponsor_id='usr_owner'", 404],
    ["INSERT INTO private_draft_erasures VALUES('P-ALPHA')", 503],
    ["DELETE FROM problem_memberships WHERE problem_id='P-ALPHA'", 503],
    ["UPDATE sessions SET handback='PRIVATE_HANDBACK changed' WHERE closed_at IS NOT NULL", 503],
    ["INSERT INTO content_controls VALUES('P-ALPHA','C-1','hidden',1)", 503],
    ["UPDATE enrollment_fellows SET status='paused' WHERE fellow_id='fellow-activity'", 503],
  ] as const) {
    const f = fixture();
    try {
      f.problem("P-ALPHA");
      f.session(1, { handback: "PRIVATE_HANDBACK captured" });
      f.event(1);
      f.onSnapshot(() => f.sql.exec(change));
      await privateError(await f.request(), status);
      expect(f.reads).toBe(2);
    } finally {
      f.sql.close();
    }
  }
});

test("signature refusals and invalid bounded requests cannot reach private SQL", async () => {
  const f = fixture();
  try {
    await privateError(await f.request(SCOPE, "deny"), 403);
    for (const body of [
      null,
      [],
      {},
      { ...SCOPE, sponsor_id: "usr_other" },
      { ...SCOPE, limit: 0 },
      { ...SCOPE, limit: 21 },
      { ...SCOPE, after_problem_id: "../private" },
      { ...SCOPE, after_problem_id: "P-ALPHA\n" },
    ])
      await privateError(await f.request(body), 422);
    await privateError(await f.request(SCOPE, "usr_owner", "?fellow_id=fellow-other"), 422);
    await privateError(await f.raw("{"), 422);
    await privateError(await f.raw(" ".repeat(2049) + JSON.stringify(SCOPE)), 422);
    expect(f.reads).toBe(0);
  } finally {
    f.sql.close();
  }
});

test("both snapshot failures stay private and maximum safe public sequences remain readable", async () => {
  for (const read of [1, 2]) {
    const f = fixture();
    try {
      f.problem("P-ALPHA");
      f.session(1, { handback: "PRIVATE_HANDBACK retained" });
      f.failAt(read);
      await privateError(await f.request(), 503);
    } finally {
      f.sql.close();
    }
  }
  const f = fixture();
  try {
    f.problem("P-ALPHA");
    f.event(Number.MAX_SAFE_INTEGER);
    expect((await page(await f.request())).assignments[0]?.last_public_increment?.seq).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  } finally {
    f.sql.close();
  }
});
