#!/usr/bin/env bun
/**
 * Run one test suite and emit a secret-safe NDJSON diagnostic for it.
 *
 *   bun run report                 # every suite in this package
 *   bun run report security        # one suite
 *
 * The child process inherits stdio, so the underlying `bun test` output — including
 * its stderr — reaches the log unmodified; the diagnostic line is emitted after
 * it and reports the real exit code, not a guess.
 */

import {
  assertSecretSafe,
  buildDiagnostic,
  formatDiagnostic,
  type SuiteDiagnostic,
} from "./diagnostics.ts";

const PACKAGE = "render";

const SUITES: Readonly<Record<string, string>> = {
  unit: "test/unit",
  contract: "test/contract",
  integration: "test/integration",
  security: "test/security",
};

async function runSuite(suite: string, target: string): Promise<SuiteDiagnostic> {
  const started = performance.now();
  const child = Bun.spawn(["bun", "test", target], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  const record = buildDiagnostic({
    package: PACKAGE,
    suite,
    target,
    duration_ms: Math.round(performance.now() - started),
    exit_code: exitCode,
    tool_version: Bun.version,
    runtime: `bun-${Bun.version}`,
  });
  assertSecretSafe(record);
  return record;
}

const requested = process.argv.slice(2);
const selected = requested.length > 0 ? requested : Object.keys(SUITES);

let failed = false;
for (const suite of selected) {
  const target = SUITES[suite];
  if (target === undefined) {
    console.error(`unknown suite ${JSON.stringify(suite)}; known suites: ${Object.keys(SUITES).join(", ")}`);
    process.exit(2);
  }
  const record = await runSuite(suite, target);
  console.log(formatDiagnostic(record));
  if (record.status === "fail") failed = true;
}

process.exit(failed ? 1 : 0);
