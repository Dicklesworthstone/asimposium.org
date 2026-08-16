import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { renderAll } from "./generate-wrangler.mjs";
import {
  assertStagingTemplate,
  canonicalServiceEnvelopeKeys,
  DeployResolutionError,
  parseResolverArguments,
  publishResolvedStagingArtifact,
  readStagingDeployInputs,
  requireGeneratedStagingTemplate,
  requireStagingPublicDeliveryBucket,
  resolutionDiagnostic,
  resolveStagingArtifact,
  STAGING_D1_INPUT,
  STAGING_OUTPUT_PATH,
  STAGING_SERVICE_KEYS_INPUT,
} from "./resolve-wrangler-deploy.mjs";
import { validateEnvironments } from "./validate-environments.mjs";

/**
 * Staging deploy-resolution contract.
 *
 * The fixtures are retained under the system temporary directory: this suite
 * never removes files, invokes Wrangler, reaches a provider, or writes the
 * repository's ignored deploy-resolved location. Each plant changes one
 * resolver input or filesystem shape while preserving the others.
 */

const startedAt = performance.now();
const reproduce = "bun infra/resolve-wrangler-deploy.test.mjs";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const space = mkdtempSync(join(tmpdir(), "asimposium-staging-resolution-"));
const topology = readFileSync(join(repositoryRoot, "infra/environments.toml"), "utf8");
const productionOverlay = readFileSync(
  join(repositoryRoot, "infra/environments/production.deploy.wrangler.toml"),
  "utf8",
);

const d1DatabaseId = "11111111-2222-4333-8444-555555555555";
const expectedKids = ["staging-svc-2026-08", "staging-svc-2026-07"];
const keyRecords = [
  { kid: expectedKids[0], publicKeyHex: "1".repeat(64), notBefore: 200 },
  { kid: expectedKids[1], publicKeyHex: "2".repeat(64), notBefore: 100, notAfter: 250 },
];
const keyInput = JSON.stringify(keyRecords);
const forbiddenPrivateField = ["private", "KeyHex"].join("");
const forbiddenSecretField = ["sec", "ret"].join("");

function mkdir(path) {
  mkdirSync(path, { recursive: true });
}

function fixture(name) {
  const root = join(space, name);
  mkdir(join(root, "infra/environments"));
  mkdir(join(root, "apps/wire/src"));
  // The topology validator inspects this AST solely for bound DO exports.
  writeFileSync(
    join(root, "apps/wire/src/index.ts"),
    "export class KraterOutboxDrainer {}\n",
    "utf8",
  );
  writeFileSync(join(root, "infra/environments.toml"), topology, "utf8");
  writeFileSync(
    join(root, "infra/environments/production.deploy.wrangler.toml"),
    productionOverlay,
    "utf8",
  );
  const files = renderAll(validateEnvironments(root));
  writeFileSync(
    join(root, "infra/environments/staging.wrangler.toml"),
    files["infra/environments/staging.wrangler.toml"],
    "utf8",
  );
  return root;
}

function inputs(overrides = {}) {
  return {
    d1DatabaseId,
    serviceEnvelopeKeys: keyInput,
    ...overrides,
  };
}

function expectCode(execute, code) {
  assert.throws(execute, (error) => {
    assert.ok(error instanceof DeployResolutionError);
    assert.equal(error.code, code);
    return true;
  });
}

function parseTrustedJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    assert.fail("resolver emitted invalid JSON in a trusted test fixture");
  }
}

function parsedArtifact(root) {
  return Bun.TOML.parse(resolveStagingArtifact(root, inputs()));
}

function stagingTemplateGate(name) {
  const root = fixture(name);
  const report = validateEnvironments(root);
  return {
    report,
    contents: readFileSync(join(root, "infra/environments/staging.wrangler.toml"), "utf8"),
  };
}

function stagingReport() {
  return validateEnvironments(repositoryRoot).environments.staging;
}

