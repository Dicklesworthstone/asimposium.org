import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { getMoveTemplate, type NextMoveCandidate } from "@asimposium/contracts";
import type { ReviewQueueItem } from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import { selectLedgerMoves } from "../../src/mega-commands/ledger-moves.ts";
import {
  CEREMONY_BREAKER_EVENT_THRESHOLD,
  type CeremonyMoveContext,
  type CeremonyNeedReaders,
  checkCeremonyBreaker,
  checkIdleSession,
  checkSynthesisTrigger,
  HARD_AUTO_CLOSE_MS,
  IDLE_CLOSE_MOVE_QUIET_MS,
  isObjectLevelEvent,
  SYNTHESIS_EVENT_THRESHOLD,
} from "../../src/mega-commands/materiality.ts";
import { filterMovesByPermissions } from "../../src/mega-commands/move-permissions.ts";

function createMockDb(sqlite: Database): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind: (...values: (string | number | null)[]) => ({
          first: async <T>() => (sqlite.query(sql).get(...values) ?? null) as T | null,
          all: async <T>() => ({
            results: sqlite.query(sql).all(...values) as T[],
          }),
        }),
      };
    },
  } as unknown as D1Database;
}

const context: CeremonyMoveContext = {
  viewer: { fellowId: "F-reader", sponsorId: "usr-reader" },
  permissions: { session_open: true, review: true, promote: true, evidence: true },
  now: Date.parse("2026-10-01T00:00:00.000Z"),
};
function need(claim: string, day: number, patch: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    problem_id: "P-TEST",
    claim_id: claim,
    version: 2,
    cursor: 30,
    kind: "lemma",
    statement: "AUTHORED-CONTENT-IS-NOT-A-MOVE-INSTRUCTION",
    falsifier: null,
    disposition: "open",
    need: "independent-review",
    best_recorded_tier: "none",
    direct_dependents: 0,
    dependents_capped: false,
    author_fellow_id: "F-author",
    author_sponsor_id: "usr-author",
    created_at: `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`,
    read_url: `/p/P-TEST/claims/${claim}@2.md?through=30`,
    ...patch,
  };
}

