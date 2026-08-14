import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  MigrationError,
  describeDestructiveStatements,
  digestOf,
  planMigrations,
  readMigrationDirectory,
  readStateFile,
} from "./migrate.mjs";

/**
 * Negative corpus for the migration planner.
 *
 * The planner is pure, so every ordering, checksum, idempotency, and
 * destructive-guard rule is exercised here against synthetic migration
 * directories in temporary space. `db/migrations/` is owned by W2/S-2 and is
 * never written to by this suite.
 *
 * What this does NOT do: apply anything. No D1, local or remote, is created,
 * opened, or written. A green run here says the planner decides correctly, not
 * that a migration has ever executed.
 */

const startedAt = performance.now();
const reproduce = "bun infra/migrate.test.mjs";
const space = mkdtempSync(join(tmpdir(), "asimposium-migrations-"));

function directory(name, files) {
  const root = join(space, name);
  mkdirSync(root, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(root, filename), content, "utf8");
  }
  return root;
}

function expectFailure(label, expectedCode, fn) {
  try {
    fn();
    assert.fail(`${label}: expected ${expectedCode}, but it succeeded`);
  } catch (error) {
    assert.ok(error instanceof MigrationError, `${label}: unexpected ${error}`);
    assert.equal(error.code, expectedCode, `${label}: ${error.message}`);
    assert.equal(/(?:^|\s)\/(?:Users|home|private|tmp|var)\//.test(error.message), false, label);
  }
}

const CREATE_A = "CREATE TABLE a (id TEXT PRIMARY KEY);\n";
const CREATE_B = "CREATE TABLE b (id TEXT PRIMARY KEY);\n";
const plainOptions = { environmentName: "staging", destructiveAllowed: false };
const record = (migration) => ({ id: migration.id, sequence: migration.sequence, digest: migration.digest });

const cases = [
  {
    name: "reads-and-orders-a-well-formed-directory",
    execute() {
      const migrations = readMigrationDirectory(
        directory("ok", { "0002_second.sql": CREATE_B, "0001_first.sql": CREATE_A, "README.md": "docs\n" }),
      );
      assert.deepEqual(migrations.map((m) => m.id), ["0001_first.sql", "0002_second.sql"]);
      assert.equal(migrations[0].digest, digestOf(CREATE_A));
      assert.equal(migrations[0].digest.length, 64);
    },
  },
  {
    name: "an-empty-directory-plans-nothing-and-is-idempotent",
    execute() {
      // The repository is in exactly this state today: the boundary README and
      // no SQL. It must be a clean no-op, not an error.
      const migrations = readMigrationDirectory(directory("only-readme", { "README.md": "docs\n" }));
      assert.deepEqual(migrations, []);
      const plan = planMigrations(migrations, [], plainOptions);
      assert.deepEqual(plan.to_apply, []);
      assert.equal(plan.idempotent, true);
    },
  },
  {
    name: "applying-twice-is-a-no-op",
    execute() {
      const migrations = readMigrationDirectory(directory("twice", { "0001_first.sql": CREATE_A, "0002_second.sql": CREATE_B }));
      const first = planMigrations(migrations, [], plainOptions);
      assert.deepEqual(first.to_apply.map((m) => m.id), ["0001_first.sql", "0002_second.sql"]);
      assert.equal(first.idempotent, false);

      // Second plan, given the records the first run would have written.
      const second = planMigrations(migrations, migrations.map(record), plainOptions);
      assert.deepEqual(second.to_apply, []);
      assert.equal(second.idempotent, true);
      assert.deepEqual(second.skipped.map((s) => s.reason), ["already_applied", "already_applied"]);

      // And a third is still a no-op: idempotency is stable, not a one-shot.
      assert.deepEqual(planMigrations(migrations, migrations.map(record), plainOptions).to_apply, []);
    },
  },
  {
    name: "a-partially-applied-directory-applies-only-the-remainder",
    execute() {
      const migrations = readMigrationDirectory(directory("partial", { "0001_first.sql": CREATE_A, "0002_second.sql": CREATE_B }));
      const plan = planMigrations(migrations, [record(migrations[0])], plainOptions);
      assert.deepEqual(plan.to_apply.map((m) => m.id), ["0002_second.sql"]);
      assert.equal(plan.head, 1);
    },
  },

  // --- ordering -------------------------------------------------------------
  {
    name: "out-of-order-migration-is-refused",
    execute() {
      const migrations = readMigrationDirectory(
        directory("ooo", { "0001_first.sql": CREATE_A, "0003_third.sql": CREATE_B, "0002_late.sql": "CREATE TABLE c (id TEXT);\n" }),
      );
      // 0001 and 0003 applied; 0002 then appears unapplied beneath the head.
      const applied = [record(migrations[0]), record(migrations[2])];
      expectFailure("out-of-order", "OUT_OF_ORDER_MIGRATION", () => planMigrations(migrations, applied, plainOptions));
    },
  },
  {
    name: "duplicate-sequence-number-is-refused",
    execute() {
      expectFailure("dup-seq", "DUPLICATE_MIGRATION_SEQUENCE", () =>
        readMigrationDirectory(directory("dup", { "0001_first.sql": CREATE_A, "0001_other.sql": CREATE_B })),
      );
    },
  },
  {
    name: "malformed-migration-name-is-refused",
    execute() {
      for (const [label, filename] of [
        ["no-number", "first.sql"],
        ["short-number", "001_first.sql"],
        ["uppercase", "0001_First.sql"],
        ["spaces", "0001 first.sql"],
        ["trailing-underscore", "0001_first_.sql"],
      ]) {
        expectFailure(label, "MALFORMED_MIGRATION_NAME", () =>
          readMigrationDirectory(directory(`name-${label}`, { [filename]: CREATE_A })),
        );
      }
    },
  },
  {
    name: "non-sql-file-is-refused",
    execute() {
      expectFailure("stray", "UNEXPECTED_MIGRATION_FILE", () =>
        readMigrationDirectory(directory("stray", { "0001_first.sql": CREATE_A, "notes.txt": "x" })),
      );
    },
  },
  {
    name: "empty-migration-is-refused",
    execute() {
      expectFailure("empty", "EMPTY_MIGRATION", () => readMigrationDirectory(directory("empty", { "0001_first.sql": "  \n" })));
    },
  },
  {
    name: "missing-directory-is-refused",
    execute() {
      expectFailure("missing-dir", "MISSING_MIGRATIONS_DIRECTORY", () =>
        readMigrationDirectory(join(space, "does-not-exist")),
      );
    },
  },

  // --- rollback-forward policy ---------------------------------------------
  {
    name: "down-migrations-are-refused-by-name",
    execute() {
      for (const filename of ["0002_second.down.sql", "0002_second.rollback.sql", "0002_second.undo.sql", "0002_down_second.sql"]) {
        expectFailure(filename, "DOWN_MIGRATION_REJECTED", () =>
          readMigrationDirectory(directory(`down-${filename}`, { "0001_first.sql": CREATE_A, [filename]: "DROP TABLE a;\n" })),
        );
      }
    },
  },

  // --- checksums and drift --------------------------------------------------
  {
    name: "editing-an-applied-migration-is-drift",
    execute() {
      const migrations = readMigrationDirectory(directory("drift", { "0001_first.sql": CREATE_A }));
      const applied = [{ id: "0001_first.sql", sequence: 1, digest: digestOf("CREATE TABLE something_else (id TEXT);\n") }];
      expectFailure("drift", "MIGRATION_DRIFT", () => planMigrations(migrations, applied, plainOptions));
    },
  },
  {
    name: "deleting-an-applied-migration-is-a-rewritten-history",
    execute() {
      const migrations = readMigrationDirectory(directory("vanished", { "0002_second.sql": CREATE_B }));
      const applied = [{ id: "0001_first.sql", sequence: 1, digest: digestOf(CREATE_A) }];
      expectFailure("vanished", "APPLIED_MIGRATION_MISSING", () => planMigrations(migrations, applied, plainOptions));
    },
  },
  {
    name: "digest-is-content-addressed-not-name-addressed",
    execute() {
      const a = readMigrationDirectory(directory("dig-a", { "0001_first.sql": CREATE_A }))[0];
      const b = readMigrationDirectory(directory("dig-b", { "0001_renamed.sql": CREATE_A }))[0];
      assert.equal(a.digest, b.digest);
      assert.notEqual(a.digest, digestOf(CREATE_B));
    },
  },

  // --- destructive-target guards -------------------------------------------
  {
    name: "destructive-statements-are-detected",
    execute() {
      assert.deepEqual(describeDestructiveStatements("DROP TABLE claims;"), ["DROP TABLE"]);
      assert.deepEqual(describeDestructiveStatements("drop table claims;"), ["DROP TABLE"]);
      assert.deepEqual(describeDestructiveStatements("DELETE FROM events;"), ["DELETE without WHERE"]);
      assert.deepEqual(describeDestructiveStatements("TRUNCATE events;"), ["TRUNCATE"]);
      assert.deepEqual(describeDestructiveStatements("ALTER TABLE a DROP COLUMN b;"), ["DROP COLUMN"]);
      assert.deepEqual(describeDestructiveStatements("UPDATE claims SET disposition = 'x';"), ["UPDATE without WHERE"]);
      // Scoped statements are ordinary migrations, not destruction.
      assert.deepEqual(describeDestructiveStatements("DELETE FROM events WHERE seq < 10;"), []);
      assert.deepEqual(describeDestructiveStatements("UPDATE claims SET x = 1 WHERE id = 'C-1';"), []);
      assert.deepEqual(describeDestructiveStatements(CREATE_A), []);
    },
  },
  {
    name: "undeclared-destructive-migration-is-refused-everywhere",
    execute() {
      const migrations = readMigrationDirectory(directory("undeclared", { "0001_drop.sql": "DROP TABLE claims;\n" }));
      // Refused even where destruction is permitted: the marker is what makes
      // it reviewable, and an unmarked DROP is indistinguishable from a slip.
      expectFailure("undeclared-permissive", "UNDECLARED_DESTRUCTIVE_MIGRATION", () =>
        planMigrations(migrations, [], { environmentName: "local", destructiveAllowed: true }),
      );
      expectFailure("undeclared-strict", "UNDECLARED_DESTRUCTIVE_MIGRATION", () =>
        planMigrations(migrations, [], plainOptions),
      );
    },
  },
  {
    name: "declared-destructive-migration-is-refused-on-a-protected-target",
    execute() {
      const declared = "-- asimposium:allow-destructive\nDROP TABLE claims;\n";
      const migrations = readMigrationDirectory(directory("declared", { "0001_drop.sql": declared }));
      expectFailure("protected", "DESTRUCTIVE_TARGET_REFUSED", () =>
        planMigrations(migrations, [], { environmentName: "production", destructiveAllowed: false }),
      );
      // …and permitted where the environment allows it.
      const plan = planMigrations(migrations, [], { environmentName: "local", destructiveAllowed: true });
      assert.equal(plan.to_apply[0].destructive, true);
    },
  },

  // --- applied-state parsing ------------------------------------------------
  {
    name: "state-file-must-be-well-formed",
    execute() {
      const root = directory("state", {
        "bad.json": "{not json",
        "object.json": JSON.stringify({ id: "x" }),
        "incomplete.json": JSON.stringify([{ id: "0001_first.sql" }]),
        "good.json": JSON.stringify([{ id: "0001_first.sql", sequence: 1, digest: digestOf(CREATE_A) }]),
      });
      expectFailure("missing", "MISSING_STATE_FILE", () => readStateFile(join(root, "absent.json")));
      expectFailure("bad", "MALFORMED_STATE_FILE", () => readStateFile(join(root, "bad.json")));
      expectFailure("object", "MALFORMED_STATE_FILE", () => readStateFile(join(root, "object.json")));
      expectFailure("incomplete", "MALFORMED_STATE_FILE", () => readStateFile(join(root, "incomplete.json")));
      assert.equal(readStateFile(join(root, "good.json")).length, 1);
    },
  },
];

const failed = [];
for (const testCase of cases) {
  try {
    testCase.execute();
  } catch (error) {
    failed.push({ name: testCase.name, detail: error instanceof Error ? error.message : "unknown" });
  }
}

if (failed.length === 0) {
  process.stdout.write(
    `${JSON.stringify({
      tool: "bun",
      package: "infra",
      suite: "d1-migration-contract",
      version: Bun.version,
      duration_ms: Math.round(performance.now() - startedAt),
      status: "pass",
      reproduce,
      cases_executed: cases.map(({ name }) => name),
      temporary_space_fixtures_retained: true,
      no_database_touched: true,
    })}\n`,
  );
} else {
  process.stderr.write(
    `${JSON.stringify({
      tool: "bun",
      package: "infra",
      suite: "d1-migration-contract",
      version: Bun.version,
      duration_ms: Math.round(performance.now() - startedAt),
      status: "fail",
      reproduce,
      code: "CONTRACT_CASES_FAILED",
      failed_cases: failed.map(({ name }) => name),
      assertion_diff: failed,
    })}\n`,
  );
  process.exitCode = 1;
}
