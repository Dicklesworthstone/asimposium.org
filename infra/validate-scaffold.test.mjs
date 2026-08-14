import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { ScaffoldValidationError, validateScaffold } from "./validate-scaffold.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const startedAt = performance.now();
const reproduce = "node infra/validate-scaffold.test.mjs";

function expectFailure(root, configWorkspacePath, expectedCode) {
  try {
    validateScaffold(root, configWorkspacePath);
    assert.fail(`expected ${expectedCode}`);
  } catch (error) {
    assert.ok(error instanceof ScaffoldValidationError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes("/Users/"), false);
  }
}

try {
  const positive = validateScaffold(repositoryRoot);
  assert.equal(positive.config, "infra/wrangler.toml");
  assert.equal(positive.entrypoint, "./apps/wire/src/index.ts");
  assert.equal(positive.migrations_dir, "./db/migrations");

  expectFailure(
    repositoryRoot,
    "infra/test-fixtures/forbidden-backend/wrangler.toml",
    "FORBIDDEN_BACKEND_MARKER",
  );
  expectFailure(
    repositoryRoot,
    "infra/test-fixtures/path-escape/wrangler.toml",
    "PATH_ESCAPE",
  );

  process.stdout.write(`${JSON.stringify({
    tool: "node",
    package: "infra",
    suite: "wrangler-scaffold-static-contract",
    version: process.version,
    duration_ms: Math.round(performance.now() - startedAt),
    status: "pass",
    reproduce,
  })}\n`);
} catch (error) {
  const details = error instanceof ScaffoldValidationError
    ? { code: error.code, detail: error.message }
    : { code: "ASSERTION_FAILED", detail: error instanceof Error ? error.message : "Unknown test failure." };
  process.stderr.write(`${JSON.stringify({
    tool: "node",
    package: "infra",
    suite: "wrangler-scaffold-static-contract",
    version: process.version,
    duration_ms: Math.round(performance.now() - startedAt),
    status: "fail",
    reproduce,
    ...details,
  })}\n`);
  process.exitCode = 1;
}
