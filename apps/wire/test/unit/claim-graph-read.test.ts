import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { afterEach, test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import type { ClaimDependencySnapshot } from "../../src/ledger/claim-dependency-snapshot.ts";
import { computeDependencyCeilings, type CeilingNode } from "../../src/ledger/dependency-ceiling.ts";
import {
  CLAIM_GRAPH_ROOT_LIMIT, CLAIM_GRAPH_ROOTS_SQL, readClaimGraph, summarizeClaimGraph,
} from "../../src/ledger/claim-graph-read.ts";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const problem = "P-GRAPH";
function node(target: string, dependencies: string[] = [], overrides: Partial<CeilingNode["standing"]> = {}): CeilingNode {
  return { target, dependencies, standing: { complete: true, disposition: "corroborated",
    review_state: "independently-checked", stale: false,
    latest_version: Number(target.split("@")[1]), own_ceiling: "computation", ...overrides } };
}
function graph(target = "C-3@1", through = 20, input = [
  node("C-3@1", ["C-2@1"]), node("C-2@1", ["C-1@1"]), node("C-1@1", [], { own_ceiling: "citation" }),
]): ClaimDependencySnapshot {
  const byTarget = new Map(input.map(n => [n.target, n]));
  const pending = [target], seen = new Set(pending);
  for (let i = 0; i < pending.length; i++) {
    for (const child of byTarget.get(pending[i]!)?.dependencies ?? []) {
      if (byTarget.has(child) && !seen.has(child)) { seen.add(child); pending.push(child); }
    }
  }
  const nodes = pending.map(pin => byTarget.get(pin) ?? node(pin));
  const complete = nodes.every(n => n.dependencies !== null && n.dependencies.every(pin => seen.has(pin)));
  const edges = nodes.flatMap(n => (n.dependencies ?? []).map(to => ({ from: n.target, to, available: seen.has(to) })));
  const calculated = computeDependencyCeilings(nodes.map(n => ({ ...n,
    dependencies: n.target === target && !complete ? null : n.dependencies,
  })));
  return {
    problem, target, through,
    closure: { root_available: true, complete,
      unavailable: nodes.filter(n => n.dependencies === null).map(n => n.target),
      nodes: nodes.slice(1).map(n => ({ target: n.target, pins: n.dependencies === null ? null : [] })) as ClaimDependencySnapshot["closure"]["nodes"],
      edges },
    assessments: new Map(nodes.map(n => [n.target, { scope: "publication-pins", problem, target: n.target,
      through, standing: n.standing, chain: calculated.get(n.target)! }])),
  };
}
function fixture() {
  const sqlite = new Database(":memory:"); databases.push(sqlite);
  sqlite.exec(`
    CREATE TABLE problems (id TEXT PRIMARY KEY, status TEXT, public_seq INTEGER);
    CREATE TABLE events (id TEXT PRIMARY KEY, problem_id TEXT, object_id TEXT, object_version INTEGER,
      object_kind TEXT, type TEXT, seq INTEGER, payload_sha256 TEXT);
    CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE content_controls (problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    INSERT INTO problems VALUES ('P-GRAPH','active',200), ('P-OTHER','active',200);
  `);
  const sqlCalls: string[] = [], scientificCalls: string[] = [];
  const db = { prepare(sql: string) {
    sqlCalls.push(sql);
    return { bind(...bindings: (string | number | null)[]) {
      return { async all() { return { results: sqlite.prepare(sql).all(...bindings) }; } };
    } };
  } } as unknown as D1Database;
  let sequence = 0;
  const add = (claim: number, version = 1, scope = problem) => {
    const seq = ++sequence, id = `EV-${seq}`, hash = String(seq).padStart(64, "0");
    sqlite.prepare("INSERT INTO events VALUES (?,?,?,?, 'claim', ?, ?, ?)")
      .run(id, scope, `C-${claim}`, version, version === 1 ? "claim.created" : "claim.revised", seq, hash);
    sqlite.prepare("INSERT INTO event_content VALUES (?,?,?,NULL)").run(id, hash, "SOURCE BODY NOT READ BY ROOT DISCOVERY");
    return id;
  };
  const snapshots = new Map<string, ClaimDependencySnapshot>();
  const load = async (_db: D1Database, scope: string, cursor: number, target: string) => {
    assert.equal(scope, problem); scientificCalls.push(target);
    return snapshots.get(target) ?? graph(target, cursor);
  };
  const read = (cursor = sequence) => readClaimGraph(db, problem, cursor, load);
  return { sqlite, db, add, snapshots, read, sqlCalls, scientificCalls, load };
}

test("current roots are most-recent-first and use the same captured cursor", async () => {
  const f = fixture(); f.add(1); f.add(2); f.add(3);
  const result = await f.read(3);
  assert.deepEqual(result.graphs.map(g => g.target), ["C-3@1", "C-2@1", "C-1@1"]);
  assert.deepEqual(f.scientificCalls, ["C-3@1", "C-2@1", "C-1@1"]);
  assert.equal(f.sqlCalls.length, 1);
  assert.ok(f.sqlCalls[0]!.includes("LIMIT 5"));
  assert.ok(result.graphs.every(g => g.through === 3));
  assert.equal(result.truncated, false); assert.equal(result.rootsExamined, 3);
});

test("root admission is bounded before scientific reads; the lookahead has no body", async () => {
  const f = fixture(); for (let i = 1; i <= 9; i++) f.add(i);
  const result = await f.read();
  assert.equal(f.scientificCalls.length, CLAIM_GRAPH_ROOT_LIMIT);
  assert.deepEqual(f.scientificCalls, ["C-9@1", "C-8@1", "C-7@1", "C-6@1"]);
  assert.equal(result.truncated, true);
  assert.ok(result.omitted.some(o => o.reason === "candidate_limit"));
  const rows = f.sqlite.prepare(CLAIM_GRAPH_ROOTS_SQL).all(JSON.stringify({ problem, cursor: 9 }));
  assert.equal(rows.length, 5);
  assert.ok(!JSON.stringify(rows).includes("SOURCE BODY"));
});

test("cursor isolation selects an older exact head without borrowing a later revision", async () => {
  const f = fixture(); f.add(1); f.add(2); f.add(1, 2);
  assert.deepEqual((await f.read(2)).graphs.map(g => g.target), ["C-2@1", "C-1@1"]);
  assert.deepEqual((await f.read(3)).graphs.map(g => g.target), ["C-1@2", "C-2@1"]);
});

test("publication boundary refuses an unpublished cut", async () => {
  const f = fixture(); f.add(1); f.sqlite.exec("UPDATE problems SET public_seq=0 WHERE id='P-GRAPH'");
  const result = await f.read(1);
  assert.equal(result.scopeAvailable, false); assert.equal(result.graphs.length, 0);
  assert.equal(f.scientificCalls.length, 0); assert.ok(result.omitted.length > 0);
});

test("foreign claims neither take selection slots nor enter scientific reads", async () => {
  const f = fixture(); f.add(1); for (let i = 2; i <= 10; i++) f.add(i, 1, "P-OTHER");
  assert.deepEqual((await f.read()).graphs.map(g => g.target), ["C-1@1"]);
});

test("empty available scope differs from missing and private scope", async () => {
  const f = fixture();
  const empty = await f.read(0);
  assert.equal(empty.scopeAvailable, true); assert.deepEqual(empty.omitted, []);
  assert.equal(empty.rootsExamined, 0);
  f.sqlite.exec("UPDATE problems SET status='private-draft' WHERE id='P-GRAPH'");
  const hidden = await f.read(0);
  assert.equal(hidden.scopeAvailable, false); assert.ok(hidden.omitted.length > 0);
  f.sqlite.exec("DELETE FROM problems WHERE id='P-GRAPH'");
  assert.equal((await f.read(0)).scopeAvailable, false);
  assert.equal(f.scientificCalls.length, 0);
});

for (const target of ["C-1", "C-1@2", "#2"]) {
  test(`current hiding prevents a head fallback: ${target}`, async () => {
    const f = fixture(); f.add(1); f.add(1, 2);
    f.sqlite.prepare("INSERT INTO content_controls VALUES ('P-GRAPH',?,'hidden',1)").run(target);
    const result = await f.read(2);
    assert.deepEqual(result.graphs, []); assert.equal(f.scientificCalls.length, 0);
    assert.ok(result.omitted.some(o => o.reason === "content_unavailable"));
  });
}

test("latest content restoration restores the exact head without editing historical source", async () => {
  const f = fixture(); f.add(1);
  f.sqlite.exec("INSERT INTO content_controls VALUES ('P-GRAPH','C-1','hidden',1)");
  assert.equal((await f.read()).graphs.length, 0);
  f.sqlite.exec("INSERT INTO content_controls VALUES ('P-GRAPH','C-1','public',2)");
  assert.equal((await f.read()).graphs[0]?.target, "C-1@1");
});

test("whole-problem hiding applies even to an older cursor", async () => {
  const f = fixture(); f.add(1); f.add(2);
  f.sqlite.exec("INSERT INTO content_controls VALUES ('P-GRAPH','problem','hidden',1)");
  assert.equal((await f.read(1)).scopeAvailable, false); assert.equal(f.scientificCalls.length, 0);
});

for (const change of ["redact", "missing", "digest-detached"]) {
  test(`unreadable head is omitted, never silently replaced: ${change}`, async () => {
    const f = fixture(); f.add(1); const id = f.add(1, 2);
    if (change === "redact") f.sqlite.prepare("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(id);
    else if (change === "missing") f.sqlite.prepare("DELETE FROM event_content WHERE event_id=?").run(id);
    else f.sqlite.prepare("UPDATE event_content SET payload_sha256='different' WHERE event_id=?").run(id);
    assert.equal((await f.read()).graphs.length, 0); assert.equal(f.scientificCalls.length, 0);
  });
}

test("duplicate publication identities fail closed before the snapshot loader", async () => {
  const f = fixture(); f.add(1); f.add(1);
  assert.equal((await f.read()).graphs.length, 0); assert.equal(f.scientificCalls.length, 0);
});

test("a failing scientific graph does not hide independently readable roots or echo errors", async () => {
  const f = fixture(); f.add(1); f.add(2);
  const result = await readClaimGraph(f.db, problem, 2, async (...args) => {
    if (args[3] === "C-2@1") throw new Error("PRIVATE storage annotation");
    return f.load(...args);
  });
  assert.deepEqual(result.graphs.map(g => g.target), ["C-1@1"]);
  assert.ok(result.omitted.some(o => o.reason === "content_unavailable"));
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
});

test("SQL failure is not fabricated as a successfully empty graph", async () => {
  const f = fixture(); f.add(1); f.sqlite.exec("ALTER TABLE events RENAME TO missing_events");
  await assert.rejects(f.read());
});

for (const [scope, cursor] of [[problem, NaN], [problem, -1], [problem, 1.2], ["P-GRAPH\n", 2], ["P--BAD", 2]] as const) {
  test(`invalid request performs no reads: ${JSON.stringify([scope,cursor])}`, async () => {
    const f = fixture(); await assert.rejects(readClaimGraph(f.db, scope, cursor, f.load));
    assert.equal(f.sqlCalls.length, 0);
  });
}

test("graph summary exposes the minimum transitive class without upgrading dispositions", () => {
  const result = summarizeClaimGraph(graph(), problem, 20, "C-3@1");
  assert.equal(result.standing.disposition, "corroborated");
  assert.equal(result.standing.own_ceiling, "computation");
  assert.equal(result.chain.ceiling, "citation");
  assert.deepEqual(result.chain.weakest_path, ["C-3@1", "C-2@1", "C-1@1"]);
  assert.equal(result.limiting_premise.standing?.own_ceiling, "citation");
  assert.equal(result.limiting_premise.read_url, "/p/P-GRAPH/claims/C-1@1.md?through=20");
  assert.equal(result.read_url, "/p/P-GRAPH/claims/C-3@1.md?through=20");
});

for (const own_ceiling of ["assertion", "heuristic", "citation", "computation", "certified"] as const) {
  test(`${own_ceiling} path has no invented scientific standing`, () => {
    const snapshot = graph("C-2@1", 20, [node("C-2@1", ["C-1@1"], { own_ceiling: "certified" }),
      node("C-1@1", [], { own_ceiling, disposition: "open", review_state: "unreviewed" })]);
    const result = summarizeClaimGraph(snapshot, problem, 20, "C-2@1");
    assert.equal(result.chain.ceiling, own_ceiling);
    assert.equal(snapshot.assessments.get("C-1@1")!.standing.disposition, "open");
  });
}

for (const [state, reason] of [
  [{ disposition: "withdrawn" }, "premise-inactive"],
  [{ disposition: "disputed", review_state: "contested" }, "premise-contested"],
  [{ latest_version: 2 }, "premise-not-current"],
] as const) {
  test(`adverse premises are visible but cannot lend a favorable ceiling: ${reason}`, () => {
    const snapshot = graph("C-2@1", 20, [node("C-2@1", ["C-1@1"]), node("C-1@1", [], state)]);
    const result = summarizeClaimGraph(snapshot, problem, 20, "C-2@1");
    assert.equal(result.chain.ceiling, null); assert.equal(result.chain.reason, reason);
    assert.equal(result.limiting_premise.target, "C-1@1");
    assert.equal(result.standing.disposition, "corroborated");
  });
}

test("unknown scientific history preserves null values and an explicit unavailable reason", () => {
  const unknown = { complete: false, disposition: null, review_state: null, stale: true, latest_version: null, own_ceiling: null } as const;
  const snapshot = graph("C-2@1", 20, [node("C-2@1", ["C-1@1"]), node("C-1@1", [], unknown)]);
  const result = summarizeClaimGraph(snapshot, problem, 20, "C-2@1");
  assert.equal(result.chain.reason, "source-unavailable"); assert.equal(result.chain.ceiling, null);
  assert.equal(result.limiting_premise.standing?.own_ceiling, null);
});

test("unknown dependency history is not an empty graph", () => {
  const root = { ...node("C-1@1"), dependencies: null };
  const snapshot = graph("C-1@1", 20, [root]);
  const result = summarizeClaimGraph(snapshot, problem, 20, "C-1@1");
  assert.equal(result.closure.complete, false); assert.equal(result.chain.ceiling, null);
  assert.equal(result.chain.reason, "dependency-history-unavailable");
});

for (const mutate of [
  (s: ClaimDependencySnapshot) => Object.assign(s, { problem: "P-OTHER" }),
  (s: ClaimDependencySnapshot) => Object.assign(s, { through: 21 }),
  (s: ClaimDependencySnapshot) => Object.assign(s, { target: "C-3@2" }),
  (s: ClaimDependencySnapshot) => Object.assign(s.assessments.get("C-1@1")!, { through: 21 }),
  (s: ClaimDependencySnapshot) => Object.assign(s.assessments.get("C-1@1")!.standing, { own_ceiling: "PROVED" }),
  (s: ClaimDependencySnapshot) => Object.assign(s.assessments.get("C-3@1")!.chain, { ceiling: "certified" }),
  (s: ClaimDependencySnapshot) => Object.assign(s.assessments.get("C-3@1")!.chain, { weakest_path: ["C-3@1", "C-99@1"] }),
  (s: ClaimDependencySnapshot) => { s.closure.nodes.push(s.closure.nodes[0]!); },
  (s: ClaimDependencySnapshot) => { s.closure.edges.pop(); },
  (s: ClaimDependencySnapshot) => { s.closure.edges.push(s.closure.edges[0]!); },
]) {
  test(`cross-cut or inconsistent graph cannot mint a summary: ${mutate.toString()}`, () => {
    const snapshot = graph(); mutate(snapshot);
    assert.throws(() => summarizeClaimGraph(snapshot, problem, 20, "C-3@1"));
  });
}

test("displayed unavailable chain is disclosed, not suppressed or relabeled positive", async () => {
  const f = fixture(); f.add(1); f.add(2);
  f.snapshots.set("C-2@1", graph("C-2@1", 2, [node("C-2@1", ["C-1@1"]), node("C-1@1", [], { disposition: "withdrawn" })]));
  const result = await f.read(2);
  assert.equal(result.graphs[0]?.chain.reason, "premise-inactive");
  assert.ok(result.omitted.some(o => o.reason === "premise_assessment_unavailable"));
});

test("all graph records use independent own standing and strip unknown source annotations", () => {
  const snapshot = graph();
  for (const a of snapshot.assessments.values()) {
    Object.assign(a.standing, { instructions: "UNTRUSTED" }); Object.assign(a.chain, { author_note: "UNTRUSTED" });
  }
  const before = JSON.stringify([...snapshot.assessments]);
  const summary = summarizeClaimGraph(snapshot, problem, 20, "C-3@1");
  assert.ok(!JSON.stringify(summary).includes("UNTRUSTED"));
  (summary.chain.weakest_path as string[]).push("C-99@1");
  assert.equal(JSON.stringify([...snapshot.assessments]), before);
});

test("the largest admitted path remains whole and one extra node refuses", () => {
  const chain = (length: number) => Array.from({ length }, (_, i) => {
    const id = length - i;
    return node(`C-${id}@1`, id > 1 ? [`C-${id - 1}@1`] : [], { own_ceiling: id > 1 ? "computation" : "assertion" });
  });
  const summary = summarizeClaimGraph(graph("C-64@1", 100, chain(64)), problem, 100, "C-64@1");
  assert.equal(summary.chain.weakest_path.length, 64);
  assert.throws(() => summarizeClaimGraph(graph("C-65@1", 100, chain(65)), problem, 100, "C-65@1"));
});
