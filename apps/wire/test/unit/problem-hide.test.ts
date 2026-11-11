import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SponsorProblemHideReceiptSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { hiddenByContentControlSql } from "../../src/krater/public-content.ts";
import { sponsorProblemHideHttp } from "../../src/moderation/problem-hide.ts";
import { applyOperatorControl } from "../../src/moderation/store.ts";

const OWNER = "usr_creator_fixture";
const OTHER = "usr_other_fixture";
const PROBLEM = "P-HIDE";
const PRIVATE_REASON = "Private owner context for withdrawing this problem.";
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** Real migration SQL through a unit D1 adapter, with explicit race hooks.
 * These are not a claim of native Worker/D1 or browser execution. */
function fixture() {
  const sql = new Database(":memory:", { strict: true });
  databases.push(sql);
  sql.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE sponsors(sponsor_id TEXT PRIMARY KEY, tombstoned_at INTEGER);
    CREATE TABLE enrollment_fellows(fellow_id TEXT PRIMARY KEY, sponsor_id TEXT);
    CREATE TABLE problems(id TEXT PRIMARY KEY, sponsor_id TEXT, status TEXT,
      unlisted INTEGER, public_seq INTEGER);
    CREATE TABLE sponsor_suspension_events(sponsor_id TEXT PRIMARY KEY);
    CREATE TABLE problem_stewards(problem_id TEXT, sponsor_id TEXT);
    CREATE TABLE public_cursor(singleton INTEGER PRIMARY KEY, cursor INTEGER);
    INSERT INTO sponsors VALUES('${OWNER}', NULL), ('${OTHER}', NULL);
    INSERT INTO enrollment_fellows VALUES('FEL-CONTRIBUTOR', '${OWNER}');
    INSERT INTO problems VALUES('${PROBLEM}', '${OWNER}', 'active', 0, 7);
    INSERT INTO public_cursor VALUES(1, 0);`);
  for (const name of ["0091_moderation_plane.sql", "0145_sponsor_problem_hides.sql"]) {
    sql.exec(readFileSync(new URL(`../../../../db/migrations/${name}`, import.meta.url), "utf8"));
  }

  let beforeBatch: (() => Promise<void> | void) | undefined;
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
  const body = () => ({
    problem_id: PROBLEM,
    reason: PRIVATE_REASON,
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  return {
    sql,
    db,
    body,
    beforeNextBatch(hook: () => Promise<void> | void) {
      beforeBatch = hook;
    },
    loseNextResponse() {
      loseResponse = true;
    },
    hide(key = "owner-hide", sponsor = OWNER, command: unknown = body(), problem = PROBLEM) {
      return sponsorProblemHideHttp({
        db,
        sponsorId: sponsor,
        problemId: problem,
        body: command,
        idempotencyKey: key,
      });
    },
    counts() {
      return sql
        .query(`SELECT
        (SELECT COUNT(*) FROM content_controls) AS controls,
        (SELECT COUNT(*) FROM moderation_log) AS logs,
        (SELECT COUNT(*) FROM operator_audit) AS operator_audits,
        (SELECT COUNT(*) FROM sponsor_problem_hide_receipts) AS receipts,
        (SELECT cursor FROM public_cursor WHERE singleton = 1) AS cursor`)
        .get();
    },
    publicVisible() {
      return (
        sql
          .query(`SELECT id FROM problems p WHERE p.id = ?
        AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}`)
          .get(PROBLEM) !== null
      );
    },
    operator(visibility: "hidden" | "visible") {
      return applyOperatorControl(db, "operator-fixture", {
        problemId: PROBLEM,
        targetKind: "problem",
        targetRef: "problem",
        visibility,
        reason: "A separately reviewed operator decision.",
      });
    },
  };
}

const EMPTY = { controls: 0, logs: 0, operator_audits: 0, receipts: 0, cursor: 0 };

describe("owner problem hiding", () => {
  test("commits one attributable hide, private receipt and coarse log on the shared visibility path", async () => {
    const f = fixture();
    expect(f.publicVisible()).toBe(true);
    const response = await f.hide();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const receipt = SponsorProblemHideReceiptSchema.parse(await response.json());
    expect(receipt).toMatchObject({
      problem_id: PROBLEM,
      actor_kind: "sponsor",
      visibility: "hidden",
      version: 1,
    });
    expect(f.publicVisible()).toBe(false);
    expect(f.counts()).toEqual({
      controls: 1,
      logs: 1,
      operator_audits: 0,
      receipts: 1,
      cursor: 1,
    });
    expect(f.sql.query("SELECT public_seq FROM problems WHERE id = ?").get(PROBLEM)).toEqual({
      public_seq: 7,
    });
    expect(
      f.sql.query("SELECT actor_kind, actor, reason_category FROM content_controls").get(),
    ).toEqual({ actor_kind: "sponsor", actor: OWNER, reason_category: "sponsor-requested" });
    const log = f.sql.query("SELECT * FROM moderation_log").get();
    expect(log).toMatchObject({
      category: "sponsor-requested",
      action: "hidden",
      problem_id: PROBLEM,
    });
    expect(JSON.stringify(log)).not.toContain(PRIVATE_REASON);
    expect(JSON.stringify(log)).not.toContain(OWNER);
    expect(JSON.stringify(receipt)).not.toContain(PRIVATE_REASON);
  });

  test("hiding an unlisted owned publication never places its id in the public log", async () => {
    const f = fixture();
    f.sql.exec("UPDATE problems SET unlisted = 1");
    expect((await f.hide()).status).toBe(200);
    expect(f.sql.query("SELECT problem_id, category FROM moderation_log").get()).toEqual({
      problem_id: null,
      category: "sponsor-requested",
    });
    expect(f.publicVisible()).toBe(false);
  });

  test("current problem ownership is required even when the caller stewards or contributes", async () => {
    const f = fixture();
    f.sql.query("UPDATE problems SET sponsor_id = ?").run(OTHER);
    f.sql.query("INSERT INTO problem_stewards VALUES(?, ?)").run(PROBLEM, OWNER);
    expect((await f.hide()).status).toBe(404);
    expect(
      (await f.hide("absent", OWNER, { ...f.body(), problem_id: "P-ABSENT" }, "P-ABSENT")).status,
    ).toBe(404);
    f.sql.query("UPDATE problems SET sponsor_id = ?, status = 'private-draft'").run(OWNER);
    expect((await f.hide()).status).toBe(404);
    f.sql.exec("UPDATE problems SET status = 'active', public_seq = 0");
    expect((await f.hide()).status).toBe(404);
    expect(f.counts()).toEqual(EMPTY);
  });

  test("tombstoning, suspension and ownership loss are rechecked in the write transaction", async () => {
    for (const change of [
      `UPDATE sponsors SET tombstoned_at = 1 WHERE sponsor_id = '${OWNER}'`,
      `INSERT INTO sponsor_suspension_events VALUES('${OWNER}')`,
      `UPDATE problems SET sponsor_id = '${OTHER}'`,
      "UPDATE problems SET status = 'private-draft'",
    ]) {
      const f = fixture();
      f.beforeNextBatch(() => {
        f.sql.exec(change);
      });
      expect((await f.hide()).status).toBe(404);
      expect(f.counts()).toEqual(EMPTY);
    }
  });

  test("known receipts require current ownership and a live account", async () => {
    const f = fixture();
    expect((await f.hide()).status).toBe(200);
    const committed = f.counts();
    f.sql.query("INSERT INTO sponsor_suspension_events VALUES(?)").run(OWNER);
    expect((await f.hide()).status).toBe(404);
    expect(f.counts()).toEqual(committed);
  });

  test("stale and beyond-skew authentication, malformed commands and secrets store nothing", async () => {
    const f = fixture();
    const now = Math.floor(Date.now() / 1000);
    for (const time of [now - 2000, now + 2000]) {
      expect(
        (
          await f.hide("stale", OWNER, {
            ...f.body(),
            step_up_authenticated_at: time,
          })
        ).status,
      ).toBe(403);
    }
    for (const command of [
      { ...f.body(), problem_id: "P-OTHER" },
      { ...f.body(), reason: " " },
      { ...f.body(), action: "restore" },
      { ...f.body(), actor_kind: "operator" },
      { ...f.body(), step_up_authenticated_at: 0.5 },
      { ...f.body(), reason: "asimp_ag_" + "A".repeat(45) },
    ]) {
      expect((await f.hide("invalid", OWNER, command)).status).toBe(422);
    }
    expect((await f.hide("invalid key")).status).toBe(422);
    expect(f.counts()).toEqual(EMPTY);
  });

  test("an operator restore survives replay and preserves the sponsor's original provenance", async () => {
    const f = fixture();
    const first = await (await f.hide()).json();
    expect((await f.operator("visible")).ok).toBe(true);
    const restored = f.counts();
    expect(f.publicVisible()).toBe(true);
    const replay = await f.hide("owner-hide", OWNER, {
      ...f.body(),
      step_up_authenticated_at: Math.floor(Date.now() / 1000) - 1,
    });
    expect(await replay.json()).toEqual(first);
    expect(f.publicVisible()).toBe(true);
    expect(f.counts()).toEqual(restored);
    expect(
      f.sql
        .query(`SELECT version, COALESCE(actor_kind,
      CASE source WHEN 'operator' THEN 'operator' ELSE 'community' END) AS actor_kind
      FROM content_controls ORDER BY version`)
        .all(),
    ).toEqual([
      { version: 1, actor_kind: "sponsor" },
      { version: 2, actor_kind: "operator" },
    ]);
    expect(restored).toEqual({
      controls: 2,
      logs: 2,
      operator_audits: 1,
      receipts: 1,
      cursor: 2,
    });
  });

  test("the same retry key cannot authorize a changed reason or target", async () => {
    const f = fixture();
    expect((await f.hide()).status).toBe(200);
    const before = f.counts();
    const conflict = await f.hide("owner-hide", OWNER, {
      ...f.body(),
      reason: "A different private decision.",
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    f.sql.query("INSERT INTO problems VALUES('P-SECOND', ?, 'active', 0, 1)").run(OWNER);
    expect(
      (
        await f.hide(
          "owner-hide",
          OWNER,
          {
            ...f.body(),
            problem_id: "P-SECOND",
          },
          "P-SECOND",
        )
      ).status,
    ).toBe(409);
    expect(f.counts()).toEqual(before);
  });

  test("lost acknowledgments and concurrent identical commands return one receipt", async () => {
    const lost = fixture();
    lost.loseNextResponse();
    expect((await lost.hide()).status).toBe(200);
    expect(lost.counts()).toEqual({
      controls: 1,
      logs: 1,
      operator_audits: 0,
      receipts: 1,
      cursor: 1,
    });
    const racing = fixture();
    let winner: unknown;
    racing.beforeNextBatch(async () => {
      winner = await (await racing.hide()).json();
    });
    const loser = await racing.hide();
    expect(loser.status).toBe(200);
    expect(await loser.json()).toEqual(winner);
    expect(racing.counts()).toEqual(lost.counts());
  });

  test("a newer visibility decision defeats a stale owner write without producing a receipt", async () => {
    const f = fixture();
    f.beforeNextBatch(async () => {
      expect((await f.operator("hidden")).ok).toBe(true);
    });
    expect((await f.hide()).status).toBe(409);
    expect(f.counts()).toEqual({
      controls: 1,
      logs: 1,
      operator_audits: 1,
      receipts: 0,
      cursor: 1,
    });
  });

  test("receipt failure rolls back control, public log and cursor together", async () => {
    const f = fixture();
    f.sql.exec(`CREATE TRIGGER fail_hide_receipt BEFORE INSERT ON sponsor_problem_hide_receipts
      BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END;`);
    expect((await f.hide()).status).toBe(503);
    expect(f.counts()).toEqual(EMPTY);
    expect(f.publicVisible()).toBe(true);
  });

  test("accepted receipts are append-only and cannot claim another authority", async () => {
    const f = fixture();
    expect((await f.hide()).status).toBe(200);
    expect(() =>
      f.sql.exec("UPDATE sponsor_problem_hide_receipts SET control_version = 99"),
    ).toThrow("SPONSOR_PROBLEM_HIDE_RECEIPT_IMMUTABLE");
    expect(() => f.sql.exec("DELETE FROM sponsor_problem_hide_receipts")).toThrow(
      "SPONSOR_PROBLEM_HIDE_RECEIPT_IMMUTABLE",
    );
    expect(() =>
      f.sql.exec(`INSERT INTO sponsor_problem_hide_receipts
      SELECT sponsor_id, '${"d".repeat(64)}', request_digest, problem_id, control_id,
        control_version, step_up_authenticated_at,
        json_set(receipt_json, '$.actor_kind', 'operator'), created_at
      FROM sponsor_problem_hide_receipts`),
    ).toThrow("SPONSOR_PROBLEM_HIDE_RECEIPT_MISMATCH");
  });
});
