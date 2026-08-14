import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const ZERO_D1_ID = "00000000-0000-0000-0000-000000000000";
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
const REQUIRED_RESPONSIBILITY_DOCS = [
  "db/migrations/README.md",
  "infra/README.md",
  "docs/README.md",
];
const FORBIDDEN_BACKEND_MARKERS = ["supabase", "turso", "neon", "prisma"];
const STRICT_ARRAY_TABLES = new Set(["d1_databases", "r2_buckets", "rules"]);

export class ScaffoldValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new ScaffoldValidationError(code, message);
}

function relativeDisplay(root, target) {
  const value = relative(root, target).split(sep).join("/");
  return value === "" ? "." : `./${value}`;
}

function readRequiredAssignment(content, key, source) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(
    new RegExp(`^\\s*${escapedKey}\\s*=\\s*"([^"]+)"\\s*$`, "m"),
  );
  if (!match) {
    fail("MISSING_CONFIG_KEY", `${source} must define ${key}.`);
  }
  return match[1];
}

function readRequiredBooleanAssignment(content, key, source) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(
    new RegExp(`^\\s*${escapedKey}\\s*=\\s*(true|false)\\s*$`, "m"),
  );
  if (!match) {
    fail("MISSING_CONFIG_KEY", `${source} must define ${key}.`);
  }
  return match[1] === "true";
}

function readRequiredSingleStringArrayAssignment(content, key, source) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(
    new RegExp(`^\\s*${escapedKey}\\s*=\\s*\\[\\s*"([^\"]+)"\\s*\\]\\s*$`, "m"),
  );
  if (!match) {
    fail("MISSING_CONFIG_KEY", `${source} must define ${key} as a single-string array.`);
  }
  return match[1];
}

function readTable(content, table, source) {
  const lines = content.split("\n");
  const headers = [`[[${table}]]`, `[${table}]`];
  const matches = lines
    .map((line, index) => ({ index, header: line.trim() }))
    .filter(({ header }) => headers.includes(header));
  if (matches.length === 0) {
    fail("MISSING_CONFIG_TABLE", `${source} must define ${headers[0]} or ${headers[1]}.`);
  }

  if (STRICT_ARRAY_TABLES.has(table)) {
    if (matches.length !== 1) {
      fail(
        "DUPLICATE_CONFIG_TABLE",
        `${source} must define exactly one ${headers[0]}; duplicate, shadowed, or conflicting ${table} entries are not allowed.`,
      );
    }
    if (matches[0].header !== headers[0]) {
      fail(
        "UNSAFE_CONFIG_TABLE",
        `${source} must define ${headers[0]}, not ${headers[1]}.`,
      );
    }
  }

  const rows = [];
  for (let index = matches[0].index + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      break;
    }
    rows.push(lines[index]);
  }
  return rows.join("\n");
}

function readTableAssignment(content, table, key, source) {
  return readRequiredAssignment(readTable(content, table, source), key, source);
}

function assertExact(value, expected, key, source) {
  if (value !== expected) {
    fail(
      "UNSAFE_CONFIG_VALUE",
      `${source} must set ${key} to ${JSON.stringify(expected)}.`,
    );
  }
}

function isOutside(root, target) {
  const relation = relative(root, target);
  return relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation);
}

function resolveRepositoryPath(root, configPath, declaredPath, key) {
  if (isAbsolute(declaredPath)) {
    fail("PATH_ESCAPE", `${key} must be repository-relative.`);
  }

  const target = resolve(dirname(configPath), declaredPath);
  if (isOutside(root, target)) {
    fail("PATH_ESCAPE", `${key} resolves outside the repository.`);
  }
  return target;
}

function assertPhysicalRepositoryContainment(root, target, key) {
  if (!existsSync(target)) {
    fail("MISSING_REQUIRED_TARGET", `${key} must resolve to an existing repository target.`);
  }

  let physicalRoot;
  let physicalTarget;
  try {
    physicalRoot = realpathSync(root);
    physicalTarget = realpathSync(target);
  } catch {
    fail("MISSING_REQUIRED_TARGET", `${key} must resolve to an existing repository target.`);
  }

  if (isOutside(physicalRoot, physicalTarget)) {
    fail("PATH_ESCAPE", `${key} resolves outside the repository after symlink resolution.`);
  }
}

