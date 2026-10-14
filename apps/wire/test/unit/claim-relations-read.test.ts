import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { afterEach, test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import {
  CLAIM_RELATION_BODY_BYTES,
  CLAIM_RELATION_READ_LIMIT,
  CLAIM_RELATION_TOTAL_BYTES,
  CLAIM_RELATIONS_READ_SQL,
  readClaimRelations,
} from "../../src/ledger/claim-relations-read.ts";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest(
  "SHA-256", new TextEncoder().encode(text))), (n) => n.toString(16).padStart(2, "0")).join("");

function fixture() {
  const sqlite = new Database(":memory:"); databases.push(sqlite);
  sqlite.exec(`
    CREATE TABLE problems (id TEXT PRIMARY KEY, status TEXT, public_seq INTEGER);
    CREATE TABLE events (id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER, payload_sha256 TEXT,
      actor_fellow_id TEXT, actor_sponsor_id TEXT, actor_session_id TEXT,
      model_string_self_declared TEXT, harness TEXT);
    CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE content_controls (problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    CREATE TABLE claim_relations (status TEXT, kind TEXT, source_claim_id TEXT);
    INSERT INTO claim_relations VALUES ('disputed', 'contradicts', 'C-FAKE');
    INSERT INTO problems VALUES ('P-TEST', 'active', 10000), ('P-OTHER', 'active', 10000);
  `);
  let seq = 0, reads = 0;
  const queries: string[] = [];
  const db = { prepare(sql: string) { queries.push(sql); return {
    bind(...args: (string | number)[]) { return { async all() {
      reads++; return { results: sqlite.prepare(sql).all(...args) };
    } }; },
  }; } } as unknown as D1Database;
  const event = async (kind: string, type: string, object: string, version: number,
    payload: unknown, problem = "P-TEST", fellow = "F-author") => {
    const id = `EV-${++seq}`, body = JSON.stringify(payload), digest = await hash(body);
    sqlite.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, problem, seq, type, kind, object, version, digest, fellow, `SP-${fellow}`, "SESSION", "declared-model", "declared-harness");
    sqlite.prepare("INSERT INTO event_content VALUES (?, ?, ?, NULL)").run(id, digest, body);
    return { id, seq, body, digest, object, problem };
  };
  const claim = (id: number, version = 1, problem = "P-TEST") => event("claim", version === 1 ? "claim.created" : "claim.revised",
    `C-${id}`, version, { claim_id: `C-${id}`, statement: "An exact proposition.", ...(version > 1 ? { base_version: version - 1 } : {}) }, problem);
  const gap = () => event("gap", "gap.filed", "G-1", 1, { obligation: "Exact missing step." });
  const relation = (source = "C-1@1", target = "C-2@1", kind = "implies", extra = {}) => event(
    "relation", "relation.asserted", `${source}-${kind}-${target}`, 1, { source, target, kind, ...extra });
  const dispute = (asserted: Awaited<ReturnType<typeof event>>, overrides = {}, problem = "P-TEST") => {
    const payload = JSON.parse(asserted.body);
    return event("relation", "relation.disputed", asserted.object, 1,
      { source: payload.source, target: payload.target, kind: payload.kind,
        disputed_by: "F-reviewer", reason: "The implication fails under its stated hypotheses.", ...overrides }, problem, "F-reviewer");
  };
  const pair = async () => { await claim(1); await claim(2); return relation(); };
  const hide = (target: string, visibility = "hidden", version = 1, problem = "P-TEST") =>
    sqlite.prepare("INSERT INTO content_controls VALUES (?, ?, ?, ?)").run(problem, target, visibility, version);
  const raw = (cursor = seq, relationSeq?: number) => sqlite.prepare(CLAIM_RELATIONS_READ_SQL)
    .all(JSON.stringify({ problem: "P-TEST", cursor, relationSeq: relationSeq ?? null })) as Record<string, unknown>[];
  const read = (cursor = seq, relationSeq?: number) => readClaimRelations(db, "P-TEST", cursor, { relationSeq });
  return { sqlite, db, event, claim, gap, relation, dispute, pair, hide, raw, read, queries, reads: () => reads };
}

