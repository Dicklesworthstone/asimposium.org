import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { MoveTemplate } from "@asimposium/contracts";
import type { ReviewQueueResponse } from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import { readReviewQueue, type ReviewQueueScience } from "../../src/discovery/review-queue-read";
import { readReviewAdmissions } from "../../src/discovery/review-queue-admissions";
import { loadLedgerMoves } from "../../src/mega-commands/ledger-moves";
import {
  readCanonicalReviewQueuePack,
  type ReviewQueuePackDependencies,
} from "../../src/sessions/review-queue-pack";
import type { LedgerPackSection } from "../../src/sessions/ledger-pack";

// Actual production SQL, SHA-256 verification, selection and pack composition.
// The scientific fold and templates are explicit fixtures, NOT an end-to-end
// proof of review verification or the mounted authenticated session route.
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
const viewer = { fellowId: "F-READER", sponsorId: "SP-READER" };
const emptyInvitations = async (): Promise<LedgerPackSection> => ({ candidates: [], omitted: [] });
const science: ReviewQueueScience = {
  prepare(db, _problem, _cursor, _limit, target) {
    return db.prepare("SELECT ? AS target_version").bind(target.version);
  },
  async fold(rows) {
    return {
      stale: false,
      currentVersion: rows[0]?.target_version ?? null,
      disposition: "open",
      context: { verified_reviews: [], recorded_refutation_attempts: 0 },
    } as unknown as Awaited<ReturnType<ReviewQueueScience["fold"]>>;
  },
};
function templateFor(move: "review" | "add-refuter"): MoveTemplate {
  return {
    move, availability: "available", prefilled_hints: {},
    request: { method: "POST", path: "/v1/sessions/{id}/review" },
  } as MoveTemplate;
}
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER);
    INSERT INTO problems VALUES('P-DEMO',0,'active',0),('P-OTHER',0,'active',1);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, object_kind TEXT,
      object_id TEXT, object_version INTEGER, type TEXT, payload_sha256 TEXT, created_at TEXT,
      actor_fellow_id TEXT, actor_sponsor_id TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE screening_publications(event_id TEXT PRIMARY KEY, provenance_json TEXT NOT NULL);
    CREATE TABLE claim_versions(problem_id TEXT, claim_id TEXT, version INTEGER,
      kind TEXT, statement TEXT, falsifier TEXT, content_digest TEXT);
    CREATE TABLE content_controls(problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    CREATE TABLE retractions(problem_id TEXT, retraction_id TEXT, target_object TEXT, seq INTEGER);
    CREATE TABLE reviews(problem_id TEXT, review_id TEXT, source_event_id TEXT, source_seq INTEGER,
      target_claim_id TEXT, target_version INTEGER, reviewer_fellow_id TEXT);
  `);
  let statements = 0;
  let beforeBatch: (() => void) | undefined;
  const queries: string[] = [];
  const prepare = (query: string) => ({
    bind: (...values: (string | number | null)[]) => ({
      all: async () => {
        statements++;
        queries.push(query);
        return { results: sql.prepare(query).all(...values), success: true, meta: {} };
      },
    }),
  });
  const db = {
    prepare,
    batch: async (batch: { all(): Promise<unknown> }[]) => {
      beforeBatch?.();
      sql.exec("BEGIN");
      try {
        const out = [];
        for (const statement of batch) out.push(await statement.all());
        sql.exec("COMMIT");
        return out;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  const event = (seq: number, id: string, kind: string, type: string, version: number,
    payload: object, problem = "P-DEMO", author = "F-AUTHOR", sponsor = "SP-AUTHOR") => {
    const eventId = `${problem}-${kind}-${seq}`;
    const body = JSON.stringify(payload);
    const sha = hash(body);
    const at = new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString();
    sql.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(eventId, problem, seq, kind, id, version, type, sha, at, author, sponsor);
    sql.prepare("INSERT INTO event_content VALUES(?,?,?,NULL)").run(eventId, sha, body);
    sql.prepare("UPDATE problems SET public_seq = MAX(public_seq, ?) WHERE id = ?").run(seq, problem);
    return { eventId, sha };
  };
  function claim(seq: number, id = `C-${seq}`, options: {
    problem?: string; version?: number; statement?: string; falsifier?: string;
    author?: string; sponsor?: string; pins?: object[];
  } = {}) {
    const problem = options.problem ?? "P-DEMO";
    const version = options.version ?? 1;
    const statement = options.statement ?? `Statement ${id} version ${version}`;
    const falsifier = options.falsifier ?? "A reproducible counterexample";
    const kind = "conjecture";
    const published = event(seq, id, "claim", version === 1 ? "claim.created" : "claim.revised", version, {
      claim_id: id, kind, statement, falsifier,
      dependency_pins: options.pins ?? [],
      ...(version === 1 ? {} : { base_version: version - 1 }),
    }, problem, options.author, options.sponsor);
    const digest = `sha256:${hash(JSON.stringify({ falsifier, kind, statement }))}`;
    sql.prepare("INSERT INTO claim_versions VALUES(?,?,?,?,?,?,?)")
      .run(problem, id, version, kind, statement, falsifier, digest);
    return { claim_id: id, version, event_id: published.eventId,
      payload_digest: published.sha, content_digest: digest };
  }
  function review(seq: number, claimId: string, version: number, problem = "P-DEMO", fellow = viewer.fellowId) {
    const id = `R-${seq}`;
    const { eventId } = event(seq, id, "review", "review.created", 1,
      { target_claim_id: claimId, target_version: version }, problem, fellow, viewer.sponsorId);
    sql.prepare("INSERT INTO reviews VALUES(?,?,?,?,?,?,?)")
      .run(problem, id, eventId, seq, claimId, version, fellow);
    return eventId;
  }
  const source: ReviewQueuePackDependencies = {
    loadQueue: (database, query, snapshot) => readReviewQueue(database, query, science, snapshot),
    templateFor, invitations: emptyInvitations, neutralize: (body) => body,
  };
  const cursor = () => Number(sql.query<{ public_seq: number }, []>("SELECT public_seq FROM problems WHERE id='P-DEMO'").get()?.public_seq);
  return {
    sql, db, claim, review, source, queries, cursor,
    count: () => statements,
    beforeBatch: (callback: () => void) => { beforeBatch = callback; },
    read: (through = cursor(), overrides: Partial<ReviewQueuePackDependencies> = {}) =>
      readCanonicalReviewQueuePack(db, "P-DEMO", through, viewer, { ...source, ...overrides }),
  };
}

function invitation(): LedgerPackSection {
  return { candidates: [{
    kind: "review-invitation", id: "PRIVATE-ASSIGNMENT", scope: "workshop", untrusted: true,
    tokens: 1, body: "Assigned work for this participant", stable_prefix: 2,
    why_included: "participant-checked invitation fixture",
  }], omitted: [] };
}

test("pack uses canonical dependency consequence ahead of raw oldest-first order", async () => {
  const f = fixture();
  try {
    f.claim(1);
    const important = f.claim(2);
    f.claim(3, "C-3", { pins: [important] });
    f.claim(4, "C-4", { pins: [important] });
    const pack = await f.read();
    const next = await loadLedgerMoves(f.db, "P-DEMO", viewer,
      { session_open: true, review: true, promote: false }, f.source, f.cursor());
    assert.deepEqual(pack.targets, next.moves.map((move) => move.refs[1]));
    assert.equal(pack.targets[0], "C-2@1");
    const record = JSON.parse(pack.candidates.find((item) => item.id === "C-2@1")!.body);
    assert.equal(record.direct_dependents, 2);
    assert.equal(record.best_recorded_tier, "none");
    assert.equal(Object.hasOwn(record, "prospective_independence_tier"), false);
    assert.equal(record.read_url, "/p/P-DEMO/claims/C-2@1.md?through=4");
  } finally { f.sql.close(); }
});

test("review queue pack keeps the publication notice outside exact-version scientific text", async () => {
  const f = fixture();
  const receipt = JSON.parse(readFileSync(new URL(
    "../../../../packages/contracts/test/fixtures/valid/screening-publication-warning-provenance.json",
    import.meta.url,
  ), "utf8"));
  try {
    const first = f.claim(1);
    f.sql.prepare("INSERT INTO screening_publications VALUES (?, ?)")
      .run(first.event_id, JSON.stringify(receipt));
    const pack = await f.read();
    const item = pack.candidates.find((candidate) => candidate.id === "C-1@1");
    assert.ok(item);
    assert.deepEqual(item?.screening_notice, receipt.public_action);
    assert.equal(JSON.parse(item.body).statement, "Statement C-1 version 1");
    assert.ok(!JSON.stringify(pack).includes(receipt.input_digest));
    f.claim(2, "C-1", { version: 2 });
    assert.equal((await f.read()).candidates.find((candidate) => candidate.id === "C-1@2")?.screening_notice, undefined);
    assert.deepEqual((await f.read(1)).candidates.find((candidate) => candidate.id === "C-1@1")?.screening_notice, receipt.public_action);
  } finally { f.sql.close(); }
});

test("own and same-sponsor work is not presented as an independent recommendation", async () => {
  const f = fixture();
  try {
    f.claim(1, "C-1", { author: viewer.fellowId });
    f.claim(2, "C-2", { sponsor: viewer.sponsorId });
    f.claim(3);
    assert.deepEqual((await f.read()).targets, ["C-3@1"]);
  } finally { f.sql.close(); }
});

test("committed own review suppresses only its exact target, even after body redaction", async () => {
  const f = fixture();
  try {
    f.claim(1, "C-1"); f.claim(2, "C-2");
    const reviewId = f.review(3, "C-1", 1);
    f.sql.prepare("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(reviewId);
    assert.deepEqual((await f.read()).targets, ["C-2@1"]);
    f.claim(4, "C-1", { version: 2 });
    assert.ok((await f.read()).targets.includes("C-1@2"));
    assert.ok((await f.read(2)).targets.includes("C-1@1"));
  } finally { f.sql.close(); }
});

for (const mismatch of ["other-problem", "other-reviewer", "wrong-event-actor", "wrong-sequence"] as const) {
  test(`review-history ${mismatch} cannot suppress this participant's work`, async () => {
    const f = fixture();
    try {
      f.claim(1);
      const problem = mismatch === "other-problem" ? "P-OTHER" : "P-DEMO";
      const reviewer = mismatch === "other-reviewer" ? "F-OTHER" : viewer.fellowId;
      const eventId = f.review(2, "C-1", 1, problem, reviewer);
      if (mismatch === "wrong-event-actor")
        f.sql.prepare("UPDATE events SET actor_fellow_id='F-OTHER' WHERE id=?").run(eventId);
      if (mismatch === "wrong-sequence") f.sql.exec("UPDATE reviews SET source_seq=9");
      assert.deepEqual((await f.read()).targets, ["C-1@1"]);
    } finally { f.sql.close(); }
  });
}

