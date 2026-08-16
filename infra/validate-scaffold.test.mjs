import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { ScaffoldValidationError, validateScaffold } from "./validate-scaffold.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const startedAt = performance.now();
const reproduce = "bun infra/validate-scaffold.test.mjs";
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

[[r2_buckets]]
binding = "PUBLIC_ARTIFACTS"
bucket_name = "asimposium-public-local"

[[durable_objects.bindings]]
name = "KRATER_OUTBOX"
class_name = "KraterOutboxDrainer"

[exports.KraterOutboxDrainer]
type = "durable-object"
storage = "sqlite"

[triggers]
crons = ["*/5 * * * *"]

[[rules]]
type = "Text"
globs = ["**/*.md", "**/*.txt", "**/*.schema.json"]
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
  writeFixtureFile(
    root,
    "apps/wire/package.json",
    JSON.stringify({ devDependencies: { wrangler: "4.123.0" } }),
  );
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

function createMissingMigrationsFixture() {
  const root = join(temporaryFixtureRoot, "missing-migrations");
  mkdirSync(join(root, "infra"), { recursive: true });
  mkdirSync(join(root, "apps", "wire", "src"), { recursive: true });
  writeFileSync(join(root, "apps", "wire", "src", "index.ts"), "export default {};\n", "utf8");
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

function expectFailure(root, configWorkspacePath, expectedCode, expectedDetail) {
  try {
    validateScaffold(root, configWorkspacePath);
    assert.fail(`expected ${expectedCode}`);
  } catch (error) {
    assert.ok(error instanceof ScaffoldValidationError);
    assert.equal(error.code, expectedCode);
    if (expectedDetail !== undefined) {
      assert.equal(error.message.includes(expectedDetail), true);
    }
    assert.equal(error.message.includes("/Users/"), false);
    assert.equal(/(?:^|\s)\/(?:private|tmp|var)\//.test(error.message), false);
  }
}

try {
  const duplicateD1Config = validConfig.replace(
    "[[r2_buckets]]",
    '[[d1_databases]]\nbinding = "DB_SHADOW"\ndatabase_name = "conflicting-local"\ndatabase_id = "00000000-0000-0000-0000-000000000000"\nmigrations_dir = "../db/migrations"\n\n[[r2_buckets]]',
  );
  const shadowedR2Config = validConfig.replace(
    "[[r2_buckets]]",
    '[r2_buckets]\nbinding = "ARTIFACTS_SHADOW"\nbucket_name = "conflicting-local"\n\n[[r2_buckets]]',
  );
  const missingPublicR2Config = validConfig.replace(
    '\n[[r2_buckets]]\nbinding = "PUBLIC_ARTIFACTS"\nbucket_name = "asimposium-public-local"\n',
    "\n",
  );
  const wrongPublicR2BindingConfig = validConfig.replace(
    'binding = "PUBLIC_ARTIFACTS"',
    'binding = "ARTIFACTS"',
  );
  const aliasedPublicR2BucketConfig = validConfig.replace(
    'bucket_name = "asimposium-public-local"',
    'bucket_name = "asimposium-artifacts-local"',
  );
  const missingMarkdownRuleConfig = validConfig.replace(
    '\n[[rules]]\ntype = "Text"\nglobs = ["**/*.md", "**/*.txt", "**/*.schema.json"]\nfallthrough = true\n',
    "\n",
  );
  const wrongMarkdownRuleTypeConfig = validConfig.replace('type = "Text"', 'type = "Data"');
  const wrongMarkdownRuleGlobConfig = validConfig.replace(
    'globs = ["**/*.md", "**/*.txt", "**/*.schema.json"]',
    'globs = ["**/*.md"]',
  );
  const wrongMarkdownRuleFallthroughConfig = validConfig.replace(
    "fallthrough = true",
    "fallthrough = false",
  );
  const shadowedMarkdownRuleConfig = validConfig.replace("[[rules]]", "[rules]");
  const duplicateMarkdownRuleConfig = `${validConfig}
[[rules]]
type = "Text"
globs = ["**/*.md", "**/*.txt", "**/*.schema.json"]
fallthrough = true
`;
  const commentSuffixedDuplicateD1Config = validConfig.replace(
    "[[r2_buckets]]",
    "[[d1_databases]] # shadow\n\n[[r2_buckets]]",
  );
  const commentSuffixedDuplicateR2Config = validConfig.replace(
    "[[rules]]",
    "[[r2_buckets]] # shadow\n\n[[rules]]",
  );
  const commentSuffixedDuplicateRulesConfig = `${validConfig}
[[rules]] # shadow
`;
  const malformedTomlConfig = validConfig.replace("workers_dev = false", "workers_dev = [");
  const duplicateScalarConfig = validConfig.replace(
    'name = "asimposium-stoa-local"',
    'name = "asimposium-stoa-local"\nname = "asimposium-stoa-local"',
  );
  const unknownRootKeyConfig = validConfig.replace(
    "[dev]",
    'unexpected_root_key = "value"\n\n[dev]',
  );
  const unknownRootTableConfig = `${validConfig}
[unexpected_root_table]
value = "value"
`;
  const extraDevKeyConfig = validConfig.replace(
    'local_protocol = "http"',
    'local_protocol = "http"\nextra_dev_key = true',
  );
  const nestedRulesTableConfig = `${validConfig}
[rules.shadow]
value = "value"
`;
  const nestedRulesArrayConfig = `${validConfig}
[[rules.shadow]]
value = "value"
`;
  const extraD1KeyConfig = validConfig.replace(
    'migrations_dir = "../db/migrations"',
    'migrations_dir = "../db/migrations"\nextra_d1_key = "value"',
  );
  const extraR2KeyConfig = validConfig.replace(
    'bucket_name = "asimposium-artifacts-local"',
    'bucket_name = "asimposium-artifacts-local"\nextra_r2_key = "value"',
  );
  const extraRulesKeyConfig = validConfig.replace(
    "fallthrough = true",
    'fallthrough = true\nextra_rules_key = "value"',
  );
  const extraCompatibilityFlagConfig = validConfig.replace(
    'compatibility_flags = ["nodejs_compat"]',
    'compatibility_flags = ["nodejs_compat", "additional_flag"]',
  );
  const wrongOutboxBindingConfig = validConfig.replace(
    'name = "KRATER_OUTBOX"',
    'name = "OUTBOX_SHADOW"',
  );
  const wrongOutboxStorageConfig = validConfig.replace('storage = "sqlite"', 'storage = "memory"');
  const missingOutboxCronConfig = validConfig.replace(
    '\n[triggers]\ncrons = ["*/5 * * * *"]\n',
    "\n",
  );
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
      name: "missing-required-migrations-target",
      execute() {
        expectFailure(
          createMissingMigrationsFixture(),
          "infra/wrangler.toml",
          "MISSING_REQUIRED_TARGET",
        );
      },
    },
    {
      name: "duplicate-d1-binding",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("duplicate-d1", duplicateD1Config),
          "infra/wrangler.toml",
          "DUPLICATE_CONFIG_TABLE",
        );
      },
    },
    {
      name: "shadowed-r2-binding",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("shadowed-r2", shadowedR2Config),
          "infra/wrangler.toml",
          "MALFORMED_TOML",
        );
      },
    },
    {
      name: "missing-public-r2-binding",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("missing-public-r2", missingPublicR2Config),
          "infra/wrangler.toml",
          "MISSING_CONFIG_TABLE",
        );
      },
    },
    {
      name: "wrong-public-r2-binding",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("wrong-public-r2-binding", wrongPublicR2BindingConfig),
          "infra/wrangler.toml",
          "UNSAFE_CONFIG_VALUE",
        );
      },
    },
    {
      name: "aliased-public-r2-bucket",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("aliased-public-r2", aliasedPublicR2BucketConfig),
          "infra/wrangler.toml",
          "UNSAFE_CONFIG_VALUE",
        );
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
        expectFailure(
          createCompleteFixtureRoot("missing-markdown-rule", missingMarkdownRuleConfig),
          "infra/wrangler.toml",
          "MISSING_CONFIG_TABLE",
        );
      },
    },
    {
      name: "wrong-markdown-text-rule-type",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("wrong-markdown-rule-type", wrongMarkdownRuleTypeConfig),
          "infra/wrangler.toml",
          "UNSAFE_CONFIG_VALUE",
        );
      },
    },
    {
      name: "wrong-markdown-text-rule-glob",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("wrong-markdown-rule-glob", wrongMarkdownRuleGlobConfig),
          "infra/wrangler.toml",
          "UNSAFE_CONFIG_VALUE",
        );
      },
    },
    {
      name: "wrong-markdown-text-rule-fallthrough",
      execute() {
        expectFailure(
          createCompleteFixtureRoot(
            "wrong-markdown-rule-fallthrough",
            wrongMarkdownRuleFallthroughConfig,
          ),
          "infra/wrangler.toml",
          "UNSAFE_CONFIG_VALUE",
        );
      },
    },
    {
      name: "shadowed-markdown-text-rule",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("shadowed-markdown-rule", shadowedMarkdownRuleConfig),
          "infra/wrangler.toml",
          "UNSAFE_CONFIG_TABLE",
        );
      },
    },
    {
      name: "duplicate-markdown-text-rule",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("duplicate-markdown-rule", duplicateMarkdownRuleConfig),
          "infra/wrangler.toml",
          "DUPLICATE_CONFIG_TABLE",
        );
      },
    },
    {
      name: "comment-suffixed-duplicate-d1-binding",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("comment-duplicate-d1", commentSuffixedDuplicateD1Config),
          "infra/wrangler.toml",
          "DUPLICATE_CONFIG_TABLE",
        );
      },
    },
    {
      name: "comment-suffixed-duplicate-r2-binding",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("comment-duplicate-r2", commentSuffixedDuplicateR2Config),
          "infra/wrangler.toml",
          "DUPLICATE_CONFIG_TABLE",
        );
      },
    },
    {
      name: "comment-suffixed-duplicate-markdown-rule",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("comment-duplicate-rules", commentSuffixedDuplicateRulesConfig),
          "infra/wrangler.toml",
          "DUPLICATE_CONFIG_TABLE",
        );
      },
    },
    {
      name: "malformed-toml",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("malformed-toml", malformedTomlConfig),
          "infra/wrangler.toml",
          "MALFORMED_TOML",
        );
      },
    },
    {
      name: "duplicate-scalar-key",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("duplicate-scalar", duplicateScalarConfig),
          "infra/wrangler.toml",
          "MALFORMED_TOML",
        );
      },
    },
    {
      name: "unknown-root-key",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("unknown-root-key", unknownRootKeyConfig),
          "infra/wrangler.toml",
          "UNSAFE_CONFIG_KEY",
          "root contains unsupported configuration key",
        );
      },
    },
    {
      name: "unknown-root-table",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("unknown-root-table", unknownRootTableConfig),
          "infra/wrangler.toml",
          "UNSAFE_CONFIG_KEY",
        );
      },
    },
    {
      name: "extra-dev-key",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("extra-dev-key", extraDevKeyConfig),
          "infra/wrangler.toml",
          "UNSAFE_CONFIG_KEY",
        );
      },
    },
    {
      name: "nested-rules-table",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("nested-rules-table", nestedRulesTableConfig),
          "infra/wrangler.toml",
          "UNSAFE_CONFIG_KEY",
        );
      },
    },
    {
      name: "nested-rules-array",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("nested-rules-array", nestedRulesArrayConfig),
          "infra/wrangler.toml",
          "UNSAFE_CONFIG_KEY",
        );
      },
    },
    {
      name: "extra-d1-key",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("extra-d1-key", extraD1KeyConfig),
          "infra/wrangler.toml",
          "UNSAFE_CONFIG_KEY",
        );
      },
    },
    {
      name: "extra-r2-key",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("extra-r2-key", extraR2KeyConfig),
          "infra/wrangler.toml",
          "UNSAFE_CONFIG_KEY",
        );
      },
    },
    {
      name: "extra-rules-key",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("extra-rules-key", extraRulesKeyConfig),
          "infra/wrangler.toml",
          "UNSAFE_CONFIG_KEY",
        );
      },
    },
    {
      name: "extra-compatibility-flag",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("extra-compatibility-flag", extraCompatibilityFlagConfig),
          "infra/wrangler.toml",
          "UNSAFE_CONFIG_VALUE",
        );
      },
    },
    {
      name: "wrong-outbox-binding",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("wrong-outbox-binding", wrongOutboxBindingConfig),
          "infra/wrangler.toml",
          "UNSAFE_CONFIG_VALUE",
        );
      },
    },
    {
      name: "wrong-outbox-storage",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("wrong-outbox-storage", wrongOutboxStorageConfig),
          "infra/wrangler.toml",
          "UNSAFE_CONFIG_VALUE",
        );
      },
    },
    {
      name: "missing-outbox-cron",
      execute() {
        expectFailure(
          createCompleteFixtureRoot("missing-outbox-cron", missingOutboxCronConfig),
          "infra/wrangler.toml",
          "MISSING_CONFIG_TABLE",
        );
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
  if (failedCases.length > 0) {
    throw new ScaffoldValidationError(
      "CONTRACT_CASES_FAILED",
      `Validator contract cases failed: ${failedCases.join(", ")}.`,
    );
  }
  assert.deepEqual(failedCases, []);
  assert.equal(cases.length, 35);

  process.stdout.write(
    `${JSON.stringify({
      tool: "bun",
      package: "infra",
      suite: "wrangler-scaffold-static-contract",
      version: Bun.version,
      duration_ms: Math.round(performance.now() - startedAt),
      status: "pass",
      reproduce,
      cases_executed: cases.map(({ name }) => name),
      temporary_space_fixtures_retained: true,
    })}\n`,
  );
} catch (error) {
  const details =
    error instanceof ScaffoldValidationError
      ? { code: error.code, detail: error.message }
      : { code: "ASSERTION_FAILED", detail: "One or more validator contract cases failed." };
  process.stderr.write(
    `${JSON.stringify({
      tool: "bun",
      package: "infra",
      suite: "wrangler-scaffold-static-contract",
      version: Bun.version,
      duration_ms: Math.round(performance.now() - startedAt),
      status: "fail",
      reproduce,
      ...details,
    })}\n`,
  );
  process.exitCode = 1;
}
