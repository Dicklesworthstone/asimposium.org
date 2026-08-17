import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { EnvironmentValidationError, validateEnvironments } from "./validate-environments.mjs";

/**
 * Per-environment Wrangler configuration, generated from the topology
 * (bead asimposiumorg-p1g, OPS.3).
 *
 * This is what stops `environments.toml` from being decorative. The topology is
 * the single source; these files are its deterministic projection, and
 * `--check` proves they still agree. Hand-editing a generated file is therefore
 * a detectable act, not a silent divergence between what was reviewed and what
 * would be deployed.
 *
 * Generation is a pure string function of the validated topology: same input,
 * same bytes, no timestamps, no ordering that depends on a filesystem. It
 * creates no remote resource, contacts no network, and holds no credential.
 *
 * Resource ids stay `${VAR}` references. Wrangler does not interpolate
 * environment variables in its configuration, so these files are not directly
 * deployable as written — CI must substitute the ids at deploy time. That is
 * recorded here rather than papered over: see infra/README.md.
 */

export const GENERATED_DIRECTORY = "infra/environments";
/**
 * The one checked-in configuration in the generated directory that this tool
 * does not render. It is hand-maintained deploy-time configuration, so it is
 * expected on disk but never reconciled against the topology here.
 */
export const DEPLOY_OVERLAY_NAME = "production.deploy.wrangler.toml";
const BANNER = "# GENERATED FROM infra/environments.toml — DO NOT EDIT BY HAND.";

function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Render one environment. Key order is fixed by this function, not by object
 * iteration order, so the output is stable across runtimes.
 */
/**
 * The bound-vs-exported Durable Object classes of one parsed Wrangler config.
 *
 * The positive gate and its planted negative both call this, so weakening it
 * cannot leave the negative passing for an unrelated reason.
 */
export function durableObjectParity(parsedConfig) {
  return {
    bound: (parsedConfig.durable_objects?.bindings ?? [])
      .map((binding) => binding.class_name)
      .sort(),
    exported: Object.keys(parsedConfig.exports ?? {}).sort(),
  };
}

/**
 * The origin one parsed Wrangler config publishes to its Worker.
 *
 * The positive gate and its planted negative both read through this, so a
 * projection that stopped being emitted cannot leave either passing.
 */
export function stoaOriginProjection(parsedConfig) {
  return parsedConfig.vars?.STOA_ORIGIN;
}

