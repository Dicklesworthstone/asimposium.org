import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SynthesesListResponseSchema, type SynthesisItem } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { Hono } from "hono";
import type { Env } from "../../src/env.ts";
import { handleSynthesesList } from "../../src/ledger/syntheses-list-http.ts";
import {
  readSynthesisPage,
  SYNTHESIS_READ_BYTES,
  SynthesisReadError,
  type SynthesisReadOptions,
} from "../../src/ledger/synthesis-read.ts";

// These tests execute the production SQL and hash checks against SQLite.
// The identity decoder isolates source integrity from the production Zod
// adapter; this fixture is not evidence of deployed D1 or schema validation.
const decode = (value: unknown) => value as SynthesisItem;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER);
    CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,type TEXT,object_kind TEXT,
      object_id TEXT,object_version INTEGER,payload_sha256 TEXT,created_at TEXT,
      actor_fellow_id TEXT,actor_sponsor_id TEXT,actor_session_id TEXT,model_string_self_declared TEXT,harness TEXT,
      UNIQUE(problem_id,seq));
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
    CREATE TABLE content_controls(problem_id TEXT,target_ref TEXT,version INTEGER,visibility TEXT);
    INSERT INTO problems VALUES ('P-SYNTH',0,'active',0),('P-OTHER',0,'active',0);`);
  const queries: string[] = [];
  const db = {
    prepare(query: string) {
      return {
        bind(...values: (string | number | null)[]) {
          return {
            async all() {
              queries.push(query);
              return { results: sql.query(query).all(...values), success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  function publish(
    seq = 2,
    id = "SYNTH-A",
    change: Record<string, unknown> = {},
    envelope: Record<string, unknown> = {},
    raw?: string,
  ) {
    const payload = {
      synthesis_id: id,
      covers_through: seq - 1,
      body_md: "Published scientific work.",
      anchors: [{ target_kind: "claim", target_id: "C-1", target_version: 1 }],
      omitted: ["C-2: scope not examined"],
      selection_policy: "Retain competing findings.",
      dropped_single_author_count: 1,
      ...change,
    };
    const body = raw ?? JSON.stringify(payload);
    const problem = String(envelope.problem_id ?? "P-SYNTH");
    const eventId = `EV-${problem}-${seq}`;
    const e = {
      type: "synthesis.created",
      kind: "synthesis",
      version: 1,
      fellow: "F-ORIGINAL",
      sponsor: "SP-ORIGINAL",
      session: "S-ORIGINAL",
      model: "self-declared/model",
      harness: "test-harness",
      at: "2026-10-11T00:00:00.000Z",
      ...envelope,
    };
    sql
      .query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        eventId,
        problem,
        seq,
        e.type as string,
        e.kind as string,
        id,
        e.version as number,
        digest(body),
        e.at as string,
        e.fellow as string,
        e.sponsor as string,
        e.session as string,
        e.model as string,
        e.harness as string,
      );
    sql.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(eventId, digest(body), body);
    sql.query("UPDATE problems SET public_seq=max(public_seq,?) WHERE id=?").run(seq, problem);
    return { eventId, body, payload };
  }
  function hide(target: string, version = 1, visibility = "hidden") {
    sql
      .query("INSERT INTO content_controls VALUES('P-SYNTH',?,?,?)")
      .run(target, version, visibility);
  }
  const read = (options: SynthesisReadOptions = {}) =>
    readSynthesisPage(db, "P-SYNTH", options, decode);
  const app = new Hono<{ Bindings: Env }>();
  for (const format of ["json", "md", "html"] as const)
    app.on(["GET", "HEAD"], `/p/:id/syntheses.${format}`, (c) => handleSynthesesList(c, format));
  const http = (path = "/p/P-SYNTH/syntheses.json", init?: RequestInit) =>
    app.fetch(new Request(`https://a.asimposium.org${path}`, init), { DB: db } as Env);
  return { sql, db, queries, publish, hide, read, http };
}
async function using(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture();
  try {
    await run(f);
  } finally {
    f.sql.close();
  }
}

