import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ProblemDocumentSchema, SponsorReportsResponseSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../../src/env.ts";
import {
  createSponsorReportsRouter,
  SPONSOR_REPORTS_ROUTE,
} from "../../src/moderation/sponsor-reports.ts";
import { sponsorMutationRefusal } from "../../src/moderation/sponsor-suspension.ts";

const NOW = "2026-11-22T12:00:00.000Z";
const reportId = (id: number) => `RP-${String(id).padStart(26, "0")}`;

/** SQLite selection and modeled verification are unit evidence, not native e2e. */
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE sponsors(sponsor_id TEXT PRIMARY KEY, tombstoned_at TEXT);
    CREATE TABLE reports(report_id TEXT PRIMARY KEY, problem_id TEXT, target_ref TEXT, source_ref TEXT,
      reason TEXT, reporter_class TEXT, reporter_sponsor_id TEXT, status TEXT,
      created_at TEXT, resolved_at TEXT, note TEXT, resolved_by TEXT, resolution_reason TEXT);
    CREATE INDEX reports_sponsor_history_idx ON reports(reporter_sponsor_id,created_at DESC,report_id DESC);
    INSERT INTO sponsors VALUES('usr_owner',NULL),('usr_other',NULL),('usr_empty',NULL);`);
  let reads = 0;
  let afterSnapshot: (() => void) | undefined;
  let failureAt: number | undefined;
  const db = {
    prepare(query: string) {
      let bindings: (string | number | null)[] = [];
      return {
        bind(...values: (string | number | null)[]) {
          bindings = values;
          return this;
        },
        async first() {
          reads++;
          if (reads === failureAt) throw new Error("PRIVATE_SQL_ERROR");
          const row = sql.query(query).get(...bindings);
          const callback = afterSnapshot;
          afterSnapshot = undefined;
          callback?.();
          return row ?? null;
        },
      };
    },
  } as unknown as D1Database;
  const app = createSponsorReportsRouter({
    db,
    verifiedSponsor: async (request, route, action) => {
      expect(route).toBe(SPONSOR_REPORTS_ROUTE);
      expect(action).toBe("sponsor.reports.list");
      if (request.headers.get("x-test-sponsor") === "deny")
        return new Response(null, { status: 403 });
      return {
        principal: {
          type: "sponsor",
          sponsorId: request.headers.get("x-test-sponsor") ?? "usr_owner",
        },
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
    afterSnapshot(callback: () => void) {
      afterSnapshot = callback;
    },
    failAt(read: number) {
      failureAt = read;
    },
    report(id: number, sponsor = "usr_owner", status = "pending", createdAt = NOW) {
      sql
        .query(
          "INSERT INTO reports VALUES(?, 'P-REPORTS', ?, ?, 'privacy', ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          reportId(id),
          `C-${id}`,
          `C-${id}@2`,
          id % 2 === 0 ? "fellow" : "sponsor",
          sponsor,
          status,
          createdAt,
          status === "pending" ? null : NOW,
          "PRIVATE_REPORT_NOTE",
          "PRIVATE_OPERATOR_ID",
          "PRIVATE_DECISION_PROSE",
        );
    },
    request(body = "{}", sponsor = "usr_owner", query = "", contentType = "application/json") {
      return app.request(
        `https://a.asimposium.org${SPONSOR_REPORTS_ROUTE}${query}`,
        {
          method: "POST",
          headers: { "x-test-sponsor": sponsor, "content-type": contentType },
          body,
        },
        {} as Env,
      );
    },
  };
}

