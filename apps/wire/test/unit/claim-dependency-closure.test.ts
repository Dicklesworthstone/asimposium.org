import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import {
  composeDependencyClosure,
  DEPENDENCY_CLOSURE_LIMIT,
  DEPENDENCY_SOURCE_BYTES,
  DEPENDENCY_TOTAL_BYTES,
  type DependencyClosureRow,
  prepareDependencyClosure,
} from "../../src/ledger/claim-dependency-closure";

// Real SQLite query/crypto tests, not a Cloudflare binding or deployment proof.
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const digest = async (text: string) => Array.from(new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
), (byte) => byte.toString(16).padStart(2, "0")).join("");
function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE problems (id TEXT PRIMARY KEY, status TEXT, public_seq INTEGER);
    CREATE TABLE events (id TEXT PRIMARY KEY, problem_id TEXT, object_id TEXT,
      object_version INTEGER, type TEXT, object_kind TEXT, seq INTEGER,
      payload_sha256 TEXT, actor_fellow_id TEXT, actor_sponsor_id TEXT,
      actor_session_id TEXT, model_string_self_declared TEXT, harness TEXT);
    CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_sha256 TEXT,
      payload_json TEXT, redacted_at TEXT);
    CREATE TABLE claim_versions (problem_id TEXT, claim_id TEXT, version INTEGER,
      content_digest TEXT, PRIMARY KEY (problem_id, claim_id, version));
    CREATE TABLE content_controls (problem_id TEXT, target_ref TEXT,
      visibility TEXT, version INTEGER);
    INSERT INTO problems VALUES ('P-TEST', 'active', 10000), ('P-OTHER', 'active', 10000);
  `);
  const d1 = {
    prepare(sql: string) { return { bind(...args: (string | number | null)[]) { return {
      async all() { return { results: db.prepare(sql).all(...args) }; },
    }; } }; },
  } as unknown as D1Database;
  let seq = 0;
  const add = async (claim: number, pins: unknown = [], options: {
    problem?: string; version?: number; extra?: Record<string, unknown>; statement?: string;
  } = {}) => {
    const problem = options.problem ?? "P-TEST", version = options.version ?? 1;
    const id = `E-${++seq}`, claim_id = `C-${claim}`;
    const statement = options.statement ?? `Exact proposition number ${claim}, version ${version}.`;
    const text = JSON.stringify({ claim_id, statement, kind: "lemma", falsifier: "A counterexample.",
      ...(version > 1 ? { base_version: version - 1 } : {}),
      dependency_pins: pins, ...options.extra });
    const payload_digest = await digest(text), content_digest = `sha256:${await digest(statement)}`;
    db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, 'claim', ?, ?, 'F-test', 'usr-test', 'S-test', 'declared-model', 'declared-harness')")
      .run(id, problem, claim_id, version, version === 1 ? "claim.created" : "claim.revised", seq, payload_digest);
    db.prepare("INSERT INTO event_content VALUES (?, ?, ?, NULL)").run(id, payload_digest, text);
    db.prepare("INSERT INTO claim_versions VALUES (?, ?, ?, ?)").run(problem, claim_id, version, content_digest);
    return { claim_id, version, event_id: id, payload_digest, content_digest };
  };
  const rows = async (target: string, cursor = 10000, problem = "P-TEST") =>
    (await prepareDependencyClosure(d1, problem, cursor, target).all<DependencyClosureRow>()).results;
  const read = async (target: string, cursor = 10000, problem = "P-TEST") =>
    composeDependencyClosure(await rows(target, cursor, problem), problem, target);
  return { db, d1, add, rows, read };
}

test("a three-level chain includes the exact transitive leaf and shortest paths", async () => {
  const f = fixture(), a = await f.add(1), b = await f.add(2, [a]);
  await f.add(3, [b]);
  const graph = await f.read("C-3@1");
  expect(graph.complete).toBe(true);
  expect(graph.nodes.map((n) => [n.target, n.depth, n.path])).toEqual([
    ["C-2@1", 1, ["C-3@1", "C-2@1"]], ["C-1@1", 2, ["C-3@1", "C-2@1", "C-1@1"]],
  ]);
  expect(graph.edges).toEqual([
    { from: "C-3@1", to: "C-2@1", available: true },
    { from: "C-2@1", to: "C-1@1", available: true },
  ]);
});

test("diamond traversal deduplicates publications but retains both incoming edges", async () => {
  const f = fixture(), leaf = await f.add(1), a = await f.add(2, [leaf]), b = await f.add(3, [leaf]);
  await f.add(4, [a, b]);
  expect((await f.rows("C-4@1")).length).toBe(4);
  const g = await f.read("C-4@1");
  expect(g.nodes.map((n) => n.target)).toEqual(["C-2@1", "C-3@1", "C-1@1"]);
  expect(g.edges.length).toBe(4);
  expect(g.nodes[2]?.path).toEqual(["C-4@1", "C-2@1", "C-1@1"]);
});

test("a direct edge wins over a longer path regardless of discovery order", async () => {
  const f = fixture(), leaf = await f.add(1), mid = await f.add(2, [leaf]);
  await f.add(3, [mid, leaf]);
  const g = await f.read("C-3@1");
  expect(g.nodes.find((n) => n.target === "C-1@1")?.path).toEqual(["C-3@1", "C-1@1"]);
});

test("later revisions and mutable dependency changes cannot replace publication pins", async () => {
  const f = fixture(), a = await f.add(1), b = await f.add(2, [a]);
  await f.add(3, [b]);
  await f.add(1, [], { version: 2, statement: "Entirely different later proposition." });
  const g = await f.read("C-3@1");
  expect(g.complete).toBe(true);
  expect(g.nodes.map((n) => n.target)).toEqual(["C-2@1", "C-1@1"]);
  expect(g.nodes[1]?.statement).toBe("Exact proposition number 1, version 1.");
});

test("unknown legacy dependency history is not an empty complete closure", async () => {
  const f = fixture(), leaf = await f.add(1, undefined, { extra: { dependency_pins: undefined } });
  await f.add(2, [leaf]);
  const g = await f.read("C-2@1");
  expect(g.root_available).toBe(true);
  expect(g.complete).toBe(false);
  expect(g.unavailable).toEqual(["C-1@1"]);
});

test("an explicit empty root pin list proves only an empty declared graph", async () => {
  const f = fixture(); await f.add(1);
  expect(await f.read("C-1@1")).toEqual({ root_available: true, complete: true, nodes: [], edges: [], unavailable: [] });
});

for (const change of ["redact", "hide", "tamper", "missing", "digest", "content-digest"]) {
  test(`a ${change}d premise makes the closure incomplete without exposing its statement`, async () => {
    const f = fixture(), leaf = await f.add(1), mid = await f.add(2, [leaf]);
    await f.add(3, [mid]);
    if (change === "redact") f.db.prepare("UPDATE event_content SET redacted_at = 'now' WHERE event_id = ?").run(mid.event_id);
    if (change === "hide") f.db.exec("INSERT INTO content_controls VALUES ('P-TEST', 'C-2', 'hidden', 1)");
    if (change === "tamper") f.db.prepare("UPDATE event_content SET payload_json = replace(payload_json, 'Exact', 'Forged') WHERE event_id = ?").run(mid.event_id);
    if (change === "missing") f.db.prepare("UPDATE event_content SET event_id = 'detached' WHERE event_id = ?").run(mid.event_id);
    if (change === "digest") f.db.prepare("UPDATE event_content SET payload_sha256 = ? WHERE event_id = ?").run("f".repeat(64), mid.event_id);
    if (change === "content-digest") f.db.exec("UPDATE claim_versions SET content_digest = 'sha256:bad' WHERE claim_id = 'C-2'");
    const g = await f.read("C-3@1");
    expect(g.complete).toBe(false);
    expect(g.nodes).toEqual([]);
    expect(g.unavailable).toEqual(["C-2@1"]);
  });
}

test("current redaction wins at an older cursor; restoration returns the same pinned bytes", async () => {
  const f = fixture(), leaf = await f.add(1); await f.add(2, [leaf]);
  f.db.exec("INSERT INTO content_controls VALUES ('P-TEST', 'C-1', 'hidden', 1)");
  expect((await f.read("C-2@1", 2)).complete).toBe(false);
  f.db.exec("INSERT INTO content_controls VALUES ('P-TEST', 'C-1', 'visible', 2)");
  expect((await f.read("C-2@1", 2)).complete).toBe(true);
});

for (const mode of ["private", "hidden", "future", "missing"]) {
  test(`${mode} roots expose no dependency graph`, async () => {
    const f = fixture(), a = await f.add(1); await f.add(2, [a]);
    if (mode === "private") f.db.exec("UPDATE problems SET status = 'private-draft'");
    if (mode === "hidden") f.db.exec("INSERT INTO content_controls VALUES ('P-TEST', 'problem', 'hidden', 1)");
    const g = await f.read(mode === "missing" ? "C-99@1" : "C-2@1", mode === "future" ? 1 : 2);
    expect(g.root_available).toBe(false);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  });
}

test("same local identity on another problem cannot satisfy a pin", async () => {
  const f = fixture(), foreign = await f.add(1, [], { problem: "P-OTHER" });
  await f.add(2, [foreign]);
  expect((await f.rows("C-2@1")).length).toBe(1);
  expect((await f.read("C-2@1")).unavailable).toEqual(["C-1@1"]);
});

for (const [field, value] of [["payload_digest", "a".repeat(64)], ["content_digest", `sha256:${"b".repeat(64)}`], ["version", 2], ["claim_id", "C-9"]] as const) {
  test(`a mismatched ${field} cannot lend a dependency`, async () => {
    const f = fixture(), pin = await f.add(1);
    await f.add(2, [{ ...pin, [field]: value }]);
    const g = await f.read("C-2@1");
    expect(g.complete).toBe(false); expect(g.nodes).toEqual([]);
  });
}

test("valid source bytes with a false claim identity cannot lend a child", async () => {
  const f = fixture(), pin = await f.add(1, [], { extra: { claim_id: "C-9" } });
  await f.add(2, [pin]);
  expect((await f.read("C-2@1")).complete).toBe(false);
});

test("self pins and invalid pin arrays are unknown, not complete", async () => {
  for (const pins of [null, {}, "bad", [{ claim_id: "C-1", version: 1 }]]) {
    const f = fixture(); await f.add(1, pins);
    expect((await f.read("C-1@1")).complete).toBe(false);
  }
});

test("malformed JSON fails closed without a SQL JSON exception", async () => {
  const f = fixture(), a = await f.add(1); await f.add(2, [a]);
  f.db.exec("UPDATE event_content SET payload_json = '{' WHERE event_id = 'E-1'");
  expect((await f.read("C-2@1")).complete).toBe(false);
});

test("noncausal forward references are refused even when hashes match", async () => {
  const f = fixture(), a = await f.add(1); await f.add(2, [a]);
  f.db.exec("UPDATE events SET seq = 3 WHERE id = 'E-1'");
  expect((await f.read("C-2@1")).nodes).toEqual([]);
});

test("large graphs have bounded unique candidates, a bodyless lookahead, and explicit incompleteness", async () => {
  const f = fixture(); let pin = await f.add(1);
  for (let n = 2; n <= 80; n++) pin = await f.add(n, [pin]);
  const rows = await f.rows("C-80@1");
  expect(rows.length).toBe(DEPENDENCY_CLOSURE_LIMIT + 1);
  expect(rows.at(-1)?.payload_json).toBe(null);
  expect((await f.read("C-80@1")).complete).toBe(false);
});

test("the cumulative source budget is enforced in SQL before bytes return", async () => {
  const f = fixture(); const pins = [];
  for (let n = 1; n <= 10; n++) pins.push(await f.add(n, [], { extra: { body_md: "x".repeat(40000) } }));
  await f.add(11, pins);
  const rows = await f.rows("C-11@1");
  const bytes = rows.reduce((n, row) => n + new TextEncoder().encode(row.payload_json ?? "").length, 0);
  expect(bytes <= DEPENDENCY_TOTAL_BYTES).toBe(true);
  expect(rows.some((row) => row.payload_json === null)).toBe(true);
  expect((await f.read("C-11@1")).complete).toBe(false);
});

test("an oversized source cannot expand into or expose its children", async () => {
  const f = fixture(), a = await f.add(1), b = await f.add(2, [a], { extra: { body_md: "x".repeat(DEPENDENCY_SOURCE_BYTES) } });
  await f.add(3, [b]);
  expect((await f.rows("C-3@1")).length).toBe(2);
  expect((await f.read("C-3@1")).nodes).toEqual([]);
});

test("UTF-8 source bytes, not character counts, govern the cap", async () => {
  const f = fixture(), a = await f.add(1, [], { extra: { body_md: "漢".repeat(30000) } });
  await f.add(2, [a]);
  expect((await f.rows("C-2@1"))[1]?.payload_json).toBe(null);
  expect((await f.read("C-2@1")).complete).toBe(false);
});

test("repeat reads preserve graph byte ordering", async () => {
  const f = fixture(), a = await f.add(1), b = await f.add(2, [a]); await f.add(3, [b, a]);
  expect(JSON.stringify(await f.read("C-3@1"))).toBe(JSON.stringify(await f.read("C-3@1")));
});

test("missing database results are errors rather than complete empty graphs", async () => {
  const db = { prepare() { throw new Error("storage unavailable"); } } as unknown as D1Database;
  expect(() => prepareDependencyClosure(db, "P-TEST", 1, "C-1@1")).toThrow("storage unavailable");
});

test("duplicate row identities cannot create a verified dependency", async () => {
  const f = fixture(), a = await f.add(1); await f.add(2, [a]);
  const rows = await f.rows("C-2@1");
  const duplicate = rows[1]; if (!duplicate) throw new Error("missing test row");
  const g = await composeDependencyClosure([...rows, duplicate], "P-TEST", "C-2@1");
  expect(g.complete).toBe(false); expect(g.nodes).toEqual([]);
});

test("fixed graph and byte bounds cannot silently grow", () => {
  expect(DEPENDENCY_CLOSURE_LIMIT).toBe(64);
  expect(DEPENDENCY_SOURCE_BYTES).toBe(65536);
  expect(DEPENDENCY_TOTAL_BYTES).toBe(262144);
});

test("the published problem cursor is an independent upper bound", async () => {
  const f = fixture(), a = await f.add(1); await f.add(2, [a]);
  f.db.exec("UPDATE problems SET public_seq = 1 WHERE id = 'P-TEST'");
  expect((await f.read("C-2@1", 10000)).root_available).toBe(false);
});

test("only exact canonical pins and safe numeric cursors are accepted", () => {
  const f = fixture();
  for (const target of ["C-1", "C-1@0", "C-1@01", "C-1@1\n", "C-1@1@2", "C-1@9007199254740992"])
    expect(() => prepareDependencyClosure(f.d1, "P-TEST", 1, target)).toThrow();
  for (const cursor of [-1, NaN, Infinity, 1.5, 9007199254740992])
    expect(() => prepareDependencyClosure(f.d1, "P-TEST", cursor, "C-1@1")).toThrow();
});
