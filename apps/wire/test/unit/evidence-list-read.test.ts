import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { EvidenceListResponseSchema } from "@asimposium/contracts/research-lists";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { Env } from "../../src/env.ts";
import { createEvidenceListRoutes } from "../../src/ledger/evidence-list-http.ts";
import { loadEvidenceList } from "../../src/ledger/evidence-list-read.ts";
import {
  EVIDENCE_HYPOTHESIS_PAYLOAD,
  EVIDENCE_LIST_ATTRIBUTION,
  EVIDENCE_LIST_TIME,
  evidenceListPayload,
} from "../support/evidence-list-fixture.ts";

const PROBLEM = "P-EVIDENCE-PAGES";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Unit-level real SQLite execution of the bounded selection and controls.
 * The separate native lane proves these routes on migrated Workerd/D1. */
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE problems(id TEXT PRIMARY KEY,public_seq INTEGER,status TEXT,unlisted INTEGER);
    CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,type TEXT,object_kind TEXT,
      object_id TEXT,object_version INTEGER,created_at TEXT,payload_sha256 TEXT,actor_fellow_id TEXT,
      actor_sponsor_id TEXT,actor_session_id TEXT,model_string_self_declared TEXT,harness TEXT,
      UNIQUE(problem_id,seq));
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
    CREATE TABLE screening_publications(event_id TEXT PRIMARY KEY,provenance_json TEXT NOT NULL);
    CREATE TABLE content_controls(problem_id TEXT,target_ref TEXT,version INTEGER,visibility TEXT);
    CREATE TABLE scientific_withdrawals(event_id TEXT,problem_id TEXT,seq INTEGER,event_sha256 TEXT,
      retraction_id TEXT,target_kind TEXT,target_object TEXT,source_event_id TEXT,source_sha256 TEXT);
  `);
  sql.query("INSERT INTO problems VALUES(?,0,'active',0)").run(PROBLEM);
  let cursor = 0;
  function event(kind: string, id: string, payload: unknown, version = 1) {
    const text = JSON.stringify(payload);
    const digest = hash(text);
    const seq = ++cursor;
    const eventId = `event-${id}-${version}`;
    sql
      .query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        eventId,
        PROBLEM,
        seq,
        kind === "retraction"
          ? "object.retracted"
          : kind === "claim" && version > 1
            ? "claim.revised"
            : `${kind}.created`,
        kind,
        id,
        version,
        EVIDENCE_LIST_TIME,
        digest,
        EVIDENCE_LIST_ATTRIBUTION.fellowId,
        EVIDENCE_LIST_ATTRIBUTION.sponsorId,
        EVIDENCE_LIST_ATTRIBUTION.sessionId,
        EVIDENCE_LIST_ATTRIBUTION.modelSelfDeclared,
        EVIDENCE_LIST_ATTRIBUTION.harness,
      );
    sql.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(eventId, digest, text);
    sql.query("UPDATE problems SET public_seq=? WHERE id=?").run(cursor, PROBLEM);
    return { eventId, seq, digest };
  }
  event("claim", "C-1", { claim_id: "C-1", kind: "definition", statement: "The original claim." });
  event("hypothesis", "H-1", EVIDENCE_HYPOTHESIS_PAYLOAD);
  function evidence(number: number, hypothesis = false, changes: Record<string, unknown> = {}) {
    return event("evidence", `E-${number}`, {
      ...evidenceListPayload(
        hypothesis ? { kind: "hypothesis", id: "H-1" } : { kind: "claim", id: "C-1", version: 1 },
      ),
      ...changes,
    });
  }
  function visible(target: string, visibility: "hidden" | "visible") {
    sql
      .query(`INSERT INTO content_controls SELECT ?,?,COALESCE(MAX(version),0)+1,?
      FROM content_controls WHERE problem_id=? AND target_ref=?`)
      .run(PROBLEM, target, visibility, PROBLEM, target);
  }
  function replacePayload(eventId: string, value: unknown) {
    const text = JSON.stringify(value);
    const digest = hash(text);
    sql.query("UPDATE events SET payload_sha256=? WHERE id=?").run(digest, eventId);
    sql
      .query("UPDATE event_content SET payload_sha256=?,payload_json=? WHERE event_id=?")
      .run(digest, text, eventId);
  }
  let batchCount = 0;
  let beforeBatch: ((count: number) => void) | undefined;
  let transferred: Record<string, unknown>[] = [];
  function prepare(query: string) {
    let bindings: (string | number | null)[] = [];
    return {
      bind(...values: (string | number | null)[]) {
        bindings = values;
        return this;
      },
      async all() {
        return { success: true, results: sql.query(query).all(...bindings) };
      },
    };
  }
  const db = {
    prepare,
    async batch(statements: D1PreparedStatement[]) {
      beforeBatch?.(++batchCount);
      sql.exec("BEGIN");
      try {
        const result = await Promise.all(statements.map((statement) => statement.all()));
        sql.exec("COMMIT");
        transferred = (result[1]?.results ?? []) as Record<string, unknown>[];
        return result;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  const app = createEvidenceListRoutes();
  const request = (path = `/p/${PROBLEM}/evidence.json`, init: RequestInit = {}) =>
    app.request(`https://a.asimposium.org${path}`, init, { DB: db } as Env);
  return {
    sql,
    db,
    event,
    evidence,
    visible,
    replacePayload,
    request,
    transferred: () => transferred,
    beforeBatch(callback?: (count: number) => void) {
      batchCount = 0;
      beforeBatch = callback;
    },
  };
}

