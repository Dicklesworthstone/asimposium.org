import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Env } from "../../src/env.ts";
import { supersedeHeldCaseStatement } from "../../src/screening/ingress.ts";

// asimposiumorg-qi6t: the supersede of a moot hold is guarded by the
// publication's event. When the write that would have published the bytes
// never landed, the hold must stay pending and reviewable. The real
// publication path is proven in moderation-real-bindings.mjs (step 5b).

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");

function migrated(): Database {
  const sqlite = new Database(":memory:", { strict: true });
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    sqlite.run(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  // The case row is seeded without its parent problem and Fellow rows; the
  // supersede statement under test does not depend on them.
  sqlite.run("PRAGMA foreign_keys = OFF");
  return sqlite;
}

/** The one D1 call this statement needs, over real SQLite. */
function d1(sqlite: Database): Env["DB"] {
  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) {
          values = bound;
          return statement;
        },
        async run() {
          sqlite.query(sql).run(...(values as never[]));
          return { success: true };
        },
      };
      return statement;
    },
  } as unknown as Env["DB"];
}

test("a supersede for an event that never landed leaves the hold pending", async () => {
  const sqlite = migrated();
  try {
    const digest = "a".repeat(64);
    sqlite.run(
      `INSERT INTO screening_cases (case_id, problem_id, fellow_id, sponsor_id, route, input_digest,
         context_digest, candidate_json, coarse_category, outcome, decision_path, provider_status,
         model_version, policy_version, configuration_digest, state, created_at)
       VALUES ('QC-01J0000000000000000000000A', 'P-QI6T', 'fellow-qi6t', 'usr_qi6t', 'promote', ?,
         ?, '{}', 'injection', 'quarantine', 'v1', 'ok', 'm1', 'p1', ?, 'pending', '2026-10-08T00:00:00.000Z')`,
      [digest, "b".repeat(64), "c".repeat(64)],
    );
    const screened = {
      problemId: "P-QI6T",
      fellowId: "fellow-qi6t",
      provenance: {} as never,
      supersedeInputDigest: digest,
    };
    await supersedeHeldCaseStatement(d1(sqlite), screened, "E-NEVER-WRITTEN").run();
    const state = (sqlite.query("SELECT state FROM screening_cases").get() as { state: string })
      .state;
    expect(state).toBe("pending");
  } finally {
    sqlite.close();
  }
});
