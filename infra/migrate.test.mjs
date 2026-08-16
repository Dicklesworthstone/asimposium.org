import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { REDACTED_TOKEN } from "@asimposium/contracts/diagnostic-safety";
import {
  assertRehearsalIsNotAnApplication,
  declaresDestructive,
  describeDestructiveStatements,
  digestOf,
  MigrationError,
  planMigrations,
  readMigrationDirectory,
  readStateFile,
  redactStderr,
  resolvePinnedWranglerCommand,
} from "./migrate.mjs";
import { maskAbsolutePaths } from "./validate-environments.mjs";

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
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const INSTALLED_WRANGLER_ENTRY = join(
  repositoryRoot,
  "apps/wire/node_modules/wrangler/bin/wrangler.js",
);
const INSTALLED_WRANGLER_MANIFEST = join(
  repositoryRoot,
  "apps/wire/node_modules/wrangler/package.json",
);

function pinnedWranglerFileSystem(overrides = {}) {
  return {
    existsSync: overrides.existsSync ?? existsSync,
    lstatSync: overrides.lstatSync ?? lstatSync,
    readFileSync: overrides.readFileSync ?? readFileSync,
  };
}

function exactDeclaredWranglerVersion() {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "apps/wire/package.json"), "utf8"));
  return manifest.devDependencies.wrangler;
}

/**
 * Run the real CLI and return what a caller would actually see.
 *
 * The redaction rule is about what reaches stdout and stderr, so asserting on a
 * thrown error object would test one layer above the one that matters. This
 * refuses before it reaches a database: an unknown environment cannot be
 * resolved to a target, so no D1 is opened.
 */