test("all evidence remains traversable beyond 200 events at the captured cut", async () => {
  const f = fixture();
  try {
    for (let n = 1; n <= 205; n++) f.evidence(n, n % 2 === 0);
    const captured = await loadEvidenceList(f.db, PROBLEM);
    const first = captured.face;
    expect(first).toMatchObject({ cursor: 207, count: 8, scanned_through: 10, next_after: 10 });
    expect(f.transferred()).toHaveLength(9);
    expect(f.transferred()[8]).toMatchObject({ payload_json: null, target_json: null });
    f.evidence(206);
    f.event(
      "claim",
      "C-1",
      { claim_id: "C-1", kind: "definition", statement: "Revised later.", base_version: 1 },
      2,
    );
    await captured.assertCurrent();
    const entries = [...first.evidence];
    let after = first.next_after;
    let pages = 1;
    while (after !== null) {
      const page = (await loadEvidenceList(f.db, PROBLEM, { through: first.cursor, after })).face;
      expect(page.cursor).toBe(207);
      expect(page.count).toBeLessThanOrEqual(8);
      entries.push(...page.evidence);
      after = page.next_after;
      expect(++pages).toBeLessThanOrEqual(26);
    }
    expect(pages).toBe(26);
    expect(entries.map((entry) => entry.evidence_id)).toEqual(
      Array.from({ length: 205 }, (_, i) => `E-${i + 1}`),
    );
    expect(entries[0]).toMatchObject({
      bears_on: { kind: "claim", id: "C-1", version: 1 },
      publication: {
        fellow_id: EVIDENCE_LIST_ATTRIBUTION.fellowId,
        sponsor_id: EVIDENCE_LIST_ATTRIBUTION.sponsorId,
        session_id: EVIDENCE_LIST_ATTRIBUTION.sessionId,
        model_self_declared: EVIDENCE_LIST_ATTRIBUTION.modelSelfDeclared,
        harness_self_declared: EVIDENCE_LIST_ATTRIBUTION.harness,
      },
      kind: "negative-result",
      mode: "exploratory",
    });
    expect(entries[1]?.bears_on).toEqual({ kind: "hypothesis", id: "H-1" });
    expect(entries.every((entry) => !("computed_class" in entry) && !("standing" in entry))).toBe(
      true,
    );
    expect((await loadEvidenceList(f.db, PROBLEM, { through: 209, after: 207 })).face.count).toBe(1);
  } finally {
    f.sql.close();
  }
});

