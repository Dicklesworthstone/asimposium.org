import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import { claimContentDigest } from "../../src/krater/claim-version.ts";
import {
  foldScientificRows,
  prepareScientificDispositions,
  type ScientificReadBudget,
  type ScientificRow,
} from "../../src/ledger/scientific-disposition.ts";

const BUDGET = { maxRows: 128, maxPayloadBytes: 16_384, maxTotalPayloadBytes: 131_072 };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const bytes = (text: string | null) => (text === null ? 0 : new TextEncoder().encode(text).length);

/** Canonical scientific SELECTs over SQLite, including real returned bytes.
 * This read fixture is not D1 execution or scientific admission proof. */
async function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER, payload_sha256 TEXT,
      created_at TEXT, actor_fellow_id TEXT, actor_sponsor_id TEXT, UNIQUE(problem_id,seq));
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_sha256 TEXT,
      payload_json TEXT, redacted_at TEXT);
    CREATE TABLE reviews(source_event_id TEXT, problem_id TEXT, review_id TEXT, source_seq INTEGER,
      target_claim_id TEXT, target_version INTEGER, verdict TEXT, capable_of_failure TEXT, rubric_json TEXT,
      basis TEXT, body_md TEXT);
    CREATE TABLE evidence(source_event_id TEXT, problem_id TEXT, evidence_id TEXT, source_seq INTEGER,
      bears_on_kind TEXT, bears_on_id TEXT, bears_on_version INTEGER, direction TEXT);
    CREATE TABLE retractions(problem_id TEXT, retraction_id TEXT, seq INTEGER,
      author_fellow_id TEXT, target_object TEXT);
    CREATE TABLE scientific_withdrawals(event_id TEXT, event_sha256 TEXT, problem_id TEXT,
      retraction_id TEXT, target_object TEXT, fellow_id TEXT, seq INTEGER, claim_version INTEGER,
      source_event_id TEXT, target_kind TEXT, source_sha256 TEXT, claim_id TEXT);
    CREATE TABLE claim_versions(problem_id TEXT, claim_id TEXT, version INTEGER,
      content_digest TEXT, statement TEXT, PRIMARY KEY(problem_id,claim_id,version));
    CREATE TABLE claim_concessions(event_id TEXT, event_sha256 TEXT, problem_id TEXT, claim_id TEXT);
    CREATE TABLE content_controls(problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    CREATE TABLE directive_disclosure_targets(problem_id TEXT, claim_id TEXT, claim_version INTEGER,
      invalidated INTEGER, lineage_json TEXT, scope_requirements_json TEXT,
      content_digest TEXT, source_event_id TEXT);
    CREATE TABLE directive_disclosure_records(scope_id TEXT, revision INTEGER, seq INTEGER,
      decision TEXT, event_id TEXT, problem_id TEXT, sponsor_id TEXT, public_payload_sha256 TEXT,
      public_payload_json TEXT, coverage_digest TEXT, claim_id TEXT, claim_version INTEGER,
      content_digest TEXT, source_event_id TEXT);
  `);
  const db = {
    prepare(query: string) {
      return {
        bind(...values: (string | number | null)[]) {
          return { all: async () => ({ success: true, results: sql.query(query).all(...values) }) };
        },
      };
    },
  } as unknown as D1Database;
  let sequence = 0;
  function event(type: string, kind: string, object: string, payload: unknown, author = "author") {
    const seq = ++sequence;
    const id = `EV-${seq}`;
    const body = JSON.stringify(payload),
      digest = hash(body);
    sql
      .query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        "P-DEMO",
        seq,
        type,
        kind,
        object,
        1,
        digest,
        "2026-10-27T12:00:00.000Z",
        `F-${author}`,
        `S-${author}`,
      );
    sql.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(id, digest, body);
    return { id, seq, body };
  }
  const claim = {
    kind: "conjecture",
    statement: "Every integer square is nonnegative.",
    falsifier: "An integer whose square is negative.",
  };
  event("claim.created", "claim", "C-1", { claim_id: "C-1", ...claim });
  sql
    .query("INSERT INTO claim_versions VALUES('P-DEMO','C-1',1,?,?)")
    .run(await claimContentDigest(claim, async (text) => hash(text)), claim.statement);
  return {
    sql,
    db,
    evidence(body: string, direction = "supports") {
      const evidenceId = `E-${sequence + 1}`;
      const source = event(
        "evidence.created",
        "evidence",
        evidenceId,
        {
          kind: "computation",
          mode: "confirmatory",
          computed_class: "computation",
          bears_on_kind: "claim",
          bears_on_id: "C-1",
          bears_on_version: 1,
          direction,
          body_md: body,
        },
        "examiner",
      );
      sql
        .query("INSERT INTO evidence VALUES(?,'P-DEMO',?,?,'claim','C-1',1,?)")
        .run(source.id, evidenceId, source.seq, direction);
      return { ...source, evidenceId };
    },
    async read(budget?: ScientificReadBudget, cursor = sequence) {
      return (
        await prepareScientificDispositions(
          db,
          "P-DEMO",
          cursor,
          1,
          { claimId: "C-1", version: 1 },
          budget,
        ).all<ScientificRow>()
      ).results;
    },
  };
}

test("a complete bounded history retains the canonical rows and fold", async () => {
  const f = await fixture();
  try {
    f.evidence("The finite computation checks all declared inputs.");
    f.evidence("A recorded counterexample challenges the exact claim.", "refutes");
    const original = await f.read(),
      bounded = await f.read(BUDGET);
    expect(original.every((row) => row.scientific_budget_exceeded === undefined)).toBe(true);
    expect(bounded.every((row) => row.scientific_budget_exceeded === 0)).toBe(true);
    expect(
      bounded.map((row) =>
        Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("scientific_"))),
      ),
    ).toEqual(original);
    expect(await foldScientificRows(bounded)).toEqual(await foldScientificRows(original));
    expect((await foldScientificRows(bounded)).disposition).toBe("disputed");
  } finally {
    f.sql.close();
  }
});

test("row lookahead detects late adverse history without returning or folding a truncated body set", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 139; index++) f.evidence(`Checked instance ${index}.`);
    f.evidence("An adverse witness after the bounded prefix.", "refutes");
    const original = await f.read();
    expect(original).toHaveLength(141);
    expect((await foldScientificRows(original)).disposition).toBe("disputed");
    const exact = await f.read(BUDGET, 128);
    expect(exact).toHaveLength(128);
    expect(exact.every((row) => row.scientific_budget_exceeded === 0)).toBe(true);
    const bounded = await f.read(BUDGET);
    expect(bounded).toHaveLength(129);
    expect(bounded.at(-1)?.seq).toBe(129);
    expect(bounded.every((row) => row.scientific_budget_exceeded === 1)).toBe(true);
    expect(bounded.every((row) => row.payload_json === null && row.statement === null)).toBe(true);
    await expect(foldScientificRows(bounded)).rejects.toThrow("read budget");
  } finally {
    f.sql.close();
  }
});

test("an oversized UTF-8 body is withheld in SQL and does not change the unbounded reader", async () => {
  const f = await fixture();
  try {
    const source = f.evidence("µ".repeat(10_000), "refutes");
    expect(source.body.length).toBeLessThan(BUDGET.maxPayloadBytes);
    expect(bytes(source.body)).toBeGreaterThan(BUDGET.maxPayloadBytes);
    const original = await f.read(),
      bounded = await f.read(BUDGET);
    expect(original[1]?.payload_json).toBe(source.body);
    expect((await foldScientificRows(original)).disposition).toBe("disputed");
    expect(bounded.every((row) => row.scientific_budget_exceeded === 1)).toBe(true);
    expect(bounded.every((row) => row.payload_json === null && row.statement === null)).toBe(true);
    await expect(foldScientificRows(bounded)).rejects.toThrow("read budget");
  } finally {
    f.sql.close();
  }
});

test("aggregate limits count returned statement copies and distinguish the exact byte boundary", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 11; index++) f.evidence(`${index}: ${"x".repeat(12_000)}`);
    const original = await f.read();
    const totalBytes = original.reduce(
      (sum, row) => sum + bytes(row.payload_json) + bytes(row.statement),
      0,
    );
    expect(original.every((row) => bytes(row.payload_json) <= BUDGET.maxPayloadBytes)).toBe(true);
    expect(totalBytes).toBeGreaterThan(BUDGET.maxTotalPayloadBytes);
    const bounded = await f.read(BUDGET);
    expect(bounded.every((row) => row.scientific_budget_exceeded === 1)).toBe(true);
    expect(
      bounded.reduce((sum, row) => sum + bytes(row.payload_json) + bytes(row.statement), 0),
    ).toBe(0);
    const exact = await f.read({ ...BUDGET, maxTotalPayloadBytes: totalBytes });
    expect(exact.every((row) => row.scientific_budget_exceeded === 0)).toBe(true);
    expect(
      exact.reduce((sum, row) => sum + bytes(row.payload_json) + bytes(row.statement), 0),
    ).toBe(totalBytes);
    const short = await f.read({ ...BUDGET, maxTotalPayloadBytes: totalBytes - 1 });
    expect(short.every((row) => row.scientific_budget_exceeded === 1)).toBe(true);
  } finally {
    f.sql.close();
  }
});

test("current withholding preserves adverse metadata and does not spend the body budget", async () => {
  const f = await fixture();
  try {
    const source = f.evidence("µ".repeat(10_000), "refutes");
    f.sql
      .query("INSERT INTO content_controls VALUES('P-DEMO',?,'hidden',1)")
      .run(source.evidenceId);
    const bounded = await f.read(BUDGET);
    expect(bounded.every((row) => row.scientific_budget_exceeded === 0)).toBe(true);
    expect(bounded[1]?.payload_json).toBeNull();
    expect(bounded[1]?.direction).toBe("refutes");
    expect(await foldScientificRows(bounded)).toEqual(await foldScientificRows(await f.read()));
    expect(await foldScientificRows(bounded)).toMatchObject({
      disposition: "disputed",
      stale: true,
    });
    f.sql
      .query("INSERT INTO content_controls VALUES('P-DEMO',?,'visible',2)")
      .run(source.evidenceId);
    expect((await f.read(BUDGET)).every((row) => row.scientific_budget_exceeded === 1)).toBe(true);
  } finally {
    f.sql.close();
  }
});

test("internal budget values cannot become unsafe SQL limits", async () => {
  const f = await fixture();
  try {
    for (const bad of [
      { maxRows: 0 },
      { maxRows: Number.MAX_SAFE_INTEGER },
      { maxRows: 1.5 },
      { maxPayloadBytes: -1 },
      { maxTotalPayloadBytes: Number.NaN },
    ])
      await expect(f.read({ ...BUDGET, ...bad })).rejects.toThrow("budget");
  } finally {
    f.sql.close();
  }
});
