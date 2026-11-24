import { afterEach, expect, test } from "bun:test";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { Env } from "../../src/env.ts";
import { createIntegrityNoticeRoutes } from "../../src/moderation/integrity-notices-http.ts";
import {
  readIntegrityCase,
  readPublicIntegrityNotices,
} from "../../src/moderation/integrity-read.ts";
import {
  openIntegrityCase,
  resolveIntegrityCase,
  respondToIntegrityCase,
} from "../../src/moderation/integrity-store.ts";
import { readOperatorReportDetail } from "../../src/moderation/report-detail.ts";
import {
  INTEGRITY_OPERATOR,
  INTEGRITY_RATIONALE,
  INTEGRITY_REPORTER,
  INTEGRITY_RESPONSE,
  INTEGRITY_SUMMARY,
  integrityCaseFixture,
  openRequest,
  PROBLEM,
  resolveRequest,
  SPONSOR,
} from "../support/integrity-cases.ts";

type Fixture = Awaited<ReturnType<typeof integrityCaseFixture>>;
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});
async function setup() {
  const f = await integrityCaseFixture();
  fixtures.push(f);
  await f.publish();
  const report = await f.report();
  return { ...f, reportId: report.report_id };
}

test("hidden and corrupt publications cannot retain public integrity notices or stale validators", async () => {
  const f = await setup();
  const opened = await openIntegrityCase(
    f.db,
    INTEGRITY_OPERATOR,
    openRequest(f.reportId),
    "visible",
  );
  expect((await readOperatorReportDetail(f.db, f.reportId))!.integrity_case_id).toBe(
    opened.case_id,
  );
  await respondToIntegrityCase(
    f.db,
    SPONSOR,
    {
      case_id: opened.case_id,
      expected_revision: 1,
      response: INTEGRITY_RESPONSE,
    },
    "private-response",
  );
  await resolveIntegrityCase(
    f.db,
    INTEGRITY_OPERATOR,
    resolveRequest(opened.case_id, 2),
    "private-outcome",
  );
  const original = await readPublicIntegrityNotices(f.db, PROBLEM);
  for (const privateText of [
    INTEGRITY_SUMMARY,
    INTEGRITY_RESPONSE,
    INTEGRITY_RATIONALE,
    INTEGRITY_REPORTER,
  ])
    expect(JSON.stringify(original.face)).not.toContain(privateText);
  expect(original.face.notices).toHaveLength(1);
  await original.assertCurrent();
  f.visible("C-1@1", "hidden");
  await expect(original.assertCurrent()).rejects.toThrow("CHANGED");
  expect((await readPublicIntegrityNotices(f.db, PROBLEM)).face.notices).toEqual([]);
  f.visible("C-1@1", "visible", 2);
  const current = await readPublicIntegrityNotices(f.db, PROBLEM);
  const source = current.face.notices[0]!.source;
  // Bypass only this fixture's lawful-write guard to emulate retained corruption.
  f.sql.exec("DROP TRIGGER event_content_lawful_redaction_only");
  f.sql
    .query("UPDATE event_content SET payload_json = ? WHERE event_id = ?")
    .run('{"statement":"CORRUPT_UNCOMMITTED_SOURCE"}', source.event_id);
  await expect(current.assertCurrent()).rejects.toThrow("CHANGED");
  expect((await readPublicIntegrityNotices(f.db, PROBLEM)).face.notices).toEqual([]);
  expect(
    (
      await readIntegrityCase(
        f.db,
        {
          case_id: opened.case_id,
          after_revision: 0,
          limit: 20,
        },
        SPONSOR,
      )
    ).case.source.event_id,
  ).toBe(source.event_id);
});

test("an unsubstantiated outcome removes the public notice and cannot return304 for its prior representation", async () => {
  const f = await setup();
  const opened = await openIntegrityCase(
    f.db,
    INTEGRITY_OPERATOR,
    openRequest(f.reportId),
    "notice",
  );
  const router = createIntegrityNoticeRoutes();
  const env = { DB: f.db } as Env;
  const url = `https://a.asimposium.org/p/${PROBLEM}/integrity.json`;
  const before = await router.request(url, undefined, env);
  expect(before.status).toBe(200);
  const etag = before.headers.get("etag");
  expect(etag).not.toBeNull();
  expect((await router.request(url, { headers: { "if-none-match": etag! } }, env)).status).toBe(
    304,
  );
  const snapshot = await readPublicIntegrityNotices(f.db, PROBLEM);
  await resolveIntegrityCase(
    f.db,
    INTEGRITY_OPERATOR,
    {
      ...resolveRequest(opened.case_id, 1),
      outcome: "unsubstantiated",
    },
    "unsubstantiated",
  );
  await expect(snapshot.assertCurrent()).rejects.toThrow("CHANGED");
  const after = await router.request(url, { headers: { "if-none-match": etag! } }, env);
  expect(after.status).toBe(200);
  expect(((await after.json()) as { notices: unknown[] }).notices).toEqual([]);
  const privateCase = await readIntegrityCase(
    f.db,
    { case_id: opened.case_id, after_revision: 0, limit: 20 },
    SPONSOR,
  );
  expect(privateCase.case.outcome).toBe("unsubstantiated");
  expect(privateCase.actions).toHaveLength(2);
});

