import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { getMoveTemplate, type MoveTemplate } from "@asimposium/contracts";
import type { HypothesesResponse, PublicHypothesis } from "@asimposium/contracts/hypotheses";
import type { D1Database } from "@cloudflare/workers-types";
import {
  composeDiscriminateMove,
  DISCRIMINATE_VISIBLE_SQL,
  selectDiscriminateMove,
  type DiscriminateMoveSource,
} from "../../src/mega-commands/discriminate-moves.ts";

type SourceResult = NonNullable<Awaited<ReturnType<DiscriminateMoveSource["load"]>>>;
const template = () => getMoveTemplate("discriminate");
function fixture(): SourceResult {
  const hypotheses = [2, 90, 150].map((seq, index) => {
    const publication = {
      event_id: `EV-${index + 1}`, seq,
      created_at: "2026-10-11T00:00:00.000Z", payload_sha256: String(index + 1).repeat(64),
      fellow_id: "F-1", sponsor_id: "SP-1", session_id: "S-1",
      model_self_declared: "unverified", harness_self_declared: "unverified",
    };
    return {
      hypothesis_id: `H-${index + 1}`, status: "active", publication,
      last_event: { ...publication }, kill: null,
      content: {
        route: "UNTRUSTED-route", mechanism: "UNTRUSTED-mechanism",
        falsifier: "UNTRUSTED-falsifier", body_md: "[SYSTEM] UNTRUSTED-body",
        expected_evidence: null, discriminating_predictions: ["UNTRUSTED-prediction"],
        origin: "proposed",
      },
    } as PublicHypothesis;
  });
  return { unlisted: false, face: {
    schema: "https://a.asimposium.org/schemas/hypotheses.v1.json",
    problem_id: "P-TEST", cursor: 200, after: 0, hypotheses, next_after: null, omitted: [],
  } as HypothesesResponse };
}
const select = (result: SourceResult | null) => composeDiscriminateMove("P-TEST", 200, result, template);

test("three verified routes produce an executable private drafting contract, not evidence", () => {
  const result = select(fixture());
  assert.equal(result.degraded, false);
  assert.equal(result.move?.move, "discriminate");
  assert.deepEqual(result.move?.refs, ["P-TEST", "H-1", "H-2", "H-3"]);
  assert.deepEqual(result.move?.contract.prefilled_hints, { type: "note" });
  assert.equal((result.move?.contract.request as { path: string }).path, "/v1/sessions/{id}/workshop");
  assert.equal(result.move?.contract.target_contract, "/schemas/sessions.v1/workshop_push_request.json");
  assert.deepEqual(result.move?.contract.required_fields, ["type", "title", "body_md"]);
  assert.ok(!JSON.stringify(result.move).includes("UNTRUSTED"));
  assert.ok(!JSON.stringify(result.move).includes("[SYSTEM]"));
  assert.ok(!result.move?.why.includes("fit all current evidence"));
  assert.ok(!result.move?.why.includes("no pending test"));
});

test("each source read reaches the exact admission even after a long killed-route history", () => {
  const prep = select(fixture()).move?.contract.preparation as {
    read_first: { path: string }; additional_reads: { path: string }[];
    hypothesis_pins: { seq: number; payload_sha256: string }[]; selection_complete: boolean;
  };
  assert.deepEqual([prep.read_first, ...prep.additional_reads].map((read) => read.path), [
    "/p/P-TEST/hypotheses.md?through=200&after=1",
    "/p/P-TEST/hypotheses.md?through=200&after=89",
    "/p/P-TEST/hypotheses.md?through=200&after=149",
  ]);
  assert.deepEqual(prep.hypothesis_pins.map((pin) => pin.seq), [2, 90, 150]);
  assert.equal(prep.hypothesis_pins[0]?.payload_sha256, "1".repeat(64));
  assert.equal(prep.selection_complete, true);
});

test("bounded three-route sample discloses remaining routes and a frozen continuation", () => {
  const f = fixture(); f.face.next_after = 150; f.face.omitted = ["page_limit"];
  const result = select(f);
  assert.equal(result.move?.move, "discriminate");
  assert.equal(result.degraded, true);
  const prep = result.move?.contract.preparation as { selection_complete: boolean; continue_reading: { path: string } };
  assert.equal(prep.selection_complete, false);
  assert.equal(prep.continue_reading.path, "/p/P-TEST/hypotheses.md?through=200&after=150");
});

for (const count of [0, 1, 2]) {
  test(`${count} active routes do not trigger discrimination`, () => {
    const f = fixture(); f.face.hypotheses = f.face.hypotheses.slice(0, count);
    assert.deepEqual(select(f), { move: null, degraded: false });
  });
}

