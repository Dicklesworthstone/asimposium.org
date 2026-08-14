import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { MigrationError, localD1 } from "./migrate.mjs";

/**
 * Integration suite: this one DOES touch a database.
 *
 * It exercises the Wrangler local-D1 seam against a real local database
 * (workerd's own SQLite, no account, no network, not a mock). It is separate
 * from `migrate.test.mjs` precisely because that suite asserts it touches no
 * database, and a claim like that stops being true the moment the two are
 * mixed.
 *
 * What it proves: a failing local D1 command surfaces a bounded, redacted
 * account of *why* it failed instead of swallowing Wrangler's stderr.
 * What it does not prove: anything about a remote D1, a deployment, or a
 * provisioned environment.
 */

const startedAt = performance.now();
const reproduce = "bun infra/migrate-local.test.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE = "asimposium-local";

const cases = [
  {
    name: "a-successful-local-command-returns-json",
    execute() {
      const raw = localD1(root, DATABASE, ["--command", "SELECT 1 AS ok;"]);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // State the expectation rather than throwing a bare SyntaxError: the
        // useful failure here is "Wrangler stopped emitting JSON", not a parse
        // error with no context.
        assert.fail("a successful local D1 command must return parseable JSON");
      }
      assert.equal(parsed[0].results[0].ok, 1);
    },
  },
  {
    name: "a-failing-local-command-surfaces-a-redacted-cause",
    execute() {
      // Deliberately invalid SQL: Wrangler fails and writes the reason to
      // stderr. Before this fix that reason was discarded entirely.
      let thrown;
      try {
        localD1(root, DATABASE, ["--command", "SELECT * FROM a_table_that_does_not_exist;"]);
        assert.fail("expected the invalid query to fail");
      } catch (error) {
        thrown = error;
      }

      assert.ok(thrown instanceof MigrationError, String(thrown));
      assert.equal(thrown.code, "LOCAL_D1_COMMAND_FAILED");

      const cause = thrown.causalOutput;
      assert.equal(typeof cause, "string");
      assert.ok(["stdout", "stderr"].includes(thrown.causalStream), thrown.causalStream);
      // The cause must actually be present — an empty string would mean the
      // stderr was still being swallowed, just more politely.
      assert.ok(cause.length > 0, "causal output must not be empty");
      // …and it must name the real problem, not merely say "it failed".
      assert.ok(/no such table|does not exist|error/i.test(cause), cause);

      // Bounded and safe to paste into an issue.
      assert.ok(cause.length <= 601, `causal output must be bounded, got ${cause.length}`);
      assert.equal(cause.includes("\n"), false, "must collapse to one line");
      for (const forbidden of ["/Users/", "/private/", "/var/folders", "asimp_ag_", "BEGIN PRIVATE KEY"]) {
        assert.equal(cause.includes(forbidden), false, `leaked ${forbidden}: ${cause}`);
      }
      assert.equal(/[A-Fa-f0-9]{32,}/.test(cause), false, `leaked a long hex run: ${cause}`);
      // No environment variable assignments survive.
      assert.equal(/\b[A-Z][A-Z0-9_]{2,}=(?!<redacted>)\S/.test(cause), false, cause);
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

const base = {
  tool: "bun",
  package: "infra",
  suite: "d1-migration-local-integration",
  version: Bun.version,
  duration_ms: Math.round(performance.now() - startedAt),
  reproduce,
};

if (failed.length === 0) {
  process.stdout.write(
    `${JSON.stringify({
      ...base,
      status: "pass",
      cases_executed: cases.map(({ name }) => name),
      database: "wrangler local D1 (workerd SQLite); no remote resource touched",
    })}\n`,
  );
} else {
  process.stderr.write(
    `${JSON.stringify({
      ...base,
      status: "fail",
      code: "CONTRACT_CASES_FAILED",
      failed_cases: failed.map(({ name }) => name),
      assertion_diff: failed,
    })}\n`,
  );
  process.exitCode = 1;
}
