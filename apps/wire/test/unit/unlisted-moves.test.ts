import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { HelloAssignment, MoveKind, MoveTemplate } from "@asimposium/contracts";
import type { ReviewQueueItem, ReviewQueueResponse } from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import type { FellowCredentialBinding } from "../../src/enrollment/service.ts";
import { loadLedgerMoves } from "../../src/mega-commands/ledger-moves.ts";
import { LedgerMovesProvider, type LiveMovesDependencies } from "../../src/mega-commands/live-provider.ts";

const credential = {
  fellowId: "F-READER", sponsorId: "SP-READER", credentialId: "FC-READER",
  fellowStatus: "active", grantedScopes: ["review", "promote"], grantedResources: {},
} as unknown as FellowCredentialBinding;
function template(move: MoveKind): MoveTemplate {
  return {
    move, title: "Fixture", trigger: "Fixture", description: "Fixture", availability: "available",
    target_contract: "/schemas/sessions.v1/review_request.json",
    request: { method: "POST", path: "/v1/sessions/{id}/review", auth: "fellow-bearer", idempotency_key_required: true },
    prefilled_hints: {}, required_fields: ["body_md"],
  };
}
function item(problem: string, claim = "C-1", need: ReviewQueueItem["need"] = "independent-review"): ReviewQueueItem {
  return {
    problem_id: problem, claim_id: claim, version: 1, cursor: 10, kind: "definition",
    statement: "Fixture definition", falsifier: null, disposition: "open", need,
    best_recorded_tier: "none", direct_dependents: 0, dependents_capped: false,
    author_fellow_id: "F-AUTHOR", author_sponsor_id: "SP-AUTHOR",
    created_at: "2026-10-01T00:00:00.000Z", read_url: `/p/${problem}/claims/${claim}@1.md?through=10`,
  };
}
function page(problem: string, rows = [item(problem)], next_after: string | null = null): ReviewQueueResponse {
  return {
    schema: "https://a.asimposium.org/schemas/review-queue.v1.json", policy: "review-discovery-v1",
    problem, candidates: rows, scanned: rows.length, next_after, omitted: [],
    selection_boundary: "fixture" as ReviewQueueResponse["selection_boundary"],
  };
}

