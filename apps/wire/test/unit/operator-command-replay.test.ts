import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ProblemDocumentSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import {
  operatorContentControl,
  operatorQuarantineDecision,
  operatorReportResolution,
} from "../../src/moderation/operator-http.ts";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

// A unit adapter for the real migration SQL. Native HTTP/D1 replay is exercised
// separately in moderation-real-bindings.mjs; these hooks force losing races.
function fixture() {
  const sql = new Database(":memory:", { strict: true });
  databases.push(sql);
  sql.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE enrollment_fellows(fellow_id TEXT PRIMARY KEY, sponsor_id TEXT NOT NULL);
    CREATE TABLE problems(id TEXT PRIMARY KEY, status TEXT, unlisted INTEGER, public_seq INTEGER);
    CREATE TABLE events(problem_id TEXT, object_id TEXT, object_kind TEXT);
    INSERT INTO enrollment_fellows VALUES('author', 'sponsor');
    INSERT INTO problems VALUES('P-REPLAY', 'active', 0, 1);
    INSERT INTO events VALUES('P-REPLAY', 'C-1', 'claim'), ('P-REPLAY', 'C-2', 'claim');`);
  for (const name of [
    "0064_inbox_and_follows.sql",
    "0091_moderation_plane.sql",
    "0133_operator_command_receipts.sql",
  ])
    sql.exec(readFileSync(new URL(`../../../../db/migrations/${name}`, import.meta.url), "utf8"));
  sql
    .query(`INSERT INTO screening_cases
    (case_id, problem_id, fellow_id, sponsor_id, route, input_digest, context_digest,
     candidate_json, coarse_category, outcome, decision_path, provider_status,
     model_version, policy_version, configuration_digest, state, created_at)
    VALUES('QC-replay', 'P-REPLAY', 'author', 'sponsor', 'promote', ?, ?, ?,
      'injection', 'quarantine', 'model', 'ok', 'model-v1', 'policy-v1', ?, 'pending', ?)`)
    .run(
      "a".repeat(64),
      "b".repeat(64),
      '{"statement":"PRIVATE-HELD-WORK"}',
      "c".repeat(64),
      "2026-11-01T00:00:00.000Z",
    );
  sql.exec(`INSERT INTO reports
    (report_id, problem_id, target_kind, target_ref, reason, reporter_class,
     reporter_sponsor_id, status, created_at)
    VALUES('RP-replay', 'P-REPLAY', 'claim', 'C-1', 'privacy', 'sponsor',
      'reporter', 'pending', '2026-11-01T00:00:00.000Z');`);

  let beforeBatch: (() => Promise<void>) | undefined;
  let loseResponse = false;
  function prepare(text: string) {
    let values: (string | number | null)[] = [];
    const statement = {
      bind(...bound: (string | number | null)[]) {
        values = bound;
        return statement;
      },
      async first() {
        return sql.query(text).get(...values);
      },
      async all() {
        return statement.execute();
      },
      async run() {
        return statement.execute();
      },
      execute() {
        const results = sql.query(text).all(...values);
        const changes = (sql.query("SELECT changes() AS n").get() as { n: number }).n;
        return { results, success: true, meta: { changes } };
      },
    };
    return statement;
  }
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      const hook = beforeBatch;
      beforeBatch = undefined;
      await hook?.();
      const result = sql.transaction(() => statements.map((statement) => statement.execute()))();
      if (loseResponse) {
        loseResponse = false;
        throw new Error("response lost after commit");
      }
      return result;
    },
  } as unknown as D1Database;
  const controlBody = {
    target_id: "P-REPLAY/C-1",
    target_kind: "claim" as const,
    action: "hide" as const,
    reason: "PRIVATE-OPERATOR-RATIONALE",
  };
  return {
    sql,
    db,
    controlBody,
    beforeNextBatch(hook: () => Promise<void>) {
      beforeBatch = hook;
    },
    loseNextResponse() {
      loseResponse = true;
    },
    counts() {
      return sql
        .query(`SELECT
        (SELECT COUNT(*) FROM operator_audit) AS audits,
        (SELECT COUNT(*) FROM operator_command_receipts) AS receipts,
        (SELECT COUNT(*) FROM content_controls) AS controls,
        (SELECT COUNT(*) FROM moderation_log) AS logs,
        (SELECT COUNT(*) FROM fellow_inbox_notices) AS notices`)
        .get();
    },
    visibility() {
      return sql
        .query(`SELECT visibility FROM content_controls
        WHERE target_ref='C-1' ORDER BY version DESC LIMIT 1`)
        .get();
    },
    hide(key = "command-hide", operator = "operator") {
      return operatorContentControl(db, operator, controlBody, key);
    },
    quarantine(key = "command-release", operator = "operator") {
      return operatorQuarantineDecision(
        db,
        operator,
        {
          case_id: "QC-replay",
          decision: "release",
          reason: "PRIVATE-OPERATOR-RATIONALE",
        },
        key,
      );
    },
    report(key = "command-report", operator = "operator") {
      return operatorReportResolution(
        db,
        operator,
        {
          report_id: "RP-replay",
          resolution: "uphold",
          reason: "PRIVATE-OPERATOR-RATIONALE",
        },
        key,
      );
    },
  };
}

describe("operator command receipts commit with their decisions", () => {
  for (const operation of ["hide", "quarantine", "report"] as const) {
    test(`${operation}: retry returns the identical receipt and no additional effects`, async () => {
      const f = fixture();
      const first = await f[operation]();
      expect(first.status).toBe(200);
      const bytes = await first.text();
      const counts = f.counts();
      const replay = await f[operation]();
      expect(replay.status).toBe(200);
      expect(replay.headers.get("cache-control")).toBe("private, no-store");
      expect(await replay.text()).toBe(bytes);
      expect(f.counts()).toEqual(counts);
      const otherKey = await f[operation]("different-command");
      expect(otherKey.status).toBe(409);
      expect(ProblemDocumentSchema.parse(await otherKey.json()).code).toBe(
        "MODERATION_STATE_CONFLICT",
      );
      // Another operator's same key cannot read this operator's private receipt.
      const other = await f[operation](
        operation === "hide"
          ? "command-hide"
          : operation === "quarantine"
            ? "command-release"
            : "command-report",
        "another-operator",
      );
      expect(other.status).toBe(409);
      expect(await other.text()).not.toContain(JSON.parse(bytes).audit_event_id);
      expect(f.counts()).toEqual(counts);
      const rows = JSON.stringify(f.sql.query("SELECT * FROM operator_command_receipts").all());
      expect(rows).not.toContain("PRIVATE-");
      expect(rows).not.toContain('"command-');
    });

    test(`${operation}: receipt failure rolls back the decision and all side effects`, async () => {
      const f = fixture(),
        before = f.counts();
      f.sql.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON operator_command_receipts
        BEGIN SELECT RAISE(ABORT, 'planted receipt failure'); END;`);
      await expect(f[operation]()).rejects.toThrow("planted receipt failure");
      expect(f.counts()).toEqual(before);
      expect(f.sql.query("SELECT state FROM screening_cases").get()).toEqual({ state: "pending" });
      expect(f.sql.query("SELECT status FROM reports").get()).toEqual({ status: "pending" });
      f.sql.exec("DROP TRIGGER fail_receipt");
      expect((await f[operation]()).status).toBe(200);
    });

    test(`${operation}: a lost commit response is recovered from the durable receipt`, async () => {
      const f = fixture();
      f.loseNextResponse();
      const first = await f[operation]();
      expect(first.status).toBe(200);
      expect(await (await f[operation]()).text()).toBe(await first.text());
      expect(f.counts()).toMatchObject({ receipts: 1, audits: 1 });
    });

    test(`${operation}: concurrent identical requests settle once`, async () => {
      const f = fixture();
      const replies = await Promise.all(Array.from({ length: 8 }, () => f[operation]()));
      expect(replies.map((reply) => reply.status)).toEqual(Array(8).fill(200));
      expect(new Set(await Promise.all(replies.map((reply) => reply.text()))).size).toBe(1);
      expect(f.counts()).toMatchObject({ receipts: 1, audits: 1 });
    });
  }

  test("replaying an old hide after restoration never hides the record again", async () => {
    const f = fixture();
    const hidden = await (await f.hide()).text();
    expect(
      (
        await operatorContentControl(
          f.db,
          "operator",
          { ...f.controlBody, action: "restore" },
          "restore",
        )
      ).status,
    ).toBe(200);
    const before = f.counts();
    expect(await (await f.hide()).text()).toBe(hidden);
    expect(f.visibility()).toEqual({ visibility: "visible" });
    expect(f.counts()).toEqual(before);
  });

  test("a key binds the complete canonical intent across targets, actions and routes", async () => {
    const f = fixture();
    expect((await f.hide("shared-key")).status).toBe(200);
    const before = f.counts();
    for (const patch of [
      { reason: "A different reviewed explanation." },
      { target_id: "P-REPLAY/C-2" },
      { action: "restore" as const },
    ]) {
      const reply = await operatorContentControl(
        f.db,
        "operator",
        { ...f.controlBody, ...patch },
        "shared-key",
      );
      expect(reply.status).toBe(409);
      expect(ProblemDocumentSchema.parse(await reply.json()).code).toBe("IDEMPOTENCY_CONFLICT");
    }
    const crossRoute = await f.quarantine("shared-key");
    expect(crossRoute.status).toBe(409);
    expect(ProblemDocumentSchema.parse(await crossRoute.json()).code).toBe("IDEMPOTENCY_CONFLICT");
    expect(f.counts()).toEqual(before);
    // JSON property order is not a second intent.
    expect(
      (
        await operatorContentControl(
          f.db,
          "operator",
          {
            reason: f.controlBody.reason,
            action: "hide",
            target_kind: "claim",
            target_id: "P-REPLAY/C-1",
          },
          "shared-key",
        )
      ).status,
    ).toBe(200);
    expect(f.counts()).toEqual(before);
  });

  test("a cross-target key collision rolls back the losing mutation", async () => {
    const f = fixture();
    f.beforeNextBatch(async () => {
      expect(
        (
          await operatorContentControl(
            f.db,
            "operator",
            {
              ...f.controlBody,
              target_id: "P-REPLAY/C-2",
            },
            "colliding-key",
          )
        ).status,
      ).toBe(200);
    });
    const loser = await f.hide("colliding-key");
    expect(loser.status).toBe(409);
    expect(ProblemDocumentSchema.parse(await loser.json()).code).toBe("IDEMPOTENCY_CONFLICT");
    expect(f.visibility()).toBeNull();
    expect(f.counts()).toMatchObject({ controls: 1, receipts: 1, audits: 1, logs: 1 });
  });

  test("distinct concurrent keys cannot duplicate one visibility transition", async () => {
    const f = fixture();
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) => f.hide(`hide-${index}`)),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(11);
    expect(f.counts()).toMatchObject({ controls: 1, receipts: 1, audits: 1, logs: 1 });
  });

  test("a hide/restore cycle between read and commit invalidates the stale command", async () => {
    const f = fixture();
    f.beforeNextBatch(async () => {
      expect((await f.hide("winning-hide")).status).toBe(200);
      expect(
        (
          await operatorContentControl(
            f.db,
            "operator",
            {
              ...f.controlBody,
              action: "restore",
            },
            "winning-restore",
          )
        ).status,
      ).toBe(200);
    });
    expect((await f.hide("stale-hide")).status).toBe(409);
    expect(f.visibility()).toEqual({ visibility: "visible" });
    expect(f.counts()).toMatchObject({ controls: 2, receipts: 2, audits: 2, logs: 2 });
  });

  test("receipt rows cannot be rewritten or erased", async () => {
    const f = fixture();
    expect((await f.hide()).status).toBe(200);
    expect(() => f.sql.exec("UPDATE operator_command_receipts SET operation='report'")).toThrow(
      "OPERATOR_COMMAND_RECEIPT_APPEND_ONLY",
    );
    expect(() => f.sql.exec("DELETE FROM operator_command_receipts")).toThrow(
      "OPERATOR_COMMAND_RECEIPT_APPEND_ONLY",
    );
  });
});
