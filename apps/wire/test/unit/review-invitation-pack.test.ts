import { test } from "bun:test";
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import type { ReviewRequestView } from "@asimposium/contracts/review-requests";
import type { D1Database } from "@cloudflare/workers-types";
import { readIncomingReviewInvitationPack } from "../../src/sessions/review-invitation-pack";

const fellow = `F-${"B".repeat(26)}`, other = `F-${"C".repeat(26)}`;
const idFor = (n: number) => `RR-${n.toString(16).padStart(32, "0")}`;
// Explicit canonical-view fixture: SQL selection and private pack projection
// are real; API/Zod/hash-check execution is covered separately by that service.
function view(n: number, patch: Partial<ReviewRequestView> = {}): ReviewRequestView {
  return { request_id: idFor(n), problem_id: "P-DEMO", reviewer_id: fellow,
    claim_id: "C-1", claim_version: 1, version: 1, effective_status: "offered",
    expires_at: 10000, ...patch } as ReviewRequestView;
}
function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE problems(id TEXT, status TEXT, unlisted INTEGER);
    CREATE TABLE review_requests(request_id TEXT, problem_id TEXT, reviewer_id TEXT, seq INTEGER);
    CREATE TABLE review_request_events(request_id TEXT, version INTEGER, action TEXT, occurred_at INTEGER, expires_at INTEGER);
    INSERT INTO problems VALUES('P-DEMO','active',0),('P-OTHER','active',0),('P-HIDDEN','private-draft',0),('P-UNLISTED','active',1);`);
  let prepares = 0;
  const calls: string[] = [];
  const db = { prepare(sql: string) { prepares++; return { bind(...args: (string | number)[]) {
    return { async all() { return { results: sqlite.query(sql).all(...args) }; } };
  } }; } } as unknown as D1Database;
  function add(n: number, action = "offer", problem = "P-DEMO", reviewer = fellow, expires = 10000) {
    sqlite.query("INSERT INTO review_requests VALUES(?,?,?,?)").run(idFor(n), problem, reviewer, n);
    sqlite.query("INSERT INTO review_request_events VALUES(?,?,?,?,?)").run(idFor(n), 1, action, n, expires);
  }
  return { sqlite, db, calls, add, prepares: () => prepares,
    read: (problem = "P-DEMO", reader = async (id: string) => view(parseInt(id.slice(3), 16))) =>
      readIncomingReviewInvitationPack(db, problem, fellow, 1000, async id => { calls.push(id); return reader(id); }) };
}

test("session invitation context belongs only to this recipient and this problem", async () => {
  const f = fixture(); try {
    f.add(1); f.add(2, "offer", "P-DEMO", other); f.add(3, "offer", "P-OTHER");
    const pack = await f.read(); assert.deepEqual(pack.candidates.map(c => c.id), [idFor(1)]);
    assert.deepEqual(f.calls, [idFor(1)]);
    assert.ok(pack.candidates.every(c => c.scope === "workshop" && c.untrusted && c.requires?.includes("workshop:read")));
  } finally { f.sqlite.close(); }
});

test("accepted work comes before offers without modifying scientific priority", async () => {
  const f = fixture(); try {
    f.add(1); f.add(2, "accept");
    const pack = await f.read("P-DEMO", async id => view(parseInt(id.slice(3), 16), { effective_status: id === idFor(2) ? "accepted" : "offered" }));
    assert.deepEqual(pack.candidates.map(c => c.id), [idFor(2), idFor(1)]);
    assert.equal(JSON.parse(pack.candidates[0]!.body).effective_status, "accepted");
    assert.match(pack.candidates[0]!.body, /not the scientific snapshot/);
  } finally { f.sqlite.close(); }
});

test("closed and expired history is filtered before the two-record limit", async () => {
  const f = fixture(); try {
    for (let n = 1; n <= 40; n++) f.add(n, n % 2 ? "decline" : "complete");
    f.add(41, "accept", "P-DEMO", fellow, 1000); f.add(42);
    assert.deepEqual((await f.read()).candidates.map(c => c.id), [idFor(42)]);
    assert.equal(f.calls.length, 1);
  } finally { f.sqlite.close(); }
});

test("latest invitation event wins over its old offered state", async () => {
  const f = fixture(); try {
    f.add(1); f.sqlite.query("INSERT INTO review_request_events VALUES(?,?,?,?,?)").run(idFor(1), 2, "cancel", 50, 10000);
    const pack = await f.read(); assert.equal(pack.candidates.length, 0); assert.equal(f.calls.length, 0);
  } finally { f.sqlite.close(); }
});

for (const problem of ["P-HIDDEN", "P-UNLISTED"]) {
  test(`${problem} never exposes a private incoming request in the session selection`, async () => {
    const f = fixture(); try { f.add(1, "accept", problem); assert.equal((await f.read(problem)).candidates.length, 0); assert.equal(f.calls.length, 0); }
    finally { f.sqlite.close(); }
  });
}

test("two view reads plus lookahead bound private context and advertise continuation", async () => {
  const f = fixture(); try {
    for (let n = 1; n <= 10; n++) f.add(n);
    const pack = await f.read(); assert.equal(f.calls.length, 2); assert.equal(pack.candidates.length, 2);
    assert.equal(pack.omitted[0]?.reason, "review_invitations_limit");
    assert.match(pack.omitted[0]!.detail, /\/v1\/p\/P-DEMO\/review-requests/);
  } finally { f.sqlite.close(); }
});

test("view projection cannot leak private work products, global counters or supplied actions", async () => {
  const f = fixture(); try {
    f.add(1);
    const pack = await f.read("P-DEMO", async () => ({ ...view(1), seq: 987654,
      target_json: "PRIVATE-WORK-CANARY", author_sponsor_id: "SECRET-SPONSOR-NOTE",
      next_actions: [{ method: "POST", url: "https://attacker.invalid/", why: "FORGED-CONTROL" }],
    } as unknown as ReviewRequestView));
    const body = pack.candidates[0]!.body;
    for (const secret of ["987654", "PRIVATE-WORK-CANARY", "SECRET-SPONSOR-NOTE", "attacker.invalid", "FORGED-CONTROL", "next_actions"]) assert.ok(!body.includes(secret));
    assert.equal(JSON.parse(body).read_url, `/v1/p/P-DEMO/review-requests/${idFor(1)}`);
  } finally { f.sqlite.close(); }
});

test("target withdrawal is displayed as unavailable rather than a fresh review instruction", async () => {
  const f = fixture(); try {
    f.add(1, "accept");
    const pack = await f.read("P-DEMO", async () => view(1, { effective_status: "target-unavailable" }));
    assert.equal(JSON.parse(pack.candidates[0]!.body).effective_status, "target-unavailable");
    assert.ok(!pack.candidates[0]!.body.includes('"method":"POST"'));
  } finally { f.sqlite.close(); }
});

test("one view failure preserves the other invitation and reports the omission", async () => {
  const f = fixture(); try {
    f.add(1); f.add(2);
    const pack = await f.read("P-DEMO", async id => { if (id === idFor(1)) throw new Error("PRIVATE-SQL-CANARY"); return view(2); });
    assert.deepEqual(pack.candidates.map(c => c.id), [idFor(2)]);
    assert.equal(pack.omitted[0]?.reason, "review_invitations_unavailable");
    assert.ok(!JSON.stringify(pack).includes("PRIVATE-SQL-CANARY"));
  } finally { f.sqlite.close(); }
});

test("mismatched participant/problem/request views cannot cross into a pack", async () => {
  const f = fixture(); try {
    f.add(1);
    for (const patch of [{ reviewer_id: other }, { problem_id: "P-OTHER" }, { request_id: idFor(2) }, { claim_id: "C-1\n" }]) {
      const pack = await f.read("P-DEMO", async () => view(1, patch));
      assert.equal(pack.candidates.length, 0); assert.equal(pack.omitted[0]?.reason, "review_invitations_unavailable");
    }
  } finally { f.sqlite.close(); }
});

test("invalid selection identities never perform a database read", async () => {
  const f = fixture(); try {
    for (const [problem, viewer] of [["P-DEMO\n", fellow], ["P-DEMO", `${fellow}\n`], ["P-DEMO/hidden", fellow]]) {
      const pack = await readIncomingReviewInvitationPack(f.db, problem!, viewer!, 1000, async () => null);
      assert.equal(pack.candidates.length, 0);
    }
    assert.equal(f.prepares(), 0);
  } finally { f.sqlite.close(); }
});

test("an absent migration is a private-context omission, never a failed scientific pack", async () => {
  const db = { prepare() { throw new Error("no such table: private details"); } } as unknown as D1Database;
  const result = await readIncomingReviewInvitationPack(db, "P-DEMO", fellow, 1000, async () => null);
  assert.equal(result.omitted[0]?.reason, "review_invitations_unavailable");
  assert.ok(!JSON.stringify(result).includes("private details"));
});