test("private history pages both human and Fellow reports by immutable filing cursor", async () => {
  const f = fixture();
  try {
    f.report(1);
    f.report(2, "usr_owner", "dismissed");
    f.report(3, "usr_owner", "upheld");
    f.report(9, "usr_other");
    f.sql.query("UPDATE reports SET source_ref = NULL WHERE report_id = ?").run(reportId(1));
    const initial = f.sql.query("SELECT * FROM reports ORDER BY report_id").all();
    const response = await f.request('{"limit":2}');
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const text = await response.text();
    expect(text).not.toContain("PRIVATE_");
    expect(text).not.toContain(reportId(9));
    const first = SponsorReportsResponseSchema.parse(JSON.parse(text));
    expect(first.reports.map((r) => [r.report_id, r.status, r.reporter_class])).toEqual([
      [reportId(3), "upheld", "sponsor"],
      [reportId(2), "dismissed", "fellow"],
    ]);
    expect(first.has_more).toBe(true);
    expect(first.reports.map((report) => report.target)).toEqual(["C-3@2", "C-2@2"]);
    f.report(4, "usr_owner", "pending", "2026-11-22T13:00:00.000Z");
    const next = SponsorReportsResponseSchema.parse(
      await (await f.request(JSON.stringify({ limit: 2, before: first.next_cursor }))).json(),
    );
    expect(next.reports.map((r) => r.report_id)).toEqual([reportId(1)]);
    expect(next.reports[0]?.target).toBe("C-1");
    expect(next.has_more).toBe(false);
    expect(next.next_cursor).toBe(null);
    expect(
      f.sql.query("SELECT * FROM reports WHERE report_id <> ? ORDER BY report_id").all(reportId(4)),
    ).toEqual(initial);
    const empty = SponsorReportsResponseSchema.parse(
      await (await f.request("{}", "usr_empty")).json(),
    );
    expect(empty.reports).toEqual([]);
    expect(empty.next_cursor).toBe(null);
  } finally {
    f.sql.close();
  }
});

test("malformed or unbound inputs and rejected signatures never read private history", async () => {
  const f = fixture();
  try {
    for (const [body, query, contentType] of [
      ['{"sponsor_id":"usr_other"}', "", "application/json"],
      ['{"limit":51}', "", "application/json"],
      ['{"limit":2} trailing', "", "application/json"],
      ["{}", "?limit=1", "application/json"],
      ["{}", "", "text/plain"],
      [" ".repeat(2049), "", "application/json"],
    ]) {
      const response = await f.request(body, "usr_owner", query, contentType);
      expect(response.status).toBe(422);
      expect(ProblemDocumentSchema.parse(await response.json()).code).toBe("SCHEMA_INVALID");
    }
    expect((await f.request("{}", "deny")).status).toBe(403);
    expect(f.reads).toBe(0);
  } finally {
    f.sql.close();
  }
});

test("missing or deleted accounts stay opaque, including deletion during readback", async () => {
  const f = fixture();
  try {
    f.report(1);
    const missing = await f.request("{}", "usr_missing");
    expect(missing.status).toBe(404);
    const expected = ProblemDocumentSchema.parse(await missing.json());
    f.afterSnapshot(() =>
      f.sql.exec("UPDATE sponsors SET tombstoned_at='deleted' WHERE sponsor_id='usr_owner'"),
    );
    const deleted = await f.request();
    expect(deleted.status).toBe(404);
    expect(await deleted.json()).toEqual(expected);
    expect((await f.request()).status).toBe(404);
  } finally {
    f.sql.close();
  }
});

test("failed, corrupt or changed snapshots cannot masquerade as an empty or current page", async () => {
  for (const failure of ["first", "second", "corrupt", "changed"] as const) {
    const f = fixture();
    try {
      f.report(1);
      if (failure === "first") f.failAt(1);
      if (failure === "second") f.failAt(2);
      if (failure === "corrupt") f.sql.exec("UPDATE reports SET reason='PRIVATE_BAD_REASON'");
      if (failure === "changed")
        f.afterSnapshot(() =>
          f.sql.exec(`UPDATE reports SET status='dismissed',resolved_at='${NOW}'`),
        );
      const response = await f.request();
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(text).not.toContain("PRIVATE_");
      expect(text).not.toContain(reportId(1));
      expect(ProblemDocumentSchema.parse(JSON.parse(text)).code).toBe("INTERNAL_ERROR");
    } finally {
      f.sql.close();
    }
  }
});

test("suspension does not prevent reading the sponsor's existing reports", async () => {
  const f = fixture();
  try {
    // The fixture deliberately has no suspension table: this read is exempt
    // from mutation authority, just like account status and screening appeals.
    expect(
      await sponsorMutationRefusal(f.db, "usr_owner", "POST", "sponsor.reports.list"),
    ).toBeUndefined();
    expect(f.reads).toBe(0);
  } finally {
    f.sql.close();
  }
});
