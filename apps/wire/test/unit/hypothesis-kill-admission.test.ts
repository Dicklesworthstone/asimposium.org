import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../../../../db/migrations/0099_hypothesis_kill_admission.sql", import.meta.url), "utf8");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const instant = "2026-10-16T00:00:00.000Z";

// The unchanged migration runs over SQLite with the production columns. This
// isolates the settlement invariant; it is not a full D1/migration-chain test.
function fixture(install = true) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER, payload_sha256 TEXT,
      created_at TEXT, actor_fellow_id TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE hypotheses(problem_id TEXT, hypothesis_id TEXT, source_event_id TEXT,
      source_seq INTEGER, status TEXT, kill_event_id TEXT, kill_source_seq INTEGER,
      killed_at TEXT, killed_by_evidence_id TEXT, kill_reason TEXT, PRIMARY KEY(problem_id,hypothesis_id));
    CREATE TABLE evidence(problem_id TEXT, evidence_id TEXT, source_event_id TEXT,
      source_seq INTEGER, bears_on_kind TEXT, bears_on_id TEXT, direction TEXT, PRIMARY KEY(problem_id,evidence_id));
    CREATE TABLE idempotency(problem_id TEXT, idempotency_key TEXT, event_id TEXT, event_seq INTEGER,
      PRIMARY KEY(problem_id,idempotency_key));
    CREATE TABLE scientific_withdrawals(source_event_id TEXT);
    CREATE TABLE content_controls(problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    CREATE TABLE retractions(problem_id TEXT, retraction_id TEXT, seq INTEGER, target_object TEXT);
    CREATE TABLE effects(kind TEXT, event_id TEXT);
    INSERT INTO problems VALUES('P-DEMO',2,'active'),('P-OTHER',2,'active');
  `);
  function event(id: string, seq: number, type: string, object: string, body: unknown,
    problem = "P-DEMO", author = "F-AUTHOR") {
    const kind = type.startsWith("hypothesis.") ? "hypothesis" : type.startsWith("evidence.") ? "evidence" : "retraction";
    const text = JSON.stringify(body), digest = hash(text);
    db.query("INSERT INTO events VALUES(?,?,?,?,?,?,1,?,?,?)").run(id, problem, seq, type, kind, object, digest, instant, author);
    db.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(id, digest, text);
  }
  event("origin", 1, "hypothesis.created", "H-1", { route: "Enumeration", falsifier: "A nonzero residual" });
  event("source", 2, "evidence.created", "E-1", { bears_on_kind: "hypothesis", bears_on_id: "H-1", direction: "refutes", body_md: "The residual is nonzero." }, "P-DEMO", "F-REVIEWER");
  db.exec(`INSERT INTO hypotheses VALUES('P-DEMO','H-1','origin',1,'open',NULL,NULL,NULL,NULL,NULL);
    INSERT INTO evidence VALUES('P-DEMO','E-1','source',2,'hypothesis','H-1','refutes');`);
  if (install) db.exec(migration);
  function control(target: string, visibility = "hidden", problem = "P-DEMO") {
    db.query(`INSERT INTO content_controls SELECT ?,?,?,COALESCE(MAX(version),0)+1
      FROM content_controls WHERE problem_id=? AND target_ref=?`).run(problem,target,visibility,problem,target);
  }
  function body(eventId: string, value: unknown) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    db.query("UPDATE event_content SET payload_json=?,payload_sha256=? WHERE event_id=?").run(text,hash(text),eventId);
    db.query("UPDATE events SET payload_sha256=? WHERE id=?").run(hash(text),eventId);
  }
  function kill(patch: Record<string, unknown> = {}, beforeSettlement?: () => void) {
    db.exec("BEGIN");
    try {
      db.exec("INSERT INTO idempotency VALUES('P-DEMO','write',NULL,NULL); UPDATE problems SET public_seq=10 WHERE id='P-DEMO';");
      event("kill", 10, "hypothesis.killed", "H-1", { hypothesis_id: "H-1", killed_by_evidence_id: "E-1", reason: "The measured residual contradicts this route.", ...patch });
      db.exec(`UPDATE hypotheses SET status='killed',kill_event_id='kill',kill_source_seq=10,
        killed_at='${instant}',killed_by_evidence_id='E-1',kill_reason='The measured residual contradicts this route.'
        WHERE problem_id='P-DEMO' AND hypothesis_id='H-1';
        INSERT INTO effects VALUES('checkpoint','kill'),('quota','kill'),('outbox','kill');`);
      beforeSettlement?.();
      // Bun 1.3.8 can suppress an earlier statement's ABORT when exec is given
      // multiple statements. Keep the real settlement failure observable so
      // this fixture rolls back as a D1 batch does.
      db.exec("UPDATE idempotency SET event_id='kill',event_seq=10 WHERE idempotency_key='write'");
      db.exec("INSERT INTO effects VALUES('receipt','kill')");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function snapshot() {
    return ["problems","events","event_content","hypotheses","evidence","idempotency","effects","scientific_withdrawals","content_controls"].map(table => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
  }
  function refused(patch: Record<string, unknown> = {}, before?: () => void) {
    const old = snapshot();
    assert.throws(() => kill(patch,before), /HYPOTHESIS_KILL_SOURCE_INVALID/);
    assert.deepEqual(snapshot(), old, "all event/projection/cursor/checkpoint/quota/outbox/replay effects roll back");
  }
  return { db, event, control, body, kill, refused, snapshot, close: () => db.close() };
}
const use = (run: (f: ReturnType<typeof fixture>) => void) => {
  const f = fixture(); try { run(f); } finally { f.close(); }
};

test("the complete evidence-backed elimination settles exactly once", () => use(f => {
  f.kill();
  assert.deepEqual(f.db.query("SELECT * FROM idempotency").all(), [{problem_id:"P-DEMO",idempotency_key:"write",event_id:"kill",event_seq:10}]);
  assert.equal(f.db.query("SELECT * FROM effects").all().length,4);
  assert.equal(f.db.query("SELECT * FROM events WHERE type='hypothesis.killed'").all().length,1);
}));

for (const target of ["problem","H-1","H-1@1","#1","E-1","E-1@1","#2","#10"]) {
  test(`current ${target} hide refuses and a scoped restore permits elimination`, () => use(f => {
    f.control(target); f.refused(); f.control(target,"visible"); f.kill();
  }));
  test(`a ${target} control in another problem cannot change this outcome`, () => use(f => {
    f.control(target,"hidden","P-OTHER"); f.kill();
  }));
}
test("restoring the source object cannot override its hidden event", () => use(f => {
  f.control("E-1"); f.control("#2"); f.control("E-1","visible"); f.refused();
  f.control("#2","visible"); f.kill();
}));
test("unrelated versions and events do not close the exact sources", () => use(f => {
  for (const target of ["H-1@2","E-1@2","#3","E-2"]) f.control(target);
  f.kill();
}));

for (const id of ["origin","source"]) {
  for (const mode of ["redacted","missing","digest","invalid-json","empty","oversize","withdrawn"] as const) {
    test(`${mode} ${id} cannot back a new elimination`, () => use(f => {
      if(mode==="redacted") f.db.query("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(id);
      if(mode==="missing") f.db.query("DELETE FROM event_content WHERE event_id=?").run(id);
      if(mode==="digest") f.db.query("UPDATE event_content SET payload_sha256='different' WHERE event_id=?").run(id);
      if(mode==="invalid-json") f.body(id,"{invalid");
      if(mode==="empty") f.body(id,{});
      if(mode==="oversize") f.body(id,{falsifier:"f",bears_on_kind:"hypothesis",bears_on_id:"H-1",direction:"refutes",body_md:"x".repeat(524289)});
      if(mode==="withdrawn") f.db.query("INSERT INTO scientific_withdrawals VALUES(?)").run(id);
      f.refused();
    }));
  }
}
for(const patch of [{bears_on_kind:"claim"},{bears_on_id:"H-2"},{direction:"supports"},{direction:"informs"},{body_md:" "}]) {
  test(`projection cannot override immutable evidence ${JSON.stringify(patch)}`, () => use(f => {
    f.body("source",{bears_on_kind:"hypothesis",bears_on_id:"H-1",direction:"refutes",body_md:"actual observation",...patch}); f.refused();
  }));
}
for(const sql of [
  "UPDATE events SET problem_id='P-OTHER' WHERE id='source'",
  "UPDATE events SET object_version=2 WHERE id='source'",
  "UPDATE events SET type='review.created' WHERE id='source'",
  "UPDATE events SET object_kind='claim' WHERE id='source'",
  "UPDATE events SET seq=11 WHERE id='source'",
  "UPDATE events SET seq=1 WHERE id='source'",
  "UPDATE hypotheses SET source_event_id=NULL",
  "UPDATE evidence SET source_event_id=NULL",
  "UPDATE evidence SET direction='supports'",
  "UPDATE evidence SET bears_on_id='H-2'",
]) test(`exact event/projection binding refuses ${sql}`, () => use(f => { f.db.exec(sql); f.refused(); }));
for(const status of ["private-draft","resolved","retired"]) test(`${status} problems cannot be eliminated`, () => use(f => {
  f.db.query("UPDATE problems SET status=? WHERE id='P-DEMO'").run(status); f.refused();
}));
for(const patch of [{hypothesis_id:"H-2"},{killed_by_evidence_id:"E-2"},{killed_by_evidence_id:null},{reason:""},{reason:" ".repeat(20)}]) {
  test(`invalid elimination payload refuses ${JSON.stringify(patch)}`, () => use(f => f.refused(patch)));
}
test("malformed elimination JSON is refused without escaping the named invariant", () => use(f => f.refused({}, () => f.body("kill","{"))));
test("a missing or inconsistent projection aborts at settlement", () => use(f => f.refused({}, () => f.db.exec("UPDATE hypotheses SET kill_source_seq=9"))));
test("an incorrect settlement sequence aborts", () => use(f => f.refused({}, () => f.db.exec("UPDATE events SET seq=9 WHERE id='kill'"))));

test("an earlier authoritative elimination survives a forged open projection", () => use(f => {
  f.event("prior",5,"hypothesis.killed","H-1",{hypothesis_id:"H-1",killed_by_evidence_id:"E-1",reason:"Already eliminated"}); f.refused();
}));
for(const target of ["H-1","H-1@1","E-1","E-1@1"]) test(`author withdrawal of ${target} refuses new elimination`, () => use(f => {
  f.event("retracted",5,"object.retracted","RET-5",{target_object:target},"P-DEMO",target.startsWith("H")?"F-AUTHOR":"F-REVIEWER");
  f.db.query("INSERT INTO retractions VALUES('P-DEMO','RET-5',5,?)").run(target); f.refused();
}));
test("a foreign author's retraction cannot erase a source", () => use(f => {
  f.event("retracted",5,"object.retracted","RET-5",{target_object:"E-1"},"P-DEMO","F-OTHER");
  f.db.exec("INSERT INTO retractions VALUES('P-DEMO','RET-5',5,'E-1')"); f.kill();
}));
test("duplicate source envelopes are not arbitrarily resolved", () => use(f => {
  f.event("duplicate",3,"evidence.created","E-1",{bears_on_kind:"hypothesis",bears_on_id:"H-1",direction:"refutes",body_md:"duplicate"}); f.refused();
}));
for (const sequence of [1, 10, 11]) {
  test(`a consistently projected source at ${sequence} must still precede elimination and follow the hypothesis`, () => use(f => {
    f.db.query("UPDATE events SET seq=? WHERE id='source'").run(sequence);
    f.db.query("UPDATE evidence SET source_seq=? WHERE evidence_id='E-1'").run(sequence);
    f.refused();
  }));
}
for (const kind of ["hypothesis", "evidence"] as const) {
  for (const damage of ["missing-body", "redacted", "invalid-version"]) {
    test(`an unavailable duplicate ${kind} ${damage} cannot hide ambiguous history`, () => use(f => {
      f.event("duplicate", 4, `${kind}.created`, kind === "hypothesis" ? "H-1" : "E-1", {});
      if (damage === "missing-body") f.db.exec("DELETE FROM event_content WHERE event_id='duplicate'");
      if (damage === "redacted") f.db.exec("UPDATE event_content SET redacted_at='now' WHERE event_id='duplicate'");
      if (damage === "invalid-version") f.db.exec("UPDATE events SET object_version=2 WHERE id='duplicate'");
      f.refused();
    }));
  }
}
for (const id of ["origin", "source"]) {
  test(`${id} permits exactly 512 KiB of valid UTF-8 source but not one more byte`, () => use(f => {
    const base = id === "origin"
      ? { falsifier: "A nonzero residual", padding: "" }
      : { bears_on_kind: "hypothesis", bears_on_id: "H-1", direction: "refutes", body_md: "Actual observation", padding: "" };
    const room = 524288 - new TextEncoder().encode(JSON.stringify(base)).byteLength;
    const body = { ...base, padding: "é".repeat(Math.floor(room / 2)) + "x".repeat(room % 2) };
    assert.equal(new TextEncoder().encode(JSON.stringify(body)).byteLength, 524288);
    f.body(id, { ...body, padding: body.padding + "x" }); f.refused();
    f.body(id, body); f.kill();
  }));
}
test("late source withdrawal rolls back the complete command", () => use(f => f.refused({}, () => f.db.exec("INSERT INTO scientific_withdrawals VALUES('source')"))));
test("already-settled receipts remain recoverable after a source hide", () => use(f => {
  f.kill(); f.control("E-1");
  const before=f.snapshot();
  f.db.exec("UPDATE idempotency SET event_id='kill',event_seq=10 WHERE idempotency_key='write'");
  assert.deepEqual(f.snapshot(),before);
}));
test("installing the guard never rewrites historical eliminated rows", () => {
  const f=fixture(false); try { f.kill(); f.control("E-1"); const before=f.snapshot(); f.db.exec(migration); assert.deepEqual(f.snapshot(),before); } finally { f.close(); }
});
test("ledger-only restoration is not a new publication admission", () => use(f => {
  f.control("E-1"); f.event("historical",5,"hypothesis.killed","H-1",{hypothesis_id:"H-1",killed_by_evidence_id:"E-1",reason:"Retained history"});
  assert.equal(f.db.query("SELECT * FROM events WHERE id='historical'").all().length,1);
}));
test("unrelated write settlement does not invoke the hypothesis invariant", () => use(f => {
  f.control("problem"); f.db.exec("INSERT INTO idempotency VALUES('P-DEMO','other',NULL,NULL)");
  f.event("unrelated",3,"evidence.created","E-2",{body_md:"another work product"});
  f.db.exec("UPDATE idempotency SET event_id='unrelated',event_seq=3 WHERE idempotency_key='other'");
}));