test("known unlisted problem retains review work; discovery and ordinary moves remain listed-only", async () => {
  const f = fixture();
  try {
    f.claim(1); f.claim(2, "C-1", { problem: "P-OTHER" });
    f.sql.exec("UPDATE problems SET unlisted=1 WHERE id='P-DEMO'");
    assert.deepEqual((await f.read()).targets, ["C-1@1"]);
    assert.equal((await readReviewQueue(f.db, {}, science)).candidates.length, 0);
    assert.equal((await readReviewQueue(f.db, { problem: "P-DEMO" }, science)).candidates.length, 0);
    await assert.rejects(() => readReviewQueue(f.db, { problem: "P-DEMO" }, science,
      { problemId: "P-DEMO", through: 1 }), /SNAPSHOT_UNAVAILABLE/);
  } finally { f.sql.close(); }
});

for (const state of ["private-draft", "resolved", "retired", "archived"] as const) {
  test(`known-URL queue does not reopen ${state} as review-ready`, async () => {
    const f = fixture();
    try {
      f.claim(1); f.sql.prepare("UPDATE problems SET status=? WHERE id='P-DEMO'").run(state);
      const pack = await f.read();
      assert.deepEqual(pack.targets, []);
      assert.equal(pack.omitted[0]?.reason, "review_queue_unavailable");
      assert.equal(pack.candidates.some((item) => item.id === "SYS-review-queue-empty"), false);
    } finally { f.sql.close(); }
  });
}

