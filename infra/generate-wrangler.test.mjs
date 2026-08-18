import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  DEPLOY_OVERLAY_NAME,
  durableObjectParity,
  GENERATED_DIRECTORY,
  reconcile,
  renderAll,
  renderEnvironment,
  stoaOriginProjection,
} from "./generate-wrangler.mjs";
import { validateEnvironments } from "./validate-environments.mjs";

/**
 * Generated-configuration contract.
 *
 * The point of generation is that `environments.toml` stops being decorative:
 * every rule the topology validator enforces must survive into the Wrangler
 * configuration a deploy would actually read. So this suite does not merely
 * diff strings — it parses the generated TOML back and reconciles it field by
 * field against the topology.
 *
 * Nothing here creates a remote resource, runs Wrangler, or deploys.
 */

const startedAt = performance.now();
const reproduce = "bun infra/generate-wrangler.test.mjs";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const space = mkdtempSync(join(tmpdir(), "asimposium-generated-"));
const report = validateEnvironments(repositoryRoot);
const files = renderAll(report);

const parsed = Object.fromEntries(
  Object.entries(files).map(([path, contents]) => [
    path.replace(`${GENERATED_DIRECTORY}/`, "").replace(".wrangler.toml", ""),
    Bun.TOML.parse(contents),
  ]),
);

