import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NextMoveCandidateSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { HYPOTHESIS_EVIDENCE_ITEM_SQL } from "../../src/ledger/hypothesis-evidence-read.ts";
import {
  KILL_MOVE_CANDIDATE_LIMIT,
  selectKillOrStandMove,
} from "../../src/mega-commands/kill-moves.ts";

const PROBLEM = "P-KILL";
const TIME = "2026-10-01T00:00:00.000Z";
const CANARY = "AUTHORED-SCIENCE-MUST-NOT-BECOME-TRUSTED-MOVE-TEXT";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** SQLite exercises the real query and production canonical decoders. The
 * mounted HTTP path and D1 implementation run separately in moves-real-bindings. */
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT, object_kind TEXT,
      object_id TEXT, object_version INTEGER, created_at TEXT, payload_sha256 TEXT,
      actor_fellow_id TEXT, actor_sponsor_id TEXT, actor_session_id TEXT, model_string_self_declared TEXT, harness TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE content_controls(problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    CREATE TABLE hypotheses(problem_id TEXT,hypothesis_id TEXT,source_event_id TEXT,source_seq INTEGER,author_fellow_id TEXT,status TEXT);
    CREATE TABLE evidence(problem_id TEXT,evidence_id TEXT,bears_on_kind TEXT,bears_on_id TEXT,bears_on_version INTEGER,
      source_event_id TEXT,source_seq INTEGER,author_fellow_id TEXT,direction TEXT);
    CREATE TABLE retractions(problem_id TEXT,retraction_id TEXT,seq INTEGER,target_object TEXT);
    CREATE TABLE scientific_withdrawals(event_id TEXT,problem_id TEXT,seq INTEGER,event_sha256 TEXT,
      retraction_id TEXT,target_kind TEXT,target_object TEXT,source_event_id TEXT,source_sha256 TEXT);
    INSERT INTO problems VALUES ('P-KILL',0,'active',0),('P-OTHER',0,'active',0);
  `);
  const payloads = new Map<string, Record<string, unknown>>();
  const event = (
    seq: number,
    id: string,
    type: string,
    body: Record<string, unknown>,
    actor = "F-AUTHOR",
  ) => {
    const kind = type.startsWith("hypothesis.")
      ? "hypothesis"
      : type.startsWith("evidence.")
        ? "evidence"
        : "retraction";
    const eventId = `event-${seq}`,
      text = JSON.stringify(body),
      digest = sha(text);
    sql
      .query("INSERT INTO events VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?,?)")
      .run(
        eventId,
        PROBLEM,
        seq,
        type,
        kind,
        id,
        TIME,
        digest,
        actor,
        "SP-AUTHOR",
        "S-AUTHOR",
        "declared-model",
        "declared-harness",
      );
    sql.query("INSERT INTO event_content VALUES (?,?,?,NULL)").run(eventId, digest, text);
    sql.query("UPDATE problems SET public_seq=MAX(public_seq,?) WHERE id=?").run(seq, PROBLEM);
    payloads.set(eventId, body);
    return eventId;
  };
  const hypothesis = (seq = 1, id = "H-1") => {
    const eid = event(seq, id, "hypothesis.created", {
      route: `Finite route ${CANARY}`,
      mechanism: "Enumerate the declared domain",
      falsifier: "A nonzero residual",
      expected_evidence: null,
      discriminating_predictions: [],
      origin: "proposed",
      body_md: CANARY,
    });
    sql
      .query("INSERT INTO hypotheses VALUES (?,?,?,?,?,'open')")
      .run(PROBLEM, id, eid, seq, "F-AUTHOR");
    return eid;
  };
  const evidence = (seq = 2, id = "E-1", target = "H-1", patch: Record<string, unknown> = {}) => {
    const eid = event(seq, id, "evidence.created", {
      bears_on_kind: "hypothesis",
      bears_on_id: target,
      bears_on_version: null,
      direction: "refutes",
      kind: "citation",
      source: {
        kind: "locator",
        locator: "https://example.org/check",
        excerpt: "The recorded residual is nonzero.",
      },
      mode: "confirmatory",
      body_md: CANARY,
      computed_class: "citation",
      coercion_flags: [],
      ...patch,
    });
    sql
      .query("INSERT INTO evidence VALUES (?,?,'hypothesis',?,NULL,?,?,?,'refutes')")
      .run(PROBLEM, id, target, eid, seq, "F-AUTHOR");
    return eid;
  };
  const control = (target: string, visibility = "hidden", problem = PROBLEM) => {
    sql
      .query(`INSERT INTO content_controls SELECT ?,?,?,COALESCE(MAX(version),0)+1
      FROM content_controls WHERE problem_id=? AND target_ref=?`)
      .run(problem, target, visibility, problem, target);
  };
  const replace = (eventId: string, patch: Record<string, unknown>) => {
    const value = { ...payloads.get(eventId), ...patch },
      text = JSON.stringify(value),
      digest = sha(text);
    payloads.set(eventId, value);
    sql.query("UPDATE events SET payload_sha256=? WHERE id=?").run(digest, eventId);
    sql
      .query("UPDATE event_content SET payload_json=?,payload_sha256=? WHERE event_id=?")
      .run(text, digest, eventId);
  };
  let onEvidenceRead: (() => void) | undefined;
  let evidenceReads = 0;
  const prepare = (query: string) => {
    let values: (string | number | null)[] = [];
    return {
      bind(...bindings: (string | number | null)[]) {
        values = bindings;
        return this;
      },
      async first() {
        const row = sql.query(query).get(...values);
        if (query === HYPOTHESIS_EVIDENCE_ITEM_SQL) {
          evidenceReads++;
          onEvidenceRead?.();
        }
        return row;
      },
      async all() {
        return { success: true, results: sql.query(query).all(...values) };
      },
    };
  };
  const db = {
    prepare,
    async batch(statements: { all(): Promise<unknown> }[]) {
      const results = [];
      for (const statement of statements) results.push(await statement.all());
      return results;
    },
  } as unknown as D1Database;
  const next = (cursor?: number) =>
    selectKillOrStandMove(
      db,
      PROBLEM,
      cursor ??
        (
          sql.query("SELECT public_seq FROM problems WHERE id=?").get(PROBLEM) as {
            public_seq: number;
          }
        ).public_seq,
    );
  return {
    sql,
    db,
    event,
    hypothesis,
    evidence,
    control,
    replace,
    next,
    setDuringRead: (run: () => void) => {
      onEvidenceRead = run;
    },
    evidenceReads: () => evidenceReads,
    close: () => sql.close(),
  };
}
async function run(work: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture();
  try {
    f.hypothesis();
    f.evidence();
    await work(f);
  } finally {
    f.close();
  }
}

test("source-verified counterevidence yields exact readable pins without authored prose or an invented conclusion", () =>
  run(async (f) => {
    const result = await f.next();
    const move = NextMoveCandidateSchema.parse(result.move);
    assert.equal(result.degraded, false);
    assert.deepEqual(move.refs, [PROBLEM, "H-1", "E-1"]);
    assert.deepEqual(move.contract.prefilled_hints, {
      hypothesis_id: "H-1",
      killed_by_evidence_id: "E-1",
    });
    const request = move.contract.request;
    assert.ok(request && typeof request === "object" && "path" in request);
    assert.equal(request.path, "/v1/sessions/{id}/hypotheses/H-1/kill");
    const prep = move.contract.preparation as Record<string, unknown>;
    assert.deepEqual(prep.read_first, {
      method: "GET",
      path: "/p/P-KILL/hypotheses/H-1.md?through=2",
    });
    assert.deepEqual(prep.additional_reads, [{ method: "GET", path: "/p/P-KILL/evidence/E-1.md" }]);
    assert.match(JSON.stringify(prep.hypothesis_pin), /event-1/);
    assert.match(JSON.stringify(prep.evidence_pin), /event-2/);
    assert.doesNotMatch(JSON.stringify(move), new RegExp(CANARY));
    assert.doesNotMatch(move.why, /falsifier (?:has )?fired|proved|verified refutation/);
    assert.deepEqual(await f.next(), result);
  }));

test("oldest eligible publication wins before lexicographic evidence identifiers", () =>
  run(async (f) => {
    f.evidence(3, "E-0");
    assert.equal((await f.next()).move?.refs[2], "E-1");
    f.control("E-1");
    assert.equal((await f.next()).move?.refs[2], "E-0");
  }));

for (const target of ["problem", "H-1", "H-1@1", "#1", "E-1", "E-1@1", "#2"])
  test(`current ${target} control removes the move and an exact restore makes it usable`, () =>
    run(async (f) => {
      f.control(target);
      assert.equal((await f.next()).move, null);
      f.control(target, "visible");
      assert.equal((await f.next()).move?.move, "kill-or-stand");
    }));

test("foreign and unrelated-version controls cannot remove the exact sources", () =>
  run(async (f) => {
    f.control("problem", "hidden", "P-OTHER");
    for (const target of ["H-1@2", "E-1@2", "#3"]) f.control(target);
    assert.equal((await f.next()).move?.move, "kill-or-stand");
  }));

for (const source of ["event-1", "event-2"]) {
  for (const failure of ["redacted", "digest", "bytes", "schema", "withdrawn"])
    test(`${failure} ${source} cannot manufacture a kill recommendation`, () =>
      run(async (f) => {
        if (failure === "redacted")
          f.sql.query("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(source);
        if (failure === "digest")
          f.sql
            .query("UPDATE event_content SET payload_sha256=? WHERE event_id=?")
            .run("0".repeat(64), source);
        if (failure === "bytes")
          f.sql.query("UPDATE event_content SET payload_json='{}' WHERE event_id=?").run(source);
        if (failure === "schema")
          f.replace(source, source === "event-1" ? { falsifier: "" } : { bears_on_id: "H-2" });
        if (failure === "withdrawn")
          f.sql.query("INSERT INTO scientific_withdrawals(source_event_id) VALUES(?)").run(source);
        assert.equal((await f.next()).move, null);
      }));
}

for (const patch of [
  { direction: "supports" },
  { direction: "informs" },
  { computed_class: "certified" },
  { coercion_flags: ["invented"] },
])
  test(`mutable refutes label cannot override immutable source ${JSON.stringify(patch)}`, () =>
    run(async (f) => {
      f.replace("event-2", patch);
      const result = await f.next();
      assert.equal(result.move, null);
      assert.equal(result.degraded, true);
    }));

test("an actual prior elimination cannot be reopened by a forged mutable status", () =>
  run(async (f) => {
    f.event(3, "H-1", "hypothesis.killed", {
      hypothesis_id: "H-1",
      killed_by_evidence_id: "E-1",
      reason: "Recorded elimination",
    });
    assert.equal((await f.next()).move, null);
  }));

for (const target of ["H-1", "H-1@1", "E-1", "E-1@1"])
  test(`the source author's withdrawal of ${target} removes new elimination work`, () =>
    run(async (f) => {
      f.event(3, "RET-3", "object.retracted", {
        target_object: target,
        reason: "Source corrected",
      });
      f.sql.query("INSERT INTO retractions VALUES(?, 'RET-3',3,?)").run(PROBLEM, target);
      assert.equal((await f.next()).move, null);
    }));

