import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { D1Database } from "@cloudflare/workers-types";
import { recordProtocolConflict } from "../../src/directives/protocol-conflicts.ts";
import { NOW, protocolConflictFixture, SESSION } from "./protocol-conflict-fixture.ts";

type Fixture = ReturnType<typeof protocolConflictFixture>;
type Row = Record<string, string | number | null>;

const migration = readFileSync(
  new URL("../../../../db/migrations/0150_enrollment_protocol_conflicts.sql", import.meta.url),
  "utf8",
);
const newColumns = new Set([
  "source_kind",
  "source_directive_id",
  "source_enrollment_id",
  "source_proposal_id",
]);

function rows(f: Fixture, table: string): Row[] {
  return f.sql.query(`SELECT * FROM ${table} ORDER BY 1`).all() as Row[];
}

function history(f: Fixture) {
  return Object.fromEntries(
    [
      "events",
      "event_content",
      "problems",
      "public_cursor",
      "sessions",
      "sponsor_directives",
      "fellow_inbox_notices",
      "public_write_attempt_reservations",
      "screening_publications",
    ].map((table) => [table, rows(f, table)]),
  );
}

/** Exercise the real 0146 admission trigger and publication transaction. Only
 * the four columns introduced by 0150 are removed from the current service's
 * projection INSERT; source, screening, event, quota and inbox SQL are intact.
 * The shared fixture models parent tables and writer ports, not native D1. */
async function legacyConflicts(f: Fixture) {
  let adaptedInserts = 0;
  function prepare(query: string) {
    const insert =
      /^INSERT INTO protocol_conflicts \(([^)]+)\)\s+SELECT [?,]+ FROM events WHERE id = \? AND seq = \?$/.exec(
        query,
      );
    if (!insert) return f.db.prepare(query);
    const columns = insert[1]!.split(",");
    const retained = columns
      .map((name, index) => ({ name, index }))
      .filter(({ name }) => !newColumns.has(name));
    expect(columns.length - retained.length).toBe(4);
    const statement = f.db.prepare(
      `INSERT INTO protocol_conflicts (${retained.map(({ name }) => name).join(",")})
          SELECT ${retained.map(() => "?").join(",")} FROM events WHERE id = ? AND seq = ?`,
    );
    const bind = statement.bind.bind(statement);
    statement.bind = (...values) => {
      expect(values).toHaveLength(columns.length + 2);
      adaptedInserts++;
      return bind(...retained.map(({ index }) => values[index]), ...values.slice(columns.length));
    };
    return statement;
  }
  const db: D1Database = new Proxy(f.db, {
    get(target, property) {
      if (property === "prepare") return prepare;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const requests = [f.directive({ problem: null, verb: "focus" }), f.directive({ verb: "forbid" })];
  const receipts = [];
  for (const [index, request] of requests.entries())
    receipts.push(
      await recordProtocolConflict(
        { ...f.options, db },
        f.actor,
        SESSION,
        request,
        `legacy-conflict-${index}`,
      ),
    );
  expect(adaptedInserts).toBe(2);
  return { requests, receipts };
}

function upgrade(f: Fixture, lateFailure = false) {
  f.sql.exec("BEGIN");
  try {
    f.sql.exec(migration);
    if (lateFailure) f.sql.exec("INSERT INTO public_cursor(singleton,cursor) VALUES(1,999999)");
    f.sql.exec("COMMIT");
  } catch (error) {
    f.sql.exec("ROLLBACK");
    throw error;
  }
}

test("enrollment refusal migration preserves every legacy source, publication and replay receipt", async () => {
  const f = protocolConflictFixture({ enrollmentSources: false });
  try {
    const { requests, receipts } = await legacyConflicts(f);
    const original = rows(f, "protocol_conflicts");
    expect(original).toHaveLength(2);
    const legacyColumns = Object.keys(original[0]!);
    // A closed historical session must not prevent the immutable copy, even
    // though replaying its original admission trigger would now be refused.
    f.sql.query("UPDATE sessions SET closed_at=?").run(new Date(NOW + 1).toISOString());
    const originalHistory = history(f);
    const authority = f.sql
      .query("SELECT sql FROM sqlite_schema WHERE name='protocol_conflict_authority'")
      .get();
    upgrade(f);
    const preserved = f.sql
      .query(`SELECT ${legacyColumns.join(",")} FROM protocol_conflicts ORDER BY event_id`)
      .all();
    expect(JSON.stringify(preserved)).toBe(JSON.stringify(original));
    for (const row of rows(f, "protocol_conflicts")) {
      expect(row.source_kind).toBe("sponsor-directive");
      expect(row.source_directive_id).toBe(row.directive_id);
      expect(row.source_enrollment_id).toBeNull();
      expect(row.source_proposal_id).toBeNull();
    }
    expect(history(f)).toEqual(originalHistory);
    expect(
      f.sql.query("SELECT sql FROM sqlite_schema WHERE name='protocol_conflict_authority'").get(),
    ).toEqual(authority);
    expect(f.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(f.sql.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(f.sql.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    const counts = { ...f.counts };
    for (const [index, request] of requests.entries()) {
      const receipt = receipts[index];
      if (receipt === undefined) throw new Error("The legacy conflict has no original receipt.");
      expect(
        await recordProtocolConflict(
          f.options,
          f.actor,
          SESSION,
          request,
          `legacy-conflict-${index}`,
        ),
      ).toEqual(receipt);
    }
    expect(f.counts).toEqual(counts);
    expect(history(f)).toEqual(originalHistory);
    expect(() => f.sql.exec("UPDATE protocol_conflicts SET directive_id=directive_id")).toThrow(
      "PROTOCOL_CONFLICT_IMMUTABLE",
    );
    expect(() => f.sql.exec("DELETE FROM protocol_conflicts")).toThrow(
      "PROTOCOL_CONFLICT_IMMUTABLE",
    );
  } finally {
    f.close();
  }
});

test("a failed enrollment refusal upgrade restores all legacy rows, schema and cursors", async () => {
  const f = protocolConflictFixture({ enrollmentSources: false });
  try {
    await legacyConflicts(f);
    const original = rows(f, "protocol_conflicts");
    const originalHistory = history(f);
    const schema = f.sql.query("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all();
    expect(() => upgrade(f, true)).toThrow("UNIQUE constraint failed");
    expect(rows(f, "protocol_conflicts")).toEqual(original);
    expect(history(f)).toEqual(originalHistory);
    expect(f.sql.query("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all()).toEqual(
      schema,
    );
    expect(f.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    f.close();
  }
});
