import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { ScaffoldValidationError, validateScaffold } from "./validate-scaffold.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const startedAt = performance.now();
const reproduce = "node infra/validate-scaffold.test.mjs";
const temporaryFixtureRoot = mkdtempSync(join(tmpdir(), "asimposium-infra-validator-"));

const REQUIRED_DIRECTORIES = [
  "apps/web",
  "apps/wire",
  "packages/contracts",
  "packages/protocol",
  "packages/render",
  "db/migrations",
  "cli",
  "infra",
  "e2e",
  "docs",
];

const validConfig = `name = "asimposium-stoa-local"
main = "../apps/wire/src/index.ts"
compatibility_date = "2026-08-13"
compatibility_flags = ["nodejs_compat"]
workers_dev = false

[dev]
port = 8787
local_protocol = "http"

[[d1_databases]]
binding = "DB"
database_name = "asimposium-local"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "../db/migrations"

[[r2_buckets]]
binding = "ARTIFACTS"
bucket_name = "asimposium-artifacts-local"

[[rules]]
type = "Text"
globs = ["**/*.md"]
fallthrough = true
`;

function writeFixtureFile(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function createCompleteFixtureRoot(name, config = validConfig) {
  const root = join(temporaryFixtureRoot, name);
  for (const directory of REQUIRED_DIRECTORIES) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFixtureFile(root, "apps/wire/src/index.ts", "export default {};\n");
  writeFixtureFile(root, "apps/wire/package.json", JSON.stringify({ devDependencies: { wrangler: "4.123.0" } }));
  writeFixtureFile(root, "db/migrations/README.md", "fixture\n");
  writeFixtureFile(root, "infra/README.md", "fixture\n");
  writeFixtureFile(root, "docs/README.md", "fixture\n");
  writeFixtureFile(root, "infra/wrangler.toml", config);
  return root;
}

function createMissingMainFixture() {
  const root = join(temporaryFixtureRoot, "missing-main");
  mkdirSync(join(root, "infra"), { recursive: true });
  writeFixtureFile(root, "infra/wrangler.toml", validConfig);
  return root;
}

function createMainSymlinkEscapeFixture() {
  const root = join(temporaryFixtureRoot, "main-symlink-escape");
  const externalApps = join(temporaryFixtureRoot, "external-main-apps");
  mkdirSync(join(root, "infra"), { recursive: true });
  mkdirSync(join(externalApps, "wire", "src"), { recursive: true });
  writeFileSync(join(externalApps, "wire", "src", "index.ts"), "export default {};\n", "utf8");
  symlinkSync(externalApps, join(root, "apps"), "dir");
  writeFixtureFile(root, "infra/wrangler.toml", validConfig);
  return root;
}

function createMigrationsSymlinkEscapeFixture() {
  const root = join(temporaryFixtureRoot, "migrations-symlink-escape");
  const externalDatabase = join(temporaryFixtureRoot, "external-database");
  mkdirSync(join(root, "infra"), { recursive: true });
  mkdirSync(join(root, "apps", "wire", "src"), { recursive: true });
  mkdirSync(join(externalDatabase, "migrations"), { recursive: true });
  writeFileSync(join(root, "apps", "wire", "src", "index.ts"), "export default {};\n", "utf8");
  symlinkSync(externalDatabase, join(root, "db"), "dir");
  writeFixtureFile(root, "infra/wrangler.toml", validConfig);
  return root;
}

function expectFailure(root, configWorkspacePath, expectedCode) {
  try {
    validateScaffold(root, configWorkspacePath);
    assert.fail(`expected ${expectedCode}`);
  } catch (error) {
    assert.ok(error instanceof ScaffoldValidationError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes("/Users/"), false);
    assert.equal(/(?:^|\s)\/(?:private|tmp|var)\//.test(error.message), false);
  }
}

try {
  const duplicateD1Config = validConfig.replace(
    "[[r2_buckets]]",
    "[[d1_databases]]\nbinding = \"DB_SHADOW\"\ndatabase_name = \"conflicting-local\"\ndatabase_id = \"00000000-0000-0000-0000-000000000000\"\nmigrations_dir = \"../db/migrations\"\n\n[[r2_buckets]]",
  );
  const shadowedR2Config = validConfig.replace(
    "[[r2_buckets]]",
    "[r2_buckets]\nbinding = \"ARTIFACTS_SHADOW\"\nbucket_name = \"conflicting-local\"\n\n[[r2_buckets]]",
  );
  const missingMarkdownRuleConfig = validConfig.replace(
    "\n[[rules]]\ntype = \"Text\"\nglobs = [\"**/*.md\"]\nfallthrough = true\n",
    "\n",
  );
  const wrongMarkdownRuleTypeConfig = validConfig.replace('type = "Text"', 'type = "Data"');
  const wrongMarkdownRuleGlobConfig = validConfig.replace('globs = ["**/*.md"]', 'globs = ["**/*.txt"]');
  const wrongMarkdownRuleFallthroughConfig = validConfig.replace("fallthrough = true", "fallthrough = false");
  const duplicateMarkdownRuleConfig = `${validConfig}
[[rules]]
type = "Text"
globs = ["**/*.md"]
fallthrough = true
`;
  const cases = [
    {
      name: "positive",
      execute() {
        const positive = validateScaffold(repositoryRoot);
        assert.equal(positive.config, "infra/wrangler.toml");
        assert.equal(positive.entrypoint, "./apps/wire/src/index.ts");
        assert.equal(positive.migrations_dir, "./db/migrations");
      },
    },
    {
      name: "forbidden-backend",
      execute() {
        expectFailure(
          repositoryRoot,
          "infra/test-fixtures/forbidden-backend/wrangler.toml",
          "FORBIDDEN_BACKEND_MARKER",
        );
      },
    },
    {
      name: "lexical-path-escape",
      execute() {
        expectFailure(
          repositoryRoot,
          "infra/test-fixtures/path-escape/wrangler.toml",
          "PATH_ESCAPE",
        );
      },
    },
    {
      name: "missing-required-main-target",
      execute() {
        expectFailure(createMissingMainFixture(), "infra/wrangler.toml", "MISSING_REQUIRED_TARGET");
      },
    },
    {
      name: "duplicate-d1-binding",
      execute() {
        expectFailure(createCompleteFixtureRoot("duplicate-d1", duplicateD1Config), "infra/wrangler.toml", "DUPLICATE_CONFIG_TABLE");
      },
    },
    {
      name: "shadowed-r2-binding",
      execute() {
        expectFailure(createCompleteFixtureRoot("shadowed-r2", shadowedR2Config), "infra/wrangler.toml", "DUPLICATE_CONFIG_TABLE");
      },
    },
    {
      name: "main-symlink-escape",
      execute() {
        expectFailure(createMainSymlinkEscapeFixture(), "infra/wrangler.toml", "PATH_ESCAPE");
      },
    },
    {
      name: "migrations-symlink-escape",
      execute() {
        expectFailure(createMigrationsSymlinkEscapeFixture(), "infra/wrangler.toml", "PATH_ESCAPE");
      },
    },
    {
      name: "missing-markdown-text-rule",
      execute() {
        expectFailure(createCompleteFixtureRoot("missing-markdown-rule", missingMarkdownRuleConfig), "infra/wrangler.toml", "MISSING_CONFIG_TABLE");
      },
    },
    {
      name: "wrong-markdown-text-rule-type",
      execute() {
        expectFailure(createCompleteFixtureRoot("wrong-markdown-rule-type", wrongMarkdownRuleTypeConfig), "infra/wrangler.toml", "UNSAFE_CONFIG_VALUE");
      },
    },
    {
      name: "wrong-markdown-text-rule-glob",
      execute() {
        expectFailure(createCompleteFixtureRoot("wrong-markdown-rule-glob", wrongMarkdownRuleGlobConfig), "infra/wrangler.toml", "UNSAFE_CONFIG_VALUE");
      },
    },
    {
      name: "wrong-markdown-text-rule-fallthrough",
      execute() {
        expectFailure(createCompleteFixtureRoot("wrong-markdown-rule-fallthrough", wrongMarkdownRuleFallthroughConfig), "infra/wrangler.toml", "UNSAFE_CONFIG_VALUE");
      },
    },
    {
      name: "duplicate-markdown-text-rule",
      execute() {
        expectFailure(createCompleteFixtureRoot("duplicate-markdown-rule", duplicateMarkdownRuleConfig), "infra/wrangler.toml", "DUPLICATE_CONFIG_TABLE");
      },
    },
  ];
  const failedCases = [];
  for (const testCase of cases) {
    try {
      testCase.execute();
    } catch {
      failedCases.push(testCase.name);
    }
  }
  assert.deepEqual(failedCases, []);
  assert.equal(cases.length, 13);

  process.stdout.write(`${JSON.stringify({
    tool: "node",
    package: "infra",
    suite: "wrangler-scaffold-static-contract",
    version: process.version,
    duration_ms: Math.round(performance.now() - startedAt),
    status: "pass",
    reproduce,
    cases_executed: cases.map(({ name }) => name),
    temporary_space_fixtures_retained: true,
  })}\n`);
} catch (error) {
  const details = error instanceof ScaffoldValidationError
    ? { code: error.code, detail: error.message }
    : { code: "ASSERTION_FAILED", detail: "One or more validator contract cases failed." };
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
