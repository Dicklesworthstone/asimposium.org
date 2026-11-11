import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { getProblemCreationBudget } from "../../src/problems/creation-quota.ts";

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");
const MIGRATION = "0144_problem_creation_rate_limit.sql";

/** Execute the actual cutover over the complete preceding schema. This is
 * SQLite unit coverage, not a claim that the native D1 lane has run. */
test("creation quota backfills ISO and epoch-millisecond history and waits out legacy over-cap use", async () => {
  const sql = new Database(":memory:", { strict: true });
  try {
    for (const name of readdirSync(MIGRATIONS)
      .filter((name) => name.endsWith(".sql") && name < MIGRATION)
      .sort()) {
      sql.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    }
    const now = Date.now();
    const sponsor = "usr_creation_cutover";
    sql
      .query("INSERT INTO sponsors(sponsor_id,created_at,last_seen_at) VALUES(?,?,?)")
      .run(sponsor, now, now);
    const insert = sql.query(
      "INSERT INTO problems(id,sponsor_id,created_at,updated_at) VALUES(?,?,?,?)",
    );
    insert.run("P-CUTOVER-ISO", sponsor, new Date(now - 3_000).toISOString(), now);
    insert.run("P-CUTOVER-NUMBER", sponsor, now - 2_000, now);
    insert.run("P-CUTOVER-TEXT", sponsor, String(now - 1_000), now);
    insert.run("P-CUTOVER-MALFORMED", sponsor, "not-a-timestamp", now);
    insert.run("P-CUTOVER-UNATTRIBUTED", null, new Date(now).toISOString(), now);
    const before = sql.query("SELECT * FROM problems ORDER BY id").all();

    sql.exec(readFileSync(join(MIGRATIONS, MIGRATION), "utf8"));
    expect(sql.query("SELECT * FROM problems ORDER BY id").all()).toEqual(before);
    expect(
      sql
        .query("SELECT problem_id,created_at FROM problem_creation_admissions ORDER BY created_at")
        .all(),
    ).toEqual([
      { problem_id: "P-CUTOVER-ISO", created_at: now - 3_000 },
      { problem_id: "P-CUTOVER-NUMBER", created_at: now - 2_000 },
      { problem_id: "P-CUTOVER-TEXT", created_at: now - 1_000 },
    ]);
    const db = {
      prepare(query: string) {
        return {
          bind(...values: (string | number)[]) {
            return {
              async first() {
                return sql.query(query).get(...values);
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    expect(await getProblemCreationBudget(db, sponsor, now)).toEqual({
      limit: 2,
      remaining: 0,
      window_seconds: 86_400,
      retry_after_seconds: 86_398,
    });
    expect(() =>
      sql
        .query("INSERT INTO problem_creation_admissions VALUES(?,?,?)")
        .run("P-CUTOVER-REFUSED", sponsor, now),
    ).toThrow("PROBLEM_CREATION_RATE_LIMITED");
    // Expiring the oldest of three is insufficient; two are still charged.
    expect(await getProblemCreationBudget(db, sponsor, now + 86_397_000)).toMatchObject({
      remaining: 0,
      retry_after_seconds: 1,
    });
    const recoveredAt = now + 86_398_000;
    expect(await getProblemCreationBudget(db, sponsor, recoveredAt)).toEqual({
      limit: 2,
      remaining: 1,
      window_seconds: 86_400,
    });
    sql
      .query("INSERT INTO problem_creation_admissions VALUES(?,?,?)")
      .run("P-CUTOVER-NEXT", sponsor, recoveredAt);
    expect(await getProblemCreationBudget(db, sponsor, recoveredAt)).toMatchObject({
      remaining: 0,
      retry_after_seconds: 1,
    });
    expect(sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    sql.close();
  }
});