export function renderEnvironment(name, environment, policy) {
  const lines = [
    BANNER,
    `# Environment: ${name}. Regenerate with: bun infra/generate-wrangler.mjs --write`,
    `# Verify with:  bun infra/generate-wrangler.mjs --check`,
    "",
    // The Worker script name is taken from the topology, never templated from
    // the environment key: a Durable Object namespace is scoped to the script
    // that owns it, so inventing the name here would silently detach the
    // deployed namespace from the declared one (it did: "production" vs "prod").
    `name = ${tomlString(environment.durable_objects.script_namespace)}`,
    `main = ${tomlString("../../apps/wire/src/index.ts")}`,
    `compatibility_date = ${tomlString("2026-08-13")}`,
    `compatibility_flags = ["nodejs_compat"]`,
    "workers_dev = false",
    "",
  ];

  if (environment.kind === "local") {
    // Derived from the validated loopback origin, never restated: the topology
    // already pins `worker_origin` to `http://127.0.0.1:<port>`, so one
    // declaration governs both the port `wrangler dev` binds and the origin the
    // Worker publishes as STOA_ORIGIN. A second literal here could disagree
    // with it silently.
    lines.push(
      "[dev]",
      `port = ${new URL(environment.worker_origin).port}`,
      `local_protocol = ${tomlString("http")}`,
      "",
    );
  }

  lines.push("[triggers]", `crons = [${tomlString(policy.outbox_cron)}]`, "");

  lines.push(
    "[[d1_databases]]",
    `binding = ${tomlString(environment.d1.binding)}`,
    `database_name = ${tomlString(environment.d1.database_name)}`,
    `database_id = ${tomlString(environment.d1.database_id)}`,
    `migrations_dir = ${tomlString("../../db/migrations")}`,
    "",
  );

  // Buckets in declared role order so the file does not reshuffle.
  for (const role of policy.required_r2_roles) {
    const bucket = environment.r2.find((candidate) => candidate.role === role);
    lines.push(
      "[[r2_buckets]]",
      `# role: ${role}`,
      `binding = ${tomlString(bucket.binding)}`,
      `bucket_name = ${tomlString(bucket.bucket_name)}`,
      "",
    );
  }

  // Cloudflare refuses a Durable Object binding whose class the entrypoint does
  // not export, so a binding and its `[exports.<class>]` block are emitted as a
  // pair or not at all. A deferred binding is withheld from BOTH lists rather
  // than paired with an export for a class that does not exist; the deferral is
  // rendered as a comment so the omission is legible in the deployed artifact.
  // `policy.deferred_bindings` is required, not optional: a missing list must
  // fail loudly here rather than silently emit an unexportable binding.
  const deferred = new Set(policy.deferred_bindings);
  const durableObjects = [environment.durable_objects, environment.outbox];
  for (const durableObject of durableObjects) {
    if (deferred.has(durableObject.binding)) continue;
    lines.push(
      "[[durable_objects.bindings]]",
      `name = ${tomlString(durableObject.binding)}`,
      `class_name = ${tomlString(durableObject.class_name)}`,
      "",
    );
  }
  for (const durableObject of durableObjects) {
    if (deferred.has(durableObject.binding)) continue;
    lines.push(
      `[exports.${durableObject.class_name}]`,
      `type = ${tomlString("durable-object")}`,
      // Declared per binding in the topology, never invented here: the storage
      // backend decides whether the class gets SQL storage, and a renderer
      // default would make the deployed shape depend on an unreviewed value.
      `storage = ${tomlString(durableObject.storage)}`,
      "",
    );
  }
  for (const durableObject of durableObjects) {
    if (!deferred.has(durableObject.binding)) continue;
    lines.push(
      `# Deferred: ${durableObject.binding} (${durableObject.class_name}) is declared in`,
      "# infra/environments.toml but is not bound here, because the Worker entrypoint",
      "# does not export its class yet. Binding it would make this config undeployable.",
      "",
    );
  }

  lines.push(
    // Non-secret, and the only origin the Worker may claim for itself. It is
    // projected from this environment's declared `worker_origin`, never derived
    // from request metadata: a Host or X-Forwarded-Host header is supplied by
    // the caller, so trusting it would let a request relocate the origin the
    // Worker believes it serves.
    "[vars]",
    `STOA_ORIGIN = ${tomlString(environment.worker_origin)}`,
    // The Agora origin the device-flow verification URL names: projected from
    // the environment's declared `agora_origin`, never derived from requests.
    `AGORA_ORIGIN = ${tomlString(environment.agora_origin)}`,
    "",
    "[[rules]]",
    `type = ${tomlString("Text")}`,
    `globs = ["**/*.md", "**/*.txt", "**/*.schema.json"]`,
    "fallthrough = true",
    "",
    "# The public-delivery bucket is served on its own R2 custom domain, which is",
    "# configured on the bucket and never as a Worker route:",
    `#   ${environment.published_hostname === "" ? "(none for this environment)" : environment.published_hostname}`,
    "# The private-cas bucket carries no custom domain by construction.",
    "",
    "# Vercel calls this environment at the STOA_ORIGIN projected above:",
    `#   ${environment.worker_origin}`,
    "",
    "# Signing key ids (public identifiers; the keys live in wrangler secret):",
    `#   signing:          ${environment.key_ids.join(", ")}`,
    `#   service envelope: ${environment.service_envelope_key_ids.join(", ")}`,
  );

  return `${lines.join("\n")}\n`;
}

/** The full set of generated files, as {workspacePath: contents}. */
export function renderAll(report) {
  const files = {};
  for (const [name, environment] of Object.entries(report.environments)) {
    files[`${GENERATED_DIRECTORY}/${name}.wrangler.toml`] = renderEnvironment(
      name,
      environment,
      report.policy,
    );
  }
  return files;
}