const cases = [
  {
    name: "staging-resolution-is-deterministic-and-uses-only-the-declared-inputs",
    execute() {
      const root = fixture("deterministic");
      const environment = {
        [STAGING_D1_INPUT]: d1DatabaseId,
        [STAGING_SERVICE_KEYS_INPUT]: JSON.stringify([...keyRecords].reverse(), null, 2),
        STOA_ORIGIN: "https://ambient.example.invalid",
        ASIMP_STAGING_ROUTE: "r2.example.invalid",
        ASIMP_STAGING_R2_ORIGIN: "https://ambient-r2.example.invalid",
      };
      const loaded = readStagingDeployInputs(environment);
      assert.deepEqual(loaded, {
        d1DatabaseId,
        serviceEnvelopeKeys: environment[STAGING_SERVICE_KEYS_INPUT],
      });
      const fromAmbient = resolveStagingArtifact(root, loaded);
      const canonical = resolveStagingArtifact(root, inputs());
      assert.equal(fromAmbient, canonical);
      assert.equal(fromAmbient.includes("ambient.example.invalid"), false);
      assert.equal(fromAmbient.includes("ambient-r2.example.invalid"), false);
      assert.equal(fromAmbient.includes("r2.example.invalid"), false);
    },
  },
  {
    name: "resolved-staging-route-follows-worker-origin-not-r2-and-preserves-deferred-herald",
    execute() {
      const root = fixture("topology-projection");
      const config = parsedArtifact(root);
      assert.deepEqual(config.routes, [
        { pattern: "a-staging.asimposium.org", custom_domain: true },
      ]);
      assert.notEqual(config.routes[0].pattern, "artifacts-staging.asimposium.org");
      assert.equal(config.d1_databases[0].database_id, d1DatabaseId);
      assert.equal(config.vars.STOA_ORIGIN, "https://a-staging.asimposium.org");
      assert.deepEqual(
        parseTrustedJson(config.vars.SERVICE_ENVELOPE_KEYS).map((record) => record.kid),
        expectedKids,
      );
      assert.deepEqual(config.r2_buckets, [
        { binding: "ARTIFACTS", bucket_name: "asimposium-artifacts-staging" },
        { binding: "PUBLIC_ARTIFACTS", bucket_name: "asimposium-public-staging" },
      ]);
      const durableBindings = config.durable_objects?.bindings ?? [];
      assert.equal(
        durableBindings.some((binding) => binding.name === "HERALD_ROOMS"),
        false,
      );
    },
  },
  {
    name: "canonical-public-keyring-is-runtime-valid-and-order-independent",
    execute() {
      const staging = stagingReport();
      assert.equal(
        canonicalServiceEnvelopeKeys(JSON.stringify([...keyRecords].reverse()), staging),
        canonicalServiceEnvelopeKeys(JSON.stringify(keyRecords), staging),
      );
      assert.deepEqual(
        parseTrustedJson(
          canonicalServiceEnvelopeKeys(JSON.stringify([...keyRecords].reverse()), staging),
        ),
        keyRecords,
      );
    },
  },
  {
    name: "PLANTED-non-preview-staging-topology-is-refused-by-the-template-gate",
    execute() {
      const { report, contents } = stagingTemplateGate("topology-invalid");
      const planted = structuredClone(report);
      planted.environments.staging.is_preview = false;
      expectCode(() => assertStagingTemplate(planted, contents), "STAGING_TOPOLOGY_INVALID");
    },
  },
  {
    name: "PLANTED-foreign-staging-d1-reference-is-refused-by-the-template-gate",
    execute() {
      const { report, contents } = stagingTemplateGate("d1-reference-invalid");
      const planted = contents.replace(
        "$" + "{ASIMP_D1_DATABASE_ID_STAGING}",
        "$" + "{ASIMP_D1_DATABASE_ID_FOREIGN}",
      );
      expectCode(() => assertStagingTemplate(report, planted), "STAGING_D1_REFERENCE_INVALID");
    },
  },
  {
    name: "PLANTED-non-topology-staging-origin-is-refused-by-the-template-gate",
    execute() {
      const { report, contents } = stagingTemplateGate("origin-invalid");
      const planted = contents.replace(
        'STOA_ORIGIN = "https://a-staging.asimposium.org"',
        'STOA_ORIGIN = "https://wrong-staging.asimposium.org"',
      );
      expectCode(() => assertStagingTemplate(report, planted), "STAGING_ORIGIN_INVALID");
    },
  },
  {
    name: "PLANTED-non-topology-staging-r2-bucket-is-refused-by-the-template-gate",
    execute() {
      const { report, contents } = stagingTemplateGate("r2-invalid");
      const planted = contents.replace(
        'bucket_name = "asimposium-public-staging"',
        'bucket_name = "asimposium-public-foreign"',
      );
      expectCode(() => assertStagingTemplate(report, planted), "STAGING_R2_INVALID");
    },
  },
  {
    name: "PLANTED-route-in-generated-staging-template-is-refused",
    execute() {
      const { report, contents } = stagingTemplateGate("template-route");
      const planted = contents.replace(
        "workers_dev = false\n",
        'workers_dev = false\nroutes = [{ pattern = "wrong.example", custom_domain = true }]\n',
      );
      expectCode(() => assertStagingTemplate(report, planted), "STAGING_TEMPLATE_HAS_ROUTE");
    },
  },
  {
    name: "PLANTED-deferred-herald-binding-in-staging-template-is-refused",
    execute() {
      const { report, contents } = stagingTemplateGate("deferred-binding");
      const planted = contents.replace(
        "[vars]\n",
        '[[durable_objects.bindings]]\nname = "HERALD_ROOMS"\nclass_name = "HeraldRoom"\n\n[vars]\n',
      );
      expectCode(() => assertStagingTemplate(report, planted), "STAGING_DEFERRED_BINDING_PRESENT");
    },
  },
  {
    name: "PLANTED-missing-generated-staging-template-is-refused",
    execute() {
      expectCode(() => requireGeneratedStagingTemplate({}), "GENERATED_STAGING_CONFIG_MISSING");
    },
  },
  {
    name: "PLANTED-missing-renamed-public-delivery-role-fails-closed",
    execute() {
      const staging = structuredClone(stagingReport());
      staging.r2.find((bucket) => bucket.role === "public-delivery").role = "renamed-delivery";
      expectCode(
        () => requireStagingPublicDeliveryBucket(staging),
        "RESOLVED_STAGING_CONFIG_INVALID",
      );
    },
  },
  {
    name: "PLANTED-empty-public-delivery-domain-fails-closed",
    execute() {
      const staging = structuredClone(stagingReport());
      staging.r2.find((bucket) => bucket.role === "public-delivery").custom_domain = "";
      expectCode(
        () => requireStagingPublicDeliveryBucket(staging),
        "RESOLVED_STAGING_CONFIG_INVALID",
      );
    },
  },
  {
    name: "PLANTED-whitespace-public-delivery-domain-fails-closed",
    execute() {
      const staging = structuredClone(stagingReport());
      staging.r2.find((bucket) => bucket.role === "public-delivery").custom_domain =
        " artifacts-staging.asimposium.org ";
      expectCode(
        () => requireStagingPublicDeliveryBucket(staging),
        "RESOLVED_STAGING_CONFIG_INVALID",
      );
    },
  },
  {
    name: "PLANTED-malformed-public-delivery-domain-fails-closed",
    execute() {
      const staging = structuredClone(stagingReport());
      staging.r2.find((bucket) => bucket.role === "public-delivery").custom_domain =
        "artifacts_staging.asimposium.org";
      expectCode(
        () => requireStagingPublicDeliveryBucket(staging),
        "RESOLVED_STAGING_CONFIG_INVALID",
      );
    },
  },
  {
    name: "PLANTED-foreign-canonical-public-delivery-domain-fails-closed",
    execute() {
      const staging = structuredClone(stagingReport());
      staging.r2.find((bucket) => bucket.role === "public-delivery").custom_domain =
        "artifacts-other.asimposium.org";
      expectCode(
        () => requireStagingPublicDeliveryBucket(staging),
        "RESOLVED_STAGING_CONFIG_INVALID",
      );
    },
  },
  {
    name: "PLANTED-worker-public-delivery-domain-collision-fails-closed",
    execute() {
      const staging = structuredClone(stagingReport());
      staging.r2.find((bucket) => bucket.role === "public-delivery").custom_domain =
        "a-staging.asimposium.org";
      expectCode(
        () => requireStagingPublicDeliveryBucket(staging),
        "RESOLVED_STAGING_CONFIG_INVALID",
      );
    },
  },
  {
    name: "PLANTED-local-production-and-unknown-environments-are-refused",
    execute() {
      for (const environment of ["local", "production", "unknown", "staging "]) {
        expectCode(
          () => parseResolverArguments(["--env", environment, "--check"]),
          "STAGING_ENVIRONMENT_REQUIRED",
        );
      }
      expectCode(() => parseResolverArguments(["--env", "staging"]), "INVALID_ARGUMENT");
    },
  },
  {
    name: "PLANTED-nil-noncanonical-and-secret-shaped-d1-identifiers-are-refused-without-echo",
    execute() {
      const root = fixture("invalid-d1");
      for (const invalid of [
        "00000000-0000-0000-0000-000000000000",
        "11111111-2222-4333-8444-55555555555A",
        "asimp_ag_sensitive-value",
      ]) {
        try {
          resolveStagingArtifact(root, inputs({ d1DatabaseId: invalid }));
          assert.fail("expected D1 refusal");
        } catch (error) {
          assert.ok(error instanceof DeployResolutionError);
          assert.equal(error.code, "STAGING_D1_ID_INVALID");
          assert.equal(error.message.includes(invalid), false);
        }
      }
    },
  },
  {
    name: "PLANTED-missing-service-envelope-keyring-is-refused",
    execute() {
      expectCode(
        () => canonicalServiceEnvelopeKeys("", stagingReport()),
        "SERVICE_ENVELOPE_KEYS_MISSING",
      );
    },
  },
  {
    name: "PLANTED-extra-service-envelope-key-field-is-refused",
    execute() {
      expectCode(
        () =>
          canonicalServiceEnvelopeKeys(
            JSON.stringify([{ ...keyRecords[0], comment: "unsupported" }, keyRecords[1]]),
            stagingReport(),
          ),
        "SERVICE_ENVELOPE_KEYS_INVALID",
      );
    },
  },
  {
    name: "PLANTED-foreign-service-envelope-kid-is-refused",
    execute() {
      expectCode(
        () =>
          canonicalServiceEnvelopeKeys(
            JSON.stringify([{ ...keyRecords[0], kid: "foreign-svc" }, keyRecords[1]]),
            stagingReport(),
          ),
        "SERVICE_ENVELOPE_KEYS_INVALID",
      );
    },
  },
  {
    name: "PLANTED-duplicate-service-envelope-kid-is-refused",
    execute() {
      expectCode(
        () =>
          canonicalServiceEnvelopeKeys(
            JSON.stringify([keyRecords[0], { ...keyRecords[1], kid: keyRecords[0].kid }]),
            stagingReport(),
          ),
        "SERVICE_ENVELOPE_KEYS_INVALID",
      );
    },
  },
  {
    name: "PLANTED-invalid-current-and-rotation-window-shape-is-refused",
    execute() {
      expectCode(
        () =>
          canonicalServiceEnvelopeKeys(
            JSON.stringify([{ ...keyRecords[0], notAfter: 300 }, keyRecords[1]]),
            stagingReport(),
          ),
        "SERVICE_ENVELOPE_KEYS_INVALID",
      );
    },
  },
  {
    name: "PLANTED-exclusive-end-equal-to-current-start-has-no-overlap-and-is-refused",
    execute() {
      expectCode(
        () =>
          canonicalServiceEnvelopeKeys(
            JSON.stringify([
              keyRecords[0],
              { ...keyRecords[1], notAfter: keyRecords[0].notBefore },
            ]),
            stagingReport(),
          ),
        "SERVICE_ENVELOPE_KEYS_INVALID",
      );
    },
  },
  {
    name: "PLANTED-rotation-gap-before-current-start-is-refused",
    execute() {
      expectCode(
        () =>
          canonicalServiceEnvelopeKeys(
            JSON.stringify([
              keyRecords[0],
              { ...keyRecords[1], notAfter: keyRecords[0].notBefore - 1 },
            ]),
            stagingReport(),
          ),
        "SERVICE_ENVELOPE_KEYS_INVALID",
      );
    },
  },
  {
    name: "PLANTED-nonpositive-service-envelope-validity-window-is-refused",
    execute() {
      expectCode(
        () =>
          canonicalServiceEnvelopeKeys(
            JSON.stringify([
              keyRecords[0],
              { ...keyRecords[1], notAfter: keyRecords[1].notBefore },
            ]),
            stagingReport(),
          ),
        "SERVICE_ENVELOPE_KEYS_INVALID",
      );
    },
  },
  {
    name: "PLANTED-invalid-staging-service-kid-declaration-is-refused",
    execute() {
      const staging = structuredClone(stagingReport());
      staging.service_envelope_key_ids = [expectedKids[0]];
      expectCode(
        () => canonicalServiceEnvelopeKeys(keyInput, staging),
        "STAGING_SERVICE_KIDS_INVALID",
      );
    },
  },
  {
    name: "PLANTED-private-secret-missing-record-and-oversized-keyrings-are-refused",
    execute() {
      const root = fixture("invalid-keyring");
      const variants = [
        JSON.stringify([
          { ...keyRecords[0], [forbiddenPrivateField]: "3".repeat(64) },
          keyRecords[1],
        ]),
        JSON.stringify([
          { ...keyRecords[0], [forbiddenSecretField]: "not-allowed" },
          keyRecords[1],
        ]),
        JSON.stringify([keyRecords[0]]),
      ];
      for (const value of variants) {
        expectCode(
          () => resolveStagingArtifact(root, inputs({ serviceEnvelopeKeys: value })),
          "SERVICE_ENVELOPE_KEYS_INVALID",
        );
      }
      expectCode(
        () => resolveStagingArtifact(root, inputs({ serviceEnvelopeKeys: "[".repeat(2_049) })),
        "SERVICE_ENVELOPE_KEYS_TOO_LARGE",
      );
    },
  },
  {
    name: "PLANTED-generated-staging-byte-drift-is-refused-before-resolution",
    execute() {
      const root = fixture("generated-drift");
      const path = join(root, "infra/environments/staging.wrangler.toml");
      writeFileSync(path, `${readFileSync(path, "utf8")}# drift\n`, "utf8");
      expectCode(() => resolveStagingArtifact(root, inputs()), "GENERATED_STAGING_CONFIG_DRIFT");
    },
  },
  {
    name: "exclusive-publication-is-idempotent-never-replaces-and-preserves-production-overlay-bytes",
    execute() {
      const root = fixture("publication");
      const beforeOverlay = readFileSync(
        join(root, "infra/environments/production.deploy.wrangler.toml"),
        "utf8",
      );
      const resolved = resolveStagingArtifact(root, inputs());
      assert.deepEqual(publishResolvedStagingArtifact(root, resolved), {
        published: true,
        idempotent: false,
      });
      assert.equal(readFileSync(join(root, STAGING_OUTPUT_PATH), "utf8"), resolved);
      assert.deepEqual(publishResolvedStagingArtifact(root, resolved), {
        published: false,
        idempotent: true,
      });
      assert.equal(
        readFileSync(join(root, "infra/environments/production.deploy.wrangler.toml"), "utf8"),
        beforeOverlay,
      );

      const differentRoot = fixture("publication-different");
      mkdir(join(differentRoot, "infra/deploy-resolved"));
      writeFileSync(join(differentRoot, STAGING_OUTPUT_PATH), "different", "utf8");
      expectCode(
        () =>
          publishResolvedStagingArtifact(
            differentRoot,
            resolveStagingArtifact(differentRoot, inputs()),
          ),
        "OUTPUT_ARTIFACT_EXISTS_DIFFERENT",
      );
      assert.equal(readFileSync(join(differentRoot, STAGING_OUTPUT_PATH), "utf8"), "different");
    },
  },
  {
    name: "PLANTED-symlinked-parent-and-artifact-are-refused-without-following",
    execute() {
      const parentRoot = fixture("symlink-parent");
      const outside = join(space, "outside-parent");
      mkdir(outside);
      symlinkSync(outside, join(parentRoot, "infra/deploy-resolved"));
      expectCode(
        () =>
          publishResolvedStagingArtifact(parentRoot, resolveStagingArtifact(parentRoot, inputs())),
        "OUTPUT_PATH_UNSAFE",
      );

      const artifactRoot = fixture("symlink-artifact");
      const outputParent = join(artifactRoot, "infra/deploy-resolved");
      const target = join(space, "artifact-target.toml");
      mkdir(outputParent);
      writeFileSync(target, "target", "utf8");
      symlinkSync(target, join(outputParent, "staging.wrangler.toml"));
      expectCode(
        () =>
          publishResolvedStagingArtifact(
            artifactRoot,
            resolveStagingArtifact(artifactRoot, inputs()),
          ),
        "OUTPUT_ARTIFACT_UNSAFE",
      );
      assert.equal(readFileSync(target, "utf8"), "target");

      // `existsSync` follows links, so a dangling link is the easy near-miss:
      // it must still be refused as an unsafe artifact rather than treated as
      // an empty slot an exclusive writer may claim.
      const danglingRoot = fixture("dangling-symlink-artifact");
      const danglingParent = join(danglingRoot, "infra/deploy-resolved");
      mkdir(danglingParent);
      symlinkSync(
        join(space, "does-not-exist.toml"),
        join(danglingParent, "staging.wrangler.toml"),
      );
      expectCode(
        () =>
          publishResolvedStagingArtifact(
            danglingRoot,
            resolveStagingArtifact(danglingRoot, inputs()),
          ),
        "OUTPUT_ARTIFACT_UNSAFE",
      );
    },
  },
  {
    name: "PLANTED-output-parent-escape-is-refused-before-any-bytes-are-written",
    execute() {
      const root = fixture("publication-parent-race");
      // Both paths live beneath the suite's one temporary directory, so this
      // rename stays on one filesystem while moving the held parent outside
      // the fixture repository.
      const escapedParent = join(space, "publication-parent-race-escaped-parent");
      const resolved = resolveStagingArtifact(root, inputs());
      let reported;
      expectCode(() => {
        reported = publishResolvedStagingArtifact(root, resolved, {
          beforeWrite({ outputParent }) {
            renameSync(outputParent, escapedParent);
          },
        });
      }, "OUTPUT_PATH_CHANGED");
      assert.equal(reported, undefined);
      const escapedArtifact = join(escapedParent, "staging.wrangler.toml");
      assert.equal(existsSync(escapedArtifact), true);
      assert.equal(readFileSync(escapedArtifact).byteLength, 0);
    },
  },
  {
    name: "resolution-does-not-use-network-or-commands-or-create-the-repository-artifact",
    execute() {
      const root = fixture("no-network");
      const originalFetch = globalThis.fetch;
      const originalSpawn = Bun.spawn;
      let commandCalls = 0;
      globalThis.fetch = () => {
        throw new Error("network use is forbidden");
      };
      Bun.spawn = () => {
        commandCalls += 1;
        throw new Error("command use is forbidden");
      };
      try {
        assert.equal(typeof resolveStagingArtifact(root, inputs()), "string");
      } finally {
        globalThis.fetch = originalFetch;
        Bun.spawn = originalSpawn;
      }
      assert.equal(commandCalls, 0);
      assert.equal(existsSync(join(repositoryRoot, STAGING_OUTPUT_PATH)), false);
    },
  },
  {
    name: "machine-diagnostics-disclose-names-and-codes-not-inputs-or-paths",
    execute() {
      const diagnostic = resolutionDiagnostic("fail", 0, {
        code: "STAGING_D1_ID_INVALID",
      });
      assert.deepEqual(Object.keys(diagnostic).sort(), [
        "code",
        "duration_ms",
        "environment",
        "package",
        "status",
        "suite",
        "tool",
        "version",
      ]);
      assert.equal(JSON.stringify(diagnostic).includes(d1DatabaseId), false);
      assert.equal(JSON.stringify(diagnostic).includes(STAGING_OUTPUT_PATH), false);
      assert.equal(
        JSON.stringify(diagnostic).includes("ASIMP_STAGING_SERVICE_ENVELOPE_KEYS"),
        false,
      );
    },
  },
];

const results = [];
for (const testCase of cases) {
  testCase.execute();
  results.push(testCase.name);
}

process.stdout.write(
  `${JSON.stringify({
    tool: "bun",
    package: "infra",
    suite: "staging-wrangler-deploy-resolution",
    status: "pass",
    cases: results.length,
    reproduce,
    duration_ms: Math.round(performance.now() - startedAt),
  })}\n`,
);