test("another author's attempted withdrawal cannot erase current counterevidence", () =>
  run(async (f) => {
    f.event(
      3,
      "RET-3",
      "object.retracted",
      { target_object: "E-1", reason: "Other opinion" },
      "F-OTHER",
    );
    f.sql.query("INSERT INTO retractions VALUES(?, 'RET-3',3,'E-1')").run(PROBLEM);
    assert.equal((await f.next()).move?.move, "kill-or-stand");
  }));

test("a current move never relabels present evidence as an older or future cut", () =>
  run(async (f) => {
    for (const cursor of [0, 1, 3, -1, 1.5, Number.NaN])
      assert.deepEqual(await f.next(cursor), { move: null, degraded: true });
  }));

for (const status of ["private-draft", "resolved", "retired"])
  test(`${status} problems have no actionable elimination recommendation`, () =>
    run(async (f) => {
      f.sql.query("UPDATE problems SET status=? WHERE id=?").run(status, PROBLEM);
      assert.deepEqual(await f.next(), { move: null, degraded: true });
    }));

test("known unlisted work retains the same scoped, source-verified recommendation", () =>
  run(async (f) => {
    f.sql.query("UPDATE problems SET unlisted=1 WHERE id=?").run(PROBLEM);
    assert.equal((await f.next()).move?.move, "kill-or-stand");
  }));

