import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  EnvironmentValidationError,
  findControlBytes,
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

/**
 * Deploy-time variable references as they appear in the TOML. These are TOML
 * content, not JavaScript template placeholders — the `${…}` is exactly the
 * text the topology must carry so a literal resource id can never be committed.
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: TOML deploy-time reference, not a JS template.
const STAGING_ID_REFERENCE = "${ASIMP_D1_DATABASE_ID_STAGING}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: TOML deploy-time reference, not a JS template.
const PRODUCTION_ID_REFERENCE = "${ASIMP_D1_DATABASE_ID_PRODUCTION}";

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
      expectFailure(
        "unknown-role",
        inSection(baseline, "staging", `role = "private-cas"`, `role = "cache"`),
        "UNKNOWN_R2_ROLE",
      );
    },
  },
  {
    name: "public-bucket-shared-across-environments",
    execute() {
      expectFailure(
        "shared-public-bucket",
        inSection(
          baseline,
          "staging",
          `bucket_name = "asimposium-public-staging"`,
          `bucket_name = "asimposium-public-prod"`,
        ),
        "SHARED_RESOURCE",
      );
    },
  },
  {
    name: "private-bucket-shared-across-environments",
    execute() {
      expectFailure(
        "shared-private-bucket",
        inSection(
          baseline,
          "staging",
          `bucket_name = "asimposium-artifacts-staging"`,
          `bucket_name = "asimposium-artifacts-prod"`,
        ),
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
        inSection(
          baseline,
          "staging",
          `custom_domain = "artifacts-staging.asimposium.org"`,
          `custom_domain = "artifacts.asimposium.org"`,
        ),
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
        inSection(
          baseline,
          "local",
          `custom_domain = ""\n\n[env.local.durable_objects]`,
          `custom_domain = "artifacts-staging.asimposium.org"\n\n[env.local.durable_objects]`,
        ),
        "SHARED_RESOURCE",
      );
    },
  },
  {
    name: "production-does-not-publish-the-artifact-hostname",
    execute() {
      expectFailure(
        "prod-wrong-hostname",
        inSection(
          baseline,
          "production",
          `custom_domain = "artifacts.asimposium.org"`,
          `custom_domain = "cdn.example.org"`,
        ),
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
        inSection(
          baseline,
          "staging",
          `database_name = "asimposium-staging"`,
          `database_name = "asimposium-prod"`,
        ),
        "SHARED_RESOURCE",
      );
    },
  },
  {
    name: "shared-d1-database-id",
    execute() {
      expectFailure(
        "shared-d1-id",
        inSection(baseline, "staging", STAGING_ID_REFERENCE, PRODUCTION_ID_REFERENCE),
        "SHARED_RESOURCE",
      );
    },
  },
  {
    name: "shared-durable-object-namespace",
    execute() {
      expectFailure(
        "shared-do",
        inSection(
          baseline,
          "staging",
          `script_namespace = "asimposium-stoa-staging"`,
          `script_namespace = "asimposium-stoa-prod"`,
        ),
        "SHARED_RESOURCE",
      );
    },
  },

  // --- binding parity by role ----------------------------------------------
  {
    name: "r2-binding-name-differs-for-the-same-role",
    execute() {
      // Caught by the per-environment binding roster before cross-environment
      // parity is reached. That is the sharper error: the Worker's contract is
      // an exact binding set, and a renamed binding breaks it on its own,
      // independently of what any other environment declares.
      expectFailure(
        "parity-r2",
        inSection(baseline, "staging", `binding = "PUBLIC_ARTIFACTS"`, `binding = "PUBLIC_BUCKET"`),
        "BINDING_SET_MISMATCH",
      );
    },
  },
  {
    name: "d1-binding-name-differs",
    execute() {
      expectFailure(
        "parity-d1",
        inSection(baseline, "local", `binding = "DB"`, `binding = "DATABASE"`),
        "BINDING_SET_MISMATCH",
      );
    },
  },
  {
    name: "a-missing-required-binding-is-refused",
    execute() {
      // Dropping the public-delivery bucket entirely: the roster notices the
      // absent PUBLIC_ARTIFACTS even though the remaining shape is coherent.
      const withoutPublic = baseline.replace(
        `[[env.production.r2]]\nbinding = "PUBLIC_ARTIFACTS"\nrole = "public-delivery"\nbucket_name = "asimposium-public-prod"\ncustom_domain = "artifacts.asimposium.org"\n\n`,
        "",
      );
      expectFailure("missing-binding", withoutPublic, "MISSING_R2_ROLE");
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
        inSection(
          baseline,
          "staging",
          "may_hold_production_keys = false",
          "may_hold_production_keys = true",
        ),
        "PRODUCTION_KEYS_OUTSIDE_PRODUCTION",
      );
    },
  },
  {
    name: "local-permitted-to-hold-production-keys",
    execute() {
      expectFailure(
        "local-prod-keys",
        inSection(
          baseline,
          "local",
          "may_hold_production_keys = false",
          "may_hold_production_keys = true",
        ),
        "PRODUCTION_KEYS_OUTSIDE_PRODUCTION",
      );
    },
  },
  {
    name: "production-signing-key-reused-in-staging",
    execute() {
      expectFailure(
        "shared-kid",
        inSection(
          baseline,
          "staging",
          `current_kid = "staging-2026-08"`,
          `current_kid = "prod-2026-08"`,
        ),
        "SHARED_RESOURCE",
      );
    },
  },
  {
    name: "kid-overlap-is-not-an-overlap",
    execute() {
      expectFailure(
        "kid-same",
        inSection(
          baseline,
          "production",
          `previous_kid = "prod-2026-07"`,
          `previous_kid = "prod-2026-08"`,
        ),
        "KID_OVERLAP_INVALID",
      );
    },
  },
  {
    name: "production-allows-destructive-operations",
    execute() {
      expectFailure(
        "prod-destructive",
        inSection(
          baseline,
          "production",
          "destructive_operations_allowed = false",
          "destructive_operations_allowed = true",
        ),
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
        inSection(
          baseline,
          "staging",
          STAGING_ID_REFERENCE,
          "3f2a91c4-77bd-4c0e-9a11-5be2c0d41f88",
        ),
        "LITERAL_RESOURCE_ID",
      );
    },
  },
  {
    name: "local-must-use-the-zero-sentinel",
    execute() {
      expectFailure(
        "local-nonzero",
        inSection(
          baseline,
          "local",
          `database_id = "00000000-0000-0000-0000-000000000000"`,
          `database_id = "${"$"}{ASIMP_LOCAL}"`,
        ),
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
      expectFailure(
        "token",
        `${baseline}\n# asimp_ag_abcdef0123456789\n`,
        "CREDENTIAL_IN_REPOSITORY",
      );
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
      expectFailure(
        "no-staging",
        baseline.slice(0, start) + baseline.slice(end),
        "MISSING_ENVIRONMENT",
      );
    },
  },
  {
    name: "unsupported-schema-version",
    execute() {
      expectFailure(
        "schema",
        baseline.replace("schema_version = 1", "schema_version = 2"),
        "UNSUPPORTED_SCHEMA",
      );
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

  // --- path containment (parent audit) --------------------------------------
  {
    name: "config-path-traversal-is-refused",
    execute() {
      const root = withTopology("traversal", baseline);
      for (const candidate of ["../outside.toml", "../../etc/passwd", "infra/../../outside.toml"]) {
        try {
          validateEnvironments(root, candidate);
          assert.fail(`expected PATH_ESCAPE for ${candidate}`);
        } catch (error) {
          assert.equal(error.code, "PATH_ESCAPE", candidate);
        }
      }
    },
  },
  {
    name: "absolute-config-path-is-refused",
    execute() {
      try {
        validateEnvironments(withTopology("abs", baseline), "/etc/passwd");
        assert.fail("expected PATH_ESCAPE");
      } catch (error) {
        assert.equal(error.code, "PATH_ESCAPE");
      }
    },
  },
  {
    name: "symlinked-config-file-escaping-the-root-is-refused",
    execute() {
      const root = withTopology("symlink-file", baseline);
      const outside = join(space, "outside-topology");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "environments.toml"), baseline, "utf8");
      symlinkSync(join(outside, "environments.toml"), join(root, "infra/linked.toml"), "file");
      try {
        validateEnvironments(root, "infra/linked.toml");
        assert.fail("expected PATH_ESCAPE");
      } catch (error) {
        assert.equal(error.code, "PATH_ESCAPE");
      }
    },
  },
  {
    name: "symlinked-directory-escaping-the-root-is-refused",
    execute() {
      const root = withTopology("symlink-dir", baseline);
      const outside = join(space, "outside-dir");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "environments.toml"), baseline, "utf8");
      symlinkSync(outside, join(root, "linkdir"), "dir");
      try {
        validateEnvironments(root, "linkdir/environments.toml");
        assert.fail("expected PATH_ESCAPE");
      } catch (error) {
        assert.equal(error.code, "PATH_ESCAPE");
      }
    },
  },
  {
    name: "a-symlink-that-stays-inside-the-root-is-not-over-blocked",
    execute() {
      const root = withTopology("symlink-inside", baseline);
      symlinkSync(join(root, "infra/environments.toml"), join(root, "infra/alias.toml"), "file");
      const report = validateEnvironments(root, "infra/alias.toml");
      assert.equal(report.environments.production.d1_binding, "DB");
    },
  },

  // --- closed tables: a shadow field must not be silently ignored -----------
  {
    name: "unknown-keys-are-refused-at-every-level",
    execute() {
      const insertions = [
        ["root", baseline.replace("schema_version = 1", "schema_version = 1\nshadow_root = true")],
        [
          "policy",
          baseline.replace(
            `rollback_policy = "forward-only"`,
            `rollback_policy = "forward-only"\nshadow_policy = 1`,
          ),
        ],
        [
          "env",
          inSection(baseline, "staging", 'kind = "remote"', 'kind = "remote"\nshadow_env = 1'),
        ],
        [
          "d1",
          inSection(
            baseline,
            "staging",
            `database_name = "asimposium-staging"`,
            `database_name = "asimposium-staging"\nshadow_d1 = 1`,
          ),
        ],
        [
          "r2",
          inSection(
            baseline,
            "staging",
            `bucket_name = "asimposium-artifacts-staging"`,
            `bucket_name = "asimposium-artifacts-staging"\ncustom_domian = "typo.example.org"`,
          ),
        ],
        [
          "durable_objects",
          inSection(
            baseline,
            "staging",
            `class_name = "HeraldRoom"`,
            `class_name = "HeraldRoom"\nshadow_do = 1`,
          ),
        ],
        [
          "keys",
          inSection(
            baseline,
            "staging",
            `current_kid = "staging-2026-08"`,
            `current_kid = "staging-2026-08"\nshadow_key = 1`,
          ),
        ],
      ];
      for (const [level, toml] of insertions) {
        expectFailure(`shadow-${level}`, toml, "UNKNOWN_CONFIG_KEY");
      }
    },
  },

  // --- the destructive flag must be reported, not merely stored -------------
  {
    name: "destructive-flag-is-returned-for-callers-to-consume",
    execute() {
      const report = validateEnvironments(repositoryRoot);
      assert.equal(report.environments.local.destructive_operations_allowed, true);
      assert.equal(report.environments.staging.destructive_operations_allowed, true);
      assert.equal(report.environments.production.destructive_operations_allowed, false);
      assert.equal(report.environments.production.may_hold_production_keys, true);
      assert.equal(report.environments.staging.may_hold_production_keys, false);
    },
  },

  // --- service-envelope keys (Fable §14.1) ---------------------------------
  {
    name: "service-envelope-key-must-not-double-as-a-signing-key",
    execute() {
      expectFailure(
        "key-role-collision",
        inSection(
          baseline,
          "staging",
          `service_envelope_current_kid = "staging-svc-2026-08"`,
          `service_envelope_current_kid = "staging-2026-08"`,
        ),
        "KEY_ROLE_COLLISION",
      );
    },
  },
  {
    name: "service-envelope-kid-overlap-must-be-a-real-overlap",
    execute() {
      expectFailure(
        "svc-kid-same",
        inSection(
          baseline,
          "production",
          `service_envelope_previous_kid = "prod-svc-2026-07"`,
          `service_envelope_previous_kid = "prod-svc-2026-08"`,
        ),
        "KID_OVERLAP_INVALID",
      );
    },
  },
  {
    name: "service-envelope-kid-must-not-be-shared-across-environments",
    execute() {
      expectFailure(
        "svc-kid-shared",
        inSection(
          baseline,
          "staging",
          `service_envelope_current_kid = "staging-svc-2026-08"`,
          `service_envelope_current_kid = "prod-svc-2026-08"`,
        ),
        "SHARED_RESOURCE",
      );
    },
  },
  {
    name: "service-envelope-key-ids-are-reported",
    execute() {
      const report = validateEnvironments(repositoryRoot);
      assert.deepEqual(report.environments.production.service_envelope_key_ids, [
        "prod-svc-2026-08",
        "prod-svc-2026-07",
      ]);
      assert.deepEqual(report.environments.local.service_envelope_key_ids, ["local-svc-1"]);
    },
  },

  // --- worker origins -------------------------------------------------------
  {
    name: "remote-worker-origin-must-be-https",
    execute() {
      expectFailure(
        "http-remote",
        inSection(
          baseline,
          "staging",
          `worker_origin = "https://a-staging.asimposium.org"`,
          `worker_origin = "http://a-staging.asimposium.org"`,
        ),
        "UNSAFE_CONFIG_VALUE",
      );
    },
  },
  {
    name: "two-environments-must-not-share-a-worker-origin",
    execute() {
      expectFailure(
        "shared-origin",
        inSection(
          baseline,
          "staging",
          `worker_origin = "https://a-staging.asimposium.org"`,
          `worker_origin = "https://a.asimposium.org"`,
        ),
        "SHARED_RESOURCE",
      );
    },
  },

  // --- Vercel preview wiring (ADR-2) ---------------------------------------
  {
    name: "vercel-preview-must-not-target-production",
    execute() {
      expectFailure(
        "preview-to-prod",
        baseline.replace(`preview_environment = "staging"`, `preview_environment = "production"`),
        "PREVIEW_TARGETS_PRODUCTION",
      );
    },
  },
  {
    name: "vercel-preview-must-name-a-preview-tier",
    execute() {
      expectFailure(
        "preview-not-preview",
        baseline.replace(`preview_environment = "staging"`, `preview_environment = "local"`),
        "VERCEL_WIRING_INVALID",
      );
    },
  },
  {
    name: "vercel-production-must-be-production",
    execute() {
      expectFailure(
        "prod-target",
        baseline.replace(
          `production_environment = "production"`,
          `production_environment = "staging"`,
        ),
        "VERCEL_WIRING_INVALID",
      );
    },
  },
  {
    name: "vercel-must-name-known-environments",
    execute() {
      expectFailure(
        "unknown-target",
        baseline.replace(`preview_environment = "staging"`, `preview_environment = "nowhere"`),
        "UNKNOWN_ENVIRONMENT",
      );
    },
  },
  {
    name: "vercel-wiring-is-reported",
    execute() {
      const report = validateEnvironments(repositoryRoot);
      assert.deepEqual(report.vercel, {
        production_environment: "production",
        preview_environment: "staging",
      });
      // The value a Vercel preview deployment would actually be given.
      assert.equal(
        report.environments[report.vercel.preview_environment].worker_origin,
        "https://a-staging.asimposium.org",
      );
    },
  },

  // --- control bytes (parent finding) --------------------------------------
  {
    name: "a-nul-byte-anywhere-in-the-config-is-refused",
    execute() {
      // A NUL truncates strings in a lot of downstream tooling, so a value can
      // read as one thing to a validator and another to its consumer.
      expectFailure(
        "nul-in-comment",
        `${baseline}\n# trailing\u0000byte\n`,
        "CONTROL_BYTE_IN_CONFIG",
      );
      expectFailure(
        "nul-in-bucket-name",
        inSection(
          baseline,
          "staging",
          `bucket_name = "asimposium-artifacts-staging"`,
          `bucket_name = "asimposium-artifacts-staging\u0000-decoy"`,
        ),
        "CONTROL_BYTE_IN_CONFIG",
      );
      expectFailure(
        "nul-in-kid",
        inSection(
          baseline,
          "production",
          `current_kid = "prod-2026-08"`,
          `current_kid = "prod-2026-08\u0000"`,
        ),
        "CONTROL_BYTE_IN_CONFIG",
      );
      expectFailure(
        "nul-in-database-id",
        inSection(baseline, "staging", STAGING_ID_REFERENCE, `${STAGING_ID_REFERENCE}\u0000`),
        "CONTROL_BYTE_IN_CONFIG",
      );
    },
  },
  {
    name: "other-control-bytes-are-refused-but-tab-newline-and-cr-are-not",
    execute() {
      for (const [label, byte] of [
        ["BEL", "\u0007"],
        ["backspace", "\u0008"],
        ["vertical tab", "\u000b"],
        ["form feed", "\u000c"],
        ["ESC", "\u001b"],
        ["DEL", "\u007f"],
      ]) {
        expectFailure(`control-${label}`, `${baseline}\n# ${byte}\n`, "CONTROL_BYTE_IN_CONFIG");
      }
      // The three a TOML file legitimately needs must still parse.
      const withWhitespace = `${baseline}\n#\ttabbed comment\r\n`;
      const root = withTopology("legal-whitespace", withWhitespace);
      assert.equal(validateEnvironments(root).config, "infra/environments.toml");
    },
  },
  {
    name: "the-control-byte-refusal-does-not-echo-the-surrounding-bytes",
    execute() {
      const poisoned = inSection(
        baseline,
        "staging",
        `bucket_name = "asimposium-artifacts-staging"`,
        `bucket_name = "asimposium-artifacts-staging\u0000smuggled-value"`,
      );
      const root = withTopology("no-echo", poisoned);
      try {
        validateEnvironments(root);
        assert.fail("expected CONTROL_BYTE_IN_CONFIG");
      } catch (error) {
        assert.equal(error.code, "CONTROL_BYTE_IN_CONFIG");
        // The neighbourhood of a control byte is where a smuggled value sits.
        assert.equal(error.message.includes("smuggled-value"), false, error.message);
        assert.equal(error.message.includes("\u0000"), false);
        assert.match(error.message, /U\+0000/);
      }
    },
  },
  {
    name: "no-infra-source-or-config-file-contains-a-control-byte",
    execute() {
      // The check that would have caught the NUL that reached
      // validate-environments.mjs and turned it into `data` for file(1) and git.
      const infraDirectory = join(repositoryRoot, "infra");
      const offenders = [];
      for (const entry of readdirSync(infraDirectory)) {
        if (!/\.(mjs|toml)$/.test(entry)) continue;
        const found = findControlBytes(readFileSync(join(infraDirectory, entry), "utf8"));
        if (found.length > 0) {
          offenders.push(`${entry}@${found[0].offset}`);
        }
      }
      for (const entry of readdirSync(join(infraDirectory, "environments"))) {
        const found = findControlBytes(
          readFileSync(join(infraDirectory, "environments", entry), "utf8"),
        );
        if (found.length > 0) offenders.push(`environments/${entry}@${found[0].offset}`);
      }
      assert.deepEqual(offenders, []);
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