test("reconstructs complete published work without a syntheses projection", () =>
  using(async (f) => {
    const { payload } = f.publish();
    const page = await f.read();
    assert.equal(page.items.length, 1);
    assert.deepEqual(page.items[0]?.synthesis, {
      ...payload,
      problem_id: "P-SYNTH",
      seq: 2,
      authoring_principal: "F-ORIGINAL",
      sponsor_id: "SP-ORIGINAL",
      session_id: "S-ORIGINAL",
      declared_model: "self-declared/model",
      harness: "test-harness",
      created_at: "2026-10-11T00:00:00.000Z",
    });
    assert.deepEqual(page.omitted, []);
    assert.equal(f.queries.length, 1);
  }));

test("corrupt projection text and attribution cannot replace a publication", () =>
  using(async (f) => {
    f.publish(2, "SYNTH-A", { authoring_principal: "IMPERSONATOR", declared_model: "FORGED" });
    f.sql.exec(
      "CREATE TABLE syntheses(synthesis_id TEXT,body_md TEXT,authoring_principal TEXT); INSERT INTO syntheses VALUES('SYNTH-A','FORGED PROJECTION','IMPERSONATOR')",
    );
    const s = (await f.read()).items[0]?.synthesis;
    assert.equal(s?.body_md, "Published scientific work.");
    assert.equal(s?.authoring_principal, "F-ORIGINAL");
    assert.equal(s?.declared_model, "self-declared/model");
  }));

for (const status of ["private-draft"]) {
  test(`${status} problems never return retained synthesis text`, () =>
    using(async (f) => {
      f.publish();
      f.sql.query("UPDATE problems SET status=? WHERE id='P-SYNTH'").run(status);
      const p = await f.read();
      assert.equal(p.found, false);
      assert.deepEqual(p.items, []);
    }));
}
test("known unlisted problems remain public readable resources", () =>
  using(async (f) => {
    f.publish();
    f.sql.exec("UPDATE problems SET unlisted=1 WHERE id='P-SYNTH'");
    assert.equal((await f.read()).items.length, 1);
  }));
test("whole-problem hide overrides a historical cut", () =>
  using(async (f) => {
    f.publish();
    f.hide("problem");
    assert.equal((await f.read({ through: 2 })).found, false);
  }));
test("object hide and restore use the latest control, even at the old cursor", () =>
  using(async (f) => {
    f.publish();
    f.hide("SYNTH-A");
    assert.deepEqual((await f.read({ through: 2 })).items, []);
    f.hide("SYNTH-A", 2, "visible");
    assert.equal((await f.read({ through: 2 })).items.length, 1);
    f.hide("SYNTH-A", 3);
    assert.deepEqual((await f.read({ synthesisId: "SYNTH-A" })).items, []);
  }));
for (const target of ["SYNTH-A@1", "#2"]) {
  test(`exact ${target} controls govern historical synthesis reads and restore`, () =>
    using(async (f) => {
      f.publish();
      const original = await f.read({ through: 2, synthesisId: "SYNTH-A" });
      assert.equal(original.items.length, 1);
      f.hide(target);
      const hidden = await f.read({ through: 2, synthesisId: "SYNTH-A" });
      assert.deepEqual(hidden.items, []);
      assert.ok(hidden.omitted.includes("content_unavailable"));
      assert.ok(!JSON.stringify(hidden).includes("Published scientific work."));
      f.hide(target, 2, "visible");
      assert.deepEqual(await f.read({ through: 2, synthesisId: "SYNTH-A" }), original);
    }));
}
test("verified exact source witnesses and structured closing declarations survive reading", () =>
  using(async (f) => {
    const closing = {
      result_claim: { claim_id: "C-1", version: 1 },
      direction: "affirmed",
      no_claim_boundary: {
        verified: ["The finite statement."],
        mechanisms: ["Independent argument review."],
        independence_tiers: ["T2"],
        remaining_external_validation: ["No external expert admission."],
      },
    };
    const publication = f.publish(2, "SYNTH-A", { closing_resolution: closing });
    const item = (await f.read({ synthesisId: "SYNTH-A" })).items[0];
    assert.deepEqual(item?.synthesis.closing_resolution, closing);
    assert.deepEqual(item?.source, {
      eventId: publication.eventId,
      payloadDigest: digest(publication.body),
      payloadJson: publication.body,
      problemId: "P-SYNTH",
      seq: 2,
    });
  }));
test("controls are problem-scoped", () =>
  using(async (f) => {
    f.publish();
    f.sql.exec("INSERT INTO content_controls VALUES('P-OTHER','SYNTH-A',1,'hidden')");
    assert.equal((await f.read()).items.length, 1);
  }));