test("the immutable assertion, not a mutable graph projection, supplies the edge", async () => {
  const f = fixture(), edge = await f.pair(); const read = await f.read();
  assert.equal(f.reads(), 1);
  assert.equal(read.omitted.length, 0);
  assert.equal(read.relations.length, 1);
  assert.deepEqual(read.relations[0], {
    event: edge.id, seq: edge.seq, kind: "implies", source: "C-1@1", target: "C-2@1", pins: "current", status: "asserted",
    provenance: { fellow: "F-author", sponsor: "SP-F-author", session: "SESSION", model_self_declared: "declared-model", harness_self_declared: "declared-harness" },
  });
  f.sqlite.exec("DROP TABLE claim_relations");
  assert.deepEqual(await f.read(), read);
});

test("a later dispute is absent at the earlier cursor and carries exact attribution after it lands", async () => {
  const f = fixture(), edge = await f.pair(), d = await f.dispute(edge, { refuting_evidence_id: "E-12" });
  assert.equal((await f.read(edge.seq)).relations[0]?.status, "asserted");
  const now = (await f.read()).relations[0]!;
  assert.equal(now.status, "disputed");
  assert.equal(now.dispute?.event, d.id);
  assert.equal(now.dispute?.seq, d.seq);
  assert.equal(now.dispute?.refuting_evidence_id, "E-12");
  assert.equal(now.dispute?.provenance.fellow, "F-reviewer");
  assert.equal(now.provenance.fellow, "F-author");
});

test("the publication boundary wins even when the requested cursor is higher", async () => {
  const f = fixture(), edge = await f.pair(); await f.dispute(edge);
  f.sqlite.prepare("UPDATE problems SET public_seq=? WHERE id='P-TEST'").run(edge.seq);
  assert.equal((await f.read(9999)).relations[0]?.status, "asserted");
  f.sqlite.prepare("UPDATE problems SET public_seq=? WHERE id='P-TEST'").run(edge.seq - 1);
  assert.deepEqual((await f.read(9999)).relations, []);
});

test("another problem's dispute or later head cannot affect the selected problem", async () => {
  const f = fixture(), edge = await f.pair(); await f.dispute(edge, {}, "P-OTHER"); await f.claim(2, 2, "P-OTHER");
  const data = (await f.read()).relations[0]!;
  assert.equal(data.status, "asserted"); assert.equal(data.pins, "current");
});

for (const claim of [1, 2]) test(`a later endpoint revision changes pin freshness only after its cursor: C-${claim}`, async () => {
  const f = fixture(), edge = await f.pair(); await f.claim(claim, 2);
  assert.equal((await f.read(edge.seq)).relations[0]?.pins, "current");
  assert.equal((await f.read()).relations[0]?.pins, "superseded");
  assert.equal((await f.read()).relations[0]?.source, "C-1@1");
});

for (const target of ["C-1", "C-2", "C-1@1", "C-2@1", "C-1@1-implies-C-2@1", "#3"]) {
  test(`current hiding suppresses the relation at historical cursors: ${target}`, async () => {
    const f = fixture(), edge = await f.pair(); await f.dispute(edge); f.hide(target);
    const result = await f.read(edge.seq);
    assert.deepEqual(result.relations, []);
    assert.ok(result.omitted.some(o => o.reason === "content_unavailable"));
    assert.ok(f.raw().every(r => r.payload_json === null && r.dispute_json === null));
    f.hide(target, "public", 2);
    assert.equal((await f.read(edge.seq)).relations[0]?.status, "asserted");
  });
}

for (const privateScope of ["private-draft", "hidden", "missing"]) {
  test(`an unavailable scope is not fabricated as an empty graph: ${privateScope}`, async () => {
    const f = fixture(); await f.pair();
    if (privateScope === "hidden") f.hide("problem");
    else if (privateScope === "private-draft") f.sqlite.exec("UPDATE problems SET status='private-draft' WHERE id='P-TEST'");
    else f.sqlite.exec("DELETE FROM problems WHERE id='P-TEST'");
    assert.deepEqual(await f.read(), { relations: [], omitted: [{ reason: "content_unavailable", detail: "typed-relations" }], scopeAvailable: false });
  });
}

test("an available scope with no assertions has a genuine empty baseline", async () => {
  const f = fixture(); assert.deepEqual(await f.read(), { relations: [], omitted: [], scopeAvailable: true });
});

