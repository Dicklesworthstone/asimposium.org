import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const BANNER = "# GENERATED FROM infra/environments.toml — DO NOT EDIT BY HAND.";

function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Render one environment. Key order is fixed by this function, not by object
 * iteration order, so the output is stable across runtimes.
 */
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
    lines.push("[dev]", "port = 8787", `local_protocol = ${tomlString("http")}`, "");
  }

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

  lines.push(
    "[[durable_objects.bindings]]",
    `name = ${tomlString(environment.durable_objects.binding)}`,
    `class_name = ${tomlString(environment.durable_objects.class_name)}`,
    "",
    "[[rules]]",
    `type = ${tomlString("Text")}`,
    `globs = ["**/*.md", "**/*.txt"]`,
    "fallthrough = true",
    "",
    "# The public-delivery bucket is served on its own R2 custom domain, which is",
    "# configured on the bucket and never as a Worker route:",
    `#   ${environment.published_hostname === "" ? "(none for this environment)" : environment.published_hostname}`,
    "# The private-cas bucket carries no custom domain by construction.",
    "",
    "# Vercel calls this environment at:",
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
  return { missing, drifted, checked: Object.keys(files).length };
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
