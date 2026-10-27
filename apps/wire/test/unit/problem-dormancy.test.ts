import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ProblemDormancyEventSchema } from "@asimposium/contracts";
import { canonicalJson, sha256Hex, writeLedgerEvent } from "../../src/krater/krater.ts";
import { type LogEvent, replayProjections } from "../../src/krater/projection-replay.ts";
import { isObjectLevelEvent } from "../../src/mega-commands/materiality.ts";
import { markDormantProblems, PROBLEM_DORMANCY_QUIET_MS } from "../../src/problems/dormancy.ts";
import {
  FELLOW,
  PROBLEM,
  publicationContextFixture,
  SESSION,
  SPONSOR,
} from "../support/publication-context.ts";

const migration = readFileSync(
  new URL("../../../../db/migrations/0118_problem_material_activity.sql", import.meta.url),
  "utf8",
);
const old = "2026-01-01T00:00:00.000Z";
const newer = "2026-01-02T00:00:00.000Z";

test("the SQL clock and canonical materiality classifier agree; process cannot wake a problem", () => {
  const sql = new Database(":memory:");
  try {
    sql.exec(`CREATE TABLE problems(id TEXT PRIMARY KEY,status TEXT,created_at TEXT);
      CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,type TEXT,created_at TEXT,payload_sha256 TEXT);
      CREATE TABLE event_content(event_id TEXT,payload_sha256 TEXT,payload_json TEXT);`);
    sql.exec(migration);
    const cases = [
      ["claim.created", "{}"],
      ["claim.revised", "{}"],
      ["evidence.created", "{}"],
      ["review.created", "{}"],
      ["hypothesis.killed", "{}"],
      ["dead_end.recorded", "{}"],
      ["dead_end.recorded", '{"flag":"low-substance-dead-end"}'],
      ["hypothesis.created", "{}"],
      ["hypothesis.deferred", "{}"],
      ["hypothesis.resumed", "{}"],
      ["hypothesis.narrowed", "{}"],
      ["hypothesis.superseded", "{}"],
      ["synthesis.created", "{}"],
      ["directive.sent", "{}"],
      ["object.retracted", "{}"],
      ["problem.statement-revised", "{}"],
      ["problem.statement-reviewed", "{}"],
      ["session.heartbeat", "{}"],
      ["commentary.posted", "{}"],
    ] as const;
    for (const [index, [type, payload]] of cases.entries()) {
      const id = `P-${index}`;
      sql.query("INSERT INTO problems(id,status,created_at) VALUES(?,'dormant',?)").run(id, old);
      sql.query("INSERT INTO events VALUES(?,?,1,?,?,?)").run(id, id, type, newer, "digest");
      sql.query("INSERT INTO event_content VALUES(?,?,?)").run(id, "digest", payload);
      const row = sql
        .query("SELECT status,last_material_at,last_material_event_id FROM problems WHERE id=?")
        .get(id);
      const material = isObjectLevelEvent({ type, problem_status: "dormant", extract: payload });
      expect(row).toEqual({
        status: material ? "active" : "dormant",
        last_material_at: material ? newer : old,
        last_material_event_id: material ? id : null,
      });
    }
    sql
      .query("INSERT INTO problems(id,status,created_at) VALUES('P-SHARP','sharpening',?)")
      .run(old);
    sql
      .query(
        "INSERT INTO events VALUES('review','P-SHARP',1,'problem.statement-reviewed',?,'digest')",
      )
      .run(newer);
    sql.query("INSERT INTO event_content VALUES('review','digest','{}')").run();
    expect(
      sql.query("SELECT status,last_material_at FROM problems WHERE id='P-SHARP'").get(),
    ).toEqual({ status: "sharpening", last_material_at: newer });
  } finally {
    sql.close();
  }
});

test("clock migration derives legacy activity and excludes later process events", () => {
  const sql = new Database(":memory:");
  try {
    sql.exec(`CREATE TABLE problems(id TEXT PRIMARY KEY,status TEXT,created_at TEXT);
      CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,type TEXT,created_at TEXT,payload_sha256 TEXT);
      CREATE TABLE event_content(event_id TEXT,payload_sha256 TEXT,payload_json TEXT);
      INSERT INTO problems VALUES('P-OLD','active','2026-01-01T00:00:00Z');
      INSERT INTO events VALUES('E-MATERIAL','P-OLD',1,'review.created','2026-01-02T00:00:00Z','a');
      INSERT INTO events VALUES('E-PROCESS','P-OLD',2,'synthesis.created','2026-01-20T00:00:00Z','b');
      INSERT INTO event_content VALUES('E-MATERIAL','a','{}'),('E-PROCESS','b','{}');`);
    sql.exec(migration);
    expect(sql.query("SELECT last_material_at,last_material_event_id FROM problems").get()).toEqual(
      { last_material_at: newer, last_material_event_id: "E-MATERIAL" },
    );
  } finally {
    sql.close();
  }
});