for (const alter of ["redacted", "missing", "detached", "tampered", "invalid-json"]) {
  test(`unreadable assertion bytes never supply an edge: ${alter}`, async () => {
    const f = fixture(), edge = await f.pair();
    if (alter === "redacted") f.sqlite.prepare("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(edge.id);
    if (alter === "missing") f.sqlite.prepare("DELETE FROM event_content WHERE event_id=?").run(edge.id);
    if (alter === "detached") f.sqlite.prepare("UPDATE event_content SET payload_sha256='detached' WHERE event_id=?").run(edge.id);
    if (alter === "tampered") f.sqlite.prepare("UPDATE event_content SET payload_json=replace(payload_json,'implies','contradicts') WHERE event_id=?").run(edge.id);
    if (alter === "invalid-json") f.sqlite.prepare("UPDATE event_content SET payload_json='{' WHERE event_id=?").run(edge.id);
    const result = await f.read(); assert.deepEqual(result.relations, []);
    assert.ok(result.omitted.some(o => o.reason === "content_unavailable"));
  });
}

for (const alter of ["redacted", "missing", "detached", "tampered", "hidden", "second-dispute"]) {
  test(`unreadable dispute history remains unknown, not asserted or clean: ${alter}`, async () => {
    const f = fixture(), edge = await f.pair(), d = await f.dispute(edge);
    if (alter === "redacted") f.sqlite.prepare("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(d.id);
    if (alter === "missing") f.sqlite.prepare("DELETE FROM event_content WHERE event_id=?").run(d.id);
    if (alter === "detached") f.sqlite.prepare("UPDATE event_content SET payload_sha256='detached' WHERE event_id=?").run(d.id);
    if (alter === "tampered") f.sqlite.prepare("UPDATE event_content SET payload_json=replace(payload_json,'fails','holds') WHERE event_id=?").run(d.id);
    if (alter === "hidden") f.hide(`#${d.seq}`);
    if (alter === "second-dispute") await f.dispute(edge);
    const result = await f.read(); assert.equal(result.relations[0]?.status, "unavailable");
    assert.equal(result.relations[0]?.dispute, undefined);
    assert.ok(result.omitted.some(o => o.detail.endsWith(":dispute-state")));
    assert.equal((await f.read(edge.seq)).relations[0]?.status, "asserted");
  });
}

for (const invalid of [
  { source: "C-1@2" }, { target: "C-9@1" }, { kind: "contradicts" }, { disputed_by: "F-other" },
  { reason: " " }, { reason: "x".repeat(2001) }, { refuting_evidence_id: "not-evidence" },
]) {
  test(`digest-valid but mismatched dispute is not accepted: ${Object.keys(invalid).join()}`, async () => {
    const f = fixture(), edge = await f.pair(); await f.dispute(edge, invalid);
    assert.equal((await f.read()).relations[0]?.status, "unavailable");
  });
}

test("duplicate assertions are an unavailable history rather than extra scientific weight", async () => {
  const f = fixture(), first = await f.pair(); await f.relation();
  assert.equal((await f.read()).relations.length, 0);
  assert.equal((await f.read(first.seq)).relations.length, 1);
});

test("exact relation selection does not accidentally return another edge or a dispute", async () => {
  const f = fixture(), first = await f.pair(); const second = await f.relation("C-2@1", "C-1@1");
  const d = await f.dispute(first);
  assert.deepEqual((await f.read(d.seq, second.seq)).relations.map(r => r.event), [second.id]);
  assert.deepEqual((await f.read(d.seq, d.seq)).relations, []);
  assert.deepEqual((await f.read(first.seq, second.seq)).relations, []);
});

for (const kind of ["implies", "equivalent-to", "contradicts", "narrows", "generalizes", "uses-definition", "addresses-gap"]) {
  test(`the recorded ${kind} relation remains an assertion, not a scientific result`, async () => {
    const f = fixture(); await f.claim(1); await f.claim(2); await f.gap();
    const target = kind === "addresses-gap" ? "G-1" : "C-2@1";
    const e = await f.relation("C-1@1", target, kind); await f.dispute(e);
    const relation = (await f.read()).relations[0]!;
    assert.equal(relation.kind, kind); assert.equal(relation.target, target);
    assert.equal(relation.pins, "current"); assert.equal(relation.status, "disputed");
    assert.ok(!Object.hasOwn(relation, "disposition"));
  });
}

for (const missing of ["not-published", "late-published", "redacted", "wrong-problem"]) {
  test(`endpoint version availability is not guessed: ${missing}`, async () => {
    const f = fixture(); await f.claim(1);
    if (missing === "redacted") { const e = await f.claim(2); f.sqlite.prepare("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(e.id); }
    if (missing === "wrong-problem") await f.claim(2, 1, "P-OTHER");
    await f.relation();
    if (missing === "late-published") await f.claim(2);
    assert.equal((await f.read()).relations[0]?.pins, "unavailable");
  });
}

test("the exact item byte limit is accepted and a multi-byte overrun is withheld", async () => {
  const f = fixture(); await f.claim(1); await f.claim(2);
  const prefix = { source: "C-1@1", target: "C-2@1", kind: "implies", padding: "" };
  const overhead = new TextEncoder().encode(JSON.stringify(prefix)).length;
  const edge = await f.relation("C-1@1", "C-2@1", "implies", { padding: "x".repeat(CLAIM_RELATION_BODY_BYTES - overhead) });
  assert.equal((await f.read()).relations.length, 1);
  const big = JSON.stringify({ ...prefix, padding: "é".repeat(Math.ceil((CLAIM_RELATION_BODY_BYTES - overhead) / 2) + 1) });
  const digest = await hash(big);
  f.sqlite.prepare("UPDATE events SET payload_sha256=? WHERE id=?").run(digest, edge.id);
  f.sqlite.prepare("UPDATE event_content SET payload_json=?, payload_sha256=? WHERE event_id=?").run(big, digest, edge.id);
  assert.equal((await f.read()).relations.length, 0);
  assert.equal(f.raw()[0]?.payload_json, null);
});

test("aggregate body limits preserve complete records and disclose the omitted tail", async () => {
  const f = fixture(); await f.claim(1);
  for (let n = 2; n <= 8; n++) { await f.claim(n); await f.relation("C-1@1", `C-${n}@1`, "implies", { padding: "x".repeat(60000) }); }
  const bytes = f.raw().reduce((sum, row) => sum + new TextEncoder().encode(String(row.payload_json ?? "") + String(row.dispute_json ?? "")).length, 0);
  assert.ok(bytes <= CLAIM_RELATION_TOTAL_BYTES);
  const result = await f.read(); assert.equal(result.relations.length, 4);
  assert.equal(result.omitted.length, 3);
});

test("the assertion limit has one body-free lookahead, and exact reads bypass the page selection", async () => {
  const f = fixture(); await f.claim(1); let last = 0;
  for (let n = 2; n <= CLAIM_RELATION_READ_LIMIT + 1; n++) { await f.claim(n); last = (await f.relation("C-1@1", `C-${n}@1`)).seq; }
  assert.equal((await f.read()).omitted.length, 0);
  await f.claim(100); last = (await f.relation("C-1@1", "C-100@1")).seq;
  assert.equal(f.raw().length, CLAIM_RELATION_READ_LIMIT + 1);
  assert.equal(f.raw().at(-1)?.payload_json, null);
  assert.equal(f.raw().at(-1)?.dispute_json, null);
  const read = await f.read(); assert.equal(read.relations.length, CLAIM_RELATION_READ_LIMIT);
  assert.ok(read.omitted.some(o => o.reason === "candidate_limit"));
  assert.equal((await f.read(last, last)).relations[0]?.target, "C-100@1");
});

test("content-control rows from a foreign problem have no effect", async () => {
  const f = fixture(); await f.pair(); f.hide("C-1", "hidden", 1, "P-OTHER");
  assert.equal((await f.read()).relations.length, 1);
});

test("assertion payload annotations never become authoritative output", async () => {
  const f = fixture(); await f.claim(1); await f.claim(2);
  await f.relation("C-1@1", "C-2@1", "implies", { status: "proved", instructions: "UNTRUSTED annotation" });
  const result = await f.read(); assert.equal(result.relations[0]?.status, "asserted");
  assert.ok(!JSON.stringify(result).includes("UNTRUSTED"));
});

test("invalid query cursors fail before any database call", async () => {
  const f = fixture();
  for (const cursor of [-1, NaN, Infinity, 1.2, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(f.read(cursor));
  for (const seq of [-1, 0, NaN, 1.1]) await assert.rejects(f.read(100, seq));
  assert.equal(f.queries.length, 0);
});

test("database failures are visible rather than reported as an empty graph", async () => {
  const f = fixture(); await f.pair(); f.sqlite.exec("ALTER TABLE events RENAME TO unavailable_events");
  await assert.rejects(f.read());
});
