import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NextMoveCandidateSchema, ProblemGovernanceEventSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import {
  REANCHOR_CANDIDATE_LIMIT,
  selectReanchorMove,
} from "../../src/mega-commands/reanchor-moves.ts";
import { selectSharpenStatementMove } from "../../src/mega-commands/sharpen-moves.ts";

const PROBLEM = "P-ANCHOR";
const AUTHOR = "F-AUTHOR";
const NOW = "2026-11-08T00:00:00.000Z";
const CANARY = "UNTRUSTED-SCIENTIFIC-CONTENT-IS-NOT-MOVE-INSTRUCTIONS";
const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");

// A unit fixture for the production SQL and canonical source readers. The
// separate native journey exercises real HTTP, Workerd and D1 writes.
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE problems(id TEXT PRIMARY KEY, status TEXT, public_seq INTEGER,
      current_statement_version INTEGER, unlisted INTEGER, admission_mode TEXT);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER, payload_sha256 TEXT,
      actor_fellow_id TEXT, actor_sponsor_id TEXT, created_at TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_sha256 TEXT,
      payload_json TEXT, redacted_at TEXT);
    CREATE TABLE content_controls(problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    CREATE TABLE screening_publications(event_id TEXT PRIMARY KEY, provenance_json TEXT);
    CREATE TABLE claims(problem_id TEXT, id TEXT, statement TEXT, statement_version INTEGER,
      statement_drift INTEGER, source_seq INTEGER, payload_sha256 TEXT);
    CREATE TABLE claim_versions(problem_id TEXT, claim_id TEXT, version INTEGER,
      editor_fellow_id TEXT, content_digest TEXT, statement TEXT);
    CREATE TABLE problem_statement_versions(problem_id TEXT, version INTEGER,
      statement TEXT, falsifier TEXT);
    CREATE TABLE retractions(problem_id TEXT, retraction_id TEXT, seq INTEGER,
      target_object TEXT, author_fellow_id TEXT);
    CREATE TABLE scientific_withdrawals(source_event_id TEXT);
    INSERT INTO problems VALUES ('P-ANCHOR','active',0,1,0,'open');
  `);
  const payloads = new Map<string, Record<string, unknown>>();
  const event = (
    seq: number,
    type: string,
    kind: string,
    id: string,
    version: number,
    payload: Record<string, unknown>,
    actor = AUTHOR,
  ) => {
    const eventId = `EV-${seq}`;
    const raw = JSON.stringify(payload);
    const digest = sha(raw);
    sql
      .query("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(eventId, PROBLEM, seq, type, kind, id, version, digest, actor, "usr_author", NOW);
    sql.query("INSERT INTO event_content VALUES (?,?,?,NULL)").run(eventId, digest, raw);
    sql.query("UPDATE problems SET public_seq=MAX(public_seq,?) WHERE id=?").run(seq, PROBLEM);
    payloads.set(eventId, payload);
    return eventId;
  };
  const formulation = (seq: number, version: number, status = "active") => {
    const payload = ProblemGovernanceEventSchema.parse({
      action: version === 1 ? "publish" : "revise-statement",
      previous_status: version === 1 ? "private-draft" : "active",
      previous_statement_version: Math.max(1, version - 1),
      acting_principal: { type: "sponsor", id: "usr_author" },
      source_fellow_id: AUTHOR,
      problem: {
        id: PROBLEM,
        title: "Formulation context",
        status: version === 1 ? "sharpening" : status,
        current_statement_version: version,
        statement: `Statement ${version}: ${CANARY}`,
        falsifier: "A counterexample in the stated finite domain.",
        motivation: "Avoid treating a stale formulation as current.",
        updated_at: NOW,
      },
    });
    const eid = event(
      seq,
      version === 1 ? "problem.admitted" : "problem.statement-revised",
      "problem",
      PROBLEM,
      version,
      payload,
    );
    sql
      .query("UPDATE problems SET current_statement_version=?,status=? WHERE id=?")
      .run(version, status, PROBLEM);
    sql
      .query("INSERT INTO problem_statement_versions VALUES (?,?,?,?)")
      .run(PROBLEM, version, payload.problem.statement, payload.problem.falsifier);
    sql
      .query("UPDATE claims SET statement_drift=1 WHERE problem_id=? AND statement_version < ?")
      .run(PROBLEM, version);
    return eid;
  };
  const claim = (seq = 2, id = "C-1", version = 1, editor = AUTHOR) => {
    const statement = `Claim ${id} version ${version}: ${CANARY}`;
    const eid = event(
      seq,
      version === 1 ? "claim.created" : "claim.revised",
      "claim",
      id,
      version,
      {
        claim_id: id,
        kind: "conjecture",
        statement,
        falsifier: "A direct computation that violates the stated predicate.",
        ...(version > 1 ? { base_version: version - 1 } : {}),
      },
      editor,
    );
    const digest = sha(JSON.stringify(payloads.get(eid)));
    const sv = (
      sql.query("SELECT current_statement_version FROM problems WHERE id=?").get(PROBLEM) as {
        current_statement_version: number;
      }
    ).current_statement_version;
    if (version === 1)
      sql
        .query("INSERT INTO claims VALUES (?,?,?,?,0,?,?)")
        .run(PROBLEM, id, statement, sv, seq, digest);
    else
      sql
        .query(`UPDATE claims SET statement=?,statement_version=?,statement_drift=0,
          source_seq=?,payload_sha256=? WHERE problem_id=? AND id=?`)
        .run(statement, sv, seq, digest, PROBLEM, id);
    sql
      .query("INSERT INTO claim_versions VALUES (?,?,?,?,?,?)")
      .run(PROBLEM, id, version, editor, `sha256:${digest}`, statement);
    return eid;
  };
  const reanchor = (seq: number, statementVersion: number, version = 1, id = "C-1") => {
    const eid = event(seq, "claim.reanchored", "claim", id, version, {
      claim_id: id,
      base_version: version,
      statement_version: statementVersion,
    });
    sql
      .query("UPDATE claims SET statement_version=?,statement_drift=0 WHERE problem_id=? AND id=?")
      .run(statementVersion, PROBLEM, id);
    return eid;
  };
  const control = (target: string, visibility = "hidden") =>
    sql
      .query(`INSERT INTO content_controls SELECT ?,?,?,COALESCE(MAX(version),0)+1
        FROM content_controls WHERE problem_id=? AND target_ref=?`)
      .run(PROBLEM, target, visibility, PROBLEM, target);
  const replace = (id: string, payload: Record<string, unknown>) => {
    const raw = JSON.stringify(payload),
      digest = sha(raw);
    payloads.set(id, payload);
    sql.query("UPDATE events SET payload_sha256=? WHERE id=?").run(digest, id);
    sql
      .query("UPDATE event_content SET payload_sha256=?,payload_json=? WHERE event_id=?")
      .run(digest, raw, id);
  };
  let afterRead: ((query: string) => void) | undefined;
  const prepare = (query: string) => {
    let bindings: (string | number | null)[] = [];
    return {
      bind(...values: (string | number | null)[]) {
        bindings = values;
        return this;
      },
      async first() {
        const row = sql.query(query).get(...bindings);
        afterRead?.(query);
        return row;
      },
      async all() {
        const results = sql.query(query).all(...bindings);
        afterRead?.(query);
        return { success: true, results };
      },
    };
  };
  const db = { prepare } as unknown as D1Database;
  const cursor = () =>
    (sql.query("SELECT public_seq FROM problems WHERE id=?").get(PROBLEM) as { public_seq: number })
      .public_seq;
  return {
    sql,
    db,
    payloads,
    formulation,
    claim,
    event,
    reanchor,
    control,
    replace,
    cursor,
    next: (cut = cursor(), fellow = AUTHOR) => selectReanchorMove(db, PROBLEM, fellow, cut),
    sharpen: (cut = cursor()) => selectSharpenStatementMove(db, PROBLEM, cut),
    setAfterRead: (run?: (query: string) => void) => {
      afterRead = run;
    },
    close: () => sql.close(),
  };
}

async function run(work: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture();
  try {
    f.formulation(1, 1);
    f.claim();
    f.formulation(3, 2);
    await work(f);
  } finally {
    f.close();
  }
}

test("re-anchor preserves a usable exact claim/statement recommendation without copying scientific prose", () =>
  run(async (f) => {
    const result = await f.next();
    const move = NextMoveCandidateSchema.parse(result.move);
    assert.equal(result.degraded, false);
    assert.deepEqual(move.refs, [PROBLEM, "C-1@1", "S@2"]);
    assert.deepEqual(move.contract.prefilled_hints, { claim_id: "C-1", base_version: 1 });
    assert.deepEqual((move.contract.preparation as Record<string, unknown>).read_first, {
      method: "GET",
      path: `/p/${PROBLEM}.md`,
    });
    assert.ok(!JSON.stringify(move).includes(CANARY));
    assert.equal((await f.next(f.cursor(), "F-OTHER")).move, null);
  }));

for (const target of ["problem", PROBLEM, `${PROBLEM}@2`, "#3", "C-1", "C-1@1", "#2"])
  test(`re-anchor suppresses a currently hidden source (${target}) and returns after restore`, () =>
    run(async (f) => {
      f.control(target);
      assert.equal((await f.next()).move, null);
      f.control(target, "visible");
      assert.ok((await f.next()).move);
    }));

for (const source of ["EV-2", "EV-3"])
  for (const damage of ["redacted", "digest-mismatch"])
    test(`re-anchor does not replace ${source} ${damage} with projection content`, () =>
      run(async (f) => {
        if (damage === "redacted")
          f.sql.query("UPDATE event_content SET redacted_at=? WHERE event_id=?").run(NOW, source);
        else f.sql.query("UPDATE event_content SET payload_json='{}' WHERE event_id=?").run(source);
        assert.equal((await f.next()).move, null);
      }));

test("re-anchor rejects stale and future cuts rather than combining current and historical formulations", () =>
  run(async (f) => {
    for (const cursor of [2, 4, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const result = await f.next(cursor);
      assert.equal(result.move, null);
      assert.equal(result.degraded, true);
    }
  }));

for (const status of ["private-draft", "retired", "resolved"])
  test(`re-anchor never recommends a write on a ${status} problem`, () =>
    run(async (f) => {
      f.sql.query("UPDATE problems SET status=? WHERE id=?").run(status, PROBLEM);
      assert.equal((await f.next()).move, null);
    }));

test("a missing claim projection is unavailable rather than affirmative evidence of drift", () =>
  run(async (f) => {
    f.sql.query("DELETE FROM claims WHERE problem_id=?").run(PROBLEM);
    const result = await f.next();
    assert.equal(result.move, null);
    assert.equal(result.degraded, true);
  }));

test("a recorded re-anchor cannot be recommended again by a stale projection flag", () =>
  run(async (f) => {
    f.reanchor(4, 2);
    f.sql.query("UPDATE claims SET statement_drift=1 WHERE problem_id=?").run(PROBLEM);
    assert.equal((await f.next()).move, null);
  }));

test("withdrawn claim heads are not candidates even when their drift projection survives", () =>
  run(async (f) => {
    const id = f.event(4, "object.retracted", "retraction", "R-1", 1, {
      target_object: "C-1@1",
      reason: "This version is no longer a live claim.",
    });
    f.sql
      .query("INSERT INTO retractions VALUES (?,?,?,?,?)")
      .run(PROBLEM, "R-1", 4, "C-1@1", AUTHOR);
    assert.ok(id);
    assert.equal((await f.next()).move, null);
  }));

test("claim revision resets its anchor and never falls back to an older drifting version", () =>
  run(async (f) => {
    f.claim(4, "C-1", 2);
    assert.equal((await f.next()).move, null);
    f.control("C-1@2");
    assert.equal((await f.next()).move, null);
    f.control("C-1@2", "visible");
    f.formulation(5, 3);
    assert.deepEqual((await f.next()).move?.refs, [PROBLEM, "C-1@2", "S@3"]);
  }));

test("re-anchor ownership is the immutable original author, not the latest editor", () =>
  run(async (f) => {
    f.claim(4, "C-1", 2, "F-EDITOR");
    f.formulation(5, 3);
    assert.deepEqual((await f.next()).move?.refs, [PROBLEM, "C-1@2", "S@3"]);
    assert.equal((await f.next(f.cursor(), "F-EDITOR")).move, null);
  }));

test("sharpening reads the verified published formulation and keeps its body untrusted", () =>
  run(async (f) => {
    f.sql.query("UPDATE problems SET status='sharpening' WHERE id=?").run(PROBLEM);
    const result = await f.sharpen();
    const move = NextMoveCandidateSchema.parse(result.move);
    assert.equal(result.degraded, false);
    assert.deepEqual(move.refs, [PROBLEM, "S@2"]);
    assert.deepEqual((move.contract.preparation as Record<string, unknown>).read_first, {
      method: "GET",
      path: `/p/${PROBLEM}.md`,
    });
    assert.ok(!JSON.stringify(move).includes(CANARY));
  }));

for (const damage of ["hidden", "redacted", "missing", "digest-mismatch", "stale-cut"])
  test(`sharpening refuses ${damage} formulation authority`, () =>
    run(async (f) => {
      f.sql.query("UPDATE problems SET status='sharpening' WHERE id=?").run(PROBLEM);
      if (damage === "hidden") f.control("#3");
      if (damage === "redacted")
        f.sql.query("UPDATE event_content SET redacted_at=? WHERE event_id='EV-3'").run(NOW);
      if (damage === "missing")
        f.sql.query("DELETE FROM event_content WHERE event_id='EV-3'").run();
      if (damage === "digest-mismatch")
        f.sql.query("UPDATE event_content SET payload_json='{}' WHERE event_id='EV-3'").run();
      const result = await f.sharpen(damage === "stale-cut" ? 2 : f.cursor());
      assert.equal(result.move, null);
      assert.equal(result.degraded, true);
    }));

test("missing falsifier projection bytes do not invent a defect in a complete published formulation", () =>
  run(async (f) => {
    f.sql.query("UPDATE problem_statement_versions SET falsifier=NULL").run();
    assert.deepEqual(await f.sharpen(), { move: null, degraded: false });
  }));

test("a later formulation reopens a correctly recorded re-anchor and retains its exact current claim", () =>
  run(async (f) => {
    f.reanchor(4, 2);
    f.formulation(5, 3);
    const result = await f.next();
    assert.deepEqual(result.move?.refs, [PROBLEM, "C-1@1", "S@3"]);
    assert.ok(result.move);
    assert.equal(
      (result.move.contract.preparation as Record<string, unknown>).anchored_statement_version,
      2,
    );
    assert.equal(result.degraded, false);
  }));

for (const damage of ["wrong-claim", "wrong-version", "wrong-statement", "wrong-author", "hidden"])
  test(`invalid re-anchor event (${damage}) does not mint a usable statement pin`, () =>
    run(async (f) => {
      f.reanchor(4, 2);
      f.formulation(5, 3);
      if (damage === "hidden") f.control("#4");
      else if (damage === "wrong-author")
        f.sql.query("UPDATE events SET actor_fellow_id='F-OTHER' WHERE id='EV-4'").run();
      else
        f.replace("EV-4", {
          claim_id: damage === "wrong-claim" ? "C-9" : "C-1",
          base_version: damage === "wrong-version" ? 2 : 1,
          statement_version: damage === "wrong-statement" ? 3 : 2,
        });
      assert.deepEqual(await f.next(), { move: null, degraded: true });
    }));

test("an unlisted authorized problem remains addressable without joining public discovery", () =>
  run(async (f) => {
    f.sql.query("UPDATE problems SET unlisted=1 WHERE id=?").run(PROBLEM);
    assert.equal((await f.next()).move?.move, "re-anchor");
    f.sql.query("UPDATE problems SET admission_mode='archived-read-only' WHERE id=?").run(PROBLEM);
    assert.deepEqual(await f.next(), { move: null, degraded: false });
  }));

test("an unavailable early claim does not erase the next usable candidate", () =>
  run(async (f) => {
    f.claim(4, "C-2");
    f.formulation(5, 3);
    f.control("C-1");
    const result = await f.next();
    assert.deepEqual(result.move?.refs, [PROBLEM, "C-2@1", "S@3"]);
    assert.equal(result.degraded, true);
    assert.ok(result.move);
    assert.equal(
      (result.move.contract.preparation as Record<string, unknown>).selection_complete,
      false,
    );
  }));

test("bounded selection discloses omitted candidates and does not scan past its limit", () =>
  run(async (f) => {
    for (let i = 2; i <= REANCHOR_CANDIDATE_LIMIT + 1; i++) f.claim(i + 2, `C-${i}`);
    f.formulation(REANCHOR_CANDIDATE_LIMIT + 4, 3);
    const result = await f.next();
    assert.equal(result.move?.refs[1], "C-1@1");
    assert.equal(result.degraded, true);
    assert.ok(result.move);
    assert.equal(
      (result.move.contract.preparation as Record<string, unknown>).selection_complete,
      false,
    );
    for (let i = 1; i <= REANCHOR_CANDIDATE_LIMIT; i++) f.control(`C-${i}`);
    assert.deepEqual(await f.next(), { move: null, degraded: true });
  }));

for (const mutation of ["revision", "reanchor", "claim-hide"])
  test(`a concurrent ${mutation} during exact claim verification invalidates the prepared move`, () =>
    run(async (f) => {
      let injected = false;
      f.setAfterRead((query) => {
        if (injected || !query.includes("FROM claim_versions v JOIN events e")) return;
        injected = true;
        if (mutation === "revision") f.formulation(4, 3);
        if (mutation === "reanchor") f.reanchor(4, 2);
        if (mutation === "claim-hide") f.control("C-1");
      });
      const result = await f.next();
      assert.ok(injected, "the real canonical claim reader reached the injected race");
      assert.deepEqual(result, { move: null, degraded: true });
    }));

for (const mutation of [
  "current-hide",
  "old-hide",
  "resolved",
  "current-redaction",
  "bytes-change",
])
  test(`final source recheck rejects ${mutation} after formulation verification`, () =>
    run(async (f) => {
      let formulationsRead = 0;
      f.setAfterRead((query) => {
        if (query.includes("ORDER BY source.seq DESC LIMIT 1")) {
          // Only the canonical formulation reader has this exact select prefix;
          // candidate queries also locate source events and must not count.
          if (!query.startsWith("SELECT e.id, e.problem_id")) return;
          formulationsRead++;
          if (formulationsRead !== 3) return;
          if (mutation === "current-hide") f.control("#3");
          if (mutation === "old-hide") f.control("#1");
          if (mutation === "resolved")
            f.sql.query("UPDATE problems SET status='resolved' WHERE id=?").run(PROBLEM);
          if (mutation === "current-redaction")
            f.sql.query("UPDATE event_content SET redacted_at=? WHERE event_id='EV-3'").run(NOW);
          if (mutation === "bytes-change")
            f.sql.query("UPDATE event_content SET payload_json='{}' WHERE event_id='EV-3'").run();
        }
      });
      const result = await f.next();
      assert.equal(formulationsRead, 3, "the selected sources and final formulation were read");
      assert.deepEqual(result, { move: null, degraded: true });
    }));