function assertDirectory(root, workspacePath) {
  const absolutePath = resolve(root, workspacePath);
  if (!existsSync(absolutePath) || !lstatSync(absolutePath).isDirectory()) {
    fail("MISSING_LAYOUT_DIRECTORY", `Expected directory ${workspacePath}.`);
  }
}

function assertFile(root, absolutePath, key) {
  if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) {
    fail(
      "MISSING_LAYOUT_FILE",
      `${key} must resolve to a file inside the repository (${relativeDisplay(root, absolutePath)}).`,
    );
  }
}

function assertNoForbiddenBackend(content, source) {
  const lower = content.toLowerCase();
  for (const marker of FORBIDDEN_BACKEND_MARKERS) {
    if (lower.includes(marker)) {
      fail(
        "FORBIDDEN_BACKEND_MARKER",
        `${source} contains the forbidden backend marker ${JSON.stringify(marker)}.`,
      );
    }
  }
}

function assertNoRemoteConfiguration(content, source) {
  const remoteKeys = ["account_id", "route", "routes", "zone_id", "[env.", "[vars]"];
  const lower = content.toLowerCase();
  for (const key of remoteKeys) {
    if (lower.includes(key)) {
      fail("REMOTE_CONFIGURATION_PRESENT", `${source} contains disallowed local-only key ${key}.`);
    }
  }
}

function readPinnedWranglerVersion(root) {
  const packagePath = resolve(root, "apps/wire/package.json");
  if (!existsSync(packagePath)) {
    fail("MISSING_WRANGLER_PIN", "Expected apps/wire/package.json with a pinned wrangler development dependency.");
  }

  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch {
    fail("MALFORMED_WORKER_PACKAGE", "apps/wire/package.json must be valid JSON.");
  }

  const version = packageJson.devDependencies?.wrangler;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(
      "WRANGLER_VERSION_UNPINNED",
      "apps/wire devDependencies.wrangler must be an exact version without a range prefix.",
    );
  }
  return version;
}

