import { Database } from "bun:sqlite";
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { D1Database } from "@cloudflare/workers-types";
import {
  applyOperatorControl,
  currentContentControl,
  fileReport,
  resolveReport,
} from "../../src/moderation/store.ts";

const databases: Database[] = [];
afterEach(() => {
  setSystemTime();
  for (const db of databases.splice(0)) db.close();
});

// Unit SQLite adapter with the shipped moderation tables and triggers. The
// separate Workerd/D1 journey owns provider-binding evidence.
function fixture() {
  const sql = new Database(":memory:", { strict: true });
  databases.push(sql);
  sql.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE enrollment_fellows (fellow_id TEXT PRIMARY KEY, sponsor_id TEXT NOT NULL);
    CREATE TABLE problems (id TEXT PRIMARY KEY, status TEXT, unlisted INTEGER, public_seq INTEGER);
    INSERT INTO problems VALUES ('P-REPORTS', 'active', 0, 1);`);
  sql.exec(
    readFileSync(
      new URL("../../../../db/migrations/0091_moderation_plane.sql", import.meta.url),
      "utf8",
    ),
  );
  let beforeBatch: (() => Promise<void>) | undefined;
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
      sql.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        sql.exec("COMMIT");
        return results;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  let sponsor = 0;
  const report = async (reason: string, target = "C-1", targetKind = "claim") =>
    fileReport(db, {
      problemId: "P-REPORTS",
      targetKind,
      targetRef: target,
      reason,
      note: "PRIVATE-REPORT-NOTE",
      reporterClass: "sponsor",
      reporterFellowId: null,
      reporterSponsorId: `sponsor-${++sponsor}`,
    });
  const resolve = (reportId: string, resolution: "dismiss" | "uphold" = "dismiss") =>
    resolveReport(db, "operator", { reportId, resolution, reason: "PRIVATE-OPERATOR-RATIONALE" });
  const status = (reportId: string) =>
    (
      sql.query("SELECT status FROM reports WHERE report_id = ?").get(reportId) as {
        status: string;
      }
    ).status;
  const count = (table: "operator_audit" | "content_controls" | "moderation_log") =>
    (sql.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const logs = () =>
    sql.query("SELECT action, category FROM moderation_log ORDER BY seq").all() as {
      action: string;
      category: string;
    }[];
  const control = () => currentContentControl(db, "P-REPORTS", "C-1");
  const operatorControl = (visibility: "hidden" | "visible") =>
    applyOperatorControl(db, "operator", {
      problemId: "P-REPORTS",
      targetKind: "claim",
      targetRef: "C-1",
      visibility,
      reason: "A separately reviewed operator visibility decision.",
    });
  return {
    sql,
    db,
    report,
    resolve,
    status,
    count,
    logs,
    control,
    operatorControl,
    beforeNextBatch(hook: () => Promise<void>) {
      beforeBatch = hook;
    },
  };
}

async function communityHold(
  f: ReturnType<typeof fixture>,
  reasons = ["integrity", "integrity", "integrity"],
) {
  const reports = [];
  for (const reason of reasons) reports.push(await f.report(reason));
  expect((await f.control())?.source).toBe("community-reports");
  expect((await f.control())?.visibility).toBe("hidden");
  return reports;
}

describe("report resolution preserves independent allegations", () => {
  test("dismisses only the observed category, retaining safety/privacy holds until their own reviews", async () => {
    const f = fixture();
    const [integrity, privacy, safety] = await communityHold(f, ["integrity", "privacy", "safety"]);
    const duplicate = await f.report("integrity");
    const otherTarget = await f.report("integrity", "C-1@2");
    const original = await f.control();
    expect((await f.resolve(integrity!.reportId)).ok).toBe(true);
    expect(f.status(integrity!.reportId)).toBe("dismissed");
    expect(f.status(duplicate.reportId)).toBe("dismissed");
    expect(f.status(privacy!.reportId)).toBe("pending");
    expect(f.status(safety!.reportId)).toBe("pending");
    expect(f.status(otherTarget.reportId)).toBe("pending");
    expect(await f.control()).toEqual(original);
    expect(f.logs().some((item) => item.action === "restored")).toBe(false);
    expect((await f.resolve(privacy!.reportId)).ok).toBe(true);
    expect(await f.control()).toEqual(original);
    expect((await f.resolve(safety!.reportId)).ok).toBe(true);
    expect((await f.control())?.visibility).toBe("visible");
    expect(f.logs().filter((item) => item.action === "restored")).toHaveLength(1);
    expect(f.count("operator_audit")).toBe(3);
    expect(await f.resolve(integrity!.reportId)).toEqual({ ok: false, reason: "not-pending" });
    expect(f.count("operator_audit")).toBe(3);
    expect(JSON.stringify(f.logs())).not.toContain("PRIVATE-");
  });

  test("a spam dismissal cannot settle a distinct privacy allegation", async () => {
    const f = fixture();
    const [spam, duplicate, privacy] = await communityHold(f, ["spam", "spam", "privacy"]);
    await f.resolve(spam!.reportId);
    expect(f.status(duplicate!.reportId)).toBe("dismissed");
    expect(f.status(privacy!.reportId)).toBe("pending");
    expect((await f.control())?.visibility).toBe("hidden");
    expect(f.logs().filter((item) => item.action === "report-dismissed")).toEqual([
      { action: "report-dismissed", category: "spam" },
    ]);
  });

  test("upholding a community-hidden target creates a durable operator hold", async () => {
    const f = fixture();
    const [integrity, privacy, safety] = await communityHold(f, ["integrity", "privacy", "safety"]);
    expect((await f.resolve(privacy!.reportId, "uphold")).ok).toBe(true);
    const held = await f.control();
    expect(held?.source).toBe("operator");
    expect(held?.visibility).toBe("hidden");
    expect(held?.version).toBe(2);
    await f.resolve(integrity!.reportId);
    await f.resolve(safety!.reportId);
    expect(await f.control()).toEqual(held);
    expect(f.status(privacy!.reportId)).toBe("upheld");
    expect(f.logs().some((item) => item.action === "restored")).toBe(false);
  });

  test("a legacy upheld report blocks automatic restoration even under a community control", async () => {
    const f = fixture();
    const [integrity, privacy, safety] = await communityHold(f, ["integrity", "privacy", "safety"]);
    // Older deployments could uphold an already-hidden target without upgrading
    // its community control. Preserve that prior human decision during migration.
    f.sql
      .query(
        "UPDATE reports SET status = 'upheld', resolved_at = ?, resolved_by = ?, resolution_reason = ? WHERE report_id = ?",
      )
      .run(
        "2026-10-01T00:00:00.000Z",
        "earlier-operator",
        "A prior reviewed privacy finding.",
        privacy!.reportId,
      );
    await f.resolve(integrity!.reportId);
    await f.resolve(safety!.reportId);
    expect((await f.control())?.visibility).toBe("hidden");
    expect(f.status(privacy!.reportId)).toBe("upheld");
    expect(f.logs().some((item) => item.action === "restored")).toBe(false);
  });

  for (const incoming of ["integrity", "privacy"]) {
    test(`a new ${incoming} report arriving after the reviewed snapshot remains pending`, async () => {
      const f = fixture();
      const reports = await communityHold(f);
      let lateId = "";
      f.beforeNextBatch(async () => {
        lateId = (await f.report(incoming)).reportId;
      });
      expect((await f.resolve(reports[0]!.reportId)).ok).toBe(true);
      for (const report of reports) expect(f.status(report.reportId)).toBe("dismissed");
      expect(f.status(lateId)).toBe("pending");
      expect((await f.control())?.visibility).toBe("hidden");
      expect(f.logs().some((item) => item.action === "restored")).toBe(false);
      await f.resolve(lateId);
      expect((await f.control())?.visibility).toBe("visible");
    });
  }

  test("a new operator hold between read and commit cannot be undone by a stale dismissal", async () => {
    const f = fixture();
    const reports = await communityHold(f);
    let heldId: string | undefined;
    f.beforeNextBatch(async () => {
      await f.operatorControl("visible");
      await f.operatorControl("hidden");
      heldId = (await f.control())?.control_id;
    });
    expect((await f.resolve(reports[0]!.reportId)).ok).toBe(true);
    expect((await f.control())?.control_id).toBe(heldId);
    expect((await f.control())?.source).toBe("operator");
    expect((await f.control())?.visibility).toBe("hidden");
    // Only the explicit operator restore was logged; the dismissal did not restore.
    expect(f.logs().filter((item) => item.action === "restored")).toHaveLength(1);
  });

  test("a competing decision wins once even for the same operator and millisecond", async () => {
    setSystemTime(new Date("2026-10-27T12:00:00.000Z"));
    const f = fixture();
    const reports = await communityHold(f);
    f.beforeNextBatch(async () => {
      expect((await f.resolve(reports[0]!.reportId, "uphold")).ok).toBe(true);
    });
    expect(await f.resolve(reports[0]!.reportId, "dismiss")).toEqual({
      ok: false,
      reason: "not-pending",
    });
    for (const report of reports) expect(f.status(report.reportId)).toBe("upheld");
    expect(f.count("operator_audit")).toBe(1);
    expect(f.logs().filter((item) => item.action.startsWith("report-"))).toEqual([
      { action: "report-upheld", category: "integrity" },
    ]);
    expect(f.logs().some((item) => item.action === "restored")).toBe(false);
    expect((await f.control())?.source).toBe("operator");
  });

  test("concurrent decisions on duplicate category reports cannot double-audit or double-control", async () => {
    setSystemTime(new Date("2026-10-27T12:00:00.000Z"));
    const f = fixture();
    const reports = await communityHold(f);
    const outcomes = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        f.resolve(reports[i % reports.length]!.reportId, "uphold"),
      ),
    );
    expect(outcomes.filter((item) => item.ok)).toHaveLength(1);
    expect(outcomes.filter((item) => !item.ok && item.reason === "not-pending")).toHaveLength(23);
    expect(f.count("operator_audit")).toBe(1);
    expect(f.count("content_controls")).toBe(2);
    expect(f.logs().filter((item) => item.action === "report-upheld")).toHaveLength(1);
  });

  test("a failed visibility transition rolls back the selected report, peers, audit and public log", async () => {
    const f = fixture();
    const reports = await communityHold(f);
    f.sql.exec(`CREATE TRIGGER fail_control BEFORE INSERT ON content_controls
      WHEN NEW.source = 'operator' BEGIN SELECT RAISE(ABORT, 'planted control failure'); END;`);
    await expect(f.resolve(reports[0]!.reportId)).rejects.toThrow("planted control failure");
    for (const report of reports) expect(f.status(report.reportId)).toBe("pending");
    expect(f.count("operator_audit")).toBe(0);
    expect(f.count("content_controls")).toBe(1);
    expect(f.logs()).toEqual([{ action: "hidden", category: "integrity" }]);
    f.sql.exec("DROP TRIGGER fail_control");
    expect((await f.resolve(reports[0]!.reportId)).ok).toBe(true);
    expect(f.count("operator_audit")).toBe(1);
    expect((await f.control())?.visibility).toBe("visible");
  });

  test("unsupported visibility targets retain report outcomes without false hide logs", async () => {
    const f = fixture();
    const report = await f.report("integrity", "H-1", "hypothesis");
    expect((await f.resolve(report.reportId, "uphold")).ok).toBe(true);
    expect(f.status(report.reportId)).toBe("upheld");
    expect(f.count("content_controls")).toBe(0);
    expect(f.logs()).toEqual([{ action: "report-upheld", category: "integrity" }]);
    expect(await f.resolve("RP-absent")).toEqual({ ok: false, reason: "not-found" });
    expect(f.count("operator_audit")).toBe(1);
  });
});
