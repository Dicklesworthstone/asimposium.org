import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import {
  REVIEW_QUEUE_BOUNDARY, REVIEW_QUEUE_SCHEMA_ID, ReviewQueueResponseSchema,
} from "@asimposium/contracts/review-queue";
import { readSponsorFollowActivity } from "../../src/inbox/sponsor-follow-activity.ts";
import { readPublicEventTail } from "../../src/ledger/event-tail-read.ts";

function fixture(count = 0) {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems (id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER);
    CREATE TABLE events (id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER, created_at TEXT,
      payload_sha256 TEXT, actor_fellow_id TEXT, actor_sponsor_id TEXT, actor_session_id TEXT,
      model_string_self_declared TEXT, harness TEXT, UNIQUE(problem_id, seq));
    CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE content_controls (problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    CREATE TABLE workshop_objects (body TEXT);
    INSERT INTO problems VALUES ('P-DEMO', 0, 'active', 0);
    INSERT INTO workshop_objects VALUES ('PRIVATE-WORKSHOP-CANARY');`);
  const queries: string[] = [];
  const db = {
    prepare(query: string) {
      queries.push(query);
      return { bind(...values: (string | number | null)[]) {
        return { all: async <T>() => ({ results: sql.query(query).all(...values) as T[] }) };
      } };
    },
  } as unknown as D1Database;
  for (let seq = 1; seq <= count; seq++) {
    sql.query("INSERT INTO events VALUES (?, 'P-DEMO', ?, 'claim.created', 'claim', ?, 1, ?, ?, 'FEL-author', 'usr_author', 'SES-author', 'model', 'harness')")
      .run("E-" + seq, seq, "C-" + seq, "2026-10-19T00:00:00.000Z", "a".repeat(64));
    sql.query("INSERT INTO event_content VALUES (?, ?, ?, NULL)")
      .run("E-" + seq, "a".repeat(64), '{"content":"PRIVATE-BODY-CANARY"}');
  }
  sql.query("UPDATE problems SET public_seq=? WHERE id='P-DEMO'").run(count);
  return { sql, db, queries };
}
function queue(cursor: number, count = 0) {
  return ReviewQueueResponseSchema.parse({
    schema: REVIEW_QUEUE_SCHEMA_ID, policy: "review-discovery-v1", problem: "P-DEMO",
    candidates: Array.from({ length: count }, (_, index) => ({
      problem_id: "P-DEMO", claim_id: "C-" + (index + 1), version: 1, cursor,
      kind: "lemma", statement: "An exact public claim " + index, falsifier: null,
      disposition: "open", need: "independent-review", best_recorded_tier: "none",
      direct_dependents: 0, dependents_capped: false,
      author_fellow_id: "FEL-author", author_sponsor_id: "usr_author",
      created_at: "2026-10-19T00:00:00.000Z",
      read_url: `/p/P-DEMO/claims/C-${index + 1}@1.md?through=${cursor}`,
    })),
    scanned: count, next_after: null, selection_boundary: REVIEW_QUEUE_BOUNDARY, omitted: [],
  });
}

describe("follow activity reuses public sources without private work products", () => {
  test("newest material envelopes and exact review targets share the captured cut", async () => {
    const f = fixture(50);
    try {
      const seen: unknown[] = [];
      const result = await readSponsorFollowActivity(f.db, {
        problem_id: "P-DEMO", followed_at: 1000, cursor: 50,
      }, {
        tail: readPublicEventTail,
        reviews: async (_db, query, snapshot) => { seen.push([query, snapshot]); return queue(50, 3); },
      });
      expect(result.events.map(item => item.seq)).toEqual([50, 49, 48, 47, 46]);
      expect(result.reviews.map(item => item.claim_id)).toEqual(["C-1", "C-2"]);
      expect(seen).toEqual([[{ problem: "P-DEMO" }, { problemId: "P-DEMO", through: 50, includeUnlisted: true }]]);
      expect(result.omitted).toEqual(["older_events_outside_recent_window", "material_event_limit", "review_preview_limit"]);
      expect(JSON.stringify(result)).not.toContain("PRIVATE-BODY-CANARY");
      expect(JSON.stringify(result)).not.toContain("PRIVATE-WORKSHOP-CANARY");
      expect(f.queries.every(query => !query.includes("workshop_objects") && !query.includes("fellow_inbox_notices"))).toBe(true);
    } finally { f.sql.close(); }
  });

  test("unknown/private producers, lease-only activity and redacted content do not enter the preview", async () => {
    const f = fixture(5);
    try {
      f.sql.exec(`UPDATE events SET object_kind='workshop', type='workshop.pushed' WHERE seq=5;
        UPDATE events SET object_kind='question', type='question.leased' WHERE seq=4;
        UPDATE event_content SET redacted_at='2026-10-19T01:00:00.000Z' WHERE event_id='E-3';`);
      const result = await readSponsorFollowActivity(f.db, {
        problem_id: "P-DEMO", followed_at: 1000, cursor: 5,
      }, { tail: readPublicEventTail, reviews: async () => queue(5) });
      expect(result.events.map(item => item.seq)).toEqual([2, 1]);
      expect(result.omitted).toContain("event_content_unavailable");
    } finally { f.sql.close(); }
  });

  test("unavailable preference visibility prevents all activity reads", async () => {
    const calls: string[] = [];
    const result = await readSponsorFollowActivity({} as D1Database, {
      problem_id: "P-DEMO", followed_at: 1000, cursor: null,
    }, {
      tail: async () => { calls.push("tail"); return null; },
      reviews: async () => { calls.push("reviews"); return queue(1); },
    });
    expect(calls).toEqual([]);
    expect(result.cursor).toBeNull();
    expect(result.events).toEqual([]);
    expect(result.reviews).toEqual([]);
    expect(result.omitted).toEqual(["public_activity_unavailable"]);
  });

  test("a failing review source leaves independent event context with an explicit omission", async () => {
    const f = fixture(2);
    try {
      const result = await readSponsorFollowActivity(f.db, {
        problem_id: "P-DEMO", followed_at: 1000, cursor: 2,
      }, { tail: readPublicEventTail, reviews: async () => { throw new Error("unavailable"); } });
      expect(result.events.map(item => item.seq)).toEqual([2, 1]);
      expect(result.reviews).toEqual([]);
      expect(result.omitted).toContain("review_activity_unavailable");
    } finally { f.sql.close(); }
  });

  test("a substituted cross-problem review response refuses instead of displaying it", async () => {
    const f = fixture(2);
    try {
      await expect(readSponsorFollowActivity(f.db, {
        problem_id: "P-DEMO", followed_at: 1000, cursor: 2,
      }, {
        tail: readPublicEventTail,
        reviews: async () => ({ ...queue(2), problem: "P-OTHER" }),
      })).rejects.toThrow("SPONSOR_FOLLOW_REVIEW_SCOPE");
    } finally { f.sql.close(); }
  });

  test("current whole-problem hiding removes all public tail records", async () => {
    const f = fixture(2);
    try {
      f.sql.exec("INSERT INTO content_controls VALUES ('P-DEMO','problem','hidden',1)");
      const result = await readSponsorFollowActivity(f.db, {
        problem_id: "P-DEMO", followed_at: 1000, cursor: 2,
      }, { tail: readPublicEventTail, reviews: async () => { throw new Error("hidden"); } });
      expect(result.events).toEqual([]);
      expect(result.reviews).toEqual([]);
      expect(result.omitted).toEqual(["material_activity_unavailable", "review_activity_unavailable"]);
    } finally { f.sql.close(); }
  });
});