test("an entirely hidden page advances without disclosing any hidden publication", async () => {
  const f = fixture();
  try {
    for (let n = 1; n <= 10; n++) f.evidence(n);
    for (let n = 1; n <= 8; n++) f.visible(`E-${n}`, "hidden");
    const first = (await loadEvidenceList(f.db, PROBLEM, { through: 12 })).face;
    expect(first).toMatchObject({ evidence: [], count: 0, scanned_through: 10, next_after: 10 });
    expect(first.omitted).toEqual(["content_unavailable", "page_limit"]);
    expect(JSON.stringify(first)).not.toContain("event-E-");
    expect(
      (await loadEvidenceList(f.db, PROBLEM, { through: 12, after: 10 })).face.evidence.map(
        (entry) => entry.evidence_id,
      ),
    ).toEqual(["E-9", "E-10"]);
    f.visible("E-1", "visible");
    expect((await loadEvidenceList(f.db, PROBLEM, { through: 12 })).face.count).toBe(1);
  } finally {
    f.sql.close();
  }
});

test.each(["C-1", "C-1@1", "#1", "E-1", "E-1@1", "#3"])(
  "current exact source control %s overrides an old cut",
  async (target) => {
    const f = fixture();
    try {
      f.evidence(1);
      f.evidence(2, true);
      f.visible(target, "hidden");
      const face = (await loadEvidenceList(f.db, PROBLEM, { through: 4 })).face;
      expect(face.evidence.map((entry) => entry.evidence_id)).toEqual(["E-2"]);
      expect(face.omitted).toEqual(["content_unavailable"]);
      f.visible(target, "visible");
      expect((await loadEvidenceList(f.db, PROBLEM, { through: 4 })).face.count).toBe(2);
    } finally {
      f.sql.close();
    }
  },
);

test("hidden or damaged hypothesis targets never disclose evidence affinity", async () => {
  const f = fixture();
  try {
    f.evidence(1, true);
    f.visible("H-1@1", "hidden");
    expect((await loadEvidenceList(f.db, PROBLEM)).face.evidence).toEqual([]);
    f.visible("H-1@1", "visible");
    f.sql
      .query("UPDATE event_content SET payload_json='{}' WHERE event_id='event-H-1-1'")
      .run();
    const broken = (await loadEvidenceList(f.db, PROBLEM)).face;
    expect(broken.evidence).toEqual([]);
    expect(broken.omitted).toContain("content_unavailable");
    expect(JSON.stringify(broken)).not.toContain("H-1");
  } finally {
    f.sql.close();
  }
});

test("corrupt, redacted, oversized and malformed records omit safely and advance", async () => {
  const f = fixture();
  try {
    for (let n = 1; n <= 6; n++) f.evidence(n);
    f.sql
      .query("UPDATE event_content SET payload_json='CORRUPT_SECRET' WHERE event_id='event-E-1-1'")
      .run();
    f.sql
      .query("UPDATE event_content SET redacted_at=? WHERE event_id='event-E-2-1'")
      .run(EVIDENCE_LIST_TIME);
    f.replacePayload("event-E-3-1", {
      ...evidenceListPayload({ kind: "claim", id: "C-1", version: 1 }),
      body_md: "a".repeat(512 * 1024),
    });
    f.replacePayload("event-E-4-1", {
      ...evidenceListPayload({ kind: "claim", id: "C-1", version: 1 }),
      direction: "proof",
    });
    f.replacePayload("event-E-5-1", evidenceListPayload({ kind: "claim", id: "C-1", version: 2 }));
    const face = (await loadEvidenceList(f.db, PROBLEM)).face;
    expect(face).toMatchObject({ count: 1, scanned_through: 8, next_after: null });
    expect(face.evidence[0]?.evidence_id).toBe("E-6");
    expect(face.omitted).toEqual(["content_unavailable"]);
    expect(JSON.stringify(face)).not.toContain("CORRUPT_SECRET");
  } finally {
    f.sql.close();
  }
});

test("source plus target transfer respects one byte budget before JavaScript decoding", async () => {
  const f = fixture();
  try {
    f.replacePayload("event-C-1-1", {
      claim_id: "C-1",
      kind: "definition",
      statement: "a".repeat(64 * 1024),
    });
    for (let n = 1; n <= 9; n++) f.evidence(n, false, { body_md: "b".repeat(64 * 1024) });
    const face = (await loadEvidenceList(f.db, PROBLEM)).face;
    expect(face.count).toBe(7);
    expect(face.next_after).toBe(10);
    expect(face.omitted).toEqual(["content_unavailable", "page_limit"]);
    const transferred = f.transferred().reduce(
      (bytes, row) =>
        bytes +
        Buffer.byteLength(typeof row.payload_json === "string" ? row.payload_json : "") +
        Buffer.byteLength(typeof row.target_json === "string" ? row.target_json : ""),
      0,
    );
    expect(transferred).toBeLessThanOrEqual(1024 * 1024);
    expect(f.transferred()[8]).toMatchObject({ payload_json: null, target_json: null });
  } finally {
    f.sql.close();
  }
});