export class GenerationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "GenerationError";
  }
}

/** Compare generated output against what is on disk. Never writes. */
export function reconcile(root, files) {
  const drifted = [];
  const missing = [];
  for (const [workspacePath, expected] of Object.entries(files)) {
    const absolute = join(root, workspacePath);
    if (!existsSync(absolute)) {
      missing.push(workspacePath);
      continue;
    }
    if (readFileSync(absolute, "utf8") !== expected) {
      drifted.push(workspacePath);
    }
  }
  // Checking only the expected names leaves a stale fourth config invisible:
  // an environment that was renamed or removed from the topology keeps its old
  // generated file on disk, and a deploy pointed at that path would read a
  // configuration the topology no longer describes. Enumerate the directory and
  // refuse anything outside the generated set plus the one checked-in overlay.
  // Surplus is reported, never removed — this tool does not delete files.
  const expectedNames = new Set([
    ...Object.keys(files).map((workspacePath) =>
      workspacePath.slice(`${GENERATED_DIRECTORY}/`.length),
    ),
    DEPLOY_OVERLAY_NAME,
  ]);
  const surplus = [];
  const directory = join(root, GENERATED_DIRECTORY);
  if (existsSync(directory)) {
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".toml") || expectedNames.has(entry)) continue;
      surplus.push(`${GENERATED_DIRECTORY}/${entry}`);
    }
    surplus.sort();
  }
  return { missing, drifted, surplus, checked: Object.keys(files).length };
}

function diagnostic(status, startedAt, details = {}) {
  return {
    tool: "bun",
    package: "infra",
    suite: "wrangler-config-generation",
    version: Bun.version,
    duration_ms: Math.round(performance.now() - startedAt),
    status,
    reproduce: "bun infra/generate-wrangler.mjs --check",
    ...details,
  };
}

function main() {
  const startedAt = performance.now();
  try {
    const args = process.argv.slice(2);
    const write = args.includes("--write");
    const check = args.includes("--check") || !write;
    if (args.some((argument) => argument !== "--write" && argument !== "--check")) {
      throw new GenerationError(
        "INVALID_ARGUMENT",
        "Usage: bun infra/generate-wrangler.mjs [--check|--write]",
      );
    }

    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const report = validateEnvironments(root);
    const files = renderAll(report);

    if (write) {
      mkdirSync(join(root, GENERATED_DIRECTORY), { recursive: true });
      for (const [workspacePath, contents] of Object.entries(files)) {
        writeFileSync(join(root, workspacePath), contents, "utf8");
      }
      process.stdout.write(
        `${JSON.stringify(diagnostic("pass", startedAt, { mode: "write", written: Object.keys(files) }))}\n`,
      );
      return;
    }

    const result = reconcile(root, files);
    // A surplus config is reported but never removed: deleting a file the
    // operator may still need is not this tool's call, and `--write` would not
    // have cleaned it either.
    if (result.surplus.length > 0) {
      throw new GenerationError(
        "GENERATED_CONFIG_SURPLUS",
        `${GENERATED_DIRECTORY} holds configuration the topology does not describe: ${result.surplus.join(", ")}. Remove it deliberately, or add its environment to infra/environments.toml.`,
      );
    }
    if (result.missing.length > 0 || result.drifted.length > 0) {
      throw new GenerationError(
        result.missing.length > 0 ? "GENERATED_CONFIG_MISSING" : "GENERATED_CONFIG_DRIFT",
        `Generated Wrangler configuration does not match the topology. Missing: ${result.missing.join(", ") || "none"}. Drifted: ${result.drifted.join(", ") || "none"}. Regenerate with --write and review the diff.`,
      );
    }
    process.stdout.write(
      `${JSON.stringify(diagnostic("pass", startedAt, { mode: "check", ...result, checkedOnly: check }))}\n`,
    );
  } catch (error) {
    const details =
      error instanceof GenerationError || error instanceof EnvironmentValidationError
        ? { code: error.code, detail: error.message }
        : { code: "UNEXPECTED", detail: "Unexpected generation failure." };
    process.stderr.write(`${JSON.stringify(diagnostic("fail", startedAt, details))}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