const cases = [
  {
    name: "generation-is-deterministic",
    execute() {
      assert.deepEqual(renderAll(validateEnvironments(repositoryRoot)), files);
      // No timestamp, no nonce, nothing that changes when nothing changed.
      for (const contents of Object.values(files)) {
        assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:/.test(contents), false);
      }
    },
  },
  {
    name: "one-config-per-declared-environment",
    execute() {
      assert.deepEqual(Object.keys(parsed).sort(), ["local", "production", "staging"]);
    },
  },
  {
    name: "every-generated-config-is-valid-toml",
    execute() {
      for (const [name, config] of Object.entries(parsed)) {
        assert.ok(config !== null && typeof config === "object", name);
      }
    },
  },

  // --- exact reconciliation against the topology ---------------------------
  {
    name: "d1-reconciles-exactly",
    execute() {
      for (const [name, environment] of Object.entries(report.environments)) {
        const databases = parsed[name].d1_databases;
        assert.equal(databases.length, 1, name);
        assert.equal(databases[0].binding, environment.d1.binding, name);
        assert.equal(databases[0].database_name, environment.d1.database_name, name);
        assert.equal(databases[0].database_id, environment.d1.database_id, name);
        assert.equal(databases[0].migrations_dir, "../../db/migrations", name);
      }
    },
  },
  {
    name: "r2-roles-and-bindings-reconcile-exactly",
    execute() {
      for (const [name, environment] of Object.entries(report.environments)) {
        const buckets = parsed[name].r2_buckets;
        assert.equal(buckets.length, environment.r2.length, name);
        for (const declared of environment.r2) {
          const generated = buckets.find((bucket) => bucket.binding === declared.binding);
          assert.ok(generated !== undefined, `${name}: missing ${declared.binding}`);
          assert.equal(generated.bucket_name, declared.bucket_name, name);
        }
      }
    },
  },
  {
    name: "durable-object-reconciles-exactly",
    execute() {
      const deferred = new Set(report.policy.deferred_bindings);
      for (const [name, environment] of Object.entries(report.environments)) {
        const declared = [environment.durable_objects, environment.outbox];
        const emitted = declared.filter((durableObject) => !deferred.has(durableObject.binding));
        const bindings = parsed[name].durable_objects.bindings;
        assert.equal(bindings.length, emitted.length, name);
        for (const durableObject of emitted) {
          const bound = bindings.find((binding) => binding.name === durableObject.binding);
          assert.equal(bound.class_name, durableObject.class_name, name);
          // Storage comes from the topology, so a renderer that reverted to a
          // hardcoded backend would disagree with the declaration here.
          assert.deepEqual(parsed[name].exports[durableObject.class_name], {
            type: "durable-object",
            storage: durableObject.storage,
          });
        }
        assert.deepEqual(parsed[name].triggers.crons, [report.policy.outbox_cron], name);
        // A Durable Object namespace is scoped to the Worker script that owns
        // it, so the script name IS the namespace. Asserting the equality makes
        // the topology's `script_namespace` load-bearing instead of decorative:
        // rename one without the other and this fails.
        assert.equal(parsed[name].name, environment.durable_objects.script_namespace, name);
      }
    },
  },
  {
    name: "the-generated-binding-set-is-exactly-the-required-roster",
    execute() {
      for (const [name, config] of Object.entries(parsed)) {
        const bound = [
          ...config.d1_databases.map((d) => d.binding),
          ...config.r2_buckets.map((b) => b.binding),
          ...config.durable_objects.bindings.map((d) => d.name),
        ].sort();
        // A deferred binding stays in the topology roster but must not reach a
        // generated config, so the emitted roster is the required set minus it.
        const expected = report.policy.required_bindings
          .filter((binding) => !report.policy.deferred_bindings.includes(binding))
          .sort();
        assert.deepEqual(bound, expected, name);
      }
    },
  },
  {
    // Cloudflare refuses a Durable Object binding whose class the entrypoint
    // does not export. Set equality (not a count) is what makes this causal: an
    // added binding and a dropped export each fail, and in opposite directions.
    // STOA_ORIGIN is real configuration the Worker reads, not a comment. It is
    // projected from the topology so the Worker never has to ask a request what
    // origin it is serving.
    name: "stoa-origin-is-projected-from-the-declared-worker-origin",
    execute() {
      for (const [name, environment] of Object.entries(report.environments)) {
        const projected = stoaOriginProjection(parsed[name]);
        assert.equal(typeof projected, "string", name);
        assert.equal(projected, environment.worker_origin, name);
      }
    },
  },
  {
    // The planted negative, through the same reader: a projection carrying
    // another environment's origin must not survive. A swapped pair keeps both
    // values distinct, so uniqueness alone would not catch it.
    name: "PLANTED-a-foreign-origin-projection-fails-the-comparison",
    execute() {
      const origins = Object.values(report.environments).map((e) => e.worker_origin);
      for (const [name, environment] of Object.entries(report.environments)) {
        for (const foreign of origins.filter((o) => o !== environment.worker_origin)) {
          const mutated = structuredClone(parsed[name]);
          mutated.vars.STOA_ORIGIN = foreign;
          assert.notEqual(stoaOriginProjection(mutated), environment.worker_origin, name);
        }
      }
    },
  },
  {
    name: "every-emitted-durable-object-binding-has-its-export",
    execute() {
      for (const [name, config] of Object.entries(parsed)) {
        const { bound, exported } = durableObjectParity(config);
        assert.deepEqual(bound, exported, name);
      }
    },
  },
  {
    // The planted negative for the case above, through the SAME helper: strip
    // one export from a rendered config and `durableObjectParity` must stop
    // agreeing. Reimplementing the comparison here would let the positive gate
    // be weakened while this case kept passing.
    name: "PLANTED-a-binding-without-its-export-fails-the-set-equality",
    execute() {
      for (const [name, config] of Object.entries(parsed)) {
        const { bound } = durableObjectParity(config);
        assert.ok(bound.length > 0, `${name} emits no durable object to strip`);
        const stripped = structuredClone(config);
        delete stripped.exports[bound[0]];
        const mutated = durableObjectParity(stripped);
        assert.notDeepEqual(mutated.bound, mutated.exported, name);
      }
    },
  },
  {
    name: "deferred-bindings-reach-neither-the-bindings-nor-the-exports",
    execute() {
      const deferred = report.policy.deferred_bindings;
      assert.ok(deferred.length > 0, "topology declares no deferred binding to prove");
      for (const [name, environment] of Object.entries(report.environments)) {
        const declared = [environment.durable_objects, environment.outbox];
        for (const binding of deferred) {
          const durableObject = declared.find((candidate) => candidate.binding === binding);
          assert.ok(durableObject, `${name} does not declare deferred binding ${binding}`);
          assert.equal(
            parsed[name].durable_objects.bindings.some((bound) => bound.name === binding),
            false,
            name,
          );
          assert.equal(
            Object.hasOwn(parsed[name].exports ?? {}, durableObject.class_name),
            false,
            name,
          );
          // The omission is legible in the artifact, not silent.
          assert.ok(
            files[`${GENERATED_DIRECTORY}/${name}.wrangler.toml`].includes(
              `# Deferred: ${binding}`,
            ),
            name,
          );
        }
      }
    },
  },
  {
    name: "the-production-deploy-overlay-retains-outbox-recovery",
    execute() {
      const deploy = Bun.TOML.parse(
        readFileSync(
          join(repositoryRoot, "infra/environments/production.deploy.wrangler.toml"),
          "utf8",
        ),
      );
      const binding = deploy.durable_objects.bindings.find(
        (candidate) => candidate.name === report.environments.production.outbox.binding,
      );
      assert.equal(binding.class_name, report.environments.production.outbox.class_name);
      assert.deepEqual(deploy.triggers.crons, [report.policy.outbox_cron]);
      assert.deepEqual(Object.keys(deploy.triggers), ["crons"]);
      assert.deepEqual(deploy.routes, [{ pattern: "a.asimposium.org", custom_domain: true }]);
      assert.deepEqual(deploy.exports[report.environments.production.outbox.class_name], {
        type: "durable-object",
        storage: "sqlite",
      });
      assert.equal(deploy.main, parsed.production.main);
      assert.deepEqual(deploy.rules, parsed.production.rules);
      assert.equal(deploy.vars.S2_LOCAL_HARNESS, undefined);
      // The overlay is the file a production deploy actually reads, so the
      // origin projection must agree with the generated config exactly. The
      // Worker fails closed without it, and a drifted value would publish the
      // wrong origin from the one config `--check` does not reconcile.
      assert.equal(deploy.vars.STOA_ORIGIN, report.environments.production.worker_origin);
      assert.equal(deploy.vars.STOA_ORIGIN, stoaOriginProjection(parsed.production));
      // Exhaustive: the overlay may publish exactly these three non-secret
      // values and nothing else. A fourth key here is a new disclosure on the
      // deploy path, which no generated-config assertion would catch.
      // AGORA_ORIGIN is the trusted device-flow verification origin binding
      // (asimposiumorg-0yt): public, non-secret, and fail-closed at service
      // construction when absent.
      assert.equal(deploy.vars.AGORA_ORIGIN, report.environments.production.agora_origin);
      assert.deepEqual(Object.keys(deploy.vars).sort(), [
        "AGORA_ORIGIN",
        "SERVICE_ENVELOPE_KEYS",
        "STOA_ORIGIN",
      ]);
      // Public verification keys only: the signing key lives in Vercel env.
      const keyring = JSON.parse(deploy.vars.SERVICE_ENVELOPE_KEYS);
      assert.ok(Array.isArray(keyring) && keyring.length > 0);
      for (const record of keyring) {
        assert.deepEqual(Object.keys(record).sort(), ["kid", "notBefore", "publicKeyHex"]);
        assert.match(record.publicKeyHex, /^[0-9a-f]{64}$/);
      }
    },
  },
  {
    name: "the-served-text-rules-survive-generation",
    execute() {
      for (const [name, config] of Object.entries(parsed)) {
        assert.equal(config.rules.length, 1, name);
        assert.equal(config.rules[0].type, "Text", name);
        assert.deepEqual(config.rules[0].globs, ["**/*.md", "**/*.txt", "**/*.schema.json"], name);
        assert.equal(config.rules[0].fallthrough, true, name);
      }
    },
  },

  // --- the safety properties must survive into the deployable artifact -----
  {
    name: "no-generated-config-routes-a-bucket-or-exposes-a-private-one",
    execute() {
      for (const [name, config] of Object.entries(parsed)) {
        // A bucket is published by an R2 custom domain, never by a Worker
        // route: a route here would put the Worker on the blob path and could
        // expose the private bucket.
        assert.equal(config.route, undefined, name);
        assert.equal(config.routes, undefined, name);
        for (const bucket of config.r2_buckets) {
          assert.equal(bucket.custom_domain, undefined, `${name}: ${bucket.binding}`);
        }
      }
    },
  },
  {
    name: "only-production-names-the-apex-artifact-hostname",
    execute() {
      const apex = report.policy.production_artifact_hostname;
      for (const [name, contents] of Object.entries(files)) {
        const environment = name
          .replace(`${GENERATED_DIRECTORY}/`, "")
          .replace(".wrangler.toml", "");
        // The hostname appears only as a comment, and only for production.
        assert.equal(contents.includes(apex), environment === "production", environment);
      }
    },
  },
  {
    name: "no-generated-config-carries-an-account-id-or-a-literal-resource-id",
    execute() {
      for (const [name, config] of Object.entries(parsed)) {
        assert.equal(config.account_id, undefined, name);
        // `vars` is not forbidden, but it is exhaustively enumerated: the only
        // values a generated config may publish are the two non-secret origin
        // projections (Stoa self-origin and the trusted Agora origin). Anything
        // else appearing here is a new disclosure.
        assert.deepEqual(
          Object.keys(config.vars ?? {}).sort(),
          ["AGORA_ORIGIN", "STOA_ORIGIN"],
          name,
        );
        assert.equal(config.workers_dev, false, name);
        const id = config.d1_databases[0].database_id;
        const isSentinel = id === "00000000-0000-0000-0000-000000000000";
        const isReference = /^\$\{[A-Z][A-Z0-9_]*\}$/.test(id);
        assert.ok(isSentinel || isReference, `${name}: literal id ${id}`);
      }
    },
  },
  {
    name: "no-generated-config-contains-a-credential-shape",
    execute() {
      for (const [name, contents] of Object.entries(files)) {
        assert.equal(/-----BEGIN [A-Z ]*PRIVATE KEY/.test(contents), false, name);
        assert.equal(/\basimp_ag_[A-Za-z0-9]/.test(contents), false, name);
        assert.equal(/\b[A-Fa-f0-9]{64,}\b/.test(contents), false, name);
        assert.equal(/\b(sk|rk|pk)_(live|test)_/.test(contents), false, name);
      }
    },
  },
  {
    name: "every-r2-role-maps-to-the-right-binding-in-the-generated-file",
    execute() {
      // TOML parsing drops comments, and the role is the only thing that says
      // which bucket is private. So this reads the raw text and checks the
      // pairing: a generated file must not be able to swap which binding is
      // the private CAS and which is public delivery.
      for (const [path, contents] of Object.entries(files)) {
        const name = path.replace(`${GENERATED_DIRECTORY}/`, "").replace(".wrangler.toml", "");
        const pairs = [
          ...contents.matchAll(/# role: (\S+)\nbinding = "([^"]+)"\nbucket_name = "([^"]+)"/g),
        ].map((match) => ({ role: match[1], binding: match[2], bucket_name: match[3] }));
        assert.equal(pairs.length, report.environments[name].r2.length, name);
        for (const declared of report.environments[name].r2) {
          const generated = pairs.find((pair) => pair.role === declared.role);
          assert.ok(generated !== undefined, `${name}: role ${declared.role} absent`);
          assert.equal(generated.binding, declared.binding, `${name}/${declared.role} binding`);
          assert.equal(
            generated.bucket_name,
            declared.bucket_name,
            `${name}/${declared.role} bucket`,
          );
        }
      }
    },
  },
  {
    name: "no-generated-file-carries-another-environments-key-ids",
    execute() {
      // A staging key id appearing in production's configuration would be the
      // paper trail of exactly the key-sharing the topology forbids.
      for (const [path, contents] of Object.entries(files)) {
        const name = path.replace(`${GENERATED_DIRECTORY}/`, "").replace(".wrangler.toml", "");
        const own = new Set([
          ...report.environments[name].key_ids,
          ...report.environments[name].service_envelope_key_ids,
        ]);
        for (const kid of own) {
          assert.ok(contents.includes(kid), `${name} is missing its own key id ${kid}`);
        }
        for (const [other, environment] of Object.entries(report.environments)) {
          if (other === name) continue;
          for (const foreign of [...environment.key_ids, ...environment.service_envelope_key_ids]) {
            if (own.has(foreign)) continue;
            assert.equal(
              contents.includes(foreign),
              false,
              `${name} carries ${other}'s key id ${foreign}`,
            );
          }
        }
      }
    },
  },
  {
    name: "no-generated-file-carries-another-environments-worker-origin",
    execute() {
      for (const [path, contents] of Object.entries(files)) {
        const name = path.replace(`${GENERATED_DIRECTORY}/`, "").replace(".wrangler.toml", "");
        assert.ok(contents.includes(report.environments[name].worker_origin), name);
        for (const [other, environment] of Object.entries(report.environments)) {
          if (other === name) continue;
          assert.equal(
            contents.includes(environment.worker_origin),
            false,
            `${name} names ${other}'s origin`,
          );
        }
      }
    },
  },
  {
    name: "every-environment-and-resource-name-stays-in-its-own-file",
    execute() {
      // The generated set must be disjoint in every resource it names, or two
      // environments are one deploy away from sharing something.
      for (const [path, contents] of Object.entries(files)) {
        const name = path.replace(`${GENERATED_DIRECTORY}/`, "").replace(".wrangler.toml", "");
        for (const [other, environment] of Object.entries(report.environments)) {
          if (other === name) continue;
          assert.equal(
            contents.includes(environment.d1.database_name),
            false,
            `${name} names ${other}'s D1`,
          );
          for (const bucket of environment.r2) {
            assert.equal(
              contents.includes(bucket.bucket_name),
              false,
              `${name} names ${other}'s bucket`,
            );
          }
          assert.equal(
            contents.includes(environment.durable_objects.script_namespace),
            false,
            `${name} names ${other}'s DO namespace`,
          );
        }
      }
    },
  },
  {
    name: "key-ids-appear-as-identifiers-only",
    execute() {
      // Key *ids* are public and useful in a generated header; key material is
      // not, and there is none to leak because the topology holds none.
      const production = files[`${GENERATED_DIRECTORY}/production.wrangler.toml`];
      for (const kid of report.environments.production.service_envelope_key_ids) {
        assert.ok(production.includes(kid));
      }
      assert.equal(production.includes("staging-svc"), false);
    },
  },

  // --- reconciliation must actually detect divergence ----------------------
  {
    // A renamed or retired environment leaves its old generated file behind.
    // Checking only expected names cannot see it, and a deploy pointed at that
    // path would read a configuration the topology no longer describes.
    name: "reconcile-reports-a-surplus-generated-config-and-retains-it",
    execute() {
      const root = join(space, "surplus");
      mkdirSync(join(root, GENERATED_DIRECTORY), { recursive: true });
      for (const [path, contents] of Object.entries(files)) {
        writeFileSync(join(root, path), contents, "utf8");
      }
      // The checked-in overlay is expected on disk and must never be reported.
      const overlay = `${GENERATED_DIRECTORY}/${DEPLOY_OVERLAY_NAME}`;
      writeFileSync(join(root, overlay), "# hand-maintained deploy overlay\n", "utf8");
      assert.deepEqual(reconcile(root, files).surplus, []);

      const stale = `${GENERATED_DIRECTORY}/retired.wrangler.toml`;
      writeFileSync(
        join(root, stale),
        files[`${GENERATED_DIRECTORY}/staging.wrangler.toml`],
        "utf8",
      );
      const result = reconcile(root, files);
      assert.deepEqual(result.surplus, [stale]);
      assert.deepEqual(result.drifted, []);
      assert.deepEqual(result.missing, []);
      // Reported, never removed: the fixture is still on disk afterwards.
      assert.equal(existsSync(join(root, stale)), true);
    },
  },
  {
    // One declaration governs both the port `wrangler dev` binds and the origin
    // the Worker publishes, so a changed port must move both together.
    name: "the-local-dev-port-follows-the-declared-worker-origin",
    execute() {
      const local = report.environments.local;
      assert.equal(parsed.local.dev.port, Number(new URL(local.worker_origin).port));
      const moved = { ...local, worker_origin: "http://127.0.0.1:8811" };
      const rendered = Bun.TOML.parse(renderEnvironment("local", moved, report.policy));
      assert.equal(rendered.dev.port, 8811);
      assert.equal(stoaOriginProjection(rendered), "http://127.0.0.1:8811");
    },
  },
  {
    name: "reconcile-detects-a-hand-edited-generated-file",
    execute() {
      const root = join(space, "drifted");
      mkdirSync(join(root, GENERATED_DIRECTORY), { recursive: true });
      for (const [path, contents] of Object.entries(files)) {
        writeFileSync(join(root, path), contents, "utf8");
      }
      assert.deepEqual(reconcile(root, files), {
        missing: [],
        drifted: [],
        surplus: [],
        checked: 3,
      });

      // One byte of hand-editing: a bucket quietly repointed at production.
      const target = `${GENERATED_DIRECTORY}/staging.wrangler.toml`;
      writeFileSync(
        join(root, target),
        files[target].replace("asimposium-artifacts-staging", "asimposium-artifacts-prod"),
        "utf8",
      );
      const result = reconcile(root, files);
      assert.deepEqual(result.drifted, [target]);
      assert.deepEqual(result.missing, []);
    },
  },
  {
    name: "reconcile-detects-a-missing-generated-file",
    execute() {
      const root = join(space, "incomplete");
      mkdirSync(join(root, GENERATED_DIRECTORY), { recursive: true });
      const [first, ...rest] = Object.keys(files);
      for (const path of rest) {
        writeFileSync(join(root, path), files[path], "utf8");
      }
      const result = reconcile(root, files);
      assert.deepEqual(result.missing, [first]);
    },
  },
  {
    name: "the-checked-in-generated-configs-match-the-topology",
    execute() {
      // The gate the CI stage runs: what is on disk is what the topology says,
      // and nothing else is on disk beside the one checked-in deploy overlay.
      assert.deepEqual(reconcile(repositoryRoot, files), {
        missing: [],
        drifted: [],
        surplus: [],
        checked: 3,
      });
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

const base = {
  tool: "bun",
  package: "infra",
  suite: "wrangler-config-generation-contract",
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
      temporary_space_fixtures_retained: true,
      remote_resources_touched: 0,
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