test("large valid corrections remain traversable when a public page reaches its byte budget", async () => {
  const f = await integrityCaseFixture();
  fixtures.push(f);
  const expected: string[] = [];
  const body = "測定値".repeat(21845) + "測";
  for (let index = 1; index <= 4; index++) {
    await f.publish(`C-${index}`);
    const report = await f.report(`C-${index}@1`);
    const opened = await openIntegrityCase(
      f.db,
      INTEGRITY_OPERATOR,
      openRequest(report.report_id),
      `bulk-open-${index}`,
    );
    const corrections = [];
    for (let correction = 1; correction <= 8; correction++) {
      const id = `E-bulk${index}correction${correction}`;
      await f.publish(id, 1, { evidence: true, body });
      corrections.push({ problem_id: PROBLEM, target_ref: id });
    }
    await resolveIntegrityCase(
      f.db,
      INTEGRITY_OPERATOR,
      {
        ...resolveRequest(opened.case_id, 1),
        correction_refs: corrections,
      },
      `bulk-resolve-${index}`,
    );
    expected.push(opened.case_id);
  }
  const found: string[] = [];
  let after: string | undefined;
  let pages = 0;
  do {
    const page = await readPublicIntegrityNotices(f.db, PROBLEM, after);
    if (pages++ === 0) expect(page.face.has_more).toBe(true);
    for (const item of page.face.notices) {
      found.push(item.case_id);
      expect(item.corrections).toHaveLength(8);
    }
    after = page.face.next_after ?? undefined;
    expect(pages).toBeLessThan(5);
  } while (after !== undefined);
  expect(found).toEqual(expected.sort());
  expect(new Set(found).size).toBe(4);
});

test("a late unsubstantiated decision cannot slip between the metadata and content witnesses", async () => {
  const f = await setup();
  const opened = await openIntegrityCase(
    f.db,
    INTEGRITY_OPERATOR,
    openRequest(f.reportId),
    "late-open",
  );
  let armed = false;
  let changes = 0;
  const resolveDuringFence = async () => {
    if (!armed) return;
    armed = false;
    changes++;
    await resolveIntegrityCase(
      f.db,
      INTEGRITY_OPERATOR,
      {
        ...resolveRequest(opened.case_id, 1),
        outcome: "unsubstantiated",
      },
      "late-outcome",
    );
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    ({
      ...statement,
      bind(...values: unknown[]) {
        return wrap(statement.bind(...values));
      },
      async all<T = Record<string, unknown>>() {
        const result = await statement.all<T>();
        // A sequential metadata/content fence sees the old metadata, then the
        // unchanged publication bytes, despite this intervening case decision.
        await resolveDuringFence();
        return result;
      },
    }) as D1PreparedStatement;
  const raced = {
    prepare: (sql: string) => wrap(f.db.prepare(sql)),
    async batch(statements: D1PreparedStatement[]) {
      // Atomic reads admit the concurrent decision before both witnesses,
      // leaving no gap in which only one of them can be stale.
      await resolveDuringFence();
      return f.db.batch(statements);
    },
  } as D1Database;
  const snapshot = await readPublicIntegrityNotices(raced, PROBLEM);
  expect(snapshot.face.notices).toHaveLength(1);
  armed = true;
  await expect(snapshot.assertCurrent()).rejects.toThrow("CHANGED");
  expect(changes).toBe(1);
  expect((await readPublicIntegrityNotices(f.db, PROBLEM)).face.notices).toEqual([]);
});

test("problem corrections retain the captured formulation instead of drifting to a later revision", async () => {
  const f = await setup();
  const opened = await openIntegrityCase(
    f.db,
    INTEGRITY_OPERATOR,
    openRequest(f.reportId),
    "problem-open",
  );
  const corrected = await f.publishProblem(2);
  await resolveIntegrityCase(
    f.db,
    INTEGRITY_OPERATOR,
    {
      ...resolveRequest(opened.case_id, 1),
      correction_refs: [{ problem_id: PROBLEM, target_ref: "problem" }],
    },
    "problem-correction",
  );
  await f.publishProblem(3);
  const detail = await readIntegrityCase(
    f.db,
    { case_id: opened.case_id, after_revision: 0, limit: 20 },
    SPONSOR,
  );
  expect(detail.case.corrections).toEqual([
    {
      problem_id: PROBLEM,
      target_ref: "problem",
      event_id: corrected.eventId,
      payload_sha256: corrected.payloadSha256,
      seq: corrected.seq,
    },
  ]);
  const notice = await readPublicIntegrityNotices(f.db, PROBLEM);
  expect(notice.face.notices[0]!.corrections).toEqual(detail.case.corrections);
  await notice.assertCurrent();
  f.visible(`#${corrected.seq}`, "hidden");
  await expect(notice.assertCurrent()).rejects.toThrow("CHANGED");
  const hidden = await readPublicIntegrityNotices(f.db, PROBLEM);
  expect(hidden.face.notices).toHaveLength(1);
  expect(hidden.face.notices[0]!.corrections).toEqual([]);
});
