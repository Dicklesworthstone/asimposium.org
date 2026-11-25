import { Database } from "bun:sqlite";
import { describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { D1Database } from "@cloudflare/workers-types";
import { inboxNoticeStatement } from "../../src/inbox/notice-write.ts";
import {
  clearPosture,
  POSTURE_WINDOW_MS,
  PostureClearanceRefusedError,
  postureOf,
  recordRefusal,
  sponsorOwnsFellow,
} from "../../src/moderation/posture.ts";
import { decideScreeningCase } from "../../src/moderation/store.ts";

// Unit-level SQL proof, using the shipped tables and triggers. The genuine
// Workerd/D1 journey also exercises this path in moderation-real-bindings.mjs.
function fixture() {
  const sql = new Database(":memory:", { strict: true });
  sql.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE enrollment_fellows(fellow_id TEXT PRIMARY KEY, sponsor_id TEXT NOT NULL);
    CREATE TABLE problems(id TEXT PRIMARY KEY, status TEXT, unlisted INTEGER, public_seq INTEGER);
    INSERT INTO enrollment_fellows VALUES ('author', 'sponsor'), ('other', 'other-sponsor');
    INSERT INTO problems VALUES ('P-NOTICE', 'active', 0, 1);`);
  for (const name of [
    "0064_inbox_and_follows.sql",
    "0091_moderation_plane.sql",
    "0092_screening_posture.sql",
  ]) {
    sql.exec(readFileSync(new URL(`../../../../db/migrations/${name}`, import.meta.url), "utf8"));
  }
  sql
    .query(`INSERT INTO screening_cases
      (case_id, problem_id, fellow_id, sponsor_id, route, input_digest, context_digest,
       candidate_json, coarse_category, outcome, decision_path, provider_status,
       model_version, policy_version, configuration_digest, state, created_at)
      VALUES ('QC-notice', 'P-NOTICE', 'author', 'sponsor', 'promote', ?, ?, ?,
        'injection', 'quarantine', 'model', 'ok', 'model-v1', 'policy-v1', ?, 'pending', ?)`)
    .run(
      "a".repeat(64),
      "b".repeat(64),
      JSON.stringify({ statement: "Private held candidate bytes" }),
      "c".repeat(64),
      "2026-10-01T00:00:00.000Z",
    );

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
  return {
    db,
    sql,
    count(
      table: "operator_audit" | "moderation_log" | "fellow_inbox_notices" | "screening_refusals",
    ) {
      return (sql.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    },
    state() {
      return (sql.query("SELECT state FROM screening_cases").get() as { state: string }).state;
    },
  };
}

const decision = {
  caseId: "QC-notice",
  decision: "release" as const,
  reason: "Operator-only review rationale.",
};

describe("moderation decisions deliver their outcome atomically", () => {
  test("notice failure rolls the decision, audit and public log back; retry delivers once", async () => {
    const f = fixture();
    try {
      f.sql.exec(`CREATE TRIGGER fail_notice BEFORE INSERT ON fellow_inbox_notices
        BEGIN SELECT RAISE(ABORT, 'planted notice failure'); END;`);
      await expect(decideScreeningCase(f.db, "operator", decision)).rejects.toThrow(
        "planted notice failure",
      );
      expect(f.state()).toBe("pending");
      expect(f.count("operator_audit")).toBe(0);
      expect(f.count("moderation_log")).toBe(0);
      expect(f.count("fellow_inbox_notices")).toBe(0);

      f.sql.exec("DROP TRIGGER fail_notice");
      const receipt = await decideScreeningCase(f.db, "operator", decision);
      expect(receipt.ok).toBe(true);
      expect(f.state()).toBe("released");
      expect(f.count("operator_audit")).toBe(1);
      expect(f.count("moderation_log")).toBe(1);
      expect(f.count("fellow_inbox_notices")).toBe(1);
      const notice = f.sql.query("SELECT * FROM fellow_inbox_notices").get() as {
        fellow_id: string;
        seq: number;
        caused_by_event_id: string;
        detail: string;
      };
      expect(notice.fellow_id).toBe("author");
      expect(notice.seq).toBe(1);
      if (receipt.ok) expect(notice.caused_by_event_id).toBe(receipt.auditEventId);
      expect(notice.detail).toContain("Resubmit the identical request");
      expect(JSON.stringify(notice)).not.toContain("Private held candidate bytes");
      expect(JSON.stringify(notice)).not.toContain(decision.reason);
    } finally {
      f.sql.close();
    }
  });

  test("same operator and millisecond cannot double-audit or double-notify a losing decision", async () => {
    const f = fixture();
    setSystemTime(new Date("2026-10-25T12:00:00.000Z"));
    try {
      const results = await Promise.all(
        Array.from({ length: 24 }, () => decideScreeningCase(f.db, "operator", decision)),
      );
      expect(results.filter((result) => result.ok).length).toBe(1);
      expect(results.filter((result) => !result.ok && result.reason === "not-pending").length).toBe(
        23,
      );
      expect(f.count("operator_audit")).toBe(1);
      expect(f.count("moderation_log")).toBe(1);
      expect(f.count("fellow_inbox_notices")).toBe(1);
    } finally {
      setSystemTime();
      f.sql.close();
    }
  });

  test("a confirmed rejection commits one coarse private notice and no candidate bytes", async () => {
    const f = fixture();
    try {
      const receipt = await decideScreeningCase(f.db, "operator", {
        ...decision,
        decision: "confirm_rejection",
      });
      expect(receipt.ok).toBe(true);
      expect(f.state()).toBe("rejected");
      const notice = f.sql.query("SELECT detail FROM fellow_inbox_notices").get() as {
        detail: string;
      };
      expect(notice.detail).toContain("SPONSOR_APPEAL_AVAILABLE");
      expect(notice.detail).not.toContain("Private held candidate bytes");
      expect(notice.detail).not.toContain(decision.reason);
      expect(await decideScreeningCase(f.db, "operator", decision)).toEqual({
        ok: false,
        reason: "not-pending",
      });
      expect(f.count("fellow_inbox_notices")).toBe(1);
    } finally {
      f.sql.close();
    }
  });

  test("an absent case cannot produce an audit, log or notice", async () => {
    const f = fixture();
    try {
      expect(
        await decideScreeningCase(f.db, "operator", { ...decision, caseId: "QC-absent" }),
      ).toEqual({ ok: false, reason: "not-found" });
      expect(f.count("operator_audit")).toBe(0);
      expect(f.count("moderation_log")).toBe(0);
      expect(f.count("fellow_inbox_notices")).toBe(0);
    } finally {
      f.sql.close();
    }
  });

  test("guarded notice inserts retain causal dedupe and never consume a cursor for a missing cause", async () => {
    const f = fixture();
    try {
      const input = {
        fellowId: "author",
        problemId: "P-NOTICE",
        noticeType: "moderation_outcome" as const,
        title: "Original notice",
        causedByEventId: "OA-cause",
      };
      const refused = await inboxNoticeStatement(f.db, input, {
        sql: "EXISTS (SELECT 1 FROM operator_audit WHERE event_id = ?)",
        bindings: ["OA-missing"],
      });
      await f.db.batch([refused]);
      expect(f.count("fellow_inbox_notices")).toBe(0);
      await f.db.batch([await inboxNoticeStatement(f.db, input)]);
      await f.db.batch([
        await inboxNoticeStatement(f.db, { ...input, title: "Replacement template" }),
      ]);
      expect(f.count("fellow_inbox_notices")).toBe(1);
      expect(f.sql.query("SELECT seq, title FROM fellow_inbox_notices").get()).toEqual({
        seq: 1,
        title: "Original notice",
      });
    } finally {
      f.sql.close();
    }
  });
});

const refusal = (n: number) => ({
  fellowId: "author",
  sponsorId: "sponsor",
  problemId: "P-NOTICE",
  outcome: "reject" as const,
  coarseCategory: "injection",
  inputDigest: n.toString(16).padStart(64, "0"),
});

// Immutable historical rows produced before refusal deduplication crossed outcomes.
function legacyRefusal(
  f: ReturnType<typeof fixture>,
  id: string,
  n: number,
  outcome: "reject" | "quarantine",
  createdAt: string,
) {
  f.sql
    .query(`INSERT INTO screening_refusals
      (refusal_id, fellow_id, sponsor_id, problem_id, outcome, coarse_category,
       input_digest, created_at) VALUES (?, 'author', 'sponsor', 'P-NOTICE', ?, 'injection', ?, ?)`)
    .run(id, outcome, refusal(n).inputDigest, createdAt);
}

describe("screening posture changes deliver their notice atomically", () => {
  test("a failed transition notice rolls back its triggering refusal, then retries once", async () => {
    const f = fixture();
    try {
      await recordRefusal(f.db, refusal(1));
      await recordRefusal(f.db, refusal(2));
      f.sql.exec(`CREATE TRIGGER fail_posture_notice BEFORE INSERT ON fellow_inbox_notices
        BEGIN SELECT RAISE(ABORT, 'planted posture notice failure'); END;`);
      await expect(recordRefusal(f.db, refusal(3))).rejects.toThrow(
        "planted posture notice failure",
      );
      expect(f.count("screening_refusals")).toBe(2);
      expect(f.count("fellow_inbox_notices")).toBe(0);
      expect((await postureOf(f.db, "author")).quarantineFirst).toBe(false);

      f.sql.exec("DROP TRIGGER fail_posture_notice");
      await recordRefusal(f.db, refusal(3));
      await recordRefusal(f.db, refusal(3));
      expect(f.count("screening_refusals")).toBe(3);
      expect(f.count("fellow_inbox_notices")).toBe(1);
      expect((await postureOf(f.db, "author")).quarantineFirst).toBe(true);
      const notice = f.sql.query("SELECT * FROM fellow_inbox_notices").get() as {
        seq: number;
        fellow_id: string;
        caused_by_event_id: string;
        title: string;
        detail: string;
      };
      expect(notice.seq).toBe(1);
      expect(notice.fellow_id).toBe("author");
      expect(notice.title).toBe("Your public writes now wait for review");
      expect(notice.detail).not.toContain(refusal(3).coarseCategory);
      expect(notice.detail).not.toContain(refusal(3).inputDigest);
      expect(
        f.sql
          .query("SELECT input_digest FROM screening_refusals WHERE refusal_id = ?")
          .get(notice.caused_by_event_id),
      ).toEqual({ input_digest: refusal(3).inputDigest });
    } finally {
      f.sql.close();
    }
  });

  test("concurrent distinct refusals cross the threshold once without recording more verdicts", async () => {
    const f = fixture();
    setSystemTime(new Date("2026-10-25T12:00:00.000Z"));
    try {
      await Promise.all(Array.from({ length: 24 }, (_, n) => recordRefusal(f.db, refusal(n))));
      expect(f.count("screening_refusals")).toBe(3);
      expect(f.count("fellow_inbox_notices")).toBe(1);
      expect(await postureOf(f.db, "author")).toEqual({
        quarantineFirst: true,
        refusalsInWindow: 3,
        since: "2026-10-25T12:00:00.000Z",
      });
      await recordRefusal(f.db, refusal(100));
      expect(f.count("screening_refusals")).toBe(3);
      expect(f.count("fellow_inbox_notices")).toBe(1);
    } finally {
      setSystemTime();
      f.sql.close();
    }
  });

  test("duplicate bytes count once under concurrency and provider outages never count", async () => {
    const f = fixture();
    try {
      await Promise.all(Array.from({ length: 12 }, () => recordRefusal(f.db, refusal(1))));
      await Promise.all(
        [2, 3, 4].map((n) =>
          recordRefusal(f.db, { ...refusal(n), coarseCategory: "provider-unavailable" }),
        ),
      );
      expect(f.count("screening_refusals")).toBe(1);
      expect(f.count("fellow_inbox_notices")).toBe(0);
      expect((await postureOf(f.db, "author")).quarantineFirst).toBe(false);
      expect((await postureOf(f.db, "other")).refusalsInWindow).toBe(0);
    } finally {
      f.sql.close();
    }
  });

  test("concurrent outcomes for the same bytes consume one refusal per distinct envelope", async () => {
    const f = fixture();
    try {
      await Promise.all(
        Array.from({ length: 24 }, (_, n) =>
          recordRefusal(f.db, {
            ...refusal((n % 2) + 1),
            outcome: n % 4 < 2 ? "quarantine" : "reject",
          }),
        ),
      );
      expect(f.count("screening_refusals")).toBe(2);
      expect(f.count("fellow_inbox_notices")).toBe(0);
      expect(await postureOf(f.db, "author")).toMatchObject({
        quarantineFirst: false,
        refusalsInWindow: 2,
      });
      await Promise.all(
        Array.from({ length: 8 }, (_, n) =>
          recordRefusal(f.db, { ...refusal(3), outcome: n % 2 === 0 ? "reject" : "quarantine" }),
        ),
      );
      expect(f.count("screening_refusals")).toBe(3);
      expect(f.count("fellow_inbox_notices")).toBe(1);
      expect(await postureOf(f.db, "author")).toMatchObject({
        quarantineFirst: true,
        refusalsInWindow: 3,
      });
    } finally {
      f.sql.close();
    }
  });

  test("historical outcome duplicates remain auditable but cannot manufacture a posture", async () => {
    const f = fixture();
    setSystemTime(new Date("2026-10-25T12:00:00.000Z"));
    try {
      legacyRefusal(f, "SR-legacy-held", 1, "quarantine", "2026-10-25T11:00:00.000Z");
      legacyRefusal(f, "SR-legacy-denied", 1, "reject", "2026-10-25T11:00:00.001Z");
      legacyRefusal(f, "SR-legacy-other", 2, "quarantine", "2026-10-25T11:00:00.002Z");
      expect(f.count("screening_refusals")).toBe(3);
      expect(await postureOf(f.db, "author")).toEqual({
        quarantineFirst: false,
        refusalsInWindow: 2,
        since: "2026-10-25T11:00:00.000Z",
      });
      await recordRefusal(f.db, refusal(2));
      expect(f.count("screening_refusals")).toBe(3);
      expect(f.count("fellow_inbox_notices")).toBe(0);
      await recordRefusal(f.db, refusal(3));
      expect(f.count("screening_refusals")).toBe(4);
      expect(f.count("fellow_inbox_notices")).toBe(1);
      expect(await postureOf(f.db, "author")).toEqual({
        quarantineFirst: true,
        refusalsInWindow: 3,
        since: "2026-10-25T11:00:00.000Z",
      });
    } finally {
      setSystemTime();
      f.sql.close();
    }
  });

  test("a changed outcome cannot revive bytes first refused before clearance", async () => {
    const f = fixture();
    setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
    try {
      for (const n of [1, 2, 3])
        await recordRefusal(f.db, { ...refusal(n), outcome: "quarantine" });
      const clearance = await clearPosture(f.db, {
        fellowId: "author",
        clearedByClass: "sponsor",
        clearedBy: "sponsor",
        reason: "Reviewed the held writes and corrected the task.",
      });
      setSystemTime(new Date(Date.parse(clearance.clearedAt) + 1));
      await recordRefusal(f.db, refusal(1));
      expect(f.count("screening_refusals")).toBe(3);
      expect((await postureOf(f.db, "author")).refusalsInWindow).toBe(0);
      // A retained legacy duplicate after the clearance must also stay excluded:
      // first occurrence is derived before the clearance filter is applied.
      legacyRefusal(f, "SR-legacy-after-clearance", 1, "reject", new Date().toISOString());
      expect(f.count("screening_refusals")).toBe(4);
      expect(await postureOf(f.db, "author")).toEqual({
        quarantineFirst: false,
        refusalsInWindow: 0,
        since: null,
      });
      for (const n of [4, 5]) await recordRefusal(f.db, refusal(n));
      expect((await postureOf(f.db, "author")).quarantineFirst).toBe(false);
      await recordRefusal(f.db, refusal(6));
      expect((await postureOf(f.db, "author")).quarantineFirst).toBe(true);
      expect(f.count("fellow_inbox_notices")).toBe(2);
    } finally {
      setSystemTime();
      f.sql.close();
    }
  });

  test("a changed outcome cannot restart the rolling window for previously refused bytes", async () => {
    const f = fixture();
    const startedAt = Date.parse("2026-10-01T00:00:00.000Z");
    setSystemTime(new Date(startedAt));
    try {
      await recordRefusal(f.db, { ...refusal(1), outcome: "quarantine" });
      setSystemTime(new Date(startedAt + POSTURE_WINDOW_MS + 1));
      await recordRefusal(f.db, refusal(1));
      expect(f.count("screening_refusals")).toBe(1);
      legacyRefusal(f, "SR-legacy-after-window", 1, "reject", new Date().toISOString());
      expect(await postureOf(f.db, "author")).toEqual({
        quarantineFirst: false,
        refusalsInWindow: 0,
        since: null,
      });
      for (const n of [2, 3]) await recordRefusal(f.db, refusal(n));
      expect((await postureOf(f.db, "author")).quarantineFirst).toBe(false);
      expect(f.count("fellow_inbox_notices")).toBe(0);
      await recordRefusal(f.db, refusal(4));
      expect((await postureOf(f.db, "author")).quarantineFirst).toBe(true);
      expect(f.count("fellow_inbox_notices")).toBe(1);
    } finally {
      setSystemTime();
      f.sql.close();
    }
  });

  test("only explicit clearance permits another transition, even after refusals age out", async () => {
    const f = fixture();
    setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
    try {
      for (const n of [1, 2, 3]) await recordRefusal(f.db, refusal(n));
      const clearance = await clearPosture(f.db, {
        fellowId: "author",
        clearedByClass: "sponsor",
        clearedBy: "sponsor",
        reason: "Reviewed the refused writes and corrected the task.",
      });
      setSystemTime(new Date(Date.parse(clearance.clearedAt) + 1));
      await recordRefusal(f.db, refusal(1));
      expect((await postureOf(f.db, "author")).refusalsInWindow).toBe(0);
      for (const n of [4, 5, 6]) await recordRefusal(f.db, refusal(n));
      expect((await postureOf(f.db, "author")).quarantineFirst).toBe(true);
      expect(f.count("fellow_inbox_notices")).toBe(2);

      setSystemTime(new Date("2026-10-09T00:00:00.000Z"));
      expect(await postureOf(f.db, "author")).toEqual({
        quarantineFirst: true,
        refusalsInWindow: 0,
        since: new Date(Date.parse(clearance.clearedAt) + 1).toISOString(),
      });
      for (const n of [7, 8, 9]) await recordRefusal(f.db, refusal(n));
      expect(f.count("screening_refusals")).toBe(6);
      expect(f.count("fellow_inbox_notices")).toBe(2);
      const secondClearance = await clearPosture(f.db, {
        fellowId: "author",
        clearedByClass: "sponsor",
        clearedBy: "sponsor",
        reason: "Reviewed the held work after the refusal window elapsed.",
      });
      expect((await postureOf(f.db, "author")).quarantineFirst).toBe(false);
      setSystemTime(new Date(Date.parse(secondClearance.clearedAt) + 1));
      for (const n of [7, 8, 9]) await recordRefusal(f.db, refusal(n));
      expect((await postureOf(f.db, "author")).quarantineFirst).toBe(true);
      expect(f.count("screening_refusals")).toBe(9);
      const notices = f.sql
        .query("SELECT seq, caused_by_event_id FROM fellow_inbox_notices ORDER BY seq")
        .all() as { seq: number; caused_by_event_id: string }[];
      expect(notices.map((notice) => notice.seq)).toEqual([1, 2, 3]);
      expect(new Set(notices.map((notice) => notice.caused_by_event_id)).size).toBe(3);
    } finally {
      setSystemTime();
      f.sql.close();
    }
  });

  test("sparse historical refusals do not quarantine until a rolling-window cluster forms", async () => {
    const f = fixture();
    try {
      for (const [index, day] of [1, 9, 17, 18].entries()) {
        setSystemTime(new Date(`2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`));
        await recordRefusal(f.db, refusal(index + 1));
        expect((await postureOf(f.db, "author")).quarantineFirst).toBe(false);
      }
      expect(f.count("fellow_inbox_notices")).toBe(0);
      expect((await postureOf(f.db, "author")).refusalsInWindow).toBe(2);
      setSystemTime(new Date("2026-10-20T00:00:00.000Z"));
      await recordRefusal(f.db, refusal(5));
      expect(await postureOf(f.db, "author")).toEqual({
        quarantineFirst: true,
        refusalsInWindow: 3,
        since: "2026-10-17T00:00:00.000Z",
      });
      expect(f.count("fellow_inbox_notices")).toBe(1);
    } finally {
      setSystemTime();
      f.sql.close();
    }
  });

  test("the engagement window excludes an exactly seven-day-old refusal", async () => {
    const f = fixture();
    const start = Date.parse("2026-10-01T00:00:00.123Z");
    try {
      for (const [index, elapsed] of [0, POSTURE_WINDOW_MS / 2, POSTURE_WINDOW_MS].entries()) {
        setSystemTime(new Date(start + elapsed));
        await recordRefusal(f.db, refusal(index + 1));
      }
      expect(await postureOf(f.db, "author")).toEqual({
        quarantineFirst: false,
        refusalsInWindow: 2,
        since: new Date(start + POSTURE_WINDOW_MS / 2).toISOString(),
      });
      expect(f.count("fellow_inbox_notices")).toBe(0);
      setSystemTime(new Date(start + POSTURE_WINDOW_MS + 1));
      await recordRefusal(f.db, refusal(4));
      expect((await postureOf(f.db, "author")).quarantineFirst).toBe(true);
      setSystemTime(new Date(start + 4 * POSTURE_WINDOW_MS));
      expect(await postureOf(f.db, "author")).toEqual({
        quarantineFirst: true,
        refusalsInWindow: 0,
        since: new Date(start + POSTURE_WINDOW_MS / 2).toISOString(),
      });
      expect(f.count("fellow_inbox_notices")).toBe(1);
    } finally {
      setSystemTime();
      f.sql.close();
    }
  });

  test("a former sponsor cannot clear a posture after ownership changed past preflight", async () => {
    const f = fixture();
    try {
      for (const n of [1, 2, 3]) await recordRefusal(f.db, refusal(n));
      expect(await sponsorOwnsFellow(f.db, "sponsor", "author")).toBe(true);
      expect((await postureOf(f.db, "author")).quarantineFirst).toBe(true);
      f.sql
        .query("UPDATE enrollment_fellows SET sponsor_id = ? WHERE fellow_id = ?")
        .run("receiving-sponsor", "author");
      await expect(
        clearPosture(f.db, {
          fellowId: "author",
          clearedByClass: "sponsor",
          clearedBy: "sponsor",
          reason: "Reviewed the refused writes before the transfer.",
        }),
      ).rejects.toBeInstanceOf(PostureClearanceRefusedError);
      expect(f.sql.query("SELECT COUNT(*) AS n FROM screening_posture_clearances").get()).toEqual({
        n: 0,
      });
      expect((await postureOf(f.db, "author")).quarantineFirst).toBe(true);
      await clearPosture(f.db, {
        fellowId: "author",
        clearedByClass: "sponsor",
        clearedBy: "receiving-sponsor",
        reason: "The current sponsor reviewed and corrected the task.",
      });
      expect((await postureOf(f.db, "author")).quarantineFirst).toBe(false);
    } finally {
      f.sql.close();
    }
  });

  test("concurrent clearances elect one intervention and never reset an inactive posture", async () => {
    const f = fixture();
    try {
      for (const n of [1, 2, 3]) await recordRefusal(f.db, refusal(n));
      const results = await Promise.allSettled(
        Array.from({ length: 16 }, () =>
          clearPosture(f.db, {
            fellowId: "author",
            clearedByClass: "sponsor",
            clearedBy: "sponsor",
            reason: "Reviewed the held work with the Fellow.",
          }),
        ),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      for (const result of results) {
        if (result.status === "rejected")
          expect(result.reason).toBeInstanceOf(PostureClearanceRefusedError);
      }
      expect(f.sql.query("SELECT COUNT(*) AS n FROM screening_posture_clearances").get()).toEqual({
        n: 1,
      });
      expect((await postureOf(f.db, "author")).quarantineFirst).toBe(false);
      await expect(
        clearPosture(f.db, {
          fellowId: "author",
          clearedByClass: "operator",
          clearedBy: "operator",
          reason: "An inactive posture has nothing to clear.",
        }),
      ).rejects.toBeInstanceOf(PostureClearanceRefusedError);
    } finally {
      f.sql.close();
    }
  });
});
