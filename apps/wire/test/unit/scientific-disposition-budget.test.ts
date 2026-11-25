import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import { loadHonorsRecord } from "../../src/discovery/honors-service.ts";
import { claimContentDigest } from "../../src/krater/claim-version.ts";
import {
  DEFAULT_SCIENTIFIC_READ_BUDGET,
  foldScientificRows,
  prepareScientificDispositions,
  readScientificDispositions,
  type ScientificReadBudget,
  ScientificReadBudgetExceededError,
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
    CREATE TABLE public_cursor(singleton INTEGER, cursor INTEGER);
    INSERT INTO public_cursor VALUES(1,10000);
    CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER);
    INSERT INTO problems VALUES('P-DEMO',10000,'active',0);
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
      const prepared = (values: (string | number | null)[]) => ({
        all: async () => ({ success: true, results: sql.query(query).all(...values) }),
        first: async () => sql.query(query).get(...values),
      });
      return { ...prepared([]), bind: (...values: (string | number | null)[]) => prepared(values) };
    },
  } as unknown as D1Database;
  let sequence = 0;
  function event(
    type: string,
    kind: string,
    object: string,
    payload: unknown,
    author = "author",
    version = 1,
  ) {
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
        version,
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
    async revision(version: number) {
      const revised = { ...claim, statement: `Revised statement ${version}.` };
      event(
        "claim.revised",
        "claim",
        "C-1",
        { claim_id: "C-1", base_version: version - 1, ...revised },
        "author",
        version,
      );
      sql
        .query("INSERT INTO claim_versions VALUES('P-DEMO','C-1',?,?,?)")
        .run(
          version,
          await claimContentDigest(revised, async (text) => hash(text)),
          revised.statement,
        );
    },
    evidence(
      body: string,
      direction = "supports",
      target: { kind: "claim" | "hypothesis"; id: string; version: number | null } = {
        kind: "claim",
        id: "C-1",
        version: 1,
      },
    ) {
      const evidenceId = `E-${sequence + 1}`;
      const source = event(
        "evidence.created",
        "evidence",
        evidenceId,
        {
          kind: "computation",
          mode: "confirmatory",
          computed_class: "computation",
          bears_on_kind: target.kind,
          bears_on_id: target.id,
          bears_on_version: target.version ?? undefined,
          direction,
          body_md: body,
        },
        "examiner",
      );
      sql
        .query("INSERT INTO evidence VALUES(?,'P-DEMO',?,?,?,?,?,?)")
        .run(source.id, evidenceId, source.seq, target.kind, target.id, target.version, direction);
      return { ...source, evidenceId };
    },
    review(targetVersion = 1) {
      const reviewId = `R-${sequence + 1}`;
      const payload = {
        target_claim_id: "C-1",
        target_version: targetVersion,
        verdict: "refute",
        basis: "Checked the stated domain and found an admissible counterexample.",
        capable_of_failure: "The witness could fail one of the stated hypotheses.",
        rubric: [],
        body_md: "The recorded witness satisfies the hypotheses but fails the conclusion.",
      };
      const source = event("review.created", "review", reviewId, payload, "reviewer");
      sql
        .query("INSERT INTO reviews VALUES(?,'P-DEMO',?,?,'C-1',?,?,?,?,?,?)")
        .run(
          source.id,
          reviewId,
          source.seq,
          targetVersion,
          payload.verdict,
          payload.capable_of_failure,
          JSON.stringify(payload.rubric),
          payload.basis,
          payload.body_md,
        );
      return source;
    },
    async read(budget?: ScientificReadBudget, cursor = sequence, version = 1) {
      return (
        await prepareScientificDispositions(
          db,
          "P-DEMO",
          cursor,
          1,
          { claimId: "C-1", version },
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
    expect(original.every((row) => row.scientific_budget_exceeded === 0)).toBe(true);
    expect(bounded.every((row) => row.scientific_budget_exceeded === 0)).toBe(true);
    expect(bounded).toEqual(original);
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

test("an oversized UTF-8 body is withheld by a tighter collection budget", async () => {
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

test("the production default bounds history before transfer and never folds a missing late objection", async () => {
  const f = await fixture();
  try {
    for (let index = 1; index < DEFAULT_SCIENTIFIC_READ_BUDGET.maxRows; index++)
      f.evidence(`Checked instance ${index}.`);
    f.evidence("The next recorded input refutes the selected statement.", "refutes");
    f.evidence("Additional history cannot make the transferred prefix complete.");
    const bounded = await f.read();
    expect(bounded).toHaveLength(DEFAULT_SCIENTIFIC_READ_BUDGET.maxRows + 1);
    expect(bounded.every((row) => row.scientific_budget_exceeded === 1)).toBe(true);
    expect(bounded.every((row) => row.payload_json === null && row.statement === null)).toBe(true);
    await expect(foldScientificRows(bounded)).rejects.toBeInstanceOf(
      ScientificReadBudgetExceededError,
    );
    await expect(readScientificDispositions(f.db, "P-DEMO", 10000, 100)).rejects.toBeInstanceOf(
      ScientificReadBudgetExceededError,
    );

    const historical = await f.read(undefined, DEFAULT_SCIENTIFIC_READ_BUDGET.maxRows);
    expect(historical).toHaveLength(DEFAULT_SCIENTIFIC_READ_BUDGET.maxRows);
    expect(historical.every((row) => row.scientific_budget_exceeded === 0)).toBe(true);
    expect((await foldScientificRows(historical)).disposition).toBe("open");

    // The feed remains readable, but it cannot recognize any candidate whose
    // complete standing was unavailable. This calls the real Honors consumer.
    const honors = await loadHonorsRecord(f.db);
    expect(honors.results).toEqual([]);
    expect(honors.omitted).toContain(
      "some candidate histories exceed the scientific read budget; no recognition is inferred from a partial history; exact published resolution claims are checked independently",
    );
  } finally {
    f.sql.close();
  }
});

test("later revisions are excluded before the exact-version history budget", async () => {
  const f = await fixture();
  try {
    f.evidence("The first statement has a recorded counterexample.", "refutes");
    await f.revision(2);
    for (let index = 0; index < DEFAULT_SCIENTIFIC_READ_BUDGET.maxRows + 1; index++)
      f.evidence(`Later statement instance ${index}.`, "supports", {
        kind: "claim",
        id: "C-1",
        version: 2,
      });
    const oldVersion = await f.read();
    expect(oldVersion).toHaveLength(2);
    expect(oldVersion.every((row) => row.scientific_budget_exceeded === 0)).toBe(true);
    expect(await foldScientificRows(oldVersion)).toMatchObject({
      currentVersion: 1,
      disposition: "disputed",
      stale: false,
    });
    const selected = await readScientificDispositions(f.db, "P-DEMO", 10000, 1, {
      claimId: "C-1",
      version: 1,
    });
    expect(selected.get("C-1")).toMatchObject({ currentVersion: 1, disposition: "disputed" });
    const later = await f.read(undefined, undefined, 2);
    expect(later).toHaveLength(DEFAULT_SCIENTIFIC_READ_BUDGET.maxRows + 1);
    expect(later.every((row) => row.payload_json === null && row.statement === null)).toBe(true);
    await expect(foldScientificRows(later)).rejects.toBeInstanceOf(
      ScientificReadBudgetExceededError,
    );
  } finally {
    f.sql.close();
  }
});

test("default byte limits admit maximum-length escaped bodies and cap aggregate transfer", async () => {
  const f = await fixture();
  try {
    // The request schema admits 64 KiB characters, and JSON escaping can
    // expand each one to six bytes without exceeding the 512 KiB write limit.
    const body = "\u0001".repeat(64 * 1024);
    const source = f.evidence(body);
    expect(bytes(source.body)).toBeLessThan(512 * 1024);
    const ordinary = await f.read();
    expect(ordinary.every((row) => row.scientific_budget_exceeded === 0)).toBe(true);
    expect(ordinary[1]?.payload_json).toBe(source.body);

    for (let index = 0; index < 10; index++) f.evidence(body);
    const bounded = await f.read();
    expect(bounded).toHaveLength(12);
    expect(bounded.every((row) => row.scientific_budget_exceeded === 1)).toBe(true);
    expect(
      bounded.reduce((sum, row) => sum + bytes(row.payload_json) + bytes(row.statement), 0),
    ).toBe(0);
    await expect(foldScientificRows(bounded)).rejects.toBeInstanceOf(
      ScientificReadBudgetExceededError,
    );
  } finally {
    f.sql.close();
  }
});

test("a default per-body overflow withholds every body in the assessment", async () => {
  const f = await fixture();
  try {
    f.evidence("µ".repeat(DEFAULT_SCIENTIFIC_READ_BUDGET.maxPayloadBytes / 2), "refutes");
    const bounded = await f.read();
    expect(bounded).toHaveLength(2);
    expect(bounded.every((row) => row.scientific_budget_exceeded === 1)).toBe(true);
    expect(bounded.every((row) => row.payload_json === null && row.statement === null)).toBe(true);
    await expect(foldScientificRows(bounded)).rejects.toBeInstanceOf(
      ScientificReadBudgetExceededError,
    );
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

test("a drifted evidence projection cannot erase a published objection or move it to another target", async () => {
  for (const mutation of [
    "UPDATE evidence SET direction = 'supports'",
    "UPDATE evidence SET bears_on_id = 'C-2'",
    "UPDATE evidence SET bears_on_version = 2",
    "UPDATE evidence SET bears_on_kind = 'hypothesis'",
    "UPDATE evidence SET source_seq = 200",
    "UPDATE evidence SET source_event_id = 'MISSING'",
    "DELETE FROM evidence",
  ]) {
    const f = await fixture();
    try {
      f.evidence("A recorded counterexample challenges the exact claim.", "refutes");
      expect(await foldScientificRows(await f.read())).toMatchObject({
        disposition: "disputed",
        stale: false,
      });
      f.sql.exec(mutation);
      for (const budget of [undefined, BUDGET]) {
        const rows = await f.read(budget);
        // Production readers filter to the requested exact version before folding.
        await expect(
          foldScientificRows(rows.filter((row) => row.target_version <= 1)),
        ).rejects.toThrow("Scientific projections disagree with the public event history");
        // A later broken projection cannot rewrite an earlier captured cut.
        expect(await foldScientificRows(await f.read(budget, 1))).toMatchObject({
          disposition: "open",
          stale: false,
        });
      }
    } finally {
      f.sql.close();
    }
  }
});

test("a drifted review target cannot turn the original claim's adverse history into a clean read", async () => {
  for (const mutation of [
    "UPDATE reviews SET verdict = 'verify'",
    "UPDATE reviews SET target_claim_id = 'C-2'",
    "UPDATE reviews SET target_version = 2",
    "UPDATE reviews SET source_seq = 200",
    "UPDATE reviews SET source_event_id = 'MISSING'",
    "DELETE FROM reviews",
  ]) {
    const f = await fixture();
    try {
      f.review();
      expect(await foldScientificRows(await f.read())).toMatchObject({
        disposition: "disputed",
        stale: false,
      });
      f.sql.exec(mutation);
      for (const budget of [undefined, BUDGET]) {
        const rows = await f.read(budget);
        await expect(
          foldScientificRows(rows.filter((row) => row.target_version <= 1)),
        ).rejects.toThrow("Scientific projections disagree with the public event history");
      }
    } finally {
      f.sql.close();
    }
  }
});

test("a hypothesis evidence projection cannot manufacture a claim input", async () => {
  const f = await fixture();
  try {
    f.evidence("A witness concerns a different attack route.", "refutes", {
      kind: "hypothesis",
      id: "H-other",
      version: null,
    });
    expect(await foldScientificRows(await f.read())).toMatchObject({
      disposition: "open",
      stale: false,
    });
    f.sql.exec(
      "UPDATE evidence SET bears_on_kind = 'claim', bears_on_id = 'C-1', bears_on_version = 1",
    );
    for (const budget of [undefined, BUDGET])
      await expect(foldScientificRows(await f.read(budget))).rejects.toThrow(
        "Scientific projections disagree with the public event history",
      );
  } finally {
    f.sql.close();
  }
});

test("redaction preserves the recorded objection without inventing a projection disagreement", async () => {
  const f = await fixture();
  try {
    const source = f.evidence("A recorded counterexample challenges the exact claim.", "refutes");
    f.sql
      .query("UPDATE event_content SET payload_json = NULL, redacted_at = ? WHERE event_id = ?")
      .run("2026-11-23T00:00:00.000Z", source.id);
    for (const budget of [undefined, BUDGET])
      expect(await foldScientificRows(await f.read(budget))).toMatchObject({
        disposition: "disputed",
        stale: true,
      });
  } finally {
    f.sql.close();
  }
});

test("a known unrelated claim's projection disagreement does not erase the selected claim's history", async () => {
  const f = await fixture();
  try {
    const other = f.evidence("The recorded objection concerns another claim.", "refutes", {
      kind: "claim",
      id: "C-2",
      version: 1,
    });
    f.sql
      .query("UPDATE evidence SET direction = 'supports' WHERE evidence_id = ?")
      .run(other.evidenceId);
    for (const budget of [undefined, BUDGET])
      expect(await foldScientificRows(await f.read(budget))).toMatchObject({
        disposition: "open",
        stale: false,
      });
    f.evidence("A separate objection concerns the selected claim.", "refutes");
    expect(await foldScientificRows(await f.read())).toMatchObject({ disposition: "disputed" });
  } finally {
    f.sql.close();
  }
});

test("known later-version projection drift cannot contaminate an earlier exact-version read", async () => {
  const f = await fixture();
  try {
    f.evidence("The objection concerns only the later statement.", "refutes", {
      kind: "claim",
      id: "C-1",
      version: 2,
    });
    f.review(2);
    f.sql.exec("UPDATE evidence SET direction = 'supports'");
    f.sql.exec("UPDATE reviews SET verdict = 'verify'");
    for (const budget of [undefined, BUDGET]) {
      const historical = (await f.read(budget)).filter((row) => row.target_version <= 1);
      expect(await foldScientificRows(historical)).toMatchObject({
        disposition: "open",
        stale: false,
      });
      await expect(foldScientificRows(await f.read(budget, undefined, 2))).rejects.toThrow(
        "Scientific projections disagree with the public event history",
      );
    }
  } finally {
    f.sql.close();
  }
});
