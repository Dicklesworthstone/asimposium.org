import { afterEach, expect, test } from "bun:test";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { queryIntegrityCases, readIntegrityCase } from "../../src/moderation/integrity-read.ts";
import { openIntegrityCase, resolveIntegrityCase, respondToIntegrityCase } from "../../src/moderation/integrity-store.ts";
import { readOperatorReportDetail } from "../../src/moderation/report-detail.ts";
import { currentContentControl, listPendingReports, resolveReport } from "../../src/moderation/store.ts";
import {
  integrityCaseFixture, INTEGRITY_APPEAL_OPERATOR, INTEGRITY_OPERATOR,
  INTEGRITY_RATIONALE, INTEGRITY_REPORTER, INTEGRITY_RESPONSE, INTEGRITY_SUMMARY,
  openRequest, PROBLEM, resolveRequest, SPONSOR,
} from "../support/integrity-cases.ts";

type Fixture = Awaited<ReturnType<typeof integrityCaseFixture>>;
const fixtures: Fixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.sql.close(); });
async function setup() {
  const f = await integrityCaseFixture();
  fixtures.push(f);
  await f.publish();
  const report = await f.report();
  return { ...f, reportId: report.report_id };
}
function count(f: Fixture, table: "integrity_cases" | "integrity_case_actions" | "integrity_command_receipts" | "operator_audit" | "content_controls" | "fellow_inbox_notices") {
  return (f.sql.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
function reportState(f: Fixture, reportId: string) {
  return (f.sql.query("SELECT status FROM reports WHERE report_id = ?").get(reportId) as { status: string }).status;
}
function beforeBatch(db: D1Database, hook: () => Promise<void>): D1Database {
  let pending = true;
  return {
    prepare: db.prepare.bind(db),
    async batch(statements: D1PreparedStatement[]) {
      if (pending) { pending = false; await hook(); }
      return db.batch(statements);
    },
  } as D1Database;
}

test("integrity review pins the original source, records a sponsor response and one independent appeal without changing science", async () => {
  const f = await setup();
  const originalSource = (await readOperatorReportDetail(f.db, f.reportId))!.source;
  const correction = await f.publish("C-1", 2);
  const publicState = f.state();
  const request = openRequest(f.reportId);
  const opened = await openIntegrityCase(f.db, INTEGRITY_OPERATOR, request, "open-one");
  expect(await openIntegrityCase(f.db, INTEGRITY_OPERATOR, request, "open-one")).toEqual(opened);
  expect(opened).toMatchObject({ revision: 1, state: "open", appeals_used: 0 });
  expect(count(f, "integrity_cases")).toBe(1);
  expect((await listPendingReports(f.db)).totalPending).toBe(0);
  const own = await queryIntegrityCases(f.db, { limit: 20 }, SPONSOR);
  expect(own.cases.map((item) => item.case_id)).toEqual([opened.case_id]);
  expect((await queryIntegrityCases(f.db, { limit: 20 }, "usr_integrity_other")).cases).toEqual([]);
  const read = { case_id: opened.case_id, after_revision: 0, limit: 20 };
  const detail = await readIntegrityCase(f.db, read, SPONSOR);
  expect(detail.case.source.target_ref).toBe("C-1@1");
  if (originalSource.state !== "available") throw new Error("Expected retained source");
  expect(detail.case.source.event_id).toBe(originalSource.event_id);
  expect(JSON.stringify(detail)).not.toContain("PRIVATE_REPORTER_NOTE");
  expect(JSON.stringify(detail)).not.toContain(INTEGRITY_REPORTER);
  expect("report_id" in detail).toBe(false);
  expect(await readIntegrityCase(f.db, read)).toMatchObject({ report_id: f.reportId });
  await expect(readIntegrityCase(f.db, read, "usr_integrity_other")).rejects.toThrow("NOT_FOUND");

  const response = { case_id: opened.case_id, expected_revision: 1, response: INTEGRITY_RESPONSE };
  const responded = await respondToIntegrityCase(f.db, SPONSOR, response, "response-one");
  expect(responded.revision).toBe(2);
  expect(await respondToIntegrityCase(f.db, SPONSOR, response, "response-one")).toEqual(responded);
  await expect(respondToIntegrityCase(f.db, SPONSOR, {
    ...response, response: "A changed statement must not reuse the original command key.",
  }, "response-one")).rejects.toThrow("IDEMPOTENCY");

  const decision = {
    ...resolveRequest(opened.case_id, 2),
    correction_refs: [{ problem_id: PROBLEM, target_ref: "C-1@2" }],
  };
  const resolved = await resolveIntegrityCase(f.db, INTEGRITY_OPERATOR, decision, "resolve-one");
  expect(resolved).toMatchObject({ revision: 3, state: "resolved", appeals_used: 0 });
  expect(reportState(f, f.reportId)).toBe("dismissed");
  await f.publish("C-1", 3);
  const corrected = await readIntegrityCase(f.db, read, SPONSOR);
  expect(corrected.case.corrections).toMatchObject([{
    target_ref: "C-1@2", event_id: correction.eventId,
  }]);
  const scienceAfterNewVersion = f.state();

  const appeal = await respondToIntegrityCase(f.db, SPONSOR, {
    case_id: opened.case_id, expected_revision: 3, response: "Please independently reconsider the interpretation of the source.",
  }, "appeal-one");
  expect(appeal).toMatchObject({ revision: 4, state: "open", action: "appealed", appeals_used: 1 });
  expect(reportState(f, f.reportId)).toBe("pending");
  const reopened = await readIntegrityCase(f.db, read, SPONSOR);
  expect(reopened.case).toMatchObject({ outcome: null, rationale: null, corrections: [] });
  await expect(resolveIntegrityCase(f.db, INTEGRITY_OPERATOR, resolveRequest(opened.case_id, 4),
    "same-reviewer")).rejects.toThrow("REVIEWER");
  const final = await resolveIntegrityCase(f.db, INTEGRITY_APPEAL_OPERATOR, {
    ...resolveRequest(opened.case_id, 4), outcome: "confirmed",
  }, "appeal-outcome");
  expect(final).toMatchObject({ revision: 5, state: "resolved", appeals_used: 1 });
  expect(reportState(f, f.reportId)).toBe("upheld");
  await expect(respondToIntegrityCase(f.db, SPONSOR, {
    case_id: opened.case_id, expected_revision: 5, response: INTEGRITY_RESPONSE,
  }, "second-appeal")).rejects.toThrow("CONFLICT");
  expect(f.state()).toEqual(scienceAfterNewVersion);
  expect(publicState.events).toHaveLength(2);
  expect(count(f, "content_controls")).toBe(0);
  const all = await readIntegrityCase(f.db, read, SPONSOR);
  expect(all.actions.map((item) => item.kind)).toEqual(["opened", "response", "resolved", "appealed", "resolved"]);
  expect(count(f, "integrity_case_actions")).toBe(5);
  expect(count(f, "integrity_command_receipts")).toBe(5);
  const firstPage = await readIntegrityCase(f.db, { ...read, limit: 2 }, SPONSOR);
  expect(firstPage).toMatchObject({ has_more: true, next_after_revision: 2 });
  const secondPage = await readIntegrityCase(f.db, { ...read, after_revision: 2 }, SPONSOR);
  expect(secondPage.actions.map((item) => item.revision)).toEqual([3, 4, 5]);
  const auditAndNotices = JSON.stringify({
    audit: f.sql.query("SELECT reason FROM operator_audit").all(),
    notices: f.sql.query("SELECT title,detail FROM fellow_inbox_notices").all(),
  });
  for (const privateText of [INTEGRITY_SUMMARY, INTEGRITY_RESPONSE, INTEGRITY_RATIONALE])
    expect(auditAndNotices).not.toContain(privateText);
});

test("known subject, reporter and correction-author conflicts cannot be waived by a declaration", async () => {
  const f = await setup();
  for (const operator of [SPONSOR, INTEGRITY_REPORTER]) {
    await expect(openIntegrityCase(f.db, operator, openRequest(f.reportId), `conflict-${operator}`))
      .rejects.toThrow("REVIEWER");
  }
  await expect(openIntegrityCase(f.db, INTEGRITY_OPERATOR, {
    ...openRequest(f.reportId), auth_issued_at: 0,
  }, "stale-auth")).rejects.toThrow("STEP_UP");
  expect(count(f, "integrity_cases")).toBe(0);
  const opened = await openIntegrityCase(f.db, INTEGRITY_OPERATOR, openRequest(f.reportId), "eligible");
  await f.publish("C-2", 1, { sponsor: INTEGRITY_APPEAL_OPERATOR, fellow: null });
  await expect(resolveIntegrityCase(f.db, INTEGRITY_APPEAL_OPERATOR, {
    ...resolveRequest(opened.case_id, 1),
    correction_refs: [{ problem_id: PROBLEM, target_ref: "C-2@1" }],
  }, "own-correction")).rejects.toThrow("REVIEWER");
  await expect(resolveIntegrityCase(f.db, INTEGRITY_OPERATOR, {
    ...resolveRequest(opened.case_id, 1),
    correction_refs: [{ problem_id: PROBLEM, target_ref: "C-1@1" }],
  }, "source-as-correction")).rejects.toThrow("SOURCE_UNAVAILABLE");
  expect((await readIntegrityCase(f.db, { case_id: opened.case_id, after_revision: 0, limit: 20 })).case.revision).toBe(1);
});

test("three integrity allegations do not hide a public claim; generic uphold cannot bypass a case", async () => {
  const f = await setup();
  await f.report("C-1@1", "usr_integrity_other");
  await f.report("C-1@1", INTEGRITY_APPEAL_OPERATOR);
  expect(await currentContentControl(f.db, PROBLEM, "C-1")).toBeUndefined();
  expect(await resolveReport(f.db, INTEGRITY_OPERATOR, {
    reportId: f.reportId, resolution: "uphold", reason: "A generic path cannot decide scientific integrity.",
  })).toMatchObject({ ok: false, reason: "integrity-case-required" });
  const opened = await openIntegrityCase(f.db, INTEGRITY_OPERATOR, openRequest(f.reportId), "case");
  expect(await resolveReport(f.db, INTEGRITY_OPERATOR, {
    reportId: f.reportId, resolution: "dismiss", reason: "A linked case owns this report's outcome.",
  })).toMatchObject({ ok: false, reason: "integrity-case-owned" });
  expect((await readIntegrityCase(f.db, { case_id: opened.case_id, after_revision: 0, limit: 20 })).case.state).toBe("open");
  expect(count(f, "content_controls")).toBe(0);
});

test("a case and generic dismissal cannot both win a stale report snapshot", async () => {
  for (const first of ["case", "dismiss"] as const) {
    const f = await setup();
    const publicState = f.state();
    if (first === "case") {
      const raced = beforeBatch(f.db, async () => {
        await openIntegrityCase(f.db, INTEGRITY_OPERATOR, openRequest(f.reportId), "case-wins");
      });
      expect(await resolveReport(raced, INTEGRITY_OPERATOR, {
        reportId: f.reportId, resolution: "dismiss", reason: "A stale generic dismissal must lose.",
      })).toMatchObject({ ok: false });
      expect(reportState(f, f.reportId)).toBe("pending");
      expect(count(f, "integrity_cases")).toBe(1);
    } else {
      const raced = beforeBatch(f.db, async () => {
        expect((await resolveReport(f.db, INTEGRITY_OPERATOR, {
          reportId: f.reportId, resolution: "dismiss", reason: "Unsupported report dismissed before investigation.",
        })).ok).toBe(true);
      });
      await expect(openIntegrityCase(raced, INTEGRITY_OPERATOR, openRequest(f.reportId), "dismiss-wins"))
        .rejects.toThrow("CONFLICT");
      expect(reportState(f, f.reportId)).toBe("dismissed");
      expect(count(f, "integrity_cases")).toBe(0);
    }
    expect(f.state()).toEqual(publicState);
  }
});

test("case history, audit, notification and receipt commit atomically and replay once", async () => {
  const f = await setup();
  f.sql.exec(`CREATE TRIGGER fail_integrity_notice BEFORE INSERT ON fellow_inbox_notices
    BEGIN SELECT RAISE(ABORT, 'planted integrity notice failure'); END`);
  await expect(openIntegrityCase(f.db, INTEGRITY_OPERATOR, openRequest(f.reportId), "atomic"))
    .rejects.toThrow("planted integrity notice failure");
  for (const table of ["integrity_cases", "integrity_case_actions", "integrity_command_receipts", "operator_audit"] as const)
    expect(count(f, table)).toBe(0);
  f.sql.exec("DROP TRIGGER fail_integrity_notice");
  const request = openRequest(f.reportId);
  const opened = await openIntegrityCase(f.db, INTEGRITY_OPERATOR, request, "atomic");
  const outcomes = await Promise.all(Array.from({ length: 4 }, () =>
    openIntegrityCase(f.db, INTEGRITY_OPERATOR, request, "atomic")));
  for (const receipt of outcomes) expect(receipt).toEqual(opened);
  expect(count(f, "integrity_case_actions")).toBe(1);
  expect(count(f, "fellow_inbox_notices")).toBe(1);
  expect(() => f.sql.query("UPDATE integrity_case_actions SET body_json = '{}' WHERE case_id = ?")
    .run(opened.case_id)).toThrow("IMMUTABLE");
});