function runCli(args) {
  const result = Bun.spawnSync(["bun", "infra/migrate.mjs", ...args], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  return { exitCode: result.exitCode, stdout, stderr, combined: `${stdout}${stderr}` };
}

/** The last JSON line a run emitted on stderr. */
function refusalOf(run) {
  return JSON.parse(run.stderr.trim().split("\n").at(-1));
}

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
const record = (migration) => ({
  id: migration.id,
  sequence: migration.sequence,
  digest: migration.digest,
});

const cases = [
  {
    name: "the pinned Wrangler command ignores PATH and executes the exact workspace entry",
    execute() {
      const declaredVersion = exactDeclaredWranglerVersion();
      const command = resolvePinnedWranglerCommand(repositoryRoot);
      assert.deepEqual(command, [process.execPath, INSTALLED_WRANGLER_ENTRY]);

      // `process.execPath` and the entry are both absolute. This PATH excludes
      // the ambient Bun-global Wrangler, so the version result cannot come from
      // the shell command that previously made the local migration lane drift.
      const result = Bun.spawnSync({
        cmd: [...command, "--version"],
        cwd: repositoryRoot,
        env: { ...process.env, PATH: "/usr/bin:/bin" },
        stdout: "pipe",
        stderr: "pipe",
      });
      assert.equal(result.exitCode, 0, result.stderr.toString());
      assert.equal(result.stdout.toString().trim(), declaredVersion);
    },
  },
  {
    name: "a-missing-pinned-Wrangler-refuses-before-any-fallback-can-run",
    execute() {
      let thrown;
      try {
        resolvePinnedWranglerCommand(
          repositoryRoot,
          pinnedWranglerFileSystem({
            existsSync(path) {
              return path === INSTALLED_WRANGLER_ENTRY ? false : existsSync(path);
            },
          }),
        );
        assert.fail("a missing installed Wrangler must refuse");
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof MigrationError, `unexpected error: ${thrown}`);
      assert.equal(thrown.code, "PINNED_WRANGLER_UNAVAILABLE");
      assert.equal(
        thrown.message,
        "The repository-pinned Wrangler is not installed. Run bun install --frozen-lockfile.",
      );
      assert.equal(thrown.message.includes("bunx"), false);
      assert.equal(/(?:^|\s)\/(?:Users|home|private|tmp|var)\//.test(thrown.message), false);
    },
  },
  {
    name: "a-stale-pinned-Wrangler-version-refuses-without-echoing-either-version",
    execute() {
      let thrown;
      try {
        resolvePinnedWranglerCommand(
          repositoryRoot,
          pinnedWranglerFileSystem({
            readFileSync(path, options) {
              if (path === INSTALLED_WRANGLER_MANIFEST) return '{"version":"4.120.0"}';
              return readFileSync(path, options);
            },
          }),
        );
        assert.fail("a stale installed Wrangler must refuse");
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof MigrationError, `unexpected error: ${thrown}`);
      assert.equal(thrown.code, "PINNED_WRANGLER_VERSION_MISMATCH");
      assert.equal(
        thrown.message,
        "The installed repository-pinned Wrangler does not match apps/wire/package.json. Run bun install --frozen-lockfile.",
      );
      assert.equal(thrown.message.includes("4.120.0"), false);
      assert.equal(thrown.message.includes(exactDeclaredWranglerVersion()), false);
    },
  },
  {
    name: "reads-and-orders-a-well-formed-directory",
    execute() {
      const migrations = readMigrationDirectory(
        directory("ok", {
          "0002_second.sql": CREATE_B,
          "0001_first.sql": CREATE_A,
          "README.md": "docs\n",
        }),
      );
      assert.deepEqual(
        migrations.map((m) => m.id),
        ["0001_first.sql", "0002_second.sql"],
      );
      assert.equal(migrations[0].digest, digestOf(CREATE_A));
      assert.equal(migrations[0].digest.length, 64);
    },
  },
  {
    name: "an-empty-directory-plans-nothing-and-is-idempotent",
    execute() {
      // The repository is in exactly this state today: the boundary README and
      // no SQL. It must be a clean no-op, not an error.
      const migrations = readMigrationDirectory(
        directory("only-readme", { "README.md": "docs\n" }),
      );
      assert.deepEqual(migrations, []);
      const plan = planMigrations(migrations, [], plainOptions);
      assert.deepEqual(plan.to_apply, []);
      assert.equal(plan.idempotent, true);
    },
  },
  {
    name: "applying-twice-is-a-no-op",
    execute() {
      const migrations = readMigrationDirectory(
        directory("twice", { "0001_first.sql": CREATE_A, "0002_second.sql": CREATE_B }),
      );
      const first = planMigrations(migrations, [], plainOptions);
      assert.deepEqual(
        first.to_apply.map((m) => m.id),
        ["0001_first.sql", "0002_second.sql"],
      );
      assert.equal(first.idempotent, false);

      // Second plan, given the records the first run would have written.
      const second = planMigrations(migrations, migrations.map(record), plainOptions);
      assert.deepEqual(second.to_apply, []);
      assert.equal(second.idempotent, true);
      assert.deepEqual(
        second.skipped.map((s) => s.reason),
        ["already_applied", "already_applied"],
      );

      // And a third is still a no-op: idempotency is stable, not a one-shot.
      assert.deepEqual(
        planMigrations(migrations, migrations.map(record), plainOptions).to_apply,
        [],
      );
    },
  },
  {
    name: "a-partially-applied-directory-applies-only-the-remainder",
    execute() {
      const migrations = readMigrationDirectory(
        directory("partial", { "0001_first.sql": CREATE_A, "0002_second.sql": CREATE_B }),
      );
      const plan = planMigrations(migrations, [record(migrations[0])], plainOptions);
      assert.deepEqual(
        plan.to_apply.map((m) => m.id),
        ["0002_second.sql"],
      );
      assert.equal(plan.head, 1);
    },
  },

  // --- ordering -------------------------------------------------------------
  {
    name: "out-of-order-migration-is-refused",
    execute() {
      const migrations = readMigrationDirectory(
        directory("ooo", {
          "0001_first.sql": CREATE_A,
          "0003_third.sql": CREATE_B,
          "0002_late.sql": "CREATE TABLE c (id TEXT);\n",
        }),
      );
      // 0001 and 0003 applied; 0002 then appears unapplied beneath the head.
      const applied = [record(migrations[0]), record(migrations[2])];
      expectFailure("out-of-order", "OUT_OF_ORDER_MIGRATION", () =>
        planMigrations(migrations, applied, plainOptions),
      );
    },
  },
  {
    name: "duplicate-sequence-number-is-refused",
    execute() {
      expectFailure("dup-seq", "DUPLICATE_MIGRATION_SEQUENCE", () =>
        readMigrationDirectory(
          directory("dup", { "0001_first.sql": CREATE_A, "0001_other.sql": CREATE_B }),
        ),
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
        readMigrationDirectory(
          directory("stray", { "0001_first.sql": CREATE_A, "notes.txt": "x" }),
        ),
      );
    },
  },
  {
    name: "empty-migration-is-refused",
    execute() {
      expectFailure("empty", "EMPTY_MIGRATION", () =>
        readMigrationDirectory(directory("empty", { "0001_first.sql": "  \n" })),
      );
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
      for (const filename of [
        "0002_second.down.sql",
        "0002_second.rollback.sql",
        "0002_second.undo.sql",
        "0002_down_second.sql",
      ]) {
        expectFailure(filename, "DOWN_MIGRATION_REJECTED", () =>
          readMigrationDirectory(
            directory(`down-${filename}`, {
              "0001_first.sql": CREATE_A,
              [filename]: "DROP TABLE a;\n",
            }),
          ),
        );
      }
    },
  },

  // --- checksums and drift --------------------------------------------------
  {
    name: "editing-an-applied-migration-is-drift",
    execute() {
      const migrations = readMigrationDirectory(directory("drift", { "0001_first.sql": CREATE_A }));
      const applied = [
        {
          id: "0001_first.sql",
          sequence: 1,
          digest: digestOf("CREATE TABLE something_else (id TEXT);\n"),
        },
      ];
      expectFailure("drift", "MIGRATION_DRIFT", () =>
        planMigrations(migrations, applied, plainOptions),
      );
    },
  },
  {
    name: "deleting-an-applied-migration-is-a-rewritten-history",
    execute() {
      const migrations = readMigrationDirectory(
        directory("vanished", { "0002_second.sql": CREATE_B }),
      );
      const applied = [{ id: "0001_first.sql", sequence: 1, digest: digestOf(CREATE_A) }];
      expectFailure("vanished", "APPLIED_MIGRATION_MISSING", () =>
        planMigrations(migrations, applied, plainOptions),
      );
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
    name: "destructive-guard-resists-obfuscation",
    execute() {
      // Each of these was a live bypass of the previous whole-file regexes.
      const bypasses = {
        "cross-statement WHERE vouching for an unscoped UPDATE":
          "UPDATE claims SET disposition = 1;\nSELECT * FROM problems WHERE id = 1;",
        "cross-statement WHERE vouching for an unscoped DELETE":
          "DELETE FROM events;\nSELECT 1 FROM problems WHERE id = 1;",
        "comment inside the keyword pair": "DROP/**/TABLE claims;",
        "comment between the keywords": "DROP /* hi */ TABLE claims;",
        "comment splitting DELETE FROM": "DELETE/**/FROM events;",
        "DROP INDEX": "DROP INDEX idx_claims;",
        "DROP VIEW": "DROP VIEW v_claims;",
        "DROP TRIGGER": "DROP TRIGGER t_claims;",
        "ALTER TABLE RENAME TO": "ALTER TABLE claims RENAME TO claims_old;",
        "ALTER TABLE RENAME COLUMN": "ALTER TABLE claims RENAME COLUMN a TO b;",
        "REPLACE INTO": "REPLACE INTO claims (id) VALUES (1);",
        "INSERT OR REPLACE": "INSERT OR REPLACE INTO claims (id) VALUES (1);",
        "PRAGMA writable_schema": "PRAGMA writable_schema = ON;",
        VACUUM: "VACUUM;",
        "ATTACH DATABASE": "ATTACH DATABASE 'other.db' AS other;",
      };
      for (const [label, sql] of Object.entries(bypasses)) {
        assert.ok(
          describeDestructiveStatements(sql).length > 0,
          `undetected destructive form: ${label}`,
        );
      }
    },
  },
  {
    name: "destructive-guard-does-not-fire-on-comments-or-strings",
    execute() {
      // A keyword a reviewer can see is inert must stay inert, or the guard
      // becomes noise and gets routed around.
      assert.deepEqual(
        describeDestructiveStatements("-- DROP TABLE claims\nCREATE TABLE ok (id TEXT);"),
        [],
      );
      assert.deepEqual(
        describeDestructiveStatements("/* DROP TABLE claims */\nCREATE TABLE ok (id TEXT);"),
        [],
      );
      assert.deepEqual(
        describeDestructiveStatements("INSERT INTO notes (body) VALUES ('DROP TABLE claims');"),
        [],
      );
    },
  },
  {
    name: "the-opt-in-marker-must-be-a-real-comment",
    execute() {
      assert.equal(declaresDestructive("-- asimposium:allow-destructive\nDROP TABLE a;"), true);
      assert.equal(declaresDestructive("/* asimposium:allow-destructive */\nDROP TABLE a;"), true);
      // Smuggled through a string literal: the marker is data, not a decision.
      assert.equal(
        declaresDestructive(
          "INSERT INTO t VALUES ('\n-- asimposium:allow-destructive\n');\nDROP TABLE a;",
        ),
        false,
      );
      assert.equal(declaresDestructive("DROP TABLE a;"), false);
    },
  },
  {
    name: "obfuscated-destruction-is-refused-end-to-end",
    execute() {
      // The whole point: an obfuscated DROP with no marker must be refused by
      // the planner, on every environment, not merely "detected".
      const sneaky = "DROP/**/TABLE claims;\n";
      const migrations = readMigrationDirectory(directory("sneaky", { "0001_sneaky.sql": sneaky }));
      expectFailure("sneaky-permissive", "UNDECLARED_DESTRUCTIVE_MIGRATION", () =>
        planMigrations(migrations, [], { environmentName: "local", destructiveAllowed: true }),
      );
      expectFailure("sneaky-strict", "UNDECLARED_DESTRUCTIVE_MIGRATION", () =>
        planMigrations(migrations, [], plainOptions),
      );
    },
  },
  {
    name: "destructive-statements-are-detected",
    execute() {
      assert.deepEqual(describeDestructiveStatements("DROP TABLE claims;"), ["DROP TABLE"]);
      assert.deepEqual(describeDestructiveStatements("drop table claims;"), ["DROP TABLE"]);
      assert.deepEqual(describeDestructiveStatements("DELETE FROM events;"), [
        "DELETE without WHERE",
      ]);
      assert.deepEqual(describeDestructiveStatements("TRUNCATE events;"), ["TRUNCATE"]);
      assert.deepEqual(describeDestructiveStatements("ALTER TABLE a DROP COLUMN b;"), [
        "DROP COLUMN",
      ]);
      assert.deepEqual(describeDestructiveStatements("UPDATE claims SET disposition = 'x';"), [
        "UPDATE without WHERE",
      ]);
      // Scoped statements are ordinary migrations, not destruction.
      assert.deepEqual(describeDestructiveStatements("DELETE FROM events WHERE seq < 10;"), []);
      assert.deepEqual(
        describeDestructiveStatements("UPDATE claims SET x = 1 WHERE id = 'C-1';"),
        [],
      );
      assert.deepEqual(describeDestructiveStatements(CREATE_A), []);
    },
  },
  {
    name: "undeclared-destructive-migration-is-refused-everywhere",
    execute() {
      const migrations = readMigrationDirectory(
        directory("undeclared", { "0001_drop.sql": "DROP TABLE claims;\n" }),
      );
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
      const migrations = readMigrationDirectory(
        directory("declared", { "0001_drop.sql": declared }),
      );
      expectFailure("protected", "DESTRUCTIVE_TARGET_REFUSED", () =>
        planMigrations(migrations, [], {
          environmentName: "production",
          destructiveAllowed: false,
        }),
      );
      // …and permitted where the environment allows it.
      const plan = planMigrations(migrations, [], {
        environmentName: "local",
        destructiveAllowed: true,
      });
      assert.equal(plan.to_apply[0].destructive, true);
    },
  },
  {
    name: "production records through 0014 and admits pending non-destructive 0015",
    execute() {
      const migrations = readMigrationDirectory(join(repositoryRoot, "db", "migrations"));
      const applied = migrations.filter((migration) => migration.sequence <= 14).map(record);
      const plan = planMigrations(migrations, applied, {
        environmentName: "production",
        destructiveAllowed: false,
      });
      assert.equal(plan.head, 14);
      assert.deepEqual(plan.to_apply, [
        {
          id: "0015_sponsor_enrollment_bootstrap_invariant.sql",
          sequence: 15,
          digest: migrations.find((migration) => migration.sequence === 15)?.digest,
          destructive: false,
        },
      ]);
    },
  },
  {
    name: "the actual pending 0012 rebuild remains refused on production",
    execute() {
      const migrations = readMigrationDirectory(join(repositoryRoot, "db", "migrations"));
      const lifecycle = migrations.find((migration) => migration.sequence === 12);
      assert.ok(lifecycle, "0012 lifecycle migration is missing");
      assert.ok(describeDestructiveStatements(lifecycle.sql).length > 0);
      expectFailure("actual-0012-production", "UNDECLARED_DESTRUCTIVE_MIGRATION", () =>
        planMigrations(
          migrations,
          migrations.filter((migration) => migration.sequence <= 11).map(record),
          { environmentName: "production", destructiveAllowed: false },
        ),
      );
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
        "good.json": JSON.stringify([
          { id: "0001_first.sql", sequence: 1, digest: digestOf(CREATE_A) },
        ]),
      });
      expectFailure("missing", "MISSING_STATE_FILE", () =>
        readStateFile(join(root, "absent.json")),
      );
      expectFailure("bad", "MALFORMED_STATE_FILE", () => readStateFile(join(root, "bad.json")));
      expectFailure("object", "MALFORMED_STATE_FILE", () =>
        readStateFile(join(root, "object.json")),
      );
      expectFailure("incomplete", "MALFORMED_STATE_FILE", () =>
        readStateFile(join(root, "incomplete.json")),
      );
      assert.equal(readStateFile(join(root, "good.json")).length, 1);
    },
  },

  // --- state records are bounded (parent audit) -----------------------------
  {
    name: "state-record-fields-are-bounded",
    execute() {
      const good = digestOf(CREATE_A);
      const bad = {
        "id-not-a-migration.json": [{ id: "../../etc/passwd", sequence: 1, digest: good }],
        "id-arbitrary.json": [{ id: "whatever", sequence: 1, digest: good }],
        "sequence-float.json": [{ id: "0001_first.sql", sequence: 1.5, digest: good }],
        "sequence-negative.json": [{ id: "0001_first.sql", sequence: -1, digest: good }],
        "sequence-string.json": [{ id: "0001_first.sql", sequence: "1", digest: good }],
        "sequence-mismatch.json": [{ id: "0001_first.sql", sequence: 7, digest: good }],
        "digest-short.json": [{ id: "0001_first.sql", sequence: 1, digest: "abc" }],
        "digest-uppercase.json": [
          { id: "0001_first.sql", sequence: 1, digest: good.toUpperCase() },
        ],
        "digest-nonhex.json": [{ id: "0001_first.sql", sequence: 1, digest: "z".repeat(64) }],
        "extra-key.json": [
          { id: "0001_first.sql", sequence: 1, digest: good, applied_by: "someone" },
        ],
        "record-array.json": [[{ id: "0001_first.sql", sequence: 1, digest: good }]],
      };
      const files = Object.fromEntries(
        Object.entries(bad).map(([name, value]) => [name, JSON.stringify(value)]),
      );
      const root = directory("state-bounds", files);
      for (const name of Object.keys(bad)) {
        expectFailure(name, "MALFORMED_STATE_FILE", () => readStateFile(join(root, name)));
      }
    },
  },
  {
    name: "state-records-must-be-unique-and-ascending",
    execute() {
      const a = digestOf(CREATE_A);
      const b = digestOf(CREATE_B);
      const root = directory("state-order", {
        "dup-id.json": JSON.stringify([
          { id: "0001_first.sql", sequence: 1, digest: a },
          { id: "0001_first.sql", sequence: 1, digest: a },
        ]),
        "dup-seq.json": JSON.stringify([
          { id: "0001_first.sql", sequence: 1, digest: a },
          { id: "0001_other.sql", sequence: 1, digest: b },
        ]),
        "descending.json": JSON.stringify([
          { id: "0002_second.sql", sequence: 2, digest: b },
          { id: "0001_first.sql", sequence: 1, digest: a },
        ]),
      });
      expectFailure("dup-id", "DUPLICATE_STATE_RECORD", () =>
        readStateFile(join(root, "dup-id.json")),
      );
      expectFailure("dup-seq", "DUPLICATE_STATE_RECORD", () =>
        readStateFile(join(root, "dup-seq.json")),
      );
      expectFailure("descending", "UNORDERED_STATE_FILE", () =>
        readStateFile(join(root, "descending.json")),
      );
    },
  },
  {
    name: "state-file-must-be-a-regular-file",
    execute() {
      const root = directory("state-symlink", {
        "real.json": JSON.stringify([
          { id: "0001_first.sql", sequence: 1, digest: digestOf(CREATE_A) },
        ]),
      });
      symlinkSync(join(root, "real.json"), join(root, "linked.json"), "file");
      expectFailure("symlinked-state", "UNSAFE_STATE_FILE", () =>
        readStateFile(join(root, "linked.json")),
      );
      expectFailure("directory-as-state", "UNSAFE_STATE_FILE", () => readStateFile(root));
    },
  },

  // --- migration files must be real files (parent audit) --------------------
  {
    name: "symlinked-migration-file-is-refused",
    execute() {
      const outside = directory("outside-sql", { "evil.sql": "DROP TABLE claims;\n" });
      const root = directory("symlink-migration", { "0001_first.sql": CREATE_A });
      symlinkSync(join(outside, "evil.sql"), join(root, "0002_linked.sql"), "file");
      expectFailure("symlinked-migration", "SYMLINKED_MIGRATION_FILE", () =>
        readMigrationDirectory(root),
      );
    },
  },
  {
    name: "symlinked-migrations-directory-is-refused",
    execute() {
      const real = directory("real-migrations", { "0001_first.sql": CREATE_A });
      const linkParent = directory("link-parent", {});
      const link = join(linkParent, "migrations");
      symlinkSync(real, link, "dir");
      expectFailure("symlinked-dir", "SYMLINKED_MIGRATIONS_DIRECTORY", () =>
        readMigrationDirectory(link),
      );
    },
  },
  {
    name: "special-file-in-the-migrations-directory-is-refused",
    execute() {
      const root = directory("special", { "0001_first.sql": CREATE_A });
      mkdirSync(join(root, "0002_subdir.sql"), { recursive: true });
      expectFailure("subdirectory", "NON_REGULAR_MIGRATION_FILE", () =>
        readMigrationDirectory(root),
      );
    },
  },

  // --- a rehearsal may never stand in for an application (parent audit) -----
  {
    name: "state-file-cannot-be-combined-with-apply",
    execute() {
      expectFailure("rehearsal-as-apply", "STATE_FILE_WITH_APPLY", () =>
        assertRehearsalIsNotAnApplication({ apply: true, state: "infra/rehearsal.json" }),
      );
      // Each alone is fine: a plan may use a rehearsal, and an apply may run
      // without one by reading the target's ledger.
      assertRehearsalIsNotAnApplication({ apply: false, state: "infra/rehearsal.json" });
      assertRehearsalIsNotAnApplication({ apply: true, state: undefined });
      assertRehearsalIsNotAnApplication({ apply: false, state: undefined });
    },
  },

  // --- stderr is surfaced, bounded and redacted (parent audit) --------------
  {
    name: "causal-stderr-is-redacted-and-bounded",
    execute() {
      assert.equal(redactStderr(""), "");
      assert.equal(redactStderr(undefined), "");

      const noisy = [
        "wrangler failed reading /Users/someone/projects/asimposium.org/infra/wrangler.toml",
        "CLOUDFLARE_API_TOKEN=abcdef0123456789abcdef",
        "token asimp_ag_deadbeefdeadbeefdeadbeef",
        `digest ${"a1b2c3d4".repeat(8)}`,
        "-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----",
      ].join("\n");
      const safe = redactStderr(noisy);

      // The cause survives...
      assert.ok(safe.includes("wrangler failed"), safe);
      // ...but nothing that identifies a machine or carries a secret does.
      assert.equal(safe.includes("/Users/"), false, safe);
      assert.equal(safe.includes("abcdef0123456789"), false, safe);
      assert.equal(safe.includes("asimp_ag_"), false, safe);
      assert.equal(safe.includes("BEGIN PRIVATE KEY"), false, safe);
      assert.equal(/[A-Fa-f0-9]{32,}/.test(safe), false, safe);
      // Newlines collapse so one record stays one line.
      assert.equal(safe.includes("\n"), false, safe);

      // Bounded: a runaway log cannot flood a diagnostic.
      const long = redactStderr("x".repeat(50_000));
      assert.ok(long.length <= 601, String(long.length));
      assert.ok(long.endsWith("…"));
    },
  },
  {
    // Families this file never declared. They can only be redacted by the
    // shared module, so each one failing here means the delegation is gone.
    name: "credential-families-only-the-shared-module-knows-are-redacted",
    execute() {
      for (const [label, noisy, leaked] of [
        ["bearer", "Authorization: Bearer abcdefgh12345678", "abcdefgh12345678"],
        ["basic", "Authorization: Basic YWxhZGRpbjpvcGVuc2U=", "YWxhZGRpbjpvcGVuc2U"],
        ["github pat", "remote said github_pat_1234567890123456789012ab", "github_pat_1234"],
        ["stripe-shaped", "child printed sk_live_abcdefghijkl", "sk_live_abcdefghijkl"],
        ["google api key", "key AIzaSyA1234567890123456789012", "AIzaSyA1234567890"],
        ["join fragment", "url #v1.abcdefghijkl", "#v1.abcdefghijkl"],
        ["labelled password", "password: hunter2", "hunter2"],
      ]) {
        const safe = redactStderr(noisy);
        assert.equal(safe.includes(leaked), false, `${label}: ${safe}`);
        assert.ok(safe.includes(REDACTED_TOKEN), `${label}: ${safe}`);
      }
    },
  },
  {
    // Line-valued fields consume to end of line: a cookie attribute list or a
    // private body must not survive past the first `;` or `,`.
    name: "labelled-cookie-and-body-values-are-redacted-to-the-line-tail",
    execute() {
      for (const [noisy, leaked] of [
        ["cookie: sid=abc; other=secret", "other=secret"],
        ["set-cookie: a=1; Secure; HttpOnly", "HttpOnly"],
        ["directive_body: prove the lemma, then reveal the witness", "witness"],
        ["workshop_body: draft one, draft two", "draft two"],
      ]) {
        const safe = redactStderr(noisy);
        assert.equal(safe.includes(leaked), false, safe);
      }
    },
  },
  {
    // Every occurrence, not just the first: a child that echoes its environment
    // twice must not have the second copy printed.
    name: "every-occurrence-of-a-credential-family-is-replaced",
    execute() {
      const safe = redactStderr(
        "first asimp_ag_AAAABBBBCCCC then asimp_ag_DDDDEEEEFFFF and PGPASSWORD=one API_TOKEN=two",
      );
      assert.equal(safe.includes("asimp_ag_AAAA"), false, safe);
      assert.equal(safe.includes("asimp_ag_DDDD"), false, safe);
      assert.equal(safe.includes("one"), false, safe);
      assert.equal(safe.includes("two"), false, safe);
      // The labels survive so an operator knows which variables were withheld.
      assert.ok(safe.includes("PGPASSWORD="), safe);
      assert.ok(safe.includes("API_TOKEN="), safe);
    },
  },
  {
    // The scanner must not eat the diagnostic. A migration id, a short digest
    // prefix, and ordinary prose are what make a failure legible.
    name: "safe-migration-prose-and-identifiers-survive-redaction",
    execute() {
      const safe = redactStderr(
        "0004_krater_integrity_v1.sql applied in 12 ms; sequence 4; sha256 prefix a1b2c3d4",
      );
      assert.equal(
        safe,
        "0004_krater_integrity_v1.sql applied in 12 ms; sequence 4; sha256 prefix a1b2c3d4",
      );
      assert.equal(safe.includes(REDACTED_TOKEN), false, safe);
    },
  },
  {
    // Structural: the credential families live in one place. A copy reappearing
    // here is the drift this consolidation removed, and it would pass every
    // behavioural case above while silently falling behind the shared list.
    name: "migrate-does-not-restate-a-shared-credential-family",
    execute() {
      const source = readFileSync(new URL("./migrate.mjs", import.meta.url), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const duplicated of [
        "asimp_ag_",
        "BEGIN ",
        "Bearer",
        "Basic",
        "github_pat_",
        "AIza",
        "password",
        "cookie",
      ]) {
        assert.equal(code.includes(duplicated), false, `restated credential family: ${duplicated}`);
      }
      // ...while the migration-specific guards stay local to this file.
      assert.ok(code.includes("A-Z0-9_]{2,})="), "env-assignment guard missing");
      assert.ok(code.includes("A-Fa-f0-9]{32,}"), "long-hex guard missing");
      assert.ok(code.includes("MAX_CAUSAL_STDERR"), "size bound missing");
      // Absolute-path masking is still applied here, but it is defined once
      // beside the topology validator so the two runners cannot drift to
      // different notions of a masked path. Reached, not restated.
      assert.ok(code.includes("maskAbsolutePaths"), "absolute-path masking is not applied");
      assert.equal(code.includes("Volumes"), false, "absolute-path rule was restated locally");
    },
  },
  {
    // A caller who fat-fingers a token into `--env` must not have the tool that
    // refuses the value print it back into the log. The contrast run is the
    // causal half: the two invocations differ in exactly one dimension —
    // whether the argument is credential-shaped — and reach the same refusal by
    // the same path, so the redaction is shown to fire on the credential and
    // only on the credential.
    name: "a-credential-passed-as-an-environment-name-is-not-echoed",
    execute() {
      // Synthetic, shaped like a Fellow bearer token. Never a live value.
      const planted = "asimp_ag_LIVEabc123XYZdefg456";
      const refused = runCli(["--env", planted]);
      assert.equal(refused.exitCode, 1);

      const diagnostic = refusalOf(refused);
      assert.equal(diagnostic.status, "fail");
      assert.equal(diagnostic.code, "UNKNOWN_ENVIRONMENT");

      // Neither the whole token nor the distinctive tail survives anywhere a
      // caller can see, on either stream.
      assert.equal(refused.combined.includes(planted), false, "token reached the output");
      assert.equal(
        refused.combined.includes("abc123XYZdefg456"),
        false,
        "token tail reached the output",
      );
      assert.ok(diagnostic.detail.includes(REDACTED_TOKEN), "detail was not redacted");

      // The refusal is still useful: the safe prose that tells a caller what to
      // do instead is not collateral damage of the redaction.
      assert.ok(
        diagnostic.detail.includes("expected one of local, staging, production"),
        "safe prose did not survive redaction",
      );

      // Causal contrast: a non-credential name takes the same path to the same
      // code and is echoed verbatim, so the assertions above are load-bearing
      // rather than passing because nothing is ever echoed.
      const benign = runCli(["--env", "prod"]);
      const echoed = refusalOf(benign);
      assert.equal(echoed.code, "UNKNOWN_ENVIRONMENT");
      assert.ok(echoed.detail.includes('"prod"'), "a safe environment name should be echoed");
      assert.equal(echoed.detail.includes(REDACTED_TOKEN), false);
    },
  },
  {
    // A path is not a credential family, so the canonical scanner declines it.
    // Caller-controlled path diagnostics keep the absolute-path masking they
    // have always had, rather than losing it to the credential delegation.
    //
    // `--env` is the emission path under test because it is a *supported* flag
    // whose value is genuinely interpolated into the refusal. An earlier
    // revision of this case passed `--config`, which this CLI does not accept:
    // it took the INVALID_ARGUMENT branch, never interpolated the plant, and
    // "passed" only because the usage string literally contains
    // `[--state-file <path>]`. Pinning the code and refusing the usage text is
    // what keeps that false green from coming back.
    name: "an-absolute-caller-path-is-masked-in-the-diagnostic",
    execute() {
      const planted = "/Users/planted-operator/private-keys";
      const refused = runCli(["--env", planted]);
      assert.equal(refused.exitCode, 1);

      const diagnostic = refusalOf(refused);
      assert.equal(diagnostic.status, "fail");
      assert.equal(diagnostic.code, "UNKNOWN_ENVIRONMENT", "a non-interpolating branch ran");
      assert.equal(
        diagnostic.detail.includes("Usage:"),
        false,
        "took the usage branch, whose static text contains <path> and proves nothing",
      );

      // Exact, so a partial mask that left a fragment behind cannot pass.
      assert.equal(
        diagnostic.detail,
        'Unknown environment "<path>"; expected one of local, staging, production.',
      );
      assert.equal(refused.combined.includes("planted-operator"), false, "home directory leaked");
      assert.equal(refused.combined.includes(planted), false, "absolute path leaked");

      // Causal contrast: a value with no absolute path reaches the same code by
      // the same route and is echoed verbatim.
      const benign = refusalOf(runCli(["--env", "prod"]));
      assert.equal(benign.code, "UNKNOWN_ENVIRONMENT");
      assert.ok(benign.detail.includes('"prod"'), "a safe environment name should be echoed");
      assert.equal(benign.detail.includes("<path>"), false, "nothing to mask, yet masked");

      // This CLI's own path-bearing flag never interpolates the caller's path
      // at all: `--state-file` refusals are fixed strings. That is the stronger
      // property, so it is asserted as non-disclosure only and is deliberately
      // NOT offered as evidence of masking.
      const escaped = runCli(["--env", "local", "--state-file", `${planted}/state.json`]);
      assert.equal(refusalOf(escaped).code, "PATH_ESCAPE");
      assert.equal(escaped.combined.includes("planted-operator"), false, "home directory leaked");
      assert.equal(
        refusalOf(escaped).detail.includes("<path>"),
        false,
        "this refusal is a fixed string; a <path> here would mean it echoes after all",
      );

      // The masking primitive itself, which every diagnostic this file prints
      // is routed through.
      assert.equal(
        maskAbsolutePaths("read /Users/planted-operator/k.pem failed"),
        "read <path> failed",
      );
      assert.equal(
        redactStderr("wrangler: cannot open /Users/planted-operator/k.pem"),
        "wrangler: cannot open <path>",
      );
    },
  },
  {
    // A bare `\S+` value class stopped at the first space, so a quoted
    // assignment printed the tail of the value it claimed to withhold. Each
    // plant differs from the working case in exactly one dimension: where the
    // value ends.
    name: "a-quoted-environment-assignment-is-withheld-to-its-closing-quote",
    execute() {
      // Spaces inside the value: the old rule emitted ` def ghi"`.
      const spaced = redactStderr('child failed: TOKEN="abc def ghi" NEXT=keepme');
      assert.equal(spaced.includes("def"), false, "quoted value tail leaked");
      assert.equal(spaced.includes("ghi"), false, "quoted value tail leaked");
      assert.ok(spaced.includes(`TOKEN=${REDACTED_TOKEN}`), "label was not preserved");

      // An escaped quote inside the value: `"[^"]*"` would close early here and
      // leak the remainder, which is why the class consumes `\\.` as a unit.
      const escaped = redactStderr('child failed: TOKEN="abc \\" def" tail');
      assert.equal(escaped.includes("def"), false, "value past an escaped quote leaked");
      assert.ok(escaped.includes(`TOKEN=${REDACTED_TOKEN}`), "label was not preserved");

      // Single quotes are the same value class.
      const single = redactStderr("child failed: SECRET='a b c' after");
      assert.equal(single.includes(" b "), false, "single-quoted value tail leaked");

      // The bound is the closing quote and not the rest of the line: an
      // adjacent assignment is still redacted on its own terms, and ordinary
      // trailing prose survives, so the widened class did not become a
      // line-eating rule.
      assert.ok(spaced.includes(`NEXT=${REDACTED_TOKEN}`), "adjacent assignment was not redacted");
      assert.ok(escaped.endsWith("tail"), "prose after a quoted value did not survive");
      assert.ok(single.endsWith("after"), "prose after a quoted value did not survive");
    },
  },
];

const failed = [];
for (const testCase of cases) {
  try {
    testCase.execute();
  } catch (error) {
    failed.push({
      name: testCase.name,
      detail: error instanceof Error ? error.message : "unknown",
    });
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
