import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { MoveTemplate } from "@asimposium/contracts";
import type { ProofGapRecord } from "@asimposium/contracts/proof-gaps";
import type { D1Database } from "@cloudflare/workers-types";
import type { ProofGapPage } from "../../src/ledger/proof-gaps-read.ts";
import { loadGapMove, readGapMoveTargets, withGapMove } from "../../src/mega-commands/gap-moves.ts";

const now = Date.parse("2026-10-01T12:00:00.000Z");
const instant = new Date(now).toISOString();
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const template = () => ({ move: "close-gap", availability: "available", prefilled_hints: {} }) as MoveTemplate;

// Execute the production target-binding SQL and payload hashing. The canonical
// page and contract template are explicit fixture inputs, not replacement SQL.
function fixture(unlisted = false) {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, unlisted INTEGER, status TEXT);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, object_id TEXT, object_kind TEXT,
      object_version INTEGER, type TEXT, seq INTEGER, payload_sha256 TEXT, actor_fellow_id TEXT);
    CREATE TABLE event_content(event_id TEXT, payload_json TEXT, payload_sha256 TEXT, redacted_at TEXT);
    CREATE TABLE leases(problem_id TEXT, object_id TEXT, object_ref TEXT, status TEXT, leased_until TEXT);
    CREATE TABLE retractions(problem_id TEXT, retraction_id TEXT, seq INTEGER, target_object TEXT);
    CREATE TABLE content_controls(problem_id TEXT, target_ref TEXT, version INTEGER, visibility TEXT);
  `);
  sql.query("INSERT INTO problems VALUES ('P-DEMO', 10, ?, 'active')").run(unlisted ? 1 : 0);
  function publish(id: string, object: string, kind: string, type: string, seq: number, value: unknown, version = 1) {
    const body = JSON.stringify(value), hash = digest(body);
    sql.query("INSERT INTO events VALUES (?, 'P-DEMO', ?, ?, ?, ?, ?, ?, 'F-AUTHOR')")
      .run(id, object, kind, version, type, seq, hash);
    sql.query("INSERT INTO event_content VALUES (?, ?, ?, NULL)").run(id, body, hash);
    return { event_id: id, seq, payload_sha256: hash };
  }
  publish("ev-claim", "C-1", "claim", "claim.created", 1, { claim_id: "C-1", statement: "Pinned claim" });
  const content = { target_claim_id: "C-1", target_version: 1, obligation: "UNTRUSTED-WITNESS-CANARY" };
  const filing = publish("ev-gap", "G-2", "gap", "gap.filed", 2, content);
  const gap = { gap_id: "G-2", status: "open", filing, last_event: filing, content, closed_by: null } as unknown as ProofGapRecord;
  const page: ProofGapPage = {
    unlisted, problemStatus: "active",
    face: { schema: "https://a.asimposium.org/schemas/proof-gaps.v1.json", problem_id: "P-DEMO",
      cursor: 10, after: 0, target: null, gaps: [gap], next_after: null, omitted: [] },
  };
  const db = {
    prepare(text: string) {
      return { bind(...values: (string | number | null)[]) {
        return { all: async () => ({ results: sql.query(text).all(...values) }) };
      } };
    },
  } as unknown as D1Database;
  const select = (beforeBinding?: () => void) => loadGapMove(db, "P-DEMO", 10, now, {
    page: async () => { beforeBinding?.(); return page; }, template,
  });
  function control(target: string, visibility: "hidden" | "visible", version = 1) {
    sql.query("INSERT INTO content_controls VALUES ('P-DEMO', ?, ?, ?)").run(target, version, visibility);
  }
  return { sql, db, page, gap, publish, select, control };
}

for (const unlisted of [false, true]) {
  const scope = unlisted ? "unlisted" : "listed";
  test(`${scope} proof-gap work retains exact pins and direct preparation links`, async () => {
    const f = fixture(unlisted);
    try {
      const result = await f.select();
      assert.equal(result.degraded, false);
      assert.equal(result.move?.move, "close-gap");
      assert.deepEqual(result.move?.refs, ["P-DEMO", "G-2", "C-1@1"]);
      const prep = (result.move?.contract as { preparation: Record<string, unknown> }).preparation;
      assert.deepEqual(prep.read_first, { method: "GET", path: "/p/P-DEMO/gaps.md?through=10&target=G-2" });
      assert.deepEqual(prep.target_pin, { claim_id: "C-1", version: 1, event_id: "ev-claim", seq: 1,
        payload_sha256: digest(JSON.stringify({ claim_id: "C-1", statement: "Pinned claim" })) });
      assert.equal(JSON.stringify(result).includes("UNTRUSTED-WITNESS-CANARY"), false);
      assert.equal(JSON.stringify(result).includes("/search"), false);
    } finally { f.sql.close(); }
  });
  for (const target of ["problem", "G-2", "G-2@1", "#2", "C-1", "C-1@1", "#1"]) {
    test(`${scope} gap binding rechecks ${target} controls and honors a later restore`, async () => {
      const f = fixture(unlisted);
      try {
        assert.ok((await f.select()).move);
        const hidden = await f.select(() => f.control(target, "hidden"));
        assert.equal(hidden.move, null);
        assert.equal(hidden.degraded, true);
        f.control(target, "visible", 2);
        assert.ok((await f.select()).move);
        // An older hide is not stronger than the latest restore.
        assert.equal((await f.select()).degraded, false);
      } finally { f.sql.close(); }
    });
  }
  test(`${scope} gap binding refuses a listing change after its page was read`, async () => {
    const f = fixture(unlisted);
    try {
      const result = await f.select(() => f.sql.query("UPDATE problems SET unlisted = ?").run(unlisted ? 0 : 1));
      assert.equal(result.move, null);
      assert.equal(result.degraded, true);
    } finally { f.sql.close(); }
  });
}

for (const status of ["private-draft", "resolved", "retired", "sharpening"]) {
  test(`gap binding never recommends a ${status} problem even from an old readable page`, async () => {
    const f = fixture(true);
    try {
      const result = await f.select(() => f.sql.query("UPDATE problems SET status = ?").run(status));
      assert.equal(result.move, null);
      assert.equal(result.degraded, true);
    } finally { f.sql.close(); }
  });
}
for (const mutation of [
  "UPDATE event_content SET redacted_at = '2026-10-01T11:59:00.000Z' WHERE event_id = 'ev-gap'",
  "UPDATE event_content SET redacted_at = '2026-10-01T11:59:00.000Z' WHERE event_id = 'ev-claim'",
  "UPDATE event_content SET payload_json = '{}' WHERE event_id = 'ev-gap'",
  "UPDATE event_content SET payload_json = '{}' WHERE event_id = 'ev-claim'",
  "INSERT INTO leases VALUES ('P-DEMO', 'G-2', 'G-2', 'active', '2026-10-01T13:00:00.000Z')",
]) {
  test(`scoped unlisted gap selection preserves content/ownership refusal: ${mutation}`, async () => {
    const f = fixture(true);
    try {
      const result = await f.select(() => f.sql.exec(mutation));
      assert.equal(result.move, null);
      assert.equal(result.degraded, true);
    } finally { f.sql.close(); }
  });
}
test("unlisted gap selection refuses superseded and author-withdrawn claim targets", async () => {
  for (const revised of [false, true]) {
    const f = fixture(true);
    try {
      if (revised) f.publish("ev-revise", "C-1", "claim", "claim.revised", 3,
        { claim_id: "C-1", base_version: 1, statement: "Replacement" }, 2);
      else {
        f.publish("ev-retract", "R-3", "retraction", "object.retracted", 3, {});
        f.sql.exec("INSERT INTO retractions VALUES ('P-DEMO', 'R-3', 3, 'C-1@1')");
      }
      assert.equal((await f.select()).move, null);
    } finally { f.sql.close(); }
  }
});
test("gap selection refuses mixed listing scopes across its bounded pages", async () => {
  const f = fixture(true);
  try {
    await assert.rejects(loadGapMove(f.db, "P-DEMO", 10, now, {
      page: async (_db, _problem, query) => ({ ...f.page, unlisted: query.after === 0,
        face: { ...f.page.face, after: query.after ?? 0, gaps: query.after === 0
          ? [{ ...f.gap, status: "withdrawn" }] : [], next_after: query.after === 0 ? 2 : null } }),
      template,
    }), /GAP_MOVE_SNAPSHOT_INVALID/);
  } finally { f.sql.close(); }
});
test("malformed listing values cannot act as permission to include unlisted work", async () => {
  const f = fixture();
  try {
    for (const value of [undefined, 1, "true", null]) {
      f.page.unlisted = value as boolean;
      await assert.rejects(f.select(), /GAP_MOVE_SNAPSHOT_INVALID/);
      if (value === undefined) {
        // Omitted optional scope deliberately retains the listed-only API.
        assert.equal((await readGapMoveTargets(f.db, "P-DEMO", 10, instant, [f.gap])).size, 1);
      } else {
        await assert.rejects(readGapMoveTargets(f.db, "P-DEMO", 10, instant, [f.gap], value as boolean),
          /GAP_MOVE_SCOPE_INVALID/);
      }
    }
  } finally { f.sql.close(); }
});
test("gap source stays behind central promote and session permissions", async () => {
  let reads = 0;
  const selected = { moves: [], degraded: false };
  for (const permissions of [{}, { session_open: true }, { promote: true }]) {
    const result = await withGapMove({} as D1Database, "P-DEMO", 10, now, permissions, selected,
      { load: async () => { reads++; return { move: null, degraded: true }; } });
    assert.equal(result, selected);
  }
  assert.equal(reads, 0);
});