test("withdrawals are source-bound history, not deletion or a rewritten earlier cut", async () => {
  const f = fixture();
  try {
    const source = f.evidence(1, true);
    const withdrawal = f.event("retraction", "RET-1", { target_object: "E-1", reason: "Correction" });
    f.sql
      .query("INSERT INTO scientific_withdrawals VALUES(?,?,?,?,?,'evidence','E-1',?,?)")
      .run(
        withdrawal.eventId,
        PROBLEM,
        withdrawal.seq,
        withdrawal.digest,
        "RET-1",
        source.eventId,
        source.digest,
      );
    expect((await loadEvidenceList(f.db, PROBLEM, { through: 3 })).face.evidence[0]?.withdrawn).toBe(
      false,
    );
    expect((await loadEvidenceList(f.db, PROBLEM)).face.evidence[0]?.withdrawn).toBe(true);
    f.sql.query("UPDATE scientific_withdrawals SET source_sha256=?").run("0".repeat(64));
    expect((await loadEvidenceList(f.db, PROBLEM)).face.evidence[0]?.withdrawn).toBe(false);
  } finally {
    f.sql.close();
  }
});

test("only the original publication's coarse screening notice crosses the directory", async () => {
  const f = fixture();
  try {
    const source = f.evidence(1);
    const receipt = JSON.parse(
      readFileSync(
        new URL(
          "../../../../packages/contracts/test/fixtures/valid/screening-publication-warning-provenance.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    f.sql
      .query("INSERT INTO screening_publications VALUES(?,?)")
      .run(source.eventId, JSON.stringify(receipt));
    const face = (await loadEvidenceList(f.db, PROBLEM)).face;
    expect(face.evidence[0]?.screening_notice).toEqual(receipt.public_action);
    expect(JSON.stringify(face)).not.toContain(receipt.input_digest);
    expect(JSON.stringify(face)).not.toContain(receipt.model_version);
  } finally {
    f.sql.close();
  }
});

test("JSON, Markdown, HTML and HEAD preserve frozen navigation and representation validators", async () => {
  const f = fixture();
  try {
    for (let n = 1; n <= 9; n++) f.evidence(n, n % 2 === 0);
    for (const format of ["json", "md", "html"]) {
      const path = `/p/${PROBLEM}/evidence.${format}?through=11&after=0`;
      const response = await f.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-location")).toBe(path);
      expect(response.headers.get("link")).toContain(
        `/evidence.${format}?through=11&after=10>; rel="next"`,
      );
      expect(response.headers.get("link")).toContain("/schemas/research-lists.v1.json");
      const etag = response.headers.get("etag");
      if (etag === null) throw new Error("missing ETag");
      const body = await response.text();
      if (format === "json") EvidenceListResponseSchema.parse(JSON.parse(body));
      else expect(body).toContain("E-1");
      const conditional = await f.request(path, {
        headers: { "if-none-match": `"other", W/${etag}` },
      });
      expect(conditional.status).toBe(304);
      expect(await conditional.text()).toBe("");
      const head = await f.request(path, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
    }
    const redirect = await f.request(`/p/${PROBLEM}/evidence?through=11`);
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe(`/p/${PROBLEM}/evidence.md?through=11`);
  } finally {
    f.sql.close();
  }
});

test.each([
  "?after=0",
  "?after=1",
  "?through=99",
  "?through=3&after=4",
  "?through=03",
  "?through=-1",
  "?through=1e0",
  "?through=3&through=3",
  "?through=3&after=0&after=0",
  "?through=9007199254740992",
  "?through=3&body=secret",
])("malformed or unpinned cursor %s returns an actionable refusal", async (query) => {
  const f = fixture();
  try {
    f.evidence(1);
    const response = await f.request(`/p/${PROBLEM}/evidence.json${query}`);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ code: "CURSOR_INVALID" });
  } finally {
    f.sql.close();
  }
});

test("current privacy is rechecked before a conditional reply and unlisted reads stay private", async () => {
  const f = fixture();
  try {
    f.evidence(1);
    const response = await f.request();
    const etag = response.headers.get("etag");
    if (etag === null) throw new Error("missing ETag");
    f.beforeBatch((count) => {
      if (count === 2) f.visible("E-1", "hidden");
    });
    const raced = await f.request(undefined, { headers: { "if-none-match": etag } });
    expect(raced.status).toBe(503);
    expect(raced.headers.get("etag")).toBeNull();
    expect(await raced.json()).toMatchObject({ code: "INTERNAL_ERROR" });
    f.beforeBatch();
    f.visible("E-1", "visible");
    f.sql.query("UPDATE problems SET unlisted=1").run();
    const unlisted = await f.request();
    expect(unlisted.status).toBe(200);
    expect(unlisted.headers.get("cache-control")).toBe("private, no-store");
    expect(unlisted.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    f.visible("problem", "hidden");
    expect((await f.request()).status).toBe(404);
    f.visible("problem", "visible");
    f.sql.query("UPDATE problems SET status='private-draft'").run();
    expect((await f.request()).status).toBe(404);
  } finally {
    f.sql.close();
  }
});

test("claim target identity follows the shared contract, including legacy zero identifiers", async () => {
  const f = fixture();
  try {
    f.event("claim", "C-0", { claim_id: "C-0", kind: "definition", statement: "Legacy identifier." });
    f.evidence(1, false, { bears_on_id: "C-0" });
    const face = (await loadEvidenceList(f.db, PROBLEM)).face;
    expect(face.evidence[0]?.bears_on).toEqual({ kind: "claim", id: "C-0", version: 1 });
    const empty = (await loadEvidenceList(f.db, PROBLEM, { through: 0, after: 0 })).face;
    expect(empty).toMatchObject({ cursor: 0, count: 0, scanned_through: 0, next_after: null });
  } finally {
    f.sql.close();
  }
});

test.each([1, 2])("claim version %s requires its matching creation or revision event type", async (version) => {
  const f = fixture();
  try {
    if (version === 2)
      f.event("claim", "C-1", {
        claim_id: "C-1",
        kind: "definition",
        statement: "Second version.",
        base_version: 1,
      }, 2);
    f.sql
      .query("UPDATE events SET type=? WHERE object_id='C-1' AND object_version=?")
      .run(version === 1 ? "claim.revised" : "claim.created", version);
    f.evidence(1, false, { bears_on_version: version });
    const face = (await loadEvidenceList(f.db, PROBLEM)).face;
    expect(face.evidence).toEqual([]);
    expect(face.omitted).toEqual(["content_unavailable"]);
  } finally {
    f.sql.close();
  }
});

test.each(["event-E-1-1", "event-C-1-1"])(
  "duplicate immutable admission %s is withheld without poisoning unrelated evidence",
  async (sourceId) => {
    const f = fixture();
    try {
      f.evidence(1);
      f.evidence(2, true);
      f.sql
        .query("INSERT INTO events SELECT id || '-duplicate',problem_id,5,type,object_kind,object_id,object_version,created_at,payload_sha256,actor_fellow_id,actor_sponsor_id,actor_session_id,model_string_self_declared,harness FROM events WHERE id=?")
        .run(sourceId);
      f.sql
        .query("INSERT INTO event_content SELECT event_id || '-duplicate',payload_sha256,payload_json,redacted_at FROM event_content WHERE event_id=?")
        .run(sourceId);
      f.sql.query("UPDATE problems SET public_seq=5").run();
      const face = (await loadEvidenceList(f.db, PROBLEM)).face;
      expect(face.evidence.map((entry) => entry.evidence_id)).toEqual(["E-2"]);
      expect(face.omitted).toEqual(["content_unavailable"]);
      // The invalid later admission cannot rewrite the already captured cut.
      expect((await loadEvidenceList(f.db, PROBLEM, { through: 4 })).face.count).toBe(2);
    } finally {
      f.sql.close();
    }
  },
);