test("redaction suppresses body, metadata and omissions from the work product", () =>
  using(async (f) => {
    f.publish();
    f.sql.exec("UPDATE event_content SET redacted_at='now'");
    const p = await f.read();
    assert.deepEqual(p.items, []);
    assert.ok(p.omitted.includes("content_unavailable"));
    assert.ok(!JSON.stringify(p).includes("scope not examined"));
  }));
test("changed bytes are rejected even when both retained digest columns match", () =>
  using(async (f) => {
    f.publish();
    f.sql.exec(
      "UPDATE event_content SET payload_json=replace(payload_json,'Published','Fabricated')",
    );
    const p = await f.read();
    assert.deepEqual(p.items, []);
    assert.ok(p.omitted.includes("content_unavailable"));
  }));
test("mismatched content-to-event digest cannot be read", () =>
  using(async (f) => {
    f.publish();
    f.sql.exec("UPDATE event_content SET payload_sha256='other'");
    assert.deepEqual((await f.read()).items, []);
  }));
test("missing retained body is not replaced with a projection", () =>
  using(async (f) => {
    f.publish();
    f.sql.exec("UPDATE event_content SET event_id='DETACHED'");
    assert.deepEqual((await f.read()).items, []);
  }));
for (const raw of ["not json", "null", "[]", "17"]) {
  test(`invalid synthesis body ${raw} is withheld without unsafe JSON extraction`, () =>
    using(async (f) => {
      f.publish(2, "SYNTH-A", {}, {}, raw);
      assert.deepEqual((await f.read({ synthesisId: "SYNTH-A" })).items, []);
    }));
}
for (const change of [
  { synthesis_id: "SYNTH-OTHER" },
  { problem_id: "P-OTHER" },
  { covers_through: 2 },
  { covers_through: -1 },
  { covers_through: 1.5 },
  { dropped_single_author_count: -1 },
  { dropped_single_author_count: "1" },
]) {
  test(`rejects inconsistent immutable payload ${JSON.stringify(change)}`, () =>
    using(async (f) => {
      f.publish(2, "SYNTH-A", change);
      assert.deepEqual((await f.read()).items, []);
    }));
}
for (const field of ["fellow", "sponsor", "session", "model", "harness"]) {
  test(`missing ${field} is disclosed rather than invented`, () =>
    using(async (f) => {
      f.publish(2, "SYNTH-A", {}, { [field]: null });
      assert.ok((await f.read()).omitted.includes("content_unavailable"));
    }));
}
test("malformed publication time is withheld", () =>
  using(async (f) => {
    f.publish(2, "SYNTH-A", {}, { at: "not a timestamp" });
    assert.deepEqual((await f.read()).items, []);
  }));
test("the exact source must be a version-one synthesis publication", () =>
  using(async (f) => {
    f.publish(2, "SYNTH-A", {}, { type: "synthesis.fake" });
    f.publish(3, "SYNTH-B", {}, { kind: "claim" });
    f.publish(4, "SYNTH-C", {}, { version: 2 });
    assert.deepEqual((await f.read()).items, []);
  }));
test("duplicate creation never manufactures an exact synthesis", () =>
  using(async (f) => {
    f.publish(2);
    f.publish(3);
    assert.deepEqual((await f.read({ synthesisId: "SYNTH-A" })).items, []);
  }));
test("list order follows publication, not an author-supplied coverage rank", () =>
  using(async (f) => {
    f.publish(5, "SYNTH-A", { covers_through: 4 });
    f.publish(6, "SYNTH-B", { covers_through: 1 });
    assert.deepEqual(
      (await f.read()).items.map((i) => i.synthesis.synthesis_id),
      ["SYNTH-B", "SYNTH-A"],
    );
  }));
test("lookahead reports page limits without confusing an exact-sized page", () =>
  using(async (f) => {
    f.publish(2, "SYNTH-A");
    f.publish(3, "SYNTH-B");
    assert.ok((await f.read({ limit: 1 })).omitted.includes("page_limit"));
    assert.ok(!(await f.read({ limit: 2 })).omitted.includes("page_limit"));
  }));
test("exact reads find old publications beyond the ordinary list limit", () =>
  using(async (f) => {
    for (let i = 1; i <= 60; i++) f.publish(i + 1, `SYNTH-${i}`);
    assert.equal((await f.read()).items.length, 50);
    const exact = await f.read({ synthesisId: "SYNTH-1" });
    assert.equal(exact.items[0]?.synthesis.synthesis_id, "SYNTH-1");
    assert.deepEqual(exact.omitted, []);
  }));