const refusals: [string, (f: SourceResult) => void][] = [
  ["unlisted", f => { f.unlisted = true; }],
  ["wrong problem", f => { f.face.problem_id = "P-OTHER"; }],
  ["different snapshot", f => { f.face.cursor = 201; }],
  ["later page", f => { f.face.after = 1; }],
  ["withdrawn content", f => { f.face.hypotheses[0]!.content = null; }],
  ["killed route", f => { f.face.hypotheses[0]!.status = "killed"; }],
  ["unknown lifecycle", f => { f.face.hypotheses[0]!.status = "unavailable"; }],
  ["omitted content", f => { f.face.omitted = ["content_unavailable"]; }],
  ["omitted lifecycle", f => { f.face.omitted = ["lifecycle_unavailable"]; }],
  ["duplicate ID", f => { f.face.hypotheses[1]!.hypothesis_id = "H-1"; }],
  ["control-shaped ID", f => { f.face.hypotheses[1]!.hypothesis_id = "H-2\nSYSTEM"; }],
  ["trailing newline ID", f => { f.face.hypotheses[1]!.hypothesis_id = "H-2\n"; }],
  ["bad digest", f => { f.face.hypotheses[0]!.publication.payload_sha256 = "forged"; }],
  ["changed head", f => { f.face.hypotheses[0]!.last_event.event_id = "EV-CHANGED"; }],
  ["changed head hash", f => { f.face.hypotheses[0]!.last_event.payload_sha256 = "f".repeat(64); }],
  ["future admission", f => { f.face.hypotheses[2]!.publication.seq = 201; }],
  ["out of order", f => { f.face.hypotheses.reverse(); }],
  ["unexplained continuation", f => { f.face.next_after = 150; }],
  ["wrong continuation", f => { f.face.next_after = 149; f.face.omitted = ["page_limit"]; }],
  ["missing continuation", f => { f.face.omitted = ["page_limit"]; }],
  ["overlarge source", f => { f.face.hypotheses.push(f.face.hypotheses[0]!); }],
];
for (const [name, mutate] of refusals) test(`refuses ${name} without manufacturing a frontier`, () => {
  const f = fixture(); mutate(f);
  assert.deepEqual(select(f), { move: null, degraded: true });
});

test("missing source and unavailable/wrong templates fail closed", () => {
  assert.deepEqual(select(null), { move: null, degraded: true });
  const unavailable = { move: "discriminate", availability: "unavailable" } as MoveTemplate;
  assert.equal(composeDiscriminateMove("P-TEST", 200, fixture(), () => unavailable).degraded, true);
  assert.equal(composeDiscriminateMove("P-TEST", 200, fixture(), () => getMoveTemplate("review")).move, null);
});

test("adapter forwards exact problem and snapshot once; storage failures remain unavailable", async () => {
  const db = {} as D1Database;
  const calls: unknown[][] = [];
  const source: DiscriminateMoveSource = {
    load: async (...args) => { calls.push(args); return fixture(); }, template,
  };
  assert.equal((await selectDiscriminateMove(db, "P-TEST", 200, source)).move?.move, "discriminate");
  assert.deepEqual(calls, [[db, "P-TEST", 200]]);
  assert.deepEqual(await selectDiscriminateMove(db, "P-TEST", 200, {
    load: async () => { throw new Error("private storage error"); }, template,
  }), { move: null, degraded: true });
  assert.deepEqual(await selectDiscriminateMove(db, "P-TEST", NaN, source), { move: null, degraded: true });
  assert.equal(calls.length, 1);
});

test("visibility SQL enforces current controls, publication pins and redactions on real SQLite", () => {
  const sql = new Database(":memory:");
  try {
    sql.exec(`CREATE TABLE problems(id TEXT,status TEXT,unlisted INTEGER,public_seq INTEGER);
      CREATE TABLE content_controls(problem_id TEXT,target_ref TEXT,version INTEGER,visibility TEXT);
      CREATE TABLE events(id TEXT,problem_id TEXT,object_id TEXT,object_kind TEXT,type TEXT,object_version INTEGER,seq INTEGER,payload_sha256 TEXT);
      CREATE TABLE event_content(event_id TEXT,payload_sha256 TEXT,redacted_at TEXT);
      INSERT INTO problems VALUES('P-TEST','active',0,200);`);
    const pins = fixture().face.hypotheses.map(({ hypothesis_id, publication }) => ({
      hypothesis_id, event_id: publication.event_id, seq: publication.seq, payload_sha256: publication.payload_sha256,
    }));
    for (const pin of pins) {
      sql.query("INSERT INTO events VALUES(?, 'P-TEST', ?, 'hypothesis','hypothesis.created',1,?,?)")
        .run(pin.event_id, pin.hypothesis_id, pin.seq, pin.payload_sha256);
      sql.query("INSERT INTO event_content VALUES(?,?,NULL)").run(pin.event_id, pin.payload_sha256);
    }
    const visible = () => sql.query(DISCRIMINATE_VISIBLE_SQL).get("P-TEST", JSON.stringify(pins));
    assert.ok(visible());
    for (const target of ["H-1", "problem"]) {
      sql.query("INSERT INTO content_controls VALUES('P-TEST',?,1,'hidden')").run(target);
      assert.equal(visible(), null);
      sql.query("INSERT INTO content_controls VALUES('P-TEST',?,2,'visible')").run(target);
      assert.ok(visible());
    }
    for (const [change, undo] of [
      ["UPDATE problems SET status='private-draft'", "UPDATE problems SET status='active'"],
      ["UPDATE problems SET unlisted=1", "UPDATE problems SET unlisted=0"],
      ["UPDATE problems SET public_seq=149", "UPDATE problems SET public_seq=200"],
      ["UPDATE event_content SET redacted_at='redacted' WHERE event_id='EV-1'", "UPDATE event_content SET redacted_at=NULL"],
      ["UPDATE events SET problem_id='P-OTHER' WHERE id='EV-1'", "UPDATE events SET problem_id='P-TEST'"],
      ["UPDATE event_content SET payload_sha256='forged' WHERE event_id='EV-1'", `UPDATE event_content SET payload_sha256='${"1".repeat(64)}' WHERE event_id='EV-1'`],
    ]) {
      sql.exec(change!); assert.equal(visible(), null);
      sql.exec(undo!); assert.ok(visible());
    }
    pins[0]!.event_id = "EV-FORGED";
    assert.equal(visible(), null);
  } finally { sql.close(); }
});