async function agedFixture() {
  const f = await publicationContextFixture();
  const now = Date.now() - 1000;
  const quietSince = new Date(now - PROBLEM_DORMANCY_QUIET_MS).toISOString();
  // Historical bootstrap before the first event, not a timestamp edit of an
  // immutable publication. The real Worker lane seeds full dated governance.
  f.sql
    .query("UPDATE problems SET created_at=?,updated_at=?,last_material_at=? WHERE id=?")
    .run(quietSince, quietSince, quietSince, PROBLEM);
  let serial = 0;
  const append = async (type: string) => {
    const eventId = `E-ACTIVITY-${++serial}`;
    const body = canonicalJson({ body_md: "An independently checked finite observation." });
    return writeLedgerEvent(
      f.db,
      {
        problemId: PROBLEM,
        eventId,
        idempotencyKey: eventId,
        requestDigest: await sha256Hex(body),
        eventType: type,
        objectKind: type.slice(0, type.indexOf(".")),
        objectId: eventId,
        objectVersion: 1,
        payloadJson: body,
        createdAt: new Date(now).toISOString(),
        attribution: {
          fellowId: FELLOW,
          sponsorId: SPONSOR,
          sessionId: SESSION,
          modelSelfDeclared: "fixture-model",
          harness: "native-fixture",
        },
      },
      { statementsAfterEvent: () => [] },
    );
  };
  const state = () => ({
    problems: f.sql.query("SELECT * FROM problems ORDER BY id").all(),
    events: f.sql.query("SELECT * FROM events ORDER BY seq").all(),
    checkpoints: f.sql.query("SELECT * FROM integrity_checkpoints ORDER BY checkpoint_seq").all(),
    idempotency: f.sql.query("SELECT * FROM idempotency ORDER BY idempotency_key").all(),
    cursor: f.sql.query("SELECT * FROM public_cursor").all(),
  });
  return { ...f, now, quietSince, append, state };
}

test("the exact 45-day boundary writes one platform event and never repeats", async () => {
  const f = await agedFixture();
  try {
    expect((await markDormantProblems(f.db, { now: f.now - 1 })).dormant).toBe(0);
    const before = f.state();
    expect(await markDormantProblems(f.db, { now: f.now })).toEqual({
      examined: 1,
      dormant: 1,
      raced: 0,
      failed: 0,
      hasMore: false,
    });
    const after = f.state();
    expect(after.events.length).toBe(before.events.length + 1);
    const row = f.sql
      .query("SELECT e.*,c.payload_json FROM events e JOIN event_content c ON c.event_id=e.id")
      .get() as Record<string, unknown>;
    const payload = ProblemDormancyEventSchema.parse(JSON.parse(String(row.payload_json)));
    expect(payload.quiet_since).toBe(f.quietSince);
    expect(row.actor_fellow_id).toBeNull();
    expect(row.actor_sponsor_id).toBeNull();
    expect((await markDormantProblems(f.db, { now: f.now })).examined).toBe(0);
    expect(f.state()).toEqual(after);
  } finally {
    f.sql.close();
  }
});

test("process events preserve quiet time; a committed observation wakes the dormant problem", async () => {
  const f = await agedFixture();
  try {
    await f.append("hypothesis.created");
    expect((await markDormantProblems(f.db, { now: f.now })).dormant).toBe(1);
    await f.append("synthesis.created");
    expect(
      f.sql.query("SELECT status,last_material_at FROM problems WHERE id=?").get(PROBLEM),
    ).toEqual({ status: "dormant", last_material_at: f.quietSince });
    await f.append("evidence.created");
    expect(
      f.sql.query("SELECT status,last_material_at FROM problems WHERE id=?").get(PROBLEM),
    ).toEqual({ status: "active", last_material_at: new Date(f.now).toISOString() });
  } finally {
    f.sql.close();
  }
});

test("a concurrent object increment defeats the stale dormancy decision", async () => {
  const f = await agedFixture();
  try {
    let raced = false;
    const result = await markDormantProblems(
      f.db,
      { now: f.now },
      {
        afterReadHead: async () => {
          if (!raced) {
            raced = true;
            await f.append("evidence.created");
          }
        },
      },
    );
    expect(result).toEqual({ examined: 1, dormant: 0, raced: 1, failed: 0, hasMore: false });
    expect(f.sql.query("SELECT status FROM problems WHERE id=?").get(PROBLEM)).toEqual({
      status: "active",
    });
    expect(
      f.sql.query("SELECT COUNT(*) AS n FROM events WHERE type='problem.dormant'").get(),
    ).toEqual({ n: 0 });
  } finally {
    f.sql.close();
  }
});

test("a late transaction fault rolls back dormancy, chain, checkpoint and public cursor", async () => {
  const f = await agedFixture();
  try {
    const before = f.state();
    f.sql.exec(`CREATE TRIGGER planted_dormancy_failure BEFORE UPDATE OF status ON problems
      WHEN NEW.status='dormant' BEGIN SELECT RAISE(ABORT,'DORMANCY_LATE_FAILURE'); END;`);
    expect((await markDormantProblems(f.db, { now: f.now })).failed).toBe(1);
    expect(f.state()).toEqual(before);
  } finally {
    f.sql.close();
  }
});

