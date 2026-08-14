import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseToml(content, source) {
  try {
    const parsed = Bun.TOML.parse(content);
    if (!isRecord(parsed)) {
      fail("MALFORMED_TOML", `${source} must parse to a TOML object.`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof ScaffoldValidationError) throw error;
    fail("MALFORMED_TOML", `${source} must be valid TOML.`);
  }
}

function readRequiredString(record, key, source) {
  const value = record[key];
  if (value === undefined) {
    fail("MISSING_CONFIG_KEY", `${source} must define ${key}.`);
  }
  if (typeof value !== "string") {
    fail("UNSAFE_CONFIG_VALUE", `${source} must define ${key} as a string.`);
  }
  return value;
}

function readRequiredBoolean(record, key, source) {
  const value = record[key];
  if (value === undefined) {
    fail("MISSING_CONFIG_KEY", `${source} must define ${key}.`);
  }
  if (typeof value !== "boolean") {
    fail("UNSAFE_CONFIG_VALUE", `${source} must define ${key} as a boolean.`);
  }
  return value;
}

function readRequiredNumber(record, key, source) {
  const value = record[key];
  if (value === undefined) {
    fail("MISSING_CONFIG_KEY", `${source} must define ${key}.`);
  }
  if (typeof value !== "number") {
    fail("UNSAFE_CONFIG_VALUE", `${source} must define ${key} as a number.`);
  }
  return value;
}

function readRequiredObject(record, key, source) {
  const value = record[key];
  if (value === undefined) {
    fail("MISSING_CONFIG_TABLE", `${source} must define [${key}].`);
  }
  if (!isRecord(value)) {
    fail("UNSAFE_CONFIG_TABLE", `${source} must define [${key}] as an object table.`);
  }
  return value;
}

function readSingleObjectArray(record, table, source) {
  const value = record[table];
  if (value === undefined) {
    fail("MISSING_CONFIG_TABLE", `${source} must define [[${table}]].`);
  }
  if (!Array.isArray(value)) {
    fail("UNSAFE_CONFIG_TABLE", `${source} must define [[${table}]], not [${table}].`);
  }
  if (value.length !== 1) {
    fail(
      "DUPLICATE_CONFIG_TABLE",
      `${source} must define exactly one [[${table}]] entry; duplicate, shadowed, or conflicting entries are not allowed.`,
    );
  }
  const entry = value[0];
  if (!isRecord(entry)) {
    fail("UNSAFE_CONFIG_TABLE", `${source} must define [[${table}]] entries as objects.`);
  }
  return entry;
}

function readRequiredSingleStringArray(record, key, source) {
  const value = record[key];
  if (value === undefined) {
    fail("MISSING_CONFIG_KEY", `${source} must define ${key}.`);
  }
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== "string") {
    fail("UNSAFE_CONFIG_VALUE", `${source} must define ${key} as a single-string array.`);
  }
  return value[0];
}

function assertExact(value, expected, key, source) {
  if (value !== expected) {
    fail("UNSAFE_CONFIG_VALUE", `${source} must set ${key} to ${JSON.stringify(expected)}.`);
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
    fail(
      "MISSING_WRANGLER_PIN",
      "Expected apps/wire/package.json with a pinned wrangler development dependency.",
    );
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
  const parsedConfig = parseToml(config, configSource);
  assertNoForbiddenBackend(config, configSource);
  assertNoRemoteConfiguration(config, configSource);

  const declaredMain = readRequiredString(parsedConfig, "main", configSource);
  const mainPath = resolveRepositoryPath(root, configPath, declaredMain, "main");
  assertExact(declaredMain, "../apps/wire/src/index.ts", "main", configSource);
  assertPhysicalRepositoryContainment(root, mainPath, "main");

  assertExact(
    readRequiredString(parsedConfig, "name", configSource),
    "asimposium-stoa-local",
    "name",
    configSource,
  );
  assertExact(
    readRequiredString(parsedConfig, "compatibility_date", configSource),
    "2026-08-13",
    "compatibility_date",
    configSource,
  );

  const compatibilityFlags = parsedConfig.compatibility_flags;
  if (!Array.isArray(compatibilityFlags) || !compatibilityFlags.includes("nodejs_compat")) {
    fail("MISSING_COMPATIBILITY_FLAG", `${configSource} must enable nodejs_compat.`);
  }
  assertExact(
    readRequiredBoolean(parsedConfig, "workers_dev", configSource),
    false,
    "workers_dev",
    configSource,
  );
  const dev = readRequiredObject(parsedConfig, "dev", configSource);
  assertExact(readRequiredNumber(dev, "port", configSource), 8787, "dev.port", configSource);
  assertExact(
    readRequiredString(dev, "local_protocol", configSource),
    "http",
    "dev.local_protocol",
    configSource,
  );

  const d1Database = readSingleObjectArray(parsedConfig, "d1_databases", configSource);
  assertExact(
    readRequiredString(d1Database, "binding", configSource),
    "DB",
    "d1_databases.binding",
    configSource,
  );
  assertExact(
    readRequiredString(d1Database, "database_name", configSource),
    "asimposium-local",
    "d1_databases.database_name",
    configSource,
  );
  assertExact(
    readRequiredString(d1Database, "database_id", configSource),
    ZERO_D1_ID,
    "d1_databases.database_id",
    configSource,
  );
  const migrationsDirectory = readRequiredString(d1Database, "migrations_dir", configSource);
  assertExact(migrationsDirectory, "../db/migrations", "d1_databases.migrations_dir", configSource);
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

  const r2Bucket = readSingleObjectArray(parsedConfig, "r2_buckets", configSource);
  assertExact(
    readRequiredString(r2Bucket, "binding", configSource),
    "ARTIFACTS",
    "r2_buckets.binding",
    configSource,
  );
  assertExact(
    readRequiredString(r2Bucket, "bucket_name", configSource),
    "asimposium-artifacts-local",
    "r2_buckets.bucket_name",
    configSource,
  );

  const rules = readSingleObjectArray(parsedConfig, "rules", configSource);
  assertExact(readRequiredString(rules, "type", configSource), "Text", "rules.type", configSource);
  assertExact(
    readRequiredSingleStringArray(rules, "globs", configSource),
    "**/*.md",
    "rules.globs",
    configSource,
  );
  assertExact(
    readRequiredBoolean(rules, "fallthrough", configSource),
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
  fail(
    "INVALID_ARGUMENT",
    "Usage: bun infra/validate-scaffold.mjs [--config <repository-relative-path>]",
  );
}

function diagnostic(status, startedAt, details = {}) {
  return {
    tool: "bun",
    package: "infra",
    suite: "wrangler-scaffold-static",
    version: Bun.version,
    duration_ms: Math.round(performance.now() - startedAt),
    status,
    reproduce: "bun infra/validate-scaffold.mjs",
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
    const details =
      error instanceof ScaffoldValidationError
        ? { code: error.code, detail: error.message }
        : { code: "UNEXPECTED", detail: "Unexpected static validation failure." };
    process.stderr.write(`${JSON.stringify(diagnostic("fail", startedAt, details))}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main();
}