for (const target of ["problem", "C-1"]) {
  test(`current hide of ${target} applies to historical scoped selection and restore works`, async () => {
    const f = fixture();
    try {
      f.claim(1);
      f.sql.prepare("INSERT INTO content_controls VALUES('P-DEMO',?,'hidden',1)").run(target);
      const hidden = await f.read(1);
      assert.deepEqual(hidden.targets, []);
      assert.equal(JSON.stringify(hidden).includes("Statement C-1"), false);
      f.sql.prepare("INSERT INTO content_controls VALUES('P-DEMO',?,'visible',2)").run(target);
      assert.deepEqual((await f.read(1)).targets, ["C-1@1"]);
    } finally { f.sql.close(); }
  });
}

for (const corruption of ["projection", "source", "redaction"]) {
  test(`canonical ${corruption} failure never falls back to projection science`, async () => {
    const f = fixture();
    try {
      f.claim(1);
      if (corruption === "projection") f.sql.exec("UPDATE claim_versions SET falsifier='forged falsifier'");
      if (corruption === "source") f.sql.exec("UPDATE event_content SET payload_json='{}'");
      if (corruption === "redaction") f.sql.exec("UPDATE event_content SET redacted_at='now'");
      const pack = await f.read();
      assert.deepEqual(pack.targets, []);
      assert.ok(pack.omitted.some((item) => item.reason === "content_unavailable"));
      assert.equal(JSON.stringify(pack).includes("forged falsifier"), false);
    } finally { f.sql.close(); }
  });
}