export function validateScaffold(rootDirectory, configWorkspacePath = "infra/wrangler.toml") {
  const root = resolve(rootDirectory);
  if (isAbsolute(configWorkspacePath)) {
    fail("PATH_ESCAPE", "The Wrangler configuration path must be repository-relative.");
  }
  const configPath = resolve(root, configWorkspacePath);
  if (isOutside(root, configPath)) {
    fail("PATH_ESCAPE", "The Wrangler configuration path resolves outside the repository.");
  }
  const configSource = relativeDisplay(root, configPath).replace(/^\.\//, "");

  if (!existsSync(configPath)) {
    fail("MISSING_CONFIG_FILE", `Expected ${configSource}.`);
  }
  assertPhysicalRepositoryContainment(root, configPath, "The Wrangler configuration path");

  const config = readFileSync(configPath, "utf8");
  assertNoForbiddenBackend(config, configSource);
  assertNoRemoteConfiguration(config, configSource);

  const declaredMain = readRequiredAssignment(config, "main", configSource);
  const mainPath = resolveRepositoryPath(root, configPath, declaredMain, "main");
  assertExact(
    declaredMain,
    "../apps/wire/src/index.ts",
    "main",
    configSource,
  );
  assertPhysicalRepositoryContainment(root, mainPath, "main");

  assertExact(readRequiredAssignment(config, "name", configSource), "asimposium-stoa-local", "name", configSource);
  assertExact(
    readRequiredAssignment(config, "compatibility_date", configSource),
    "2026-08-13",
    "compatibility_date",
    configSource,
  );

  if (!/^\s*compatibility_flags\s*=\s*\[[^\]]*"nodejs_compat"[^\]]*\]\s*$/m.test(config)) {
    fail("MISSING_COMPATIBILITY_FLAG", `${configSource} must enable nodejs_compat.`);
  }
  if (!/^\s*workers_dev\s*=\s*false\s*$/m.test(config)) {
    fail("UNSAFE_CONFIG_VALUE", `${configSource} must disable workers_dev.`);
  }
  if (!/^\s*port\s*=\s*8787\s*$/m.test(config)) {
    fail("MISSING_CONFIG_KEY", `${configSource} must set local dev port 8787.`);
  }
  assertExact(
    readRequiredAssignment(readTable(config, "dev", configSource), "local_protocol", configSource),
    "http",
    "dev.local_protocol",
    configSource,
  );

  assertExact(
    readTableAssignment(config, "d1_databases", "binding", configSource),
    "DB",
    "d1_databases.binding",
    configSource,
  );
  assertExact(
    readTableAssignment(config, "d1_databases", "database_name", configSource),
    "asimposium-local",
    "d1_databases.database_name",
    configSource,
  );
  assertExact(
    readTableAssignment(config, "d1_databases", "database_id", configSource),
    ZERO_D1_ID,
    "d1_databases.database_id",
    configSource,
  );
  const migrationsDirectory = readTableAssignment(config, "d1_databases", "migrations_dir", configSource);
  assertExact(
    migrationsDirectory,
    "../db/migrations",
    "d1_databases.migrations_dir",
    configSource,
  );
  const migrationsPath = resolveRepositoryPath(
    root,
    configPath,
    migrationsDirectory,
    "d1_databases.migrations_dir",
  );
  assertPhysicalRepositoryContainment(root, migrationsPath, "d1_databases.migrations_dir");
  const wrangler_version = readPinnedWranglerVersion(root);

  for (const workspacePath of REQUIRED_DIRECTORIES) {
    assertDirectory(root, workspacePath);
  }
  for (const responsibilityDocument of REQUIRED_RESPONSIBILITY_DOCS) {
    assertFile(root, resolve(root, responsibilityDocument), responsibilityDocument);
  }
  assertFile(root, mainPath, "main");
  if (!existsSync(migrationsPath) || !lstatSync(migrationsPath).isDirectory()) {
    fail(
      "MISSING_MIGRATIONS_DIRECTORY",
      `d1_databases.migrations_dir must resolve to a directory (${relativeDisplay(root, migrationsPath)}).`,
    );
  }

  assertExact(
    readTableAssignment(config, "r2_buckets", "binding", configSource),
    "ARTIFACTS",
    "r2_buckets.binding",
    configSource,
  );
  assertExact(
    readTableAssignment(config, "r2_buckets", "bucket_name", configSource),
    "asimposium-artifacts-local",
    "r2_buckets.bucket_name",
    configSource,
  );

  const rules = readTable(config, "rules", configSource);
  assertExact(
    readRequiredAssignment(rules, "type", configSource),
    "Text",
    "rules.type",
    configSource,
  );
  assertExact(
    readRequiredSingleStringArrayAssignment(rules, "globs", configSource),
    "**/*.md",
    "rules.globs",
    configSource,
  );
  assertExact(
    readRequiredBooleanAssignment(rules, "fallthrough", configSource),
    true,
    "rules.fallthrough",
    configSource,
  );

  return {
    config: configSource,
    entrypoint: relativeDisplay(root, mainPath),
    migrations_dir: relativeDisplay(root, migrationsPath),
    required_directories: REQUIRED_DIRECTORIES,
    responsibility_docs: REQUIRED_RESPONSIBILITY_DOCS,
    wrangler_version,
  };
}

function parseArguments(argumentsList) {
  if (argumentsList.length === 0) {
    return {
      root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      config: "infra/wrangler.toml",
    };
  }
  if (argumentsList.length === 2 && argumentsList[0] === "--config") {
    return {
      root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      config: argumentsList[1],
    };
  }
  fail("INVALID_ARGUMENT", "Usage: node infra/validate-scaffold.mjs [--config <repository-relative-path>]");
}

function diagnostic(status, startedAt, details = {}) {
  return {
    tool: "node",
    package: "infra",
    suite: "wrangler-scaffold-static",
    version: process.version,
    duration_ms: Math.round(performance.now() - startedAt),
    status,
    reproduce: "node infra/validate-scaffold.mjs",
    ...details,
  };
}

function main() {
  const startedAt = performance.now();
  try {
    const argumentsResult = parseArguments(process.argv.slice(2));
    const report = validateScaffold(argumentsResult.root, argumentsResult.config);
    process.stdout.write(`${JSON.stringify(diagnostic("pass", startedAt, report))}\n`);
  } catch (error) {
    const details = error instanceof ScaffoldValidationError
      ? { code: error.code, detail: error.message }
      : { code: "UNEXPECTED", detail: "Unexpected static validation failure." };
    process.stderr.write(`${JSON.stringify(diagnostic("fail", startedAt, details))}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
