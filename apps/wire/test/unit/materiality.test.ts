import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import {
  CEREMONY_BREAKER_EVENT_THRESHOLD,
  checkCeremonyBreaker,
  checkIdleSession,
  checkSynthesisTrigger,
  HARD_AUTO_CLOSE_MS,
  IDLE_CLOSE_MOVE_QUIET_MS,
  isObjectLevelEvent,
  SYNTHESIS_EVENT_THRESHOLD,
} from "../../src/mega-commands/materiality.ts";

function createMockDb(sqlite: Database): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind: (...values: unknown[]) => ({
          first: async <T>() => (sqlite.query(sql).get(...(values as any[])) ?? null) as T | null,
          all: async <T>() => ({
            results: sqlite.query(sql).all(...(values as any[])) as T[],
          }),
        }),
      };
    },
  } as unknown as D1Database;
}

describe("Materiality and Ceremony Guard (Fable §9.6)", () => {
  describe("Event Classification", () => {
    test("object-level events are classed correctly", () => {
      // Claims
      expect(isObjectLevelEvent({ type: "claim.created" })).toBe(true);
      expect(isObjectLevelEvent({ type: "claim.revised" })).toBe(true);
      // Evidence & Reviews
      expect(isObjectLevelEvent({ type: "evidence.created" })).toBe(true);
      expect(isObjectLevelEvent({ type: "review.created" })).toBe(true);
      // Hypothesis kills
      expect(isObjectLevelEvent({ type: "hypothesis.killed" })).toBe(true);
      // Problem admission
      expect(isObjectLevelEvent({ type: "problem.admitted" })).toBe(true);
    });

    test("dead_end.recorded is object-level unless tagged low-substance-dead-end", () => {
      // Substantive dead-end is object-level
      expect(isObjectLevelEvent({ type: "dead_end.recorded" })).toBe(true);
      expect(
        isObjectLevelEvent({
          type: "dead_end.recorded",
          extract: "Explored modular arithmetic obstruction",
        }),
      ).toBe(true);

      // Thin / non-substantive dead-end flagged by screening is process-level
      expect(
        isObjectLevelEvent({
          type: "dead_end.recorded",
          extract: "low-substance-dead-end: empty exploration",
        }),
      ).toBe(false);
    });

    test("statement work is object-level ONLY during sharpening", () => {
      // During sharpening, statement work IS object-level
      expect(
        isObjectLevelEvent({
          type: "problem.statement-reviewed",
          problem_status: "sharpening",
        }),
      ).toBe(true);
      expect(
        isObjectLevelEvent({
          type: "problem.statement-revised",
          problem_status: "sharpening",
        }),
      ).toBe(true);
      expect(
        isObjectLevelEvent({
          type: "problem.statement-updated",
          problem_status: "sharpening",
        }),
      ).toBe(true);

      // After active, statement revisions are process-level
      expect(
        isObjectLevelEvent({
          type: "problem.statement-reviewed",
          problem_status: "active",
        }),
      ).toBe(false);
      expect(
        isObjectLevelEvent({
          type: "problem.statement-revised",
          problem_status: "active",
        }),
      ).toBe(false);
      expect(
        isObjectLevelEvent({
          type: "problem.statement-reviewed",
          problem_status: "dormant",
        }),
      ).toBe(false);
    });

    test("process-level events do not rank as material science", () => {
      expect(isObjectLevelEvent({ type: "synthesis.published" })).toBe(false);
      expect(isObjectLevelEvent({ type: "object.retracted" })).toBe(false);
      expect(isObjectLevelEvent({ type: "directive.sent" })).toBe(false);
      expect(isObjectLevelEvent({ type: "problem_membership.assigned" })).toBe(false);
      expect(isObjectLevelEvent({ type: "problem_membership.updated" })).toBe(false);
      expect(isObjectLevelEvent({ type: "session.opened" })).toBe(false);
      expect(isObjectLevelEvent({ type: "session.closed" })).toBe(false);
      expect(isObjectLevelEvent({ type: "session.heartbeat" })).toBe(false);
    });
  });

  describe("Ceremony Breaker (back-to-the-object)", () => {
    test("threshold constants match specification", () => {
      expect(CEREMONY_BREAKER_EVENT_THRESHOLD).toBe(25);
      expect(SYNTHESIS_EVENT_THRESHOLD).toBe(200);
      expect(IDLE_CLOSE_MOVE_QUIET_MS).toBe(3 * 3600 * 1000);
      expect(HARD_AUTO_CLOSE_MS).toBe(12 * 3600 * 1000);
      expect(IDLE_CLOSE_MOVE_QUIET_MS).toBeLessThan(HARD_AUTO_CLOSE_MS);
    });

    test("does not trigger when fewer than 25 events exist", async () => {
      const sqlite = new Database(":memory:");
      sqlite.exec(`
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          problem_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          type TEXT NOT NULL,
          object_kind TEXT,
          object_id TEXT,
          object_version INTEGER,
          extract TEXT
        );
        CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_json TEXT);
        CREATE TABLE reviews (problem_id TEXT, target_claim_id TEXT, target_version INTEGER);
        CREATE TABLE evidence (problem_id TEXT, bears_on_kind TEXT, bears_on_id TEXT, bears_on_version INTEGER, direction TEXT);
        CREATE TABLE proof_gaps (gap_id TEXT PRIMARY KEY, problem_id TEXT, statement TEXT, status TEXT, created_at TEXT);
      `);

      // 10 process events
      for (let i = 1; i <= 10; i++) {
        sqlite.run(
          "INSERT INTO events VALUES (?, 'P-TEST', ?, 'synthesis.published', 'synthesis', 'SYN-1', 1, NULL)",
          [`EV-${i}`, i],
        );
      }

      const db = createMockDb(sqlite);
      const result = await checkCeremonyBreaker(db, "P-TEST", 10, "active");
      expect(result.active).toBe(false);
      expect(result.totalEventsInWindow).toBe(10);
      sqlite.close();
    });

    test("does not trigger when window has at least 1 object-level event", async () => {
      const sqlite = new Database(":memory:");
      sqlite.exec(`
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          problem_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          type TEXT NOT NULL,
          object_kind TEXT,
          object_id TEXT,
          object_version INTEGER,
          extract TEXT
        );
        CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_json TEXT);
        CREATE TABLE reviews (problem_id TEXT, target_claim_id TEXT, target_version INTEGER);
        CREATE TABLE evidence (problem_id TEXT, bears_on_kind TEXT, bears_on_id TEXT, bears_on_version INTEGER, direction TEXT);
        CREATE TABLE proof_gaps (gap_id TEXT PRIMARY KEY, problem_id TEXT, statement TEXT, status TEXT, created_at TEXT);
      `);

      // 24 process events + 1 claim.created event
      for (let i = 1; i <= 24; i++) {
        sqlite.run(
          "INSERT INTO events VALUES (?, 'P-TEST', ?, 'synthesis.published', 'synthesis', 'SYN-1', 1, NULL)",
          [`EV-${i}`, i],
        );
      }
      sqlite.run(
        "INSERT INTO events VALUES ('EV-25', 'P-TEST', 25, 'claim.created', 'claim', 'C-1', 1, NULL)",
      );

      const db = createMockDb(sqlite);
      const result = await checkCeremonyBreaker(db, "P-TEST", 25, "active");
      expect(result.active).toBe(false);
      expect(result.objectEventCountInWindow).toBe(1);
      sqlite.close();
    });

    test("triggers when 25 events have zero object increments and names oldest unreviewed claim", async () => {
      const sqlite = new Database(":memory:");
      sqlite.exec(`
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          problem_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          type TEXT NOT NULL,
          object_kind TEXT,
          object_id TEXT,
          object_version INTEGER,
          extract TEXT
        );
        CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_json TEXT);
        CREATE TABLE reviews (problem_id TEXT, target_claim_id TEXT, target_version INTEGER);
        CREATE TABLE evidence (problem_id TEXT, bears_on_kind TEXT, bears_on_id TEXT, bears_on_version INTEGER, direction TEXT);
        CREATE TABLE proof_gaps (gap_id TEXT PRIMARY KEY, problem_id TEXT, statement TEXT, status TEXT, created_at TEXT);
      `);

      // Old claim at seq 1
      sqlite.run(
        "INSERT INTO events VALUES ('EV-CLAIM', 'P-TEST', 1, 'claim.created', 'claim', 'C-1', 1, NULL)",
      );
      sqlite.run(
        "INSERT INTO event_content VALUES ('EV-CLAIM', json_object('statement', 'A conjecture.'))",
      );

      // Followed by 25 process events (seq 2 to 26)
      for (let i = 2; i <= 26; i++) {
        sqlite.run(
          "INSERT INTO events VALUES (?, 'P-TEST', ?, 'synthesis.published', 'synthesis', 'SYN-1', 1, NULL)",
          [`EV-${i}`, i],
        );
      }

      const db = createMockDb(sqlite);
      const result = await checkCeremonyBreaker(db, "P-TEST", 26, "active");
      expect(result.active).toBe(true);
      expect(result.objectEventCountInWindow).toBe(0);
      expect(result.oldestNeed?.kind).toBe("unreviewed-claim");
      expect(result.oldestNeed?.ref).toBe("C-1@1");
      expect(result.oldestNeed?.description).toContain("Oldest unreviewed claim C-1@1");
      sqlite.close();
    });
  });

  describe("Synthesis Trigger (200+ events)", () => {
    test("fires when >= 200 events have elapsed since last synthesis", async () => {
      const sqlite = new Database(":memory:");
      sqlite.exec(`
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          problem_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          type TEXT NOT NULL
        );
      `);

      // Synthesis at seq 10
      sqlite.run("INSERT INTO events VALUES ('EV-SYN', 'P-TEST', 10, 'synthesis.published')");

      // 199 events since synthesis
      for (let i = 11; i <= 209; i++) {
        sqlite.run("INSERT INTO events VALUES (?, 'P-TEST', ?, 'claim.created')", [`EV-${i}`, i]);
      }

      const db = createMockDb(sqlite);
      const res199 = await checkSynthesisTrigger(db, "P-TEST", 209);
      expect(res199.needed).toBe(false);
      expect(res199.eventCountSinceLast).toBe(199);

      // 200th event
      sqlite.run("INSERT INTO events VALUES ('EV-210', 'P-TEST', 210, 'claim.created')");
      const res200 = await checkSynthesisTrigger(db, "P-TEST", 210);
      expect(res200.needed).toBe(true);
      expect(res200.eventCountSinceLast).toBe(200);

      sqlite.close();
    });
  });

  describe("Idle Session Close (3h quiet)", () => {
    test("detects open session quiet for 3+ hours", async () => {
      const sqlite = new Database(":memory:");
      sqlite.exec(`
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          problem_id TEXT NOT NULL,
          fellow_id TEXT NOT NULL,
          opened_at TEXT NOT NULL,
          last_heartbeat_at TEXT NOT NULL,
          closed_at TEXT
        );
      `);

      const now = 10_000_000_000;
      // 2.5 hours quiet: not yet idle
      const recentHeartbeat = new Date(now - 2.5 * 3600 * 1000).toISOString();
      sqlite.run(
        "INSERT INTO sessions VALUES ('S-1', 'P-TEST', 'F-FELLOW', '2026-09-01T00:00:00.000Z', ?, NULL)",
        [recentHeartbeat],
      );

      const db = createMockDb(sqlite);
      const resRecent = await checkIdleSession(db, "P-TEST", "F-FELLOW", now);
      expect(resRecent).toBeNull();

      // 3.5 hours quiet: triggers idle-close
      const quietHeartbeat = new Date(now - 3.5 * 3600 * 1000).toISOString();
      sqlite.run("UPDATE sessions SET last_heartbeat_at = ? WHERE session_id = 'S-1'", [
        quietHeartbeat,
      ]);

      const resIdle = await checkIdleSession(db, "P-TEST", "F-FELLOW", now);
      expect(resIdle).not.toBeNull();
      expect(resIdle?.sessionId).toBe("S-1");
      expect(resIdle?.quietMs).toBeGreaterThanOrEqual(3 * 3600 * 1000);

      // Closed session does not trigger
      sqlite.run(
        "UPDATE sessions SET closed_at = '2026-09-01T04:00:00.000Z' WHERE session_id = 'S-1'",
      );
      const resClosed = await checkIdleSession(db, "P-TEST", "F-FELLOW", now);
      expect(resClosed).toBeNull();

      sqlite.close();
    });
  });
});
