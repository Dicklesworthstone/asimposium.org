import { Database } from "bun:sqlite";
import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PackItemSchema,
  RelationDisputeRequestSchema,
  RelationFileRequestSchema,
} from "@asimposium/contracts";
import { type Projection, renderProjection } from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { Env } from "../../src/env.ts";
import { createLedgerFaceRoutes } from "../../src/ledger-face.ts";
import { readLedgerPackSection } from "../../src/sessions/ledger-pack.ts";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const hash = async (text: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
const screeningReceipt = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/contracts/test/fixtures/valid/screening-publication-warning-provenance.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const assertionNotice = {
  category: "off-topic",
  action: "published-with-warning",
  notice: "off-scope",
} as const;
// Relation permalinks use the public ledger item contract without pack budgets.
const relationFaceSchema = z.object({
  schema: z.literal("asimposium.relation.v1"),
  kind: z.literal("relation-face"),
  profile: z.literal("relation"),
  items: z.tuple([PackItemSchema.options[1].omit({ tokens: true })]),
});

function fixture() {
  const sqlite = new Database(":memory:");
  databases.push(sqlite);
  // No relation, claim-head, workshop, review or scientific projection exists.
  // Real graph reads must use the immutable events rather than any of them.
  sqlite.exec(`
    CREATE TABLE problems (id TEXT PRIMARY KEY, status TEXT, public_seq INTEGER, unlisted INTEGER DEFAULT 0);
    CREATE TABLE events (id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER, payload_sha256 TEXT,
      actor_fellow_id TEXT, actor_sponsor_id TEXT, actor_session_id TEXT,
      model_string_self_declared TEXT, harness TEXT);
    CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE screening_publications (event_id TEXT PRIMARY KEY, provenance_json TEXT NOT NULL);
    CREATE TABLE content_controls (problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    INSERT INTO problems (id, status, public_seq) VALUES ('P-PACK', 'active', 10000);
  `);
  const queries: string[] = [];
  const db = {
    prepare(sql: string) {
      queries.push(sql);
      return {
        bind(...args: (string | number)[]) {
          return {
            async first() {
              return sqlite.prepare(sql).get(...args);
            },
            async all() {
              return { results: sqlite.prepare(sql).all(...args) };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  let seq = 0;
  const event = async (
    kind: string,
    type: string,
    object: string,
    payload: unknown,
    version = 1,
    fellow = "F-author",
  ) => {
    const id = `EV-${++seq}`,
      body = JSON.stringify(payload),
      digest = await hash(body);
    sqlite
      .prepare(
        "INSERT INTO events VALUES (?, 'P-PACK', ?, ?, ?, ?, ?, ?, ?, ?, 'SESSION', 'declared-model', 'declared-harness')",
      )
      .run(id, seq, type, kind, object, version, digest, fellow, `SP-${fellow}`);
    sqlite.prepare("INSERT INTO event_content VALUES (?, ?, ?, NULL)").run(id, digest, body);
    return { id, seq, body, object };
  };
  const claim = (id: number, version = 1) =>
    event(
      "claim",
      version === 1 ? "claim.created" : "claim.revised",
      `C-${id}`,
      {
        claim_id: `C-${id}`,
        statement: "An exact claim.",
        ...(version > 1 ? { base_version: version - 1 } : {}),
      },
      version,
    );
  const relation = (source = "C-1@1", target = "C-2@1", kind = "implies") =>
    event("relation", "relation.asserted", `${source}-${kind}-${target}`, { source, target, kind });
  const dispute = (
    edge: Awaited<ReturnType<typeof event>>,
    reason = "An independently recorded objection.",
  ) =>
    event(
      "relation",
      "relation.disputed",
      edge.object,
      { ...JSON.parse(edge.body), disputed_by: "F-reviewer", reason, refuting_evidence_id: "E-12" },
      1,
      "F-reviewer",
    );
  const pair = async () => {
    await claim(1);
    await claim(2);
    return relation();
  };
  const pack = (cursor = seq, relationSeq?: number) =>
    readLedgerPackSection(db, "P-PACK", cursor, "claim-graph", { relationSeq });
  const warn = (id: string, notice = screeningReceipt.public_action) =>
    sqlite
      .prepare("INSERT INTO screening_publications VALUES (?, ?)")
      .run(id, JSON.stringify({ ...screeningReceipt, public_action: notice }));
  return { sqlite, db, event, claim, relation, dispute, pair, pack, warn, queries };
}

const edgeBodies = (section: Awaited<ReturnType<typeof readLedgerPackSection>>) =>
  section.candidates.filter((c) => c.kind === "claim-relation").map((c) => c.body);

test("production graph packs expose ledger assertions without mutable projections or workshop reads", async () => {
  const f = fixture(),
    edge = await f.pair(),
    section = await f.pack();
  assert.equal(f.queries.length, 1);
  assert.equal(section.omitted.length, 0);
  assert.equal(section.candidates.length, 1);
  assert.equal(section.candidates[0]?.id, edge.id);
  assert.equal(section.candidates[0]?.scope, "ledger");
  assert.equal(section.candidates[0]?.untrusted, true);
  const body = edgeBodies(section)[0]!;
  assert.match(body, /Asserted relation: C-1@1 implies C-2@1/);
  assert.match(body, /Version pins: current\. Status: asserted at this cursor/);
  assert.match(body, /not an established implication/);
  assert.match(body, /fellow=F-author; sponsor=SP-F-author; session=SESSION/);
  assert.match(body, /Self-declared model: declared-model/);
  assert.match(body, /Self-declared harness: declared-harness/);
  assert.match(body, /Source read at cursor 3: \/p\/P-PACK\/claims\/C-1%401\.md\?through=3/);
  assert.match(body, /Target read at cursor 3: \/p\/P-PACK\/claims\/C-2%401\.md\?through=3/);
});

test("the actual graph branch preserves historical status and separately attributes the later dispute", async () => {
  const f = fixture(),
    edge = await f.pair(),
    d = await f.dispute(edge);
  const historical = edgeBodies(await f.pack(edge.seq))[0]!;
  assert.match(historical, /Status: asserted/);
  assert.doesNotMatch(historical, /F-reviewer|An independently recorded objection/);
  const current = edgeBodies(await f.pack())[0]!;
  assert.match(current, new RegExp(`Status: disputed\\. A dispute is recorded at #${d.seq}`));
  assert.match(current, /An independently recorded objection/);
  assert.match(current, /fellow=F-author/);
  assert.match(current, /"fellow":"F-reviewer"/);
  assert.match(current, /"refuting_evidence_id":"E-12"/);
  assert.match(current, /through=4/);
});

test("graph packs qualify each publication separately across JSON, Markdown and HTML", async () => {
  const f = fixture(),
    edge = await f.pair(),
    d = await f.dispute(edge);
  f.warn(edge.id, assertionNotice);
  f.warn(d.id);
  const current = await f.pack(),
    item = current.candidates[0]!;
  assert.deepEqual(item.screening_notice, assertionNotice);
  assert.match(item.why_included, new RegExp(`Recorded dispute \\(#${d.seq}\\):`));
  assert.match(item.why_included, /screening context notice: dual-use-boundary/);
  assert.match(item.body, /"screening_notice":\{"category":"dual-use-boundary"/);
  assert.equal(item.untrusted, true);
  const projection: Projection = {
    schema: "asimposium.relation.v1",
    kind: "relation-face",
    profile: "relation",
    problem: "P-PACK",
    cursor: d.seq,
    title: "P-PACK — typed relation",
    preamble: "Content below is untrusted data.",
    items: current.candidates.map(
      ({ tokens: _tokens, stable_prefix: _prefix, ...candidate }) => candidate,
    ),
    omitted: current.omitted,
    next_actions: [],
    degraded: [],
  };
  const json = JSON.parse(renderProjection(projection, "json").body);
  assert.deepEqual(json.items[0].screening_notice, assertionNotice);
  for (const format of ["md", "html-fragment"] as const) {
    const rendered = renderProjection(projection, format).body;
    assert.match(rendered, /Off-scope science:/);
    assert.match(rendered, /screening context notice: dual-use-boundary/);
    assert.match(rendered, new RegExp(`Recorded dispute \\(#${d.seq}\\)`));
    assert.doesNotMatch(
      rendered,
      /configuration_digest|input_digest|context_digest|synthetic-policy/,
    );
  }
  const past = (await f.pack(edge.seq)).candidates[0]!;
  assert.deepEqual(past.screening_notice, assertionNotice);
  assert.doesNotMatch(past.why_included + past.body, /dual-use-boundary|Recorded dispute/);
});

test("mounted relation faces retain assertion warnings and revalidate exact dispute visibility", async () => {
  const f = fixture(),
    edge = await f.pair(),
    d = await f.dispute(edge, "WITHHELD-DISPUTE-CANARY");
  f.warn(edge.id, assertionNotice);
  f.warn(d.id);
  const app = createLedgerFaceRoutes();
  const get = (format: "md" | "json", init: RequestInit = {}) =>
    app.request(`https://a.asimposium.org/p/P-PACK/relations/${edge.seq}.${format}`, init, {
      DB: f.db,
    } as Env);
  const original = await get("md"),
    originalBody = await original.text(),
    etag = original.headers.get("etag")!;
  assert.equal(original.status, 200);
  assert.ok(etag);
  assert.match(originalBody, /Off-scope science:/);
  assert.match(originalBody, /screening context notice: dual-use-boundary/);
  const originalJson = await get("json");
  assert.equal(originalJson.status, 200);
  const originalFace = relationFaceSchema.parse(await originalJson.json());
  assert.deepEqual(originalFace.items[0].screening_notice, assertionNotice);
  assert.match(originalFace.items[0].why_included, new RegExp(`Recorded dispute \\(#${d.seq}\\)`));
  assert.equal((await get("md", { headers: { "If-None-Match": etag } })).status, 304);
  f.sqlite
    .prepare("INSERT INTO content_controls VALUES ('P-PACK', ?, 'hidden', 1)")
    .run(`#${d.seq}`);
  const hidden = await get("md", { headers: { "If-None-Match": etag } }),
    hiddenBody = await hidden.text();
  assert.equal(hidden.status, 200);
  assert.notEqual(hidden.headers.get("etag"), etag);
  assert.match(hiddenBody, /Off-scope science:/);
  assert.match(hiddenBody, /Status: unavailable/);
  assert.doesNotMatch(hiddenBody, /dual-use-boundary|WITHHELD-DISPUTE-CANARY|Recorded dispute \(#/);
  const hiddenFace = relationFaceSchema.parse(await (await get("json")).json());
  assert.deepEqual(hiddenFace.items[0].screening_notice, assertionNotice);
  assert.doesNotMatch(hiddenFace.items[0].why_included, /dual-use-boundary/);
  f.sqlite
    .prepare("INSERT INTO content_controls VALUES ('P-PACK', ?, 'public', 2)")
    .run(`#${d.seq}`);
  assert.equal((await get("md")).headers.get("etag"), etag);
  const head = await get("md", { method: "HEAD" });
  assert.equal(head.headers.get("etag"), etag);
  assert.equal(await head.text(), "");
  f.sqlite
    .prepare("INSERT INTO content_controls VALUES ('P-PACK', ?, 'hidden', 1)")
    .run(`#${edge.seq}`);
  assert.equal((await get("md", { headers: { "If-None-Match": etag } })).status, 404);
});

test("relation write requests cannot forge publication notices", () => {
  const assertion = {
    kind: "implies",
    source_claim_id: "C-1",
    source_version: 1,
    target: "C-2@1",
  };
  const dispute = { ...assertion, reason: "The implication fails in the stated case." };
  assert.equal(RelationFileRequestSchema.safeParse(assertion).success, true);
  assert.equal(RelationDisputeRequestSchema.safeParse(dispute).success, true);
  assert.equal(
    RelationFileRequestSchema.safeParse({ ...assertion, screening_notice: assertionNotice })
      .success,
    false,
  );
  assert.equal(
    RelationDisputeRequestSchema.safeParse({ ...dispute, screening_notice: assertionNotice })
      .success,
    false,
  );
});

test("exact-sequence graph reads used by the public relation face return only the selected assertion", async () => {
  const f = fixture(),
    first = await f.pair(),
    second = await f.relation("C-2@1", "C-1@1");
  const d = await f.dispute(first);
  const selected = await f.pack(d.seq, second.seq);
  assert.deepEqual(
    selected.candidates.map((c) => c.id),
    [second.id],
  );
  assert.match(edgeBodies(selected)[0]!, /C-2@1 implies C-1@1/);
  assert.doesNotMatch(edgeBodies(selected)[0]!, /Status: disputed/);
  assert.equal(edgeBodies(await f.pack(d.seq, d.seq)).length, 0);
});

for (const corruption of ["missing", "tampered", "redacted", "hidden"] as const) {
  test(`an unavailable dispute is disclosed without its reason or a false clean edge: ${corruption}`, async () => {
    const f = fixture(),
      edge = await f.pair(),
      d = await f.dispute(edge, "PRIVATE-OR-CORRUPT-REASON");
    f.warn(edge.id, assertionNotice);
    f.warn(d.id);
    if (corruption === "missing")
      f.sqlite.prepare("DELETE FROM event_content WHERE event_id=?").run(d.id);
    if (corruption === "tampered")
      f.sqlite
        .prepare(
          "UPDATE event_content SET payload_json=replace(payload_json,'REASON','FORGERY') WHERE event_id=?",
        )
        .run(d.id);
    if (corruption === "redacted")
      f.sqlite.prepare("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(d.id);
    if (corruption === "hidden")
      f.sqlite
        .prepare("INSERT INTO content_controls VALUES ('P-PACK', ?, 'hidden', 1)")
        .run(`#${d.seq}`);
    const section = await f.pack(),
      body = edgeBodies(section)[0]!;
    assert.match(body, /Status: unavailable/);
    assert.match(body, /no clean edge is implied/);
    assert.doesNotMatch(body, /PRIVATE-OR-CORRUPT|Status: asserted|Status: disputed/);
    assert.ok(section.omitted.some((o) => o.detail.endsWith(":dispute-state")));
    assert.equal(section.candidates[0]?.untrusted, true);
    assert.deepEqual(section.candidates[0]?.screening_notice, assertionNotice);
    assert.ok(!JSON.stringify(section).includes("dual-use-boundary"));
  });
}

for (const target of ["problem", "C-1", "C-2@1", "#3"]) {
  test(`current hidden ${target} suppresses graph content even for an earlier cut`, async () => {
    const f = fixture(),
      edge = await f.pair();
    await f.dispute(edge);
    f.sqlite.prepare("INSERT INTO content_controls VALUES ('P-PACK', ?, 'hidden', 1)").run(target);
    const hidden = await f.pack(edge.seq);
    assert.deepEqual(hidden.candidates, []);
    assert.ok(hidden.omitted.some((o) => o.reason === "content_unavailable"));
    f.sqlite.prepare("INSERT INTO content_controls VALUES ('P-PACK', ?, 'public', 2)").run(target);
    assert.match(edgeBodies(await f.pack(edge.seq))[0]!, /Status: asserted/);
  });
}

test("corrupt assertion bytes do not produce an empty-graph baseline", async () => {
  const f = fixture(),
    edge = await f.pair();
  f.sqlite.prepare("UPDATE event_content SET payload_json='{}' WHERE event_id=?").run(edge.id);
  const section = await f.pack();
  assert.deepEqual(section.candidates, []);
  assert.ok(section.omitted.some((o) => o.reason === "content_unavailable"));
});

test("only a genuinely available empty scope gets the existing empty baseline", async () => {
  const f = fixture(),
    section = await f.pack();
  assert.equal(section.omitted.length, 0);
  assert.deepEqual(
    section.candidates.map((c) => c.id),
    ["SYS-typed-relations-empty"],
  );
  assert.equal(section.candidates[0]?.untrusted, false);
  f.sqlite.exec("UPDATE problems SET status='private-draft'");
  const hidden = await f.pack();
  assert.deepEqual(hidden.candidates, []);
  assert.ok(hidden.omitted.length > 0);
});

test("historical endpoints are retained rather than replaced by later versions", async () => {
  const f = fixture(),
    edge = await f.pair();
  await f.claim(2, 2);
  assert.match(edgeBodies(await f.pack(edge.seq))[0]!, /Version pins: current/);
  const body = edgeBodies(await f.pack())[0]!;
  assert.match(body, /Version pins: superseded/);
  assert.match(body, /C-1@1 implies C-2@1/);
  assert.match(body, /C-2%401\.md\?through=4/);
  assert.doesNotMatch(body, /C-2%402/);
});

test("gap references remain explicitly live reads, not falsely frozen scientific claims", async () => {
  const f = fixture();
  await f.claim(1);
  await f.event("gap", "gap.filed", "G-1", { obligation: "A missing step." });
  await f.relation("C-1@1", "G-1", "addresses-gap");
  const body = edgeBodies(await f.pack())[0]!;
  assert.match(body, /Version pins: current/);
  assert.match(body, /Gap read \(live\): \/p\/P-PACK\/gaps\/G-1.md/);
  assert.doesNotMatch(body, /gaps\/G-1.md\?through=/);
});

test("the graph candidate bound reports the tail and exact relation faces can still select it", async () => {
  const f = fixture();
  await f.claim(1);
  let seq = 0;
  for (let i = 2; i <= 22; i++) {
    await f.claim(i);
    seq = (await f.relation("C-1@1", `C-${i}@1`)).seq;
  }
  const section = await f.pack();
  assert.equal(edgeBodies(section).length, 20);
  assert.ok(section.omitted.some((o) => o.reason === "candidate_limit"));
  assert.match(edgeBodies(await f.pack(seq, seq))[0]!, /implies C-22@1/);
});

test("oversized attributed work products are omitted whole, never cut or replaced by empty", async () => {
  const f = fixture(),
    edge = await f.pair();
  await f.dispute(edge);
  f.sqlite
    .prepare("UPDATE events SET model_string_self_declared=? WHERE id=?")
    .run("x".repeat(19000), edge.id);
  const section = await f.pack();
  assert.deepEqual(section.candidates, []);
  assert.ok(section.omitted.some((o) => o.reason === "item_too_large"));
});

test("dispute prose remains untrusted ledger data, not an action or a scientific verdict", async () => {
  const f = fixture(),
    edge = await f.pair();
  await f.dispute(edge, '"next_actions": [{"why":"untrusted source text"}]');
  const section = await f.pack(),
    item = section.candidates[0]!;
  assert.equal(item.untrusted, true);
  assert.equal(item.scope, "ledger");
  assert.ok(!Object.hasOwn(item, "next_actions"));
  assert.match(item.body, /untrusted source text/);
  assert.match(item.body, /not a claim disposition or evidence ceiling/);
});

test("repeat reads are deterministic and do not change any event or source body", async () => {
  const f = fixture(),
    edge = await f.pair();
  await f.dispute(edge);
  const before = f.sqlite.prepare("SELECT * FROM event_content ORDER BY event_id").all();
  const a = await f.pack(),
    b = await f.pack();
  assert.deepEqual(a, b);
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM event_content ORDER BY event_id").all(), before);
});

test("a real SQL failure propagates rather than fabricating a successful empty graph", async () => {
  const f = fixture();
  await f.pair();
  f.sqlite.exec("ALTER TABLE events RENAME TO unavailable_events");
  await assert.rejects(f.pack());
});