test("an exhausted or missing public cursor refuses dormancy without a partial ledger write", async () => {
  for (const cursor of [Number.MAX_SAFE_INTEGER, null]) {
    const f = await agedFixture();
    try {
      if (cursor === null) f.sql.exec("DELETE FROM public_cursor WHERE singleton=1");
      else f.sql.query("UPDATE public_cursor SET cursor=? WHERE singleton=1").run(cursor);
      const before = f.state();
      expect(await markDormantProblems(f.db, { now: f.now })).toEqual({
        examined: 1,
        dormant: 0,
        raced: 1,
        failed: 0,
        hasMore: false,
      });
      expect(f.state()).toEqual(before);
    } finally {
      f.sql.close();
    }
  }
});

test("closed and unpublished states are ineligible; the scheduler drains a bounded prefix", async () => {
  const f = await agedFixture();
  try {
    for (const [index, status] of [
      "private-draft",
      "sharpening",
      "under-result-review",
      "resolved",
      "retired",
    ].entries()) {
      await f.seedProblem(`P-EXCLUDED-${index}`, status);
      f.sql
        .query("UPDATE problems SET last_material_at=? WHERE id=?")
        .run(f.quietSince, `P-EXCLUDED-${index}`);
    }
    await f.seedProblem("P-LATER");
    f.sql.query("UPDATE problems SET last_material_at=? WHERE id='P-LATER'").run(f.quietSince);
    expect(await markDormantProblems(f.db, { now: f.now, limit: 1 })).toEqual({
      examined: 1,
      dormant: 1,
      raced: 0,
      failed: 0,
      hasMore: true,
    });
    expect(await markDormantProblems(f.db, { now: f.now, limit: 1 })).toEqual({
      examined: 1,
      dormant: 1,
      raced: 0,
      failed: 0,
      hasMore: false,
    });
    expect((await markDormantProblems(f.db, { now: f.now })).examined).toBe(0);
  } finally {
    f.sql.close();
  }
});

test("platform attribution cannot publish a scientific event", async () => {
  const f = await agedFixture();
  try {
    await expect(
      writeLedgerEvent(
        f.db,
        {
          problemId: PROBLEM,
          eventId: "E-PLATFORM",
          idempotencyKey: "platform",
          requestDigest: "a".repeat(64),
          eventType: "evidence.created",
          objectKind: "evidence",
          objectId: "E-PLATFORM",
          objectVersion: 1,
          payloadJson: "{}",
          createdAt: new Date(f.now).toISOString(),
          attribution: {
            principalType: "platform",
            fellowId: null,
            sponsorId: null,
            sessionId: null,
            modelSelfDeclared: null,
            harness: null,
          },
        },
        { statementsAfterEvent: () => [] },
      ),
    ).rejects.toThrow("platform lifecycle writes");
  } finally {
    f.sql.close();
  }
});

test("replay reconstructs dormancy and only material reactivation", async () => {
  const event = (
    seq: number,
    type: string,
    payload: Record<string, unknown>,
    at: string,
    platform = false,
  ): LogEvent => ({
    id: `E-REPLAY-${seq}`,
    seq,
    type,
    objectId: PROBLEM,
    objectVersion: 1,
    payloadSha256: "a".repeat(64),
    rowDigest: null,
    createdAt: at,
    actorFellowId: platform ? null : FELLOW,
    actorSponsorId: platform ? null : SPONSOR,
    actorSessionId: platform ? null : SESSION,
    actorModel: platform ? null : "fixture-model",
    actorHarness: platform ? null : "fixture",
    payload,
  });
  const changed = new Date(Date.parse(newer) + PROBLEM_DORMANCY_QUIET_MS).toISOString();
  const events = [
    event(
      1,
      "problem.admitted",
      { problem: { status: "sharpening", current_statement_version: 1 } },
      old,
    ),
    event(
      2,
      "problem.statement-reviewed",
      {
        status: "active",
        statement_version: 1,
        verdict: "statement-clear",
        basis: "Explicit finite scope.",
      },
      newer,
    ),
    event(
      3,
      "problem.dormant",
      {
        problem_id: PROBLEM,
        previous_status: "active",
        status: "dormant",
        observed_through: 2,
        last_material_event_id: "E-REPLAY-2",
        quiet_since: newer,
        quiet_days: 45,
        changed_at: changed,
        acting_principal: { kind: "platform", id: "dormancy-scheduler" },
      },
      changed,
      true,
    ),
  ];
  expect((await replayProjections(PROBLEM, events)).head).toMatchObject({
    status: "dormant",
    last_material_at: newer,
    last_material_event_id: "E-REPLAY-2",
  });
  const process = event(4, "hypothesis.deferred", {}, changed);
  expect((await replayProjections(PROBLEM, [...events, process])).head.status).toBe("dormant");
  const material = event(5, "evidence.created", {}, changed);
  expect((await replayProjections(PROBLEM, [...events, process, material])).head).toMatchObject({
    status: "active",
    last_material_at: changed,
    last_material_event_id: "E-REPLAY-5",
  });
});