// Real event-window SQL and canonical eligibility/request construction; the
// bounded need admissions are explicit fixtures. The native moves lane proves
// their visibility, withdrawal and current-migration reads against real D1.
function processWindow(items: ReviewQueueItem[] = [], reviewed = new Set<string>()) {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE events (id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER,
      type TEXT, object_kind TEXT, object_id TEXT, object_version INTEGER);
    CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_json TEXT);
  `);
  for (let seq = 6; seq <= 30; seq++)
    sqlite.run("INSERT INTO events VALUES (?, 'P-TEST', ?, 'question.raised', 'question', ?, 1)", [
      `EV-${seq}`,
      seq,
      `Q-${seq}`,
    ]);
  let gapMove: NextMoveCandidate | null = null;
  let gapCalls = 0;
  const readers: CeremonyNeedReaders = {
    claims: async (_db, problemId, viewer, permissions, cursor) => {
      expect(problemId).toBe("P-TEST");
      expect(cursor).toBe(30);
      return {
        items,
        moves: selectLedgerMoves(items, viewer, permissions, reviewed, getMoveTemplate),
        degraded: false,
        continuation: null,
      };
    },
    gap: async (_db, problemId, cursor, now) => {
      expect([problemId, cursor, now]).toEqual(["P-TEST", 30, context.now]);
      gapCalls++;
      return { move: gapMove, degraded: false };
    },
  };
  const db = createMockDb(sqlite);
  return {
    sqlite,
    db,
    readers,
    read: (viewerContext = context) =>
      checkCeremonyBreaker(db, "P-TEST", 30, "active", viewerContext, readers),
    gapCalls: () => gapCalls,
    setGap: (move: NextMoveCandidate) => {
      gapMove = move;
    },
  };
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
      expect(isObjectLevelEvent({ type: "synthesis.created" })).toBe(false);
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
      `);

      // 10 process events
      for (let i = 1; i <= 10; i++) {
        sqlite.run(
          "INSERT INTO events VALUES (?, 'P-TEST', ?, 'synthesis.created', 'synthesis', 'SYN-1', 1, NULL)",
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
      `);

      // 24 process events + 1 claim.created event
      for (let i = 1; i <= 24; i++) {
        sqlite.run(
          "INSERT INTO events VALUES (?, 'P-TEST', ?, 'synthesis.created', 'synthesis', 'SYN-1', 1, NULL)",
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

    test("selects the oldest eligible current need without author or same-sponsor self-review", async () => {
      const f = processWindow([
        need("C-4", 4, { direct_dependents: 10 }),
        need("C-1", 1, { author_fellow_id: context.viewer.fellowId }),
        need("C-2", 2, { author_sponsor_id: context.viewer.sponsorId }),
        need("C-3", 3),
      ]);
      try {
        const result = await f.read();
        expect(result.active).toBe(true);
        expect(result.objectEventCountInWindow).toBe(0);
        expect(result.oldestNeed?.kind).toBe("unreviewed-claim");
        expect(result.oldestNeed?.ref).toBe("C-3@2");
        expect(result.selectedMove?.contract.availability).toBe("available");
        expect(result.selectedMove?.contract.prefilled_hints).toMatchObject({
          target_claim_id: "C-3",
          target_version: 2,
        });
        expect(JSON.stringify(result)).not.toContain("AUTHORED-CONTENT");
        expect(f.gapCalls()).toBe(0);
      } finally {
        f.sqlite.close();
      }
    });

    test("does not repeat a recorded review and retains the next exact-version need", async () => {
      const f = processWindow([need("C-1", 1), need("C-2", 2)], new Set(["P-TEST/C-1@2"]));
      try {
        expect((await f.read()).oldestNeed?.ref).toBe("C-2@2");
      } finally {
        f.sqlite.close();
      }
    });

    test("falls through to the canonical gap and never invents a problem-level scientific result", async () => {
      const f = processWindow([need("C-1", 1, { author_fellow_id: context.viewer.fellowId })]);
      const gap: NextMoveCandidate = {
        move: "close-gap",
        why: "An accessible, unowned obligation remains on the current claim version.",
        refs: ["P-TEST", "G-5", "C-1@2"],
        contract: {
          ...getMoveTemplate("close-gap"),
          preparation: {
            problem_id: "P-TEST",
            captured_cursor: 30,
            read_first: { method: "GET", path: "/p/P-TEST/gaps.md?through=30&target=G-5" },
          },
        },
      };
      try {
        const empty = await f.read();
        expect(empty.active).toBe(true);
        expect(empty.oldestNeed).toBeNull();
        expect(empty.selectedMove).toBeNull();
        expect(empty.degraded).toBe(false);
        f.setGap(gap);
        const selected = await f.read();
        expect(selected.oldestNeed?.kind).toBe("unowned-gap");
        expect(selected.oldestNeed?.ref).toBe("G-5");
        expect(selected.selectedMove).toBe(gap);
        expect(f.gapCalls()).toBe(2);
      } finally {
        f.sqlite.close();
      }
    });

    test("withholds targets without authenticated context or permission to act on the need", async () => {
      const f = processWindow([need("C-1", 1)]);
      try {
        const unknown = await checkCeremonyBreaker(f.db, "P-TEST", 30, "active");
        expect(unknown.active).toBe(true);
        expect(unknown.degraded).toBe(true);
        expect(unknown.oldestNeed).toBeNull();
        const denied = await f.read({ ...context, permissions: { session_open: true } });
        expect(denied.oldestNeed).toBeNull();
        expect(f.gapCalls()).toBe(0);
        const sharpening = await checkCeremonyBreaker(
          f.db,
          "P-TEST",
          30,
          "sharpening",
          { ...context, permissions: { session_open: true, promote: true } },
          f.readers,
        );
        expect(sharpening.oldestNeed).toBeNull();
        expect(sharpening.degraded).toBe(false);
        expect(f.gapCalls()).toBe(0);
      } finally {
        f.sqlite.close();
      }
    });

    test("a focused review respects review permission and write quotas, independently of promotion", () => {
      const focused = (focus?: string): NextMoveCandidate => ({
        move: "back-to-the-object",
        why: "Resume the current need.",
        refs: ["P-TEST", "C-1@2"],
        contract: { ...getMoveTemplate("review"), preparation: { focus_move: focus } },
      });
      const permissions = { session_open: true, review: true, promote: false };
      expect(filterMovesByPermissions([focused("review")], permissions)).toHaveLength(1);
      expect(filterMovesByPermissions([focused("close-gap")], permissions)).toHaveLength(0);
      expect(filterMovesByPermissions([focused("add-refuter")], permissions)).toHaveLength(0);
      expect(
        filterMovesByPermissions([focused("add-refuter")], { ...permissions, evidence: true }),
      ).toHaveLength(1);
      expect(
        filterMovesByPermissions([focused(), focused("unsupported")], permissions),
      ).toHaveLength(0);
      expect(
        filterMovesByPermissions([focused("review")], { ...permissions, review: false }),
      ).toHaveLength(0);
      expect(filterMovesByPermissions([focused("review")], permissions, true)).toHaveLength(0);
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
      sqlite.run("INSERT INTO events VALUES ('EV-SYN', 'P-TEST', 10, 'synthesis.created')");

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