test("old cuts are stable across later appends but honor later redaction", () =>
  using(async (f) => {
    f.publish();
    const before = await f.read({ through: 2 });
    f.publish(3, "SYNTH-B");
    assert.deepEqual(await f.read({ through: 2 }), before);
    f.sql.exec("UPDATE event_content SET redacted_at='now' WHERE event_id='EV-P-SYNTH-2'");
    assert.deepEqual((await f.read({ through: 2 })).items, []);
  }));
test("a requested future cursor is refused rather than exposing unannounced events", () =>
  using(async (f) => {
    f.publish();
    f.sql.exec("UPDATE problems SET public_seq=1 WHERE id='P-SYNTH'");
    await assert.rejects(f.read({ through: 2 }), /CURSOR_INVALID/);
    assert.deepEqual((await f.read()).items, []);
  }));
test("staleness excludes future events and process-only publications in one read", () =>
  using(async (f) => {
    f.publish(2, "SYNTH-A", { covers_through: 1 });
    f.publish(3, "C-1", {}, { type: "claim.created", kind: "claim" });
    f.publish(4, "SYNTH-B");
    f.publish(5, "C-2", {}, { type: "claim.created", kind: "claim" });
    const exact = await f.read({ synthesisId: "SYNTH-A", through: 4 });
    assert.equal(exact.items[0]?.materialEventsSince, 1);
    assert.equal(f.queries.length, 1);
  }));
test("synthesis staleness follows formulation and scientific source changes at the captured cut", () =>
  using(async (f) => {
    f.publish(2, "SYNTH-A", { covers_through: 1 });
    const events = [
      ["problem.statement-revised", "problem"],
      ["relation.asserted", "relation"],
      ["relation.disputed", "relation"],
      ["citation.corrected", "citation"],
      ["object.retracted", "retraction"],
      ["evidence.created", "evidence"],
    ];
    for (const [index, [type, kind]] of events.entries())
      f.publish(index + 3, `SOURCE-${index}`, {}, { type, kind });
    assert.equal(
      (await f.read({ synthesisId: "SYNTH-A", through: 2 })).items[0]?.materialEventsSince,
      0,
    );
    assert.equal(
      (await f.read({ synthesisId: "SYNTH-A", through: 3 })).items[0]?.materialEventsSince,
      1,
    );
    assert.equal(
      (await f.read({ synthesisId: "SYNTH-A", through: 7 })).items[0]?.materialEventsSince,
      5,
    );
    assert.equal((await f.read({ synthesisId: "SYNTH-A" })).items[0]?.materialEventsSince, 6);
  }));
test("scientific object identifiers do not turn leases or unknown producers into synthesis drift", () =>
  using(async (f) => {
    f.publish(2, "SYNTH-A", { covers_through: 1 });
    const events = [
      ["lease.acquired", "claim"],
      ["lease.challenged", "hypothesis"],
      ["lease.released", "gap"],
      ["problem.writer-cap-changed", "problem"],
      ["claim.unknown-metadata", "claim"],
      ["claim.created", "session"],
    ];
    for (const [index, [type, kind]] of events.entries())
      f.publish(index + 3, `PROCESS-${index}`, {}, { type, kind });
    assert.equal((await f.read({ synthesisId: "SYNTH-A" })).items[0]?.materialEventsSince, 0);
  }));
test("a page's UTF-8 budget bounds transfer without splitting work products", () =>
  using(async (f) => {
    const body = "界".repeat(Math.floor(SYNTHESIS_READ_BYTES / 4));
    f.publish(2, "SYNTH-A", { body_md: body });
    f.publish(3, "SYNTH-B", { body_md: body });
    const p = await f.read();
    assert.equal(p.items.length, 1);
    assert.equal(p.items[0]?.synthesis.body_md, body);
    assert.ok(p.omitted.includes("byte_limit"));
    assert.equal(p.nextBefore, 3);
    assert.equal(f.queries.length, 1);
    const next = await f.read({ through: p.cursor, before: p.nextBefore ?? undefined });
    assert.equal(next.items.length, 1);
    assert.equal(next.items[0]?.synthesis.synthesis_id, "SYNTH-A");
    assert.equal(next.items[0]?.synthesis.body_md, body);
    assert.equal(next.nextBefore, null);
  }));
