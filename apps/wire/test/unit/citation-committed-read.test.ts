import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CitationItem } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { loadCommittedCitation, loadCommittedCitations } from "../../src/ledger/citation-read";

/** SQL unit fixture, not a deployed D1 or migration/chain-integrity proof. */
function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE problems (id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT);
    CREATE TABLE events (
      id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER,
      payload_sha256 TEXT, created_at TEXT, actor_fellow_id TEXT,
      actor_sponsor_id TEXT, actor_session_id TEXT, model_string_self_declared TEXT, harness TEXT
    );
    CREATE TABLE event_content (
      event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT
    );
    CREATE TABLE citations (problem_id TEXT, citation_id TEXT, title TEXT);
    INSERT INTO problems VALUES ('P-TEST', 1000, 'active'), ('P-OTHER', 1000, 'active');
    INSERT INTO citations VALUES ('P-TEST', 'L-1', 'PRIVATE_PROJECTION_CANARY');
  `);
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    const statement = {
      bind: (...args: unknown[]) => {
        values = args;
        return statement;
      },
      all: async () => ({ success: true, results: sqlite.query(sql).all(...(values as never[])) }),
    };
    return statement;
  };
  const db = {
    prepare,
    batch: async (statements: Array<{ all: () => Promise<unknown> }>) => {
      sqlite.exec("BEGIN");
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.all());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  async function event(
    seq: number,
    id: string,
    version: number,
    payload: Record<string, unknown>,
    kind = "citation",
    problem = "P-TEST",
  ) {
    const body = JSON.stringify(payload);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const eventId = `${problem}-${seq}`;
    const type =
      kind === "citation"
        ? version === 1
          ? "citation.recorded"
          : "citation.corrected"
        : kind === "claim"
          ? version === 1
            ? "claim.created"
            : "claim.revised"
          : "evidence.created";
    sqlite
      .query("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        eventId,
        problem,
        seq,
        type,
        kind,
        id,
        version,
        hash,
        "2026-09-15T00:00:00.000Z",
        "F-AUTHOR",
        "SP-AUTHOR",
        "S-SESSION",
        "model-declared",
        "harness-declared",
      );
    sqlite.query("INSERT INTO event_content VALUES (?, ?, ?, NULL)").run(eventId, hash, body);
  }
  return { sqlite, db, event };
}

function citation(id = "L-1", title = "Published source", unanchored = true) {
  return {
    citation_id: id,
    title,
    authors: ["Example Author"],
    year: 2026,
    locator_kind: "doi",
    locator: "10.1234/example",
    canonical_locator: "10.1234/example",
    excerpt: "Published bounded excerpt",
    retrieved_at: "2026-09-15",
    source_provenance: "retrieved",
    unanchored,
    norm_hash: `citation:doi:${id}`,
  };
}

// Deliberate decoder seam: these tests prove the SQL selection and commitment
// boundary. The production caller supplies the canonical CitationItemSchema;
// this fixture does not purport to test Zod or its generated schema.
function decodeFixture(value: unknown): CitationItem | undefined {
  const item = value as CitationItem;
  return typeof item.title === "string" && item.title.length > 0 && Array.isArray(item.authors)
    ? item
    : undefined;
}

test("citation lists resolve historical versions from events and ignore mutable projections", async () => {
  const { sqlite, db, event } = fixture();
  try {
    await event(1, "L-1", 1, citation());
    await event(5, "L-1", 2, citation("L-1", "Corrected source"));
    const current = await loadCommittedCitations(db, "P-TEST", {}, decodeFixture);
    const previous = await loadCommittedCitations(db, "P-TEST", { through: 4 }, decodeFixture);
    assert.equal(current.citations[0]?.version, 2);
    assert.equal(previous.citations[0]?.version, 1);
    assert.equal(previous.citations[0]?.title, "Published source");
    assert.ok(!JSON.stringify(current).includes("PRIVATE_PROJECTION_CANARY"));
  } finally {
    sqlite.close();
  }
});

test("redacted head never revives an earlier version; an available exact historical version remains readable", async () => {
  const { sqlite, db, event } = fixture();
  try {
    await event(1, "L-1", 1, citation());
    await event(5, "L-1", 2, citation("L-1", "WITHDRAWN_CANARY"));
    sqlite
      .query("UPDATE event_content SET redacted_at = 'redacted' WHERE event_id = ?")
      .run("P-TEST-5");
    const list = await loadCommittedCitations(db, "P-TEST", {}, decodeFixture);
    assert.equal(list.citations.length, 0);
    assert.ok(list.omitted.some((message) => message.includes("unavailable")));
    assert.equal(await loadCommittedCitation(db, "P-TEST", "L-1", {}, decodeFixture), null);
    assert.equal(await loadCommittedCitation(db, "P-TEST", "L-1@2", {}, decodeFixture), null);
    const historical = await loadCommittedCitation(db, "P-TEST", "L-1@1", {}, decodeFixture);
    assert.equal(historical?.citation.version, 1);
    assert.deepEqual(
      historical?.versions.map((version) => version.version),
      [1],
    );
    assert.ok(!JSON.stringify(historical).includes("WITHDRAWN_CANARY"));
  } finally {
    sqlite.close();
  }
});

test("current redaction also wins over an old cursor", async () => {
  const { sqlite, db, event } = fixture();
  try {
    await event(1, "L-1", 1, citation());
    sqlite.query("UPDATE event_content SET redacted_at = 'redacted'").run();
    assert.equal(
      (await loadCommittedCitations(db, "P-TEST", { through: 1 }, decodeFixture)).citations.length,
      0,
    );
    assert.equal(
      await loadCommittedCitation(db, "P-TEST", "L-1@1", { through: 1 }, decodeFixture),
      null,
    );
  } finally {
    sqlite.close();
  }
});

test("tampered and missing content cannot be replaced by retained projections", async () => {
  for (const mutation of [
    'UPDATE event_content SET payload_json = \'{"title":"TAMPERED_CANARY"}\'',
    "UPDATE event_content SET payload_sha256 = 'wrong'",
    "UPDATE event_content SET payload_json = NULL",
  ]) {
    const { sqlite, db, event } = fixture();
    try {
      await event(1, "L-1", 1, citation());
      sqlite.exec(mutation);
      assert.equal(
        (await loadCommittedCitations(db, "P-TEST", {}, decodeFixture)).citations.length,
        0,
      );
      assert.equal(await loadCommittedCitation(db, "P-TEST", "L-1", {}, decodeFixture), null);
    } finally {
      sqlite.close();
    }
  }
});

test("public cut excludes later events and all private-draft content", async () => {
  const { sqlite, db, event } = fixture();
  try {
    await event(1, "L-1", 1, citation());
    await event(5, "L-1", 2, citation("L-1", "UNPUBLISHED_CANARY"));
    sqlite.query("UPDATE problems SET public_seq = 4 WHERE id = 'P-TEST'").run();
    assert.equal(
      (await loadCommittedCitation(db, "P-TEST", "L-1", {}, decodeFixture))?.citation.version,
      1,
    );
    assert.equal(await loadCommittedCitation(db, "P-TEST", "L-1@2", {}, decodeFixture), null);
    sqlite.query("UPDATE problems SET status = 'private-draft' WHERE id = 'P-TEST'").run();
    assert.equal(
      (await loadCommittedCitations(db, "P-TEST", {}, decodeFixture)).citations.length,
      0,
    );
    assert.equal(await loadCommittedCitation(db, "P-TEST", "L-1", {}, decodeFixture), null);
  } finally {
    sqlite.close();
  }
});

test("public events in a different problem never satisfy citation or backlink identity", async () => {
  const { sqlite, db, event } = fixture();
  try {
    await event(1, "L-1", 1, citation("L-1", "OTHER_CANARY"), "citation", "P-OTHER");
    assert.equal(await loadCommittedCitation(db, "P-TEST", "L-1", {}, decodeFixture), null);
    await event(1, "L-1", 1, citation());
    await event(2, "C-1", 1, { statement: "OTHER_CLAIM_CANARY L-1@1" }, "claim", "P-OTHER");
    const result = await loadCommittedCitation(db, "P-TEST", "L-1@1", {}, decodeFixture);
    assert.equal(result?.associated_claims.length, 0);
    assert.ok(!JSON.stringify(result).includes("OTHER_CANARY"));
  } finally {
    sqlite.close();
  }
});

test("backlinks match exact IDs and versions and retain the matched claim version", async () => {
  const { sqlite, db, event } = fixture();
  try {
    await event(1, "L-1", 1, citation());
    await event(2, "C-1", 1, { statement: "See L-10@1." }, "claim");
    await event(3, "C-2", 1, { statement: "See [L-1@1]." }, "claim");
    await event(4, "C-3", 1, { statement: "See L-1@2." }, "claim");
    await event(5, "C-4", 1, { statement: "See L-1." }, "claim");
    const exact = await loadCommittedCitation(db, "P-TEST", "L-1@1", {}, decodeFixture);
    assert.deepEqual(
      exact?.associated_claims.map((claim) => claim.claim_id),
      ["C-2"],
    );
    const head = await loadCommittedCitation(db, "P-TEST", "L-1", {}, decodeFixture);
    assert.deepEqual(
      head?.associated_claims.map((claim) => claim.claim_id),
      ["C-2", "C-4"],
    );
    await event(6, "C-2", 2, { statement: "The revision no longer cites that source." }, "claim");
    assert.equal(
      (await loadCommittedCitation(db, "P-TEST", "L-1@1", {}, decodeFixture))?.associated_claims
        .length,
      0,
    );
    const old = await loadCommittedCitation(db, "P-TEST", "L-1@1", { through: 5 }, decodeFixture);
    assert.equal(old?.associated_claims[0]?.version, 1);
  } finally {
    sqlite.close();
  }
});

test("backlink content is digest-verified and redaction-safe, including evidence", async () => {
  const { sqlite, db, event } = fixture();
  try {
    await event(1, "L-1", 1, citation());
    await event(2, "C-1", 1, { statement: "[L-1@1] CLAIM_CANARY" }, "claim");
    await event(
      3,
      "E-1",
      1,
      {
        source: { kind: "retrieved", locator: "L-1@1" },
        direction: "support",
        bears_on_id: "C-1",
        computed_class: "argument",
      },
      "evidence",
    );
    const visible = await loadCommittedCitation(db, "P-TEST", "L-1@1", {}, decodeFixture);
    assert.equal(visible?.associated_claims.length, 1);
    assert.equal(visible?.associated_evidence.length, 1);
    sqlite
      .query("UPDATE event_content SET redacted_at = 'redacted' WHERE event_id = 'P-TEST-2'")
      .run();
    sqlite
      .query(
        "UPDATE event_content SET payload_json = payload_json || ' ' WHERE event_id = 'P-TEST-3'",
      )
      .run();
    const hidden = await loadCommittedCitation(db, "P-TEST", "L-1@1", {}, decodeFixture);
    assert.equal(hidden?.associated_claims.length, 0);
    assert.equal(hidden?.associated_evidence.length, 0);
    assert.ok(!JSON.stringify(hidden).includes("CLAIM_CANARY"));
  } finally {
    sqlite.close();
  }
});

test("evidence backlinks use the committed nested source, not top-level lookalikes", async () => {
  const { sqlite, db, event } = fixture();
  try {
    await event(1, "L-1", 1, citation());
    const base = { direction: "support", bears_on_id: "C-1", computed_class: "argument" };
    await event(
      2,
      "E-1",
      1,
      { ...base, source: { kind: "retrieved", excerpt: "See L-1@1." } },
      "evidence",
    );
    await event(
      3,
      "E-2",
      1,
      { ...base, locator: "L-1@1", source: { kind: "retrieved", locator: "L-10@1" } },
      "evidence",
    );
    await event(4, "E-3", 1, { ...base, excerpt: "L-1@1", source: null }, "evidence");
    await event(5, "E-4", 1, { ...base, locator: "L-1@1", source: ["L-1@1"] }, "evidence");
    const result = await loadCommittedCitation(db, "P-TEST", "L-1@1", {}, decodeFixture);
    assert.deepEqual(
      result?.associated_evidence.map((entry) => entry.evidence_id),
      ["E-1"],
    );
  } finally {
    sqlite.close();
  }
});

test("attribution is taken from the event and unknown payload fields are not exported", async () => {
  const { sqlite, db, event } = fixture();
  try {
    await event(1, "L-1", 1, {
      ...citation(),
      sponsor_id: "SP-SPOOF",
      private_workshop: "PRIVATE_CANARY",
    });
    const result = await loadCommittedCitation(db, "P-TEST", "L-1@1", {}, decodeFixture);
    assert.equal(result?.citation.sponsor_id, "SP-AUTHOR");
    assert.equal(result?.citation.author_fellow_id, "F-AUTHOR");
    assert.equal(result?.citation.declared_model, "model-declared");
    assert.ok(!JSON.stringify(result).includes("PRIVATE_CANARY"));
    assert.ok(!JSON.stringify(result).includes("SP-SPOOF"));
  } finally {
    sqlite.close();
  }
});

test("payload identity disagreement and canonical decoder refusal withhold a citation", async () => {
  const { sqlite, db, event } = fixture();
  try {
    await event(1, "L-1", 1, citation("L-2"));
    assert.equal(await loadCommittedCitation(db, "P-TEST", "L-1@1", {}, decodeFixture), null);
    await event(2, "L-3", 1, citation("L-3"));
    assert.equal(await loadCommittedCitation(db, "P-TEST", "L-3@1", {}, () => undefined), null);
  } finally {
    sqlite.close();
  }
});

test("lists preserve numeric citation order and disclose filter and count bounds", async () => {
  const { sqlite, db, event } = fixture();
  try {
    await event(1, "L-10", 1, citation("L-10", "Source ten", false));
    await event(2, "L-2", 1, citation("L-2"));
    await event(3, "L-1", 1, citation("L-1"));
    const all = await loadCommittedCitations(db, "P-TEST", {}, decodeFixture);
    assert.deepEqual(
      all.citations.map((item) => item.citation_id),
      ["L-1", "L-2", "L-10"],
    );
    const filtered = await loadCommittedCitations(
      db,
      "P-TEST",
      { limit: 1, unanchored: true },
      decodeFixture,
    );
    assert.equal(filtered.citations.length, 1);
    assert.ok(filtered.omitted.some((message) => message.includes("filter")));
    assert.ok(filtered.omitted.some((message) => message.includes("bounded")));
  } finally {
    sqlite.close();
  }
});

test("invalid version syntax and impossible read bounds fail before SQL", async () => {
  const db = {
    prepare: () => {
      throw new Error("unexpected SQL");
    },
    batch: () => {
      throw new Error("unexpected SQL");
    },
  } as unknown as D1Database;
  for (const target of [
    "L-1@0",
    "L-1@01",
    "L-1@2junk",
    "L-1@9007199254740992",
    "L-1/../../",
    "L-1@1@2",
  ]) {
    assert.equal(await loadCommittedCitation(db, "P-TEST", target, {}, decodeFixture), null);
  }
  for (const through of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      loadCommittedCitations(db, "P-TEST", { through }, decodeFixture),
      /Invalid citation read bounds/,
    );
  }
});

test("duplicate citation versions refuse ambiguous history rather than selecting arbitrary bytes", async () => {
  const { sqlite, db, event } = fixture();
  try {
    await event(1, "L-1", 1, citation());
    await event(2, "L-1", 1, citation("L-1", "Conflicting duplicate"));
    await assert.rejects(
      loadCommittedCitation(db, "P-TEST", "L-1", {}, decodeFixture),
      /Citation history is unavailable/,
    );
  } finally {
    sqlite.close();
  }
});