test("actual event hash defeats coordinated source and projection substitution", async () => {
  const f = fixture();
  try {
    const pin = f.claim(1);
    const row = f.sql.query<{ payload_json: string }, [string]>("SELECT payload_json FROM event_content WHERE event_id=?").get(pin.event_id);
    const altered = JSON.parse(String(row?.payload_json));
    altered.statement = "SUBSTITUTED-SCIENTIFIC-TEXT";
    f.sql.prepare("UPDATE event_content SET payload_json=? WHERE event_id=?")
      .run(JSON.stringify(altered), pin.event_id);
    const changedDigest = `sha256:${hash(JSON.stringify({
      falsifier: altered.falsifier, kind: altered.kind, statement: altered.statement,
    }))}`;
    f.sql.prepare("UPDATE claim_versions SET statement=?, content_digest=?")
      .run(altered.statement, changedDigest);
    const pack = await f.read();
    assert.deepEqual(pack.targets, []);
    assert.ok(pack.omitted.some((item) => item.reason === "content_unavailable"));
    assert.equal(JSON.stringify(pack).includes(altered.statement), false);
  } finally { f.sql.close(); }
});

test("late unlisted change remains readable only in the explicitly scoped path", async () => {
  const f = fixture();
  try {
    f.claim(1);
    let batches = 0;
    f.beforeBatch(() => { if (++batches === 2) f.sql.exec("UPDATE problems SET unlisted=1"); });
    assert.deepEqual((await f.read()).targets, ["C-1@1"]);
    assert.equal((await readReviewQueue(f.db, {}, science)).candidates.length, 0);
  } finally { f.sql.close(); }
});

test("late private transition withholds metadata rather than exposing draft text", async () => {
  const f = fixture();
  try {
    f.claim(1);
    let batches = 0;
    f.beforeBatch(() => { if (++batches === 2) f.sql.exec("UPDATE problems SET status='private-draft'"); });
    assert.deepEqual((await f.read()).targets, []);
  } finally { f.sql.close(); }
});

test("a filtered first page cannot lose the captured cut on the second page", async () => {
  const f = fixture();
  try {
    for (let n = 1; n <= 10; n++) f.claim(n);
    f.sql.exec("UPDATE event_content SET redacted_at='now' WHERE event_id IN (SELECT id FROM events WHERE seq<=8)");
    const calls: unknown[] = [];
    const pack = await f.read(10, {
      async loadQueue(db, query, snapshot) {
        calls.push({ query, snapshot });
        const page = await f.source.loadQueue(db, query, snapshot);
        if (calls.length === 1) f.claim(11);
        return page;
      },
    });
    assert.deepEqual(pack.targets, ["C-9@1", "C-10@1"]);
    assert.equal(calls.length, 2);
    for (const call of calls as { snapshot: object }[]) assert.deepEqual(call.snapshot,
      { problemId: "P-DEMO", through: 10, includeUnlisted: true });
    assert.ok(pack.omitted.some((item) => item.reason === "content_unavailable" && item.detail.includes("8")));
  } finally { f.sql.close(); }
});

test("two pages and one history query are bounded; no false exhaustive claim", async () => {
  const f = fixture();
  try {
    for (let n = 1; n <= 25; n++) f.claim(n);
    const pack = await f.read();
    assert.equal(pack.targets.length, 16);
    assert.ok(pack.omitted.some((item) => item.reason === "candidate_limit"));
    assert.equal(f.queries.filter((sql) => sql.includes("SELECT DISTINCT r.target_claim_id")).length, 1);
    // 2 * (2 admission statements + 8 * (metadata + fixture fold)) + history.
    assert.equal(f.count(), 37);
  } finally { f.sql.close(); }
});