test("one oversized source never crosses the body transfer bound", () =>
  using(async (f) => {
    f.publish(2, "SYNTH-A", { body_md: "x".repeat(SYNTHESIS_READ_BYTES + 1) });
    const p = await f.read({ synthesisId: "SYNTH-A" });
    assert.deepEqual(p.items, []);
    assert.ok(p.omitted.includes("byte_limit"));
  }));
test("empty public scope, missing scope and missing exact id stay distinct internally", () =>
  using(async (f) => {
    assert.equal((await f.read()).found, true);
    assert.deepEqual((await f.read()).omitted, []);
    assert.equal((await readSynthesisPage(f.db, "P-MISSING", {}, decode)).found, false);
    assert.deepEqual((await f.read({ synthesisId: "SYNTH-MISSING" })).items, []);
  }));
test("exact identifiers are bound as data and never escape problem scope", () =>
  using(async (f) => {
    f.publish(2, "SYNTH-OTHER", {}, { problem_id: "P-OTHER" });
    f.publish();
    assert.deepEqual((await f.read({ synthesisId: "SYNTH-OTHER" })).items, []);
    assert.deepEqual((await f.read({ synthesisId: "' OR 1=1 --" })).items, []);
  }));
test("unusable database responses fail, not an invented complete empty list", async () => {
  const db = {
    prepare() {
      return {
        bind() {
          return { all: async () => ({}) };
        },
      };
    },
  } as unknown as D1Database;
  await assert.rejects(readSynthesisPage(db, "P-SYNTH", {}, decode), SynthesisReadError);
});
test("invalid internal read bounds are rejected before any query", () =>
  using(async (f) => {
    for (const options of [
      { through: NaN },
      { through: -1 },
      { through: 0.5 },
      { limit: Infinity },
      { before: 2 },
      { before: 0, through: 2 },
      { before: 3, through: 2 },
      { before: 2, through: 2, synthesisId: "SYNTH-A" },
    ])
      await assert.rejects(f.read(options), /CURSOR_INVALID/);
    assert.equal(f.queries.length, 0);
  }));
test("decoder rejection withholds a valid-hash but nonconforming work product", () =>
  using(async (f) => {
    f.publish();
    const p = await readSynthesisPage(f.db, "P-SYNTH", {}, () => null);
    assert.deepEqual(p.items, []);
    assert.ok(p.omitted.includes("content_unavailable"));
  }));

test("bounded pages traverse more than two hundred publications at one immutable cut", () =>
  using(async (f) => {
    for (let i = 1; i <= 205; i++) f.publish(i + 1, `SYNTH-${i}`);
    const seen: number[] = [];
    let page = await f.read({ limit: 8 });
    const through = page.cursor;
    f.publish(207, "SYNTH-NEW");
    for (;;) {
      seen.push(...page.items.map((item) => item.synthesis.seq));
      if (page.nextBefore === null) break;
      page = await f.read({ through, before: page.nextBefore, limit: 8 });
      assert.equal(page.cursor, through);
    }
    assert.deepEqual(
      seen,
      Array.from({ length: 205 }, (_, i) => 206 - i),
    );
    assert.equal(f.queries.length, 26);
  }));

test("wholly withheld pages advance without disclosing identities or retained content", () =>
  using(async (f) => {
    for (let seq = 2; seq <= 6; seq++) f.publish(seq, `SYNTH-${seq}`);
    f.hide("SYNTH-6");
    f.sql.exec("UPDATE event_content SET redacted_at='now' WHERE event_id='EV-P-SYNTH-5'");
    const first = await f.read({ limit: 2 });
    assert.deepEqual(first.items, []);
    assert.equal(first.nextBefore, 5);
    assert.deepEqual(first.omitted, ["content_unavailable", "page_limit"]);
    const next = await f.read({
      through: first.cursor,
      before: first.nextBefore ?? undefined,
      limit: 2,
    });
    assert.deepEqual(
      next.items.map((item) => item.synthesis.seq),
      [4, 3],
    );
    assert.equal(next.nextBefore, 3);
    const last = await f.read({
      through: first.cursor,
      before: next.nextBefore ?? undefined,
      limit: 2,
    });
    assert.deepEqual(
      last.items.map((item) => item.synthesis.seq),
      [2],
    );
    assert.equal(last.nextBefore, null);
    assert.ok(!JSON.stringify(first).includes("SYNTH-6"));
    assert.ok(!JSON.stringify(first).includes("Published scientific work"));
  }));

