import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import { findStaleRoutes, staleRouteReferences } from "../../src/ledger/stale-route";

// Real SQLite queries behind the narrow D1 read interface. This is local SQL
// coverage, not a claim about deployed D1 or the whole promotion transaction.
const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const sql = new Database(":memory:");
  databases.push(sql);
  sql.exec(`
    CREATE TABLE retractions (problem_id TEXT, target_object TEXT, retraction_id TEXT);
    CREATE TABLE events (
      problem_id TEXT, id TEXT, seq INTEGER, object_kind TEXT,
      object_id TEXT, object_version INTEGER, type TEXT
    );
    CREATE TABLE claim_versions (problem_id TEXT, claim_id TEXT, version INTEGER);
    CREATE TABLE hypotheses (problem_id TEXT, hypothesis_id TEXT, status TEXT);
  `);
  const queries: string[] = [];
  const db = {
    prepare(query: string) {
      return {
        bind(...values: (string | number | null)[]) {
          return {
            async first() {
              queries.push(query);
              return sql.query(query).get(...values);
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { sql, db, queries };
}

const openPrefix = () => Array.from({ length: 32 }, (_, i) => `C-${i + 1}`);

function retract(sql: Database, problem: string, claim: string, seq = 99) {
  const retraction = `R-${claim}`;
  sql.query("INSERT INTO retractions VALUES (?, ?, ?)").run(problem, claim, retraction);
  sql.query("INSERT INTO events VALUES (?, ?, ?, 'retraction', ?, NULL, 'object.retracted')").run(
    problem,
    `event-${retraction}`,
    seq,
    retraction,
  );
}

function revise(sql: Database, problem: string, claim: string) {
  for (const version of [1, 2, 3]) {
    sql.query("INSERT INTO claim_versions VALUES (?, ?, ?)").run(problem, claim, version);
    sql.query("INSERT INTO events VALUES (?, ?, ?, 'claim', ?, ?, 'claim.revised')").run(
      problem,
      `event-${claim}-${version}`,
      version,
      claim,
      version,
    );
  }
}

describe("stale-route validation covers the entire dependency set", () => {
  test("a retracted claim after 32 live references cannot escape validation", async () => {
    const { sql, db } = fixture();
    retract(sql, "p", "C-90");
    expect(await findStaleRoutes(db, "p", staleRouteReferences([...openPrefix(), "C-90"]))).toEqual([
      {
        ref: "C-90",
        state: "claim-retracted",
        closed_by_event_id: "event-R-C-90",
        closed_at_seq: 99,
      },
    ]);
  });

  test("a superseded pin after 32 live references reports its closing event", async () => {
    const { sql, db } = fixture();
    revise(sql, "p", "C-90");
    expect(await findStaleRoutes(db, "p", staleRouteReferences([...openPrefix(), "C-90@1"]))).toEqual([
      {
        ref: "C-90@1",
        state: "claim-version-superseded",
        closed_by_event_id: "event-C-90-2",
        closed_at_seq: 2,
        current_version: 3,
      },
    ]);
  });

  for (const status of ["killed", "refined"] as const) {
    test(`a ${status} hypothesis after the old cutoff is refused`, async () => {
      const { sql, db } = fixture();
      sql.query("INSERT INTO hypotheses VALUES ('p', 'H-route', ?)").run(status);
      sql.query("INSERT INTO events VALUES ('p', 'closed', 90, 'hypothesis', 'H-route', 2, ?)").run(
        `hypothesis.${status}`,
      );
      expect(
        await findStaleRoutes(db, "p", staleRouteReferences([...openPrefix(), "H-route"])),
      ).toEqual([
        {
          ref: "H-route",
          state: `hypothesis-${status}`,
          closed_by_event_id: "closed",
          closed_at_seq: 90,
        },
      ]);
    });
  }

  test("checks a long valid prefix without confusing diagnostic and input budgets", async () => {
    const { sql, db } = fixture();
    retract(sql, "p", "C-900");
    const refs = Array.from({ length: 96 }, (_, i) => `C-${i + 1}`);
    const result = await findStaleRoutes(db, "p", staleRouteReferences([...refs, "C-900"]));
    expect(result.map((entry) => entry.ref)).toEqual(["C-900"]);
  });

  test("caps diagnostics at 20 only after establishing that the write is stale", async () => {
    const { sql, db, queries } = fixture();
    const refs = Array.from({ length: 40 }, (_, i) => `C-${i + 100}`);
    for (const ref of refs) retract(sql, "p", ref);
    const result = await findStaleRoutes(db, "p", staleRouteReferences(refs));
    expect(result.map((entry) => entry.ref)).toEqual(refs.slice(0, 20));
    expect(queries).toHaveLength(20);
  });

  test("duplicate references neither amplify database work nor hide later closures", async () => {
    const { sql, db, queries } = fixture();
    retract(sql, "p", "C-90");
    const [live] = staleRouteReferences(["C-1"]);
    if (!live) throw new Error("missing fixture reference");
    const refs = [...Array.from({ length: 100 }, () => live), ...staleRouteReferences(["C-90"])];
    expect((await findStaleRoutes(db, "p", refs)).map((entry) => entry.ref)).toEqual(["C-90"]);
    expect(queries).toHaveLength(2);
  });

  test("different claim pins share a negative retraction lookup", async () => {
    const { sql, db, queries } = fixture();
    revise(sql, "p", "C-90");
    const result = await findStaleRoutes(db, "p", staleRouteReferences(["C-90", "C-90@1", "C-90@2"]));
    expect(result.map((entry) => entry.ref)).toEqual(["C-90@1", "C-90@2"]);
    expect(queries.filter((query) => query.includes("FROM retractions"))).toHaveLength(1);
  });

  test("retraction takes precedence over supersession for every pin", async () => {
    const { sql, db, queries } = fixture();
    revise(sql, "p", "C-90");
    retract(sql, "p", "C-90");
    const result = await findStaleRoutes(db, "p", staleRouteReferences(["C-90", "C-90@1", "C-90@2"]));
    expect(result.map((entry) => entry.state)).toEqual(Array(3).fill("claim-retracted"));
    expect(queries).toHaveLength(1);
  });

  test("closures in another problem do not poison this problem's references", async () => {
    const { sql, db } = fixture();
    retract(sql, "other", "C-90");
    revise(sql, "other", "C-90");
    sql.exec("INSERT INTO hypotheses VALUES ('other', 'H-route', 'killed')");
    expect(
      await findStaleRoutes(db, "p", staleRouteReferences(["C-90", "C-90@1", "H-route"])),
    ).toEqual([]);
  });

  test("a current pin and an unknown reference remain the caller's responsibility", async () => {
    const { sql, db } = fixture();
    revise(sql, "p", "C-90");
    expect(await findStaleRoutes(db, "p", staleRouteReferences(["C-90@3", "C-999@1"]))).toEqual([]);
  });

  test("a closure without its event still fails closed rather than looking live", async () => {
    const { sql, db } = fixture();
    sql.exec("INSERT INTO retractions VALUES ('p', 'C-90', 'missing-event')");
    expect(await findStaleRoutes(db, "p", staleRouteReferences(["C-90"]))).toEqual([
      { ref: "C-90", state: "claim-retracted", closed_by_event_id: null, closed_at_seq: null },
    ]);
  });

  test("a database error beyond the old cutoff is never converted into approval", async () => {
    const { db } = fixture();
    const failing = {
      prepare(query: string) {
        return {
          bind(...values: (string | number | null)[]) {
            if (values[1] === "C-90") throw new Error("database unavailable");
            return db.prepare(query).bind(...values);
          },
        };
      },
    } as unknown as D1Database;
    await expect(
      findStaleRoutes(failing, "p", staleRouteReferences([...openPrefix(), "C-90"])),
    ).rejects.toThrow("database unavailable");
  });
});