for (const failure of ["second-page-error", "scope", "cursor", "duplicate", "nonadvancing"] as const) {
  test(`${failure} drops all public prefixes while retaining private invitations`, async () => {
    const f = fixture();
    try {
      for (let n = 1; n <= 10; n++) f.claim(n);
      let calls = 0;
      let first: ReviewQueueResponse;
      const pack = await f.read(f.cursor(), {
        invitations: async () => invitation(),
        async loadQueue(db, query, snapshot) {
          const page = await f.source.loadQueue(db, query, snapshot);
          if (++calls === 1) { first = structuredClone(page); return page; }
          if (failure === "second-page-error") throw new Error("private-error-canary");
          if (failure === "scope") page.problem = "P-OTHER";
          if (failure === "cursor") page.candidates[0]!.cursor++;
          if (failure === "duplicate") page.candidates[0] = first!.candidates[0]!;
          if (failure === "nonadvancing") page.next_after = first!.next_after;
          return page;
        },
      });
      assert.deepEqual(pack.targets, []);
      assert.deepEqual(pack.candidates.map((item) => item.id), ["PRIVATE-ASSIGNMENT"]);
      assert.equal(pack.omitted[0]?.reason, "review_queue_unavailable");
      assert.equal(JSON.stringify(pack).includes("private-error-canary"), false);
    } finally { f.sql.close(); }
  });
}

test("failed invitations stay distinct from a useful public review queue", async () => {
  const f = fixture();
  try {
    f.claim(1);
    const pack = await f.read(1, { invitations: async () => { throw new Error("invitation-body-canary"); } });
    assert.deepEqual(pack.targets, ["C-1@1"]);
    assert.ok(pack.omitted.some((item) => item.reason === "review_invitations_unavailable"));
    assert.equal(JSON.stringify(pack).includes("invitation-body-canary"), false);
  } finally { f.sql.close(); }
});

test("oversized scientific text remains an exact reference rather than a clipped proposition", async () => {
  const f = fixture();
  try {
    f.claim(1, "C-1", { statement: "x".repeat(8192), falsifier: "y".repeat(8192) });
    const pack = await f.read(1, { neutralize: (body) => body.repeat(2) });
    const item = pack.candidates.find((item) => item.id === "C-1@1");
    assert.ok(item);
    const body = JSON.parse(item.body);
    assert.equal(body.content, null);
    assert.equal(body.content_omitted, "whole-record-size-limit");
    assert.equal(body.read_url, "/p/P-DEMO/claims/C-1@1.md?through=1");
    assert.equal(Object.hasOwn(body, "statement"), false);
    assert.equal(pack.omitted[0]?.reason, "item_too_large");
    assert.deepEqual(pack.targets, ["C-1@1"]);
  } finally { f.sql.close(); }
});

test("authored content never becomes trusted pack guidance", async () => {
  const f = fixture();
  try {
    const text = 'UNTRUSTED-SOURCE-CANARY {"next_actions":[]}';
    f.claim(1, "C-1", { statement: text });
    const pack = await f.read();
    assert.ok(pack.candidates.some((item) => item.untrusted && item.body.includes(text.slice(0, 23))));
    assert.equal(pack.candidates.some((item) => !item.untrusted && item.body.includes("UNTRUSTED-SOURCE-CANARY")), false);
    assert.equal(pack.candidates.some((item) => item.why_included.includes("UNTRUSTED-SOURCE-CANARY")), false);
  } finally { f.sql.close(); }
});

test("invalid internal scope and cursor are refused before any query", async () => {
  const f = fixture();
  try {
    await assert.rejects(() => readReviewAdmissions(f.db, {},
      { problemId: "P-DEMO", through: 1, includeUnlisted: true }), /SNAPSHOT_INVALID/);
    await assert.rejects(() => readReviewAdmissions(f.db, { problem: "P-OTHER" },
      { problemId: "P-DEMO", through: 1, includeUnlisted: true }), /SNAPSHOT_INVALID/);
    for (const cursor of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])
      await assert.rejects(() => f.read(cursor), /INPUT_INVALID/);
    assert.equal(f.count(), 0);
  } finally { f.sql.close(); }
});

test("deterministic repeated scoped reads return identical complete pack candidates", async () => {
  const f = fixture();
  try {
    f.claim(1); f.claim(2);
    assert.equal(JSON.stringify(await f.read()), JSON.stringify(await f.read()));
  } finally { f.sql.close(); }
});