test("an individually oversized source advances and cannot strand a valid older synthesis", () =>
  using(async (f) => {
    f.publish(2, "SYNTH-A");
    f.publish(3, "SYNTH-OVERSIZED", { body_md: "x".repeat(SYNTHESIS_READ_BYTES + 1) });
    const first = await f.read();
    assert.equal(first.nextBefore, 3);
    assert.deepEqual(first.items, []);
    assert.deepEqual(
      (await f.read({ through: first.cursor, before: 3 })).items.map(
        (item) => item.synthesis.synthesis_id,
      ),
      ["SYNTH-A"],
    );
  }));

test("HTTP list representations share strict snapshot navigation and conditional behavior", () =>
  using(async (f) => {
    for (let seq = 2; seq <= 11; seq++) f.publish(seq, `SYNTH-${seq}`);
    const first = await f.http();
    assert.equal(first.status, 200);
    const face = SynthesesListResponseSchema.parse(await first.json());
    assert.equal(face.cursor, 11);
    assert.equal(face.syntheses.length, 8);
    assert.equal(face.next_before, 4);
    assert.match(
      first.headers.get("link") ?? "",
      /syntheses\.json\?through=11&before=4&limit=8>; rel="next"/,
    );
    const etag = first.headers.get("etag") ?? "";
    const head = await f.http(undefined, { method: "HEAD" });
    assert.equal(await head.text(), "");
    assert.equal(head.headers.get("etag"), etag);
    assert.equal(
      (await f.http(undefined, { headers: { "if-none-match": `W/${etag}` } })).status,
      304,
    );
    for (const format of ["md", "html"]) {
      const response = await f.http(`/p/P-SYNTH/syntheses.${format}`);
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /Publication snapshot #11/);
      assert.match(body, /Older syntheses/);
      assert.notEqual(response.headers.get("etag"), etag);
    }
    f.publish(12, "SYNTH-NEW");
    const second = await f.http("/p/P-SYNTH/syntheses.json?through=11&before=4&limit=8");
    const older = SynthesesListResponseSchema.parse(await second.json());
    assert.deepEqual(
      older.syntheses.map((item) => item.seq),
      [3, 2],
    );
    assert.equal(older.next_before, null);
    f.hide("SYNTH-11");
    const changed = await f.http("/p/P-SYNTH/syntheses.json?through=11", {
      headers: { "if-none-match": etag },
    });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get("etag"), etag);
    assert.ok(!(await changed.text()).includes('"synthesis_id":"SYNTH-11"'));
    f.hide("problem");
    assert.equal((await f.http(undefined, { headers: { "if-none-match": "*" } })).status, 404);
  }));

test("HTTP list rejects ambiguous pagination and applies unlisted cache policy", () =>
  using(async (f) => {
    f.publish();
    for (const query of [
      "limit=2junk",
      "limit=0",
      "limit=201",
      "limit=1&limit=2",
      "before=2",
      "before=3&through=2",
      "before=0&through=2",
      "through=3",
      "through=01",
      "through=2&unknown=yes",
    ]) {
      const response = await f.http(`/p/P-SYNTH/syntheses.json?${query}`);
      assert.equal(response.status, 400, query);
      assert.equal(((await response.json()) as { code: string }).code, "CURSOR_INVALID");
    }
    const empty = await f.http("/p/P-SYNTH/syntheses.json?through=0");
    assert.equal(empty.status, 200);
    assert.deepEqual(SynthesesListResponseSchema.parse(await empty.json()).syntheses, []);
    f.sql.exec("UPDATE problems SET unlisted=1 WHERE id='P-SYNTH'");
    const unlisted = await f.http();
    assert.equal(unlisted.headers.get("cache-control"), "private, no-store");
    assert.equal(unlisted.headers.get("x-robots-tag"), "noindex, nofollow");
    f.sql.exec("UPDATE problems SET status='private-draft' WHERE id='P-SYNTH'");
    const hidden = await f.http(undefined, { method: "HEAD", headers: { "if-none-match": "*" } });
    assert.equal(hidden.status, 404);
    assert.equal(await hidden.text(), "");
  }));
