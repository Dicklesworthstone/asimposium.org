import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  EnvironmentValidationError,
  selectEnvironment,
  validateEnvironments,
} from "./validate-environments.mjs";

/**
 * Negative corpus for the environment topology validator.
 *
 * Every case mutates the committed topology into a specific mistake and asserts
 * the specific refusal. Fixtures are written to a fresh temporary directory and
 * are never deleted, so a failing run can be inspected afterwards.
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const startedAt = performance.now();
const reproduce = "bun infra/validate-environments.test.mjs";
const space = mkdtempSync(join(tmpdir(), "asimposium-environments-"));
const baseline = readFileSync(join(repositoryRoot, "infra/environments.toml"), "utf8");

/** Write a mutated topology into its own root and validate it there. */
function withTopology(name, toml) {
  const root = join(space, name);
  mkdirSync(join(root, "infra"), { recursive: true });
  writeFileSync(join(root, "infra/environments.toml"), toml, "utf8");
  return root;
}

function expectFailure(name, toml, expectedCode) {
  const root = withTopology(name, toml);
  try {
    validateEnvironments(root);
    assert.fail(`${name}: expected ${expectedCode}, but the topology was accepted`);
  } catch (error) {
    assert.ok(error instanceof EnvironmentValidationError, `${name}: unexpected ${error}`);
    assert.equal(error.code, expectedCode, `${name}: ${error.message}`);
    // A refusal must never disclose the operator's filesystem.
    assert.equal(/(?:^|\s)\/(?:Users|home|private|tmp|var)\//.test(error.message), false, name);
  }
}

/**
 * Replace a value inside one environment's block without touching the others.
 *
 * A block runs from its top-level `[env.<name>]` header to the next top-level
 * environment header, so it includes that environment's sub-tables
 * (`[env.<name>.d1]`, `[[env.<name>.r2]]`, …) and nothing belonging to a
 * sibling. Matching on `[env.` alone would stop at the first sub-table.
 */
const TOP_LEVEL_ENV_HEADER = /^\[env\.[a-z][a-z0-9_-]*\]$/gm;

function inSection(toml, section, from, to) {
  const headers = [...toml.matchAll(TOP_LEVEL_ENV_HEADER)];
  const index = headers.findIndex((match) => match[0] === `[env.${section}]`);
  assert.ok(index >= 0, `section ${section} not found`);
  const start = headers[index].index;
  const end = index + 1 < headers.length ? headers[index + 1].index : toml.length;
  const body = toml.slice(start, end);
  assert.ok(body.includes(from), `"${from}" not found in [env.${section}]`);
  return toml.slice(0, start) + body.replace(from, to) + toml.slice(end);
}

const cases = [
  {
    name: "positive",
    execute() {
      const report = validateEnvironments(repositoryRoot);
      assert.deepEqual(Object.keys(report.environments).sort(), ["local", "production", "staging"]);
      assert.equal(report.environments.production.published_hostname, "artifacts.asimposium.org");
      assert.equal(report.environments.staging.is_preview, true);
      assert.equal(report.policy.rollback_policy, "forward-only");
    },
  },
  {
    name: "positive-mutated-baseline-still-parses",
    execute() {
      // Guards the mutation helper itself: an unmutated copy must still pass,
      // otherwise every negative below could be passing for the wrong reason.
      const root = withTopology("untouched", baseline);
      const report = validateEnvironments(root);
      assert.equal(report.environments.production.d1_binding, "DB");
    },
  },

  // --- R2 role and publication rules ---------------------------------------
  {
    name: "private-bucket-with-custom-domain",
    execute() {
      expectFailure(
        "private-published",
        baseline.replace(
          `binding = "ARTIFACTS"\nrole = "private-cas"\nbucket_name = "asimposium-artifacts-prod"\ncustom_domain = ""`,
          `binding = "ARTIFACTS"\nrole = "private-cas"\nbucket_name = "asimposium-artifacts-prod"\ncustom_domain = "cas.asimposium.org"`,
        ),
        "PRIVATE_BUCKET_PUBLISHED",
      );
    },
  },
  {
    name: "missing-public-delivery-role",
    execute() {
      const withoutPublic = baseline.replace(
        `[[env.staging.r2]]\nbinding = "PUBLIC_ARTIFACTS"\nrole = "public-delivery"\nbucket_name = "asimposium-public-staging"\ncustom_domain = "artifacts-staging.asimposium.org"\n\n`,
        "",
      );
      expectFailure("no-public-role", withoutPublic, "MISSING_R2_ROLE");
    },
  },
  {
    name: "duplicate-r2-role",
    execute() {
      const duplicated = baseline.replace(
        `[env.staging.durable_objects]`,
        `[[env.staging.r2]]\nbinding = "EXTRA"\nrole = "private-cas"\nbucket_name = "asimposium-extra-staging"\ncustom_domain = ""\n\n[env.staging.durable_objects]`,
      );
      expectFailure("dup-role", duplicated, "DUPLICATE_R2_ROLE");
    },
  },
  {
    name: "unknown-r2-role",
    execute() {
      expectFailure("unknown-role", inSection(baseline, "staging", `role = "private-cas"`, `role = "cache"`), "UNKNOWN_R2_ROLE");
    },
  },
  {
    name: "public-bucket-shared-across-environments",
    execute() {
      expectFailure(
        "shared-public-bucket",
        inSection(baseline, "staging", `bucket_name = "asimposium-public-staging"`, `bucket_name = "asimposium-public-prod"`),
        "SHARED_RESOURCE",
      );
    },
  },
  {
    name: "private-bucket-shared-across-environments",
    execute() {
      expectFailure(
        "shared-private-bucket",
        inSection(baseline, "staging", `bucket_name = "asimposium-artifacts-staging"`, `bucket_name = "asimposium-artifacts-prod"`),
        "SHARED_RESOURCE",
      );
    },
  },
  {
    name: "staging-claims-the-production-artifact-hostname",
    execute() {
      // Refused by the hostname rule rather than the shared-resource registry:
      // staging is validated before production, so the specific rule ("that
      // hostname belongs to production") fires first. The specific message is
      // the better one to surface, so this pins that ordering deliberately.
      expectFailure(
        "staging-claims-apex",
        inSection(baseline, "staging", `custom_domain = "artifacts-staging.asimposium.org"`, `custom_domain = "artifacts.asimposium.org"`),
        "ARTIFACT_HOSTNAME_MISMATCH",
      );
    },
  },
  {
    name: "two-environments-share-one-public-hostname",
    execute() {
      // Neither is the apex, so this reaches the shared-resource registry: one
      // hostname can only ever route to one bucket.
      expectFailure(
        "shared-hostname",
        inSection(baseline, "local", `custom_domain = ""\n\n[env.local.durable_objects]`, `custom_domain = "artifacts-staging.asimposium.org"\n\n[env.local.durable_objects]`),
        "SHARED_RESOURCE",
      );
    },
  },
  {
    name: "production-does-not-publish-the-artifact-hostname",
    execute() {
      expectFailure(
        "prod-wrong-hostname",
        inSection(baseline, "production", `custom_domain = "artifacts.asimposium.org"`, `custom_domain = "cdn.example.org"`),
        "ARTIFACT_HOSTNAME_MISMATCH",
      );
    },
  },

  // --- namespace separation -------------------------------------------------
  {
    name: "shared-d1-database-name",
    execute() {
      expectFailure(
        "shared-d1-name",
        inSection(baseline, "staging", `database_name = "asimposium-staging"`, `database_name = "asimposium-prod"`),
        "SHARED_RESOURCE",
      );
    },
  },
  {
    name: "shared-d1-database-id",
    execute() {
      expectFailure(
        "shared-d1-id",
        inSection(baseline, "staging", "${ASIMP_D1_DATABASE_ID_STAGING}", "${ASIMP_D1_DATABASE_ID_PRODUCTION}"),
        "SHARED_RESOURCE",
      );
    },
  },
  {
    name: "shared-durable-object-namespace",
    execute() {
      expectFailure(
        "shared-do",
        inSection(baseline, "staging", `script_namespace = "asimposium-stoa-staging"`, `script_namespace = "asimposium-stoa-prod"`),
        "SHARED_RESOURCE",
      );
    },
  },

  // --- binding parity by role ----------------------------------------------
  {
    name: "r2-binding-name-differs-for-the-same-role",
    execute() {
      expectFailure(
        "parity-r2",
        inSection(baseline, "staging", `binding = "PUBLIC_ARTIFACTS"`, `binding = "PUBLIC_BUCKET"`),
        "BINDING_PARITY_MISMATCH",
      );
    },
  },
  {
    name: "d1-binding-name-differs",
    execute() {
      expectFailure("parity-d1", inSection(baseline, "local", `binding = "DB"`, `binding = "DATABASE"`), "BINDING_PARITY_MISMATCH");
    },
  },
  {
    name: "durable-object-class-differs",
    execute() {
      expectFailure(
        "parity-do-class",
        inSection(baseline, "staging", `class_name = "HeraldRoom"`, `class_name = "HeraldRoomV2"`),
        "BINDING_PARITY_MISMATCH",
      );
    },
  },

  // --- keys, preview restrictions, production guards ------------------------
  {
    name: "preview-permitted-to-hold-production-keys",
    execute() {
      expectFailure(
        "preview-prod-keys",
        inSection(baseline, "staging", "may_hold_production_keys = false", "may_hold_production_keys = true"),
        "PRODUCTION_KEYS_OUTSIDE_PRODUCTION",
      );
    },
  },
  {
    name: "local-permitted-to-hold-production-keys",
    execute() {
      expectFailure(
        "local-prod-keys",
        inSection(baseline, "local", "may_hold_production_keys = false", "may_hold_production_keys = true"),
        "PRODUCTION_KEYS_OUTSIDE_PRODUCTION",
      );
    },
  },
  {
    name: "production-signing-key-reused-in-staging",
    execute() {
      expectFailure(
        "shared-kid",
        inSection(baseline, "staging", `current_kid = "staging-2026-08"`, `current_kid = "prod-2026-08"`),
        "SHARED_RESOURCE",
      );
    },
  },
  {
    name: "kid-overlap-is-not-an-overlap",
    execute() {
      expectFailure(
        "kid-same",
        inSection(baseline, "production", `previous_kid = "prod-2026-07"`, `previous_kid = "prod-2026-08"`),
        "KID_OVERLAP_INVALID",
      );
    },
  },
  {
    name: "production-allows-destructive-operations",
    execute() {
      expectFailure(
        "prod-destructive",
        inSection(baseline, "production", "destructive_operations_allowed = false", "destructive_operations_allowed = true"),
        "PRODUCTION_DESTRUCTIVE_ALLOWED",
      );
    },
  },

  // --- credentials and literal ids -----------------------------------------
  {
    name: "literal-database-id-committed",
    execute() {
      expectFailure(
        "literal-id",
        inSection(baseline, "staging", "${ASIMP_D1_DATABASE_ID_STAGING}", "3f2a91c4-77bd-4c0e-9a11-5be2c0d41f88"),
        "LITERAL_RESOURCE_ID",
      );
    },
  },
  {
    name: "local-must-use-the-zero-sentinel",
    execute() {
      expectFailure(
        "local-nonzero",
        inSection(baseline, "local", `database_id = "00000000-0000-0000-0000-000000000000"`, `database_id = "${"$"}{ASIMP_LOCAL}"`),
        "UNSAFE_CONFIG_VALUE",
      );
    },
  },
  {
    name: "pem-block-in-topology",
    execute() {
      expectFailure(
        "pem",
        `${baseline}\n# -----BEGIN PRIVATE KEY-----\n`,
        "CREDENTIAL_IN_REPOSITORY",
      );
    },
  },
  {
    name: "bearer-token-in-topology",
    execute() {
      expectFailure("token", `${baseline}\n# asimp_ag_abcdef0123456789\n`, "CREDENTIAL_IN_REPOSITORY");
    },
  },
  {
    name: "long-hex-secret-in-topology",
    execute() {
      expectFailure("hex", `${baseline}\n# ${"a1b2c3d4".repeat(9)}\n`, "CREDENTIAL_IN_REPOSITORY");
    },
  },

  // --- structural ----------------------------------------------------------
  {
    name: "missing-environment",
    execute() {
      const start = baseline.indexOf("[env.staging]");
      const end = baseline.indexOf("[env.production]");
      expectFailure("no-staging", baseline.slice(0, start) + baseline.slice(end), "MISSING_ENVIRONMENT");
    },
  },
  {
    name: "unsupported-schema-version",
    execute() {
      expectFailure("schema", baseline.replace("schema_version = 1", "schema_version = 2"), "UNSUPPORTED_SCHEMA");
    },
  },
  {
    name: "rollback-policy-other-than-forward-only",
    execute() {
      expectFailure(
        "rollback",
        baseline.replace(`rollback_policy = "forward-only"`, `rollback_policy = "down-migrations"`),
        "UNSAFE_ROLLBACK_POLICY",
      );
    },
  },
  {
    name: "malformed-toml",
    execute() {
      expectFailure("bad-toml", "schema_version = \nnot toml [[[", "MALFORMED_TOML");
    },
  },
  {
    name: "missing-config-file",
    execute() {
      const root = join(space, "empty-root");
      mkdirSync(root, { recursive: true });
      try {
        validateEnvironments(root);
        assert.fail("expected MISSING_CONFIG_FILE");
      } catch (error) {
        assert.equal(error.code, "MISSING_CONFIG_FILE");
      }
    },
  },

  // --- explicit environment selection --------------------------------------
  {
    name: "environment-selection-is-explicit",
    execute() {
      const report = validateEnvironments(repositoryRoot);
      for (const missing of [undefined, ""]) {
        try {
          selectEnvironment(report, missing);
          assert.fail("expected ENVIRONMENT_NOT_SELECTED");
        } catch (error) {
          assert.equal(error.code, "ENVIRONMENT_NOT_SELECTED");
        }
      }
      try {
        selectEnvironment(report, "prod");
        assert.fail("expected UNKNOWN_ENVIRONMENT");
      } catch (error) {
        assert.equal(error.code, "UNKNOWN_ENVIRONMENT");
      }
      assert.equal(selectEnvironment(report, "staging").is_preview, true);
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
      suite: "environment-topology-contract",
      version: Bun.version,
      duration_ms: Math.round(performance.now() - startedAt),
      status: "pass",
      reproduce,
      cases_executed: cases.map(({ name }) => name),
      temporary_space_fixtures_retained: true,
    })}\n`,
  );
} else {
  process.stderr.write(
    `${JSON.stringify({
      tool: "bun",
      package: "infra",
      suite: "environment-topology-contract",
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