// Actual SQLite queries and production provider/queue selection; central policy
// and scientific queue responses are explicit dependency fixtures, not their implementations.
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, unlisted INTEGER, status TEXT);
    CREATE TABLE problem_memberships(problem_id TEXT, fellow_id TEXT, role TEXT);
    CREATE TABLE content_controls(problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    CREATE TABLE events(id TEXT, problem_id TEXT, object_id TEXT, object_kind TEXT, type TEXT,
      seq INTEGER, actor_fellow_id TEXT, writer_credential_id TEXT);
    CREATE TABLE reviews(problem_id TEXT, review_id TEXT, source_event_id TEXT, source_seq INTEGER,
      reviewer_fellow_id TEXT, target_claim_id TEXT, target_version INTEGER);
  `);
  const queries: string[] = [];
  const db = {
    prepare(query: string) {
      queries.push(query);
      return { bind: (...values: (string | number | null)[]) => ({
        first: async () => sql.query(query).get(...values) ?? null,
        all: async () => ({ results: sql.query(query).all(...values) }),
      }) };
    },
  } as unknown as D1Database;
  const calls: Parameters<LiveMovesDependencies["authorize"]>[0][] = [];
  const queues: { query: { problem: string; after?: string }; snapshot: unknown }[] = [];
  const deps: LiveMovesDependencies = {
    now: () => 100, templateFor: template, firstClaimTemplate: () => template("state-claim"),
    authorize(input) {
      calls.push(input);
      return input.effect === "promote" && input.target.kind === "existing-problem" && input.target.membershipRole === "observer"
        ? { decision: "quarantine", effect: input.effect, handling: "blocked-pending-operator-review" }
        : { decision: "allow", effect: input.effect };
    },
    async loadQueue(_db, query, snapshot) { queues.push({ query, snapshot }); return page(query.problem); },
  };
  function problem(id = "P-DEMO", unlisted = 1, role = "contributor", claims = true) {
    sql.query("INSERT INTO problems VALUES (?,10,?,'active')").run(id, unlisted);
    sql.query("INSERT INTO problem_memberships VALUES (?,'F-READER',?)").run(id, role);
    if (claims) sql.query("INSERT INTO events (problem_id,object_kind,type,seq) VALUES (?,'claim','claim.created',1)").run(id);
  }
  const next = (problemId = "P-DEMO", extra = {}) => new LedgerMovesProvider(deps).nextMoves({
    db, credential, fellowId: credential.fellowId, problemId, role: "contributor",
    effectivePermissions: { promote: true, review: true, session_open: true }, ...extra,
  });
  const triage = (ids: string[]) => new LedgerMovesProvider(deps).triageMove({
    db, credential, fellowId: credential.fellowId,
    assignments: ids.map((problem_id) => ({ problem_id, role: "contributor" }) as HelloAssignment),
  });
  return { sql, db, deps, calls, queues, queries, problem, next, triage };
}

for (const unlisted of [0, 1]) test(`member review guidance carries actual listing state ${unlisted} to policy and the canonical queue`, async () => {
  const f = fixture();
  try {
    f.problem("P-DEMO", unlisted);
    const result = await f.next();
    assert.equal(result.degraded, false);
    assert.deepEqual(result.primaryMove?.refs, ["P-DEMO", "C-1@1"]);
    assert.equal(result.effectivePermissions?.review, true);
    assert.ok(f.calls.some((c) => c.target.kind === "existing-problem" && c.target.unlisted === (unlisted === 1)));
    assert.deepEqual(f.queues[0]?.snapshot, { problemId: "P-DEMO", through: 10, ...(unlisted ? { includeUnlisted: true } : {}) });
    assert.deepEqual(f.queues[0]?.query, { problem: "P-DEMO" });
  } finally { f.sql.close(); }
});

test("unlisted observer can review without acquiring promotion rights", async () => {
  const f = fixture();
  try {
    f.problem("P-DEMO", 1, "observer");
    const result = await f.next();
    assert.equal(result.primaryMove?.move, "review");
    assert.equal(result.effectivePermissions?.promote, false);
    f.deps.loadQueue = async () => page("P-DEMO", [item("P-DEMO", "C-1", "falsification-attempt")]);
    assert.equal((await f.next()).primaryMove, null);
  } finally { f.sql.close(); }
});

test("an empty unlisted ledger offers a first claim without publicizing another problem", async () => {
  const f = fixture();
  try {
    f.problem("P-DEMO", 1, "contributor", false);
    f.problem("P-OTHER", 1);
    const result = await f.next();
    assert.equal(result.primaryMove?.move, "state-claim");
    assert.deepEqual(result.primaryMove?.refs, ["P-DEMO"]);
    assert.equal(f.queues.length, 0);
    assert.ok(!JSON.stringify(result).includes("P-OTHER"));
  } finally { f.sql.close(); }
});

test("membership loss and nonmembership never turn unlisted work into a join recommendation", async () => {
  const f = fixture();
  try {
    f.problem();
    f.sql.exec("UPDATE problem_memberships SET fellow_id='F-OTHER'");
    const result = await f.next();
    assert.equal(result.primaryMove, null);
    assert.equal(result.effectivePermissions?.session_open, false);
    assert.equal(f.queues.length, 0);
    assert.equal((await f.triage(["P-DEMO"])).move, null);
  } finally { f.sql.close(); }
});

for (const change of [
  "UPDATE problems SET status='private-draft'", "UPDATE problems SET status='resolved'",
  "UPDATE problems SET unlisted=2", "UPDATE problem_memberships SET role='operator'",
  "INSERT INTO content_controls VALUES ('P-DEMO','problem','hidden',1)",
]) test(`unavailable scopes do not reach scientific selection: ${change}`, async () => {
  const f = fixture();
  try {
    f.problem(); f.sql.exec(change);
    assert.equal((await f.next()).primaryMove, null);
    assert.equal(f.queues.length, 0);
  } finally { f.sql.close(); }
});

test("central policy refusal for unlisted targets cannot be overridden by request hints", async () => {
  const f = fixture();
  try {
    f.problem();
    f.deps.authorize = (input) => input.target.kind === "existing-problem" && input.target.unlisted
      ? { decision: "quarantine", effect: input.effect, handling: "blocked-pending-operator-review" }
      : { decision: "allow", effect: input.effect };
    const result = await f.next();
    assert.equal(result.primaryMove, null);
    assert.equal(result.effectivePermissions?.review, false);
    assert.equal(result.effectivePermissions?.promote, false);
    assert.equal(f.queues.length, 0);
  } finally { f.sql.close(); }
});

for (const [change, code] of [
  ["UPDATE problem_memberships SET fellow_id='F-OTHER'", "MOVES_SCOPE_UNAVAILABLE"],
  ["UPDATE problems SET status='private-draft'", "MOVES_SCOPE_UNAVAILABLE"],
  ["INSERT INTO content_controls VALUES ('P-DEMO','problem','hidden',1)", "MOVES_SCOPE_UNAVAILABLE"],
  ["UPDATE problems SET public_seq=11", "MOVES_CURSOR_CHANGED"],
  ["UPDATE problems SET unlisted=0", "MOVES_CURSOR_CHANGED"],
  ["UPDATE problem_memberships SET role='observer'", "MOVES_CURSOR_CHANGED"],
]) test(`ordinary next rechecks scope after scientific reads: ${change}`, async () => {
  const f = fixture();
  try {
    f.problem();
    f.deps.loadQueue = async () => { f.sql.exec(change); return page("P-DEMO"); };
    const result = await f.next();
    assert.equal(result.primaryMove, null);
    assert.equal(result.degradedReason, code);
    assert.deepEqual(result.alternatives, []);
  } finally { f.sql.close(); }
});

test("triage keeps a stable assigned problem when another loses its scope", async () => {
  const f = fixture();
  try {
    f.problem("P-AAA"); f.problem("P-BBB");
    f.deps.loadQueue = async (_db, query) => {
      if (query.problem === "P-AAA") f.sql.exec("UPDATE problems SET status='private-draft' WHERE id='P-AAA'");
      return page(query.problem);
    };
    const result = await f.triage(["P-BBB", "P-AAA"]);
    assert.deepEqual(result.move?.refs, ["P-BBB", "C-1@1"]);
    assert.equal(result.degraded, true);
  } finally { f.sql.close(); }
});

test("unlisted review history still suppresses the exact already-reviewed version", async () => {
  const f = fixture();
  try {
    f.problem();
    f.sql.exec(`INSERT INTO events VALUES ('EV-R','P-DEMO','R-1','review','review.created',5,'F-READER',NULL);
      INSERT INTO reviews VALUES ('P-DEMO','R-1','EV-R',5,'F-READER','C-1',1);`);
    assert.equal((await f.next()).primaryMove, null);
    f.deps.loadQueue = async () => page("P-DEMO", [{ ...item("P-DEMO"), version: 2 }]);
    assert.deepEqual((await f.next()).primaryMove?.refs, ["P-DEMO", "C-1@2"]);
  } finally { f.sql.close(); }
});

test("unlisted queue traversal remains scoped on every page and never advertises a listed-only continuation", async () => {
  const f = fixture();
  try {
    f.problem();
    let calls = 0;
    f.deps.loadQueue = async (_db, query, snapshot) => {
      calls++;
      assert.deepEqual(snapshot, { problemId: "P-DEMO", through: 10, includeUnlisted: true });
      assert.equal(query.problem, "P-DEMO");
      return page("P-DEMO", [item("P-DEMO", `C-${calls}`)], `next-${calls}`);
    };
    const result = await f.next();
    assert.equal(calls, 2);
    assert.equal(result.degraded, true);
    assert.equal(result.primaryMove?.move, "review");
    assert.ok(!result.selectionBoundary?.includes("/reviews.json?"));
  } finally { f.sql.close(); }
});

test("unlisted internal queue mode requires an explicit finite captured cut", async () => {
  const f = fixture();
  try {
    await assert.rejects(loadLedgerMoves(f.db, "P-DEMO", credential,
      { session_open: true, review: true }, f.deps, undefined, { includeUnlisted: true }), /MOVE_QUEUE_SNAPSHOT_INVALID/);
    assert.equal(f.queues.length, 0);
    assert.equal(f.queries.length, 0);
  } finally { f.sql.close(); }
});

test("production triage preserves higher-priority work and same-target review contracts", async () => {
  const f = fixture();
  try {
    f.problem("P-AAA", 0); f.problem("P-BBB", 0);
    f.deps.formalize = { load: async (_db, problem) => ({ degraded: false,
      move: { move: "formalize", why: "Fixture", refs: [problem, "C-1@1"], contract: template("formalize") } }) };
    const result = await f.triage(["P-BBB", "P-AAA"]);
    assert.equal(result.move?.move, "review");
    f.deps.backToObject = { load: async (_db, problem) => ({ degraded: false,
      move: problem === "P-AAA" ? { move: "back-to-the-object", why: "Fixture", refs: [problem], contract: template("back-to-the-object") } : null }) };
    assert.equal((await f.triage(["P-BBB", "P-AAA"])).move?.move, "back-to-the-object");
  } finally { f.sql.close(); }
});