for (const [name, change] of [
  ["source hide", (f: ReturnType<typeof fixture>) => f.control("E-1@1")],
  [
    "public append",
    (f: ReturnType<typeof fixture>) =>
      f.sql.query("UPDATE problems SET public_seq=3 WHERE id=?").run(PROBLEM),
  ],
  [
    "source withdrawal",
    (f: ReturnType<typeof fixture>) =>
      f.sql.query("INSERT INTO scientific_withdrawals(source_event_id) VALUES('event-2')").run(),
  ],
] as const)
  test(`a concurrent ${name} invalidates the selected pins`, () =>
    run(async (f) => {
      f.setDuringRead(() => change(f));
      assert.deepEqual(await f.next(), { move: null, degraded: true });
    }));

test("unavailable earlier content does not conceal a later eligible report", () =>
  run(async (f) => {
    f.replace("event-2", { computed_class: "certified" });
    f.evidence(3, "E-3");
    const result = await f.next();
    assert.equal(result.move?.refs[2], "E-3");
    assert.equal(result.degraded, true);
  }));

test("candidate scan is bounded and discloses incomplete selection", () =>
  run(async (f) => {
    for (let n = 3; n < 12; n++) f.evidence(n, `E-${n}`);
    for (let n = 2; n < 10; n++) f.replace(`event-${n}`, { computed_class: "certified" });
    assert.deepEqual(await f.next(), { move: null, degraded: true });
    assert.equal(f.evidenceReads(), KILL_MOVE_CANDIDATE_LIMIT);
  }));

test("duplicate evidence envelopes are rejected even when the extra body is unavailable", () =>
  run(async (f) => {
    const duplicate = f.event(3, "E-1", "evidence.created", {});
    f.sql.query("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(duplicate);
    assert.equal((await f.next()).move, null);
  }));

test("a healthy empty frontier is empty rather than degraded", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.next(), { move: null, degraded: false });
  } finally {
    f.close();
  }
});
