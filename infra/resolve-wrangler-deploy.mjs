import { dlopen } from "bun:ffi";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { VerificationKeyring } from "../apps/wire/src/auth/keyring";
import { renderAll } from "./generate-wrangler.mjs";
import {
  EnvironmentValidationError,
  redactDiagnostic,
  validateEnvironments,
} from "./validate-environments.mjs";

/**
 * Resolve the one deployable staging Worker configuration without contacting a
 * provider. The topology and generated staging template remain the authorities;
 * this file supplies only the two provisioned values a generated template
 * intentionally cannot carry: the staging D1 UUID and public verification keys.
 *
 * This is deliberately a separate resolver rather than a mode of
 * generate-wrangler.mjs. Generation remains a credential-free projection for
 * every environment. Resolution is staging-only, produces one ignored artifact,
 * and rejects any attempt to turn a local or production template into a deploy
 * input by accident.
 */

export const STAGING_ENVIRONMENT = "staging";
export const STAGING_TEMPLATE_PATH = "infra/environments/staging.wrangler.toml";
export const STAGING_OUTPUT_PATH = "infra/deploy-resolved/staging.wrangler.toml";
export const STAGING_D1_INPUT = "ASIMP_D1_DATABASE_ID_STAGING";
export const STAGING_SERVICE_KEYS_INPUT = "ASIMP_STAGING_SERVICE_ENVELOPE_KEYS";

const STAGING_D1_PLACEHOLDER = "$" + "{ASIMP_D1_DATABASE_ID_STAGING}";
const MAX_SERVICE_KEYS_BYTES = 2_048;
const MAX_ARTIFACT_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const KID = /^[A-Za-z0-9._-]{1,64}$/;
const CANONICAL_HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const OUTPUT_BASENAME = "staging.wrangler.toml";

/**
 * Node's filesystem API does not expose openat(2). Bun runs this deploy tool,
 * so use its FFI bridge only for that one kernel primitive and fail closed on
 * runtimes without a Unix libc symbol. The descriptor returned by openat is
 * consumed through ordinary node:fs calls after the race-safe relative open.
 */
function loadOpenAt() {
  const candidates =
    process.platform === "darwin"
      ? ["/usr/lib/libSystem.B.dylib"]
      : process.platform === "linux"
        ? ["libc.so.6", "libc.so"]
        : [];
  for (const candidate of candidates) {
    try {
      return dlopen(candidate, {
        openat: {
          args: ["i32", "ptr", "i32", "u32"],
          returns: "i32",
        },
      });
    } catch {
      // Try the next canonical libc name; publication refuses if none load.
    }
  }
  return undefined;
}

const OPEN_AT_LIBRARY = loadOpenAt();
const OUTPUT_BASENAME_C = Buffer.from(`${OUTPUT_BASENAME}\0`);

export class DeployResolutionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "DeployResolutionError";
  }
}

function fail(code, message) {
  throw new DeployResolutionError(code, redactDiagnostic(message));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOutside(root, target) {
  const relation = relative(root, target);
  return relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation);
}

function repositoryRoot(root) {
  try {
    return realpathSync(root);
  } catch {
    fail("REPOSITORY_ROOT_INVALID", "Repository root is unavailable.");
  }
}

function existingContainedFile(root, workspacePath, code) {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, workspacePath);
  if (isOutside(absoluteRoot, target))
    fail(code, "A required resolver input is outside the repository.");
  if (!existsSync(target)) fail(code, "A required resolver input is missing.");

  let stat;
  let physicalRoot;
  let physicalTarget;
  try {
    stat = lstatSync(target);
    physicalRoot = repositoryRoot(absoluteRoot);
    physicalTarget = realpathSync(target);
  } catch {
    fail(code, "A required resolver input is unavailable.");
  }
  if (stat.isSymbolicLink() || !stat.isFile() || isOutside(physicalRoot, physicalTarget)) {
    fail(code, "A required resolver input is unsafe.");
  }
  return target;
}

function readBounded(path, code) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(code, "A bounded resolver file could not be inspected.");
  }
  if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) {
    fail(code, "A bounded resolver file has an invalid shape.");
  }
  try {
    return readFileSync(path, "utf8");
  } catch {
    fail(code, "A bounded resolver file could not be read.");
  }
}

function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function replaceExactly(contents, needle, replacement, code) {
  const occurrences = contents.split(needle).length - 1;
  if (occurrences !== 1) fail(code, "The validated staging template has an unexpected shape.");
  return contents.replace(needle, replacement);
}

/**
 * Verify the staging template against an already validated topology report.
 * Exported so planted negatives can exercise each refusal directly; the
 * deploy path calls this exact gate after proving the checked-in bytes match
 * the generator.
 */
export function assertStagingTemplate(report, contents) {
  const staging = report.environments[STAGING_ENVIRONMENT];
  if (staging === undefined || staging.kind !== "remote" || !staging.is_preview) {
    fail("STAGING_TOPOLOGY_INVALID", "The staging topology is not a remote preview environment.");
  }
  if (staging.d1.database_id !== STAGING_D1_PLACEHOLDER) {
    fail(
      "STAGING_D1_REFERENCE_INVALID",
      "The staging D1 reference is not the declared placeholder.",
    );
  }
  if (contents.split(STAGING_D1_PLACEHOLDER).length - 1 !== 1) {
    fail("STAGING_D1_REFERENCE_INVALID", "The staging D1 placeholder is not unique.");
  }

  let parsed;
  try {
    parsed = Bun.TOML.parse(contents);
  } catch {
    fail("GENERATED_STAGING_CONFIG_INVALID", "The validated staging template is not TOML.");
  }
  const databases = parsed.d1_databases;
  if (
    !Array.isArray(databases) ||
    databases.length !== 1 ||
    databases[0]?.binding !== staging.d1.binding ||
    databases[0]?.database_name !== staging.d1.database_name ||
    databases[0]?.database_id !== STAGING_D1_PLACEHOLDER
  ) {
    fail("STAGING_D1_REFERENCE_INVALID", "The staging template D1 configuration is not exact.");
  }
  if (
    !isRecord(parsed.vars) ||
    Object.keys(parsed.vars).length !== 1 ||
    parsed.vars.STOA_ORIGIN !== staging.worker_origin
  ) {
    fail("STAGING_ORIGIN_INVALID", "The staging template origin is not topology-derived.");
  }
  if (parsed.routes !== undefined) {
    fail(
      "STAGING_TEMPLATE_HAS_ROUTE",
      "The generated staging template must not carry a deploy route.",
    );
  }
  const buckets = parsed.r2_buckets;
  if (!Array.isArray(buckets) || buckets.length !== staging.r2.length) {
    fail("STAGING_R2_INVALID", "The staging template R2 bindings are not exact.");
  }
  for (const declared of staging.r2) {
    const rendered = buckets.find((candidate) => candidate.binding === declared.binding);
    if (
      rendered === undefined ||
      rendered.bucket_name !== declared.bucket_name ||
      Object.hasOwn(rendered, "custom_domain")
    ) {
      fail("STAGING_R2_INVALID", "The staging template R2 bindings are not exact.");
    }
  }
  const deferred = staging.durable_objects.binding;
  if ((parsed.durable_objects?.bindings ?? []).some((binding) => binding.name === deferred)) {
    fail(
      "STAGING_DEFERRED_BINDING_PRESENT",
      "The deferred staging Durable Object binding is present.",
    );
  }
  return { parsed, staging };
}

function canonicalD1DatabaseId(value) {
  if (typeof value !== "string" || value.length !== 36) {
    fail("STAGING_D1_ID_INVALID", "The staging D1 id is invalid.");
  }
  // Keep the nil-id refusal before the RFC-4122 variant check. Nil is not an
  // admissible variant either, but this order ensures the explicit guard is a
  // real invariant rather than dead code hidden behind the shape validator.
  if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)) {
    fail("STAGING_D1_ID_INVALID", "The staging D1 id is invalid.");
  }
  if (!UUID.test(value)) {
    fail("STAGING_D1_ID_INVALID", "The staging D1 id is invalid.");
  }
  return value;
}

function keyRecord(record) {
  if (!isRecord(record))
    fail("SERVICE_ENVELOPE_KEYS_INVALID", "The public service keyring is invalid.");
  const keys = Object.keys(record).sort();
  const permitted =
    record.notAfter === undefined
      ? ["kid", "notBefore", "publicKeyHex"]
      : ["kid", "notAfter", "notBefore", "publicKeyHex"];
  if (keys.length !== permitted.length || keys.some((key, index) => key !== permitted[index])) {
    fail("SERVICE_ENVELOPE_KEYS_INVALID", "The public service keyring has an unsupported field.");
  }
  if (
    typeof record.kid !== "string" ||
    !KID.test(record.kid) ||
    typeof record.publicKeyHex !== "string" ||
    !HEX.test(record.publicKeyHex) ||
    !Number.isSafeInteger(record.notBefore) ||
    record.notBefore < 0 ||
    (record.notAfter !== undefined &&
      (!Number.isSafeInteger(record.notAfter) || record.notAfter <= record.notBefore))
  ) {
    fail("SERVICE_ENVELOPE_KEYS_INVALID", "The public service keyring is invalid.");
  }
  const normalized = {
    kid: record.kid,
    publicKeyHex: record.publicKeyHex,
    notBefore: record.notBefore,
  };
  if (record.notAfter !== undefined) normalized.notAfter = record.notAfter;
  return normalized;
}

/**
 * Parse only the public verification records the Worker uses at runtime. The
 * resolver deliberately accepts no private/signing material and emits records
 * in declared current-then-previous KID order, independent of caller ordering.
 */
export function canonicalServiceEnvelopeKeys(serialized, staging) {
  if (typeof serialized !== "string" || serialized.length === 0) {
    fail("SERVICE_ENVELOPE_KEYS_MISSING", "The public service keyring is missing.");
  }
  if (serialized.length > MAX_SERVICE_KEYS_BYTES) {
    fail("SERVICE_ENVELOPE_KEYS_TOO_LARGE", "The public service keyring exceeds its bound.");
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    fail("SERVICE_ENVELOPE_KEYS_INVALID", "The public service keyring is not JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    fail("SERVICE_ENVELOPE_KEYS_INVALID", "The public service keyring must contain two records.");
  }
  const records = parsed.map(keyRecord);
  try {
    // This is the Worker runtime's structural contract. Construction imports no
    // keys and performs no provider or network call.
    new VerificationKeyring(records);
  } catch {
    fail("SERVICE_ENVELOPE_KEYS_INVALID", "The public service keyring is invalid.");
  }

  const expectedKids = staging.service_envelope_key_ids;
  if (
    !Array.isArray(expectedKids) ||
    expectedKids.length !== 2 ||
    expectedKids.some((kid) => typeof kid !== "string" || kid.length === 0)
  ) {
    fail("STAGING_SERVICE_KIDS_INVALID", "The declared staging service key ids are invalid.");
  }
  const byKid = new Map(records.map((record) => [record.kid, record]));
  if (
    byKid.size !== expectedKids.length ||
    expectedKids.some((kid) => !byKid.has(kid)) ||
    [...byKid.keys()].some((kid) => !expectedKids.includes(kid))
  ) {
    fail(
      "SERVICE_ENVELOPE_KEYS_INVALID",
      "The public service keyring does not match declared staging key ids.",
    );
  }
  const ordered = expectedKids.map((kid) => byKid.get(kid));
  if (
    ordered[0].notAfter !== undefined ||
    ordered[1].notAfter === undefined ||
    ordered[1].notAfter <= ordered[0].notBefore
  ) {
    fail(
      "SERVICE_ENVELOPE_KEYS_INVALID",
      "The public service keyring does not describe the declared rotation.",
    );
  }
  return JSON.stringify(ordered);
}

/** Read exactly the two deploy inputs. Origin, routes, and R2 remain topology-derived. */
export function readStagingDeployInputs(environment = process.env) {
  return {
    d1DatabaseId: environment[STAGING_D1_INPUT],
    serviceEnvelopeKeys: environment[STAGING_SERVICE_KEYS_INPUT],
  };
}

/** Select the one generated template the staging-only resolver may consume. */
export function requireGeneratedStagingTemplate(rendered) {
  const expected = rendered[STAGING_TEMPLATE_PATH];
  if (typeof expected !== "string") {
    fail("GENERATED_STAGING_CONFIG_MISSING", "The generated staging template is unavailable.");
  }
  return expected;
}

function validatedGeneratedTemplate(root) {
  let report;
  try {
    report = validateEnvironments(root);
  } catch (error) {
    if (error instanceof EnvironmentValidationError) {
      fail("STAGING_TOPOLOGY_INVALID", "The environment topology failed validation.");
    }
    fail("STAGING_TOPOLOGY_INVALID", "The environment topology is unavailable.");
  }
  const expected = requireGeneratedStagingTemplate(renderAll(report));
  const templatePath = existingContainedFile(
    root,
    STAGING_TEMPLATE_PATH,
    "GENERATED_STAGING_CONFIG_MISSING",
  );
  const actual = readBounded(templatePath, "GENERATED_STAGING_CONFIG_INVALID");
  if (actual !== expected) {
    fail(
      "GENERATED_STAGING_CONFIG_DRIFT",
      "The generated staging template does not match the validated topology.",
    );
  }
  return { report, contents: actual, ...assertStagingTemplate(report, actual) };
}

function workerRouteOrigin(workerOrigin) {
  let parsed;
  try {
    parsed = new URL(workerOrigin);
  } catch {
    fail("STAGING_ORIGIN_INVALID", "The staging worker origin is invalid.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    fail("STAGING_ORIGIN_INVALID", "The staging worker origin is invalid.");
  }
  return parsed.hostname;
}

/**
 * Resolve the public-delivery bucket without letting a missing or renamed role
 * turn the Worker-vs-R2 hostname collision check into an optional comparison.
 */
export function requireStagingPublicDeliveryBucket(staging) {
  const matches = Array.isArray(staging?.r2)
    ? staging.r2.filter((bucket) => bucket?.role === "public-delivery")
    : [];
  const customDomain = matches[0]?.custom_domain;
  if (
    matches.length !== 1 ||
    typeof customDomain !== "string" ||
    !CANONICAL_HOSTNAME.test(customDomain) ||
    customDomain === workerRouteOrigin(staging?.worker_origin) ||
    customDomain !== staging?.published_hostname
  ) {
    fail(
      "RESOLVED_STAGING_CONFIG_INVALID",
      "The resolved staging configuration has no unique public-delivery bucket.",
    );
  }
  return matches[0];
}

/**
 * Produce deterministic staging deploy bytes without publishing them. This is
 * intentionally pure after its bounded, repository-contained reads.
 */
export function resolveStagingArtifact(root, inputs) {
  const { contents: template, staging } = validatedGeneratedTemplate(root);
  const d1DatabaseId = canonicalD1DatabaseId(inputs?.d1DatabaseId);
  const serviceEnvelopeKeys = canonicalServiceEnvelopeKeys(inputs?.serviceEnvelopeKeys, staging);
  const workerHost = workerRouteOrigin(staging.worker_origin);

  let resolved = replaceExactly(
    template,
    "# GENERATED FROM infra/environments.toml — DO NOT EDIT BY HAND.",
    "# DEPLOY-RESOLVED FROM infra/environments.toml — DO NOT EDIT OR COMMIT.",
    "GENERATED_STAGING_CONFIG_INVALID",
  );
  resolved = replaceExactly(
    resolved,
    "# Environment: staging. Regenerate with: bun infra/generate-wrangler.mjs --write",
    "# Environment: staging. Resolve only with: bun infra/resolve-wrangler-deploy.mjs --env staging --write",
    "GENERATED_STAGING_CONFIG_INVALID",
  );
  resolved = replaceExactly(
    resolved,
    "# Verify with:  bun infra/generate-wrangler.mjs --check",
    "# Source template: bun infra/generate-wrangler.mjs --check",
    "GENERATED_STAGING_CONFIG_INVALID",
  );
  resolved = replaceExactly(
    resolved,
    "workers_dev = false\n",
    `workers_dev = false\n\n# Worker custom domain, derived only from staging worker_origin.\nroutes = [\n  { pattern = ${tomlString(workerHost)}, custom_domain = true },\n]\n`,
    "GENERATED_STAGING_CONFIG_INVALID",
  );
  resolved = replaceExactly(
    resolved,
    `database_id = ${tomlString(STAGING_D1_PLACEHOLDER)}`,
    `database_id = ${tomlString(d1DatabaseId)}`,
    "STAGING_D1_REFERENCE_INVALID",
  );
  resolved = replaceExactly(
    resolved,
    `[vars]\nSTOA_ORIGIN = ${tomlString(staging.worker_origin)}`,
    `[vars]\nSTOA_ORIGIN = ${tomlString(staging.worker_origin)}\nSERVICE_ENVELOPE_KEYS = ${tomlString(serviceEnvelopeKeys)}`,
    "STAGING_ORIGIN_INVALID",
  );

  // Parse our own result so a refactor cannot accidentally turn the R2 public
  // hostname into a Worker route or resurrect the deferred Herald binding.
  let parsed;
  try {
    parsed = Bun.TOML.parse(resolved);
  } catch {
    fail("RESOLVED_STAGING_CONFIG_INVALID", "The resolved staging configuration is not TOML.");
  }
  const publicBucket = requireStagingPublicDeliveryBucket(staging);
  if (
    !Array.isArray(parsed.routes) ||
    parsed.routes.length !== 1 ||
    parsed.routes[0]?.pattern !== workerHost ||
    parsed.routes[0]?.custom_domain !== true ||
    parsed.routes[0]?.pattern === publicBucket.custom_domain ||
    parsed.d1_databases?.[0]?.database_id !== d1DatabaseId ||
    parsed.vars?.STOA_ORIGIN !== staging.worker_origin ||
    parsed.vars?.SERVICE_ENVELOPE_KEYS !== serviceEnvelopeKeys ||
    (parsed.durable_objects?.bindings ?? []).some(
      (binding) => binding.name === staging.durable_objects.binding,
    )
  ) {
    fail(
      "RESOLVED_STAGING_CONFIG_INVALID",
      "The resolved staging configuration is not topology-safe.",
    );
  }
  return resolved;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function closeQuietly(descriptor) {
  try {
    closeSync(descriptor);
  } catch {
    // The caller is already following a fail-closed path.
  }
}

function assertNamedOutputParent(root, parent) {
  let named;
  let physicalRoot;
  let physicalParent;
  try {
    named = lstatSync(parent.path);
    physicalRoot = repositoryRoot(resolve(root));
    physicalParent = realpathSync(parent.path);
  } catch {
    fail("OUTPUT_PATH_CHANGED", "The fixed output parent changed during publication.");
  }
  if (
    named.isSymbolicLink() ||
    !named.isDirectory() ||
    !sameIdentity(named, parent.identity) ||
    isOutside(physicalRoot, physicalParent)
  ) {
    fail("OUTPUT_PATH_CHANGED", "The fixed output parent changed during publication.");
  }
}

function outputParent(root) {
  const absoluteRoot = resolve(root);
  const parent = resolve(absoluteRoot, dirname(STAGING_OUTPUT_PATH));
  if (isOutside(absoluteRoot, parent))
    fail("OUTPUT_PATH_UNSAFE", "The fixed output location is unsafe.");
  try {
    mkdirSync(parent, { recursive: true });
  } catch {
    fail("OUTPUT_PATH_UNSAFE", "The fixed output parent is unavailable.");
  }
  let stat;
  let physicalRoot;
  let physicalParent;
  try {
    stat = lstatSync(parent);
    physicalRoot = repositoryRoot(absoluteRoot);
    physicalParent = realpathSync(parent);
  } catch {
    fail("OUTPUT_PATH_UNSAFE", "The fixed output parent is unavailable.");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || isOutside(physicalRoot, physicalParent)) {
    fail("OUTPUT_PATH_UNSAFE", "The fixed output parent is unsafe.");
  }
  let descriptor;
  try {
    descriptor = openSync(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const identity = fstatSync(descriptor);
    const named = lstatSync(parent);
    const openedPhysicalParent = realpathSync(parent);
    if (
      !identity.isDirectory() ||
      named.isSymbolicLink() ||
      !named.isDirectory() ||
      !sameIdentity(identity, named) ||
      isOutside(physicalRoot, openedPhysicalParent)
    ) {
      closeQuietly(descriptor);
      fail("OUTPUT_PATH_UNSAFE", "The fixed output parent is unsafe.");
    }
    return { descriptor, identity, path: parent };
  } catch (error) {
    if (descriptor !== undefined) closeQuietly(descriptor);
    if (error instanceof DeployResolutionError) throw error;
    fail("OUTPUT_PATH_UNSAFE", "The fixed output parent is unavailable.");
  }
}

function openOutputAt(parentDescriptor, flags) {
  if (OPEN_AT_LIBRARY === undefined) {
    fail(
      "OUTPUT_PUBLICATION_UNSUPPORTED",
      "Race-safe artifact publication is unavailable on this runtime.",
    );
  }
  const descriptor = OPEN_AT_LIBRARY.symbols.openat(parentDescriptor, OUTPUT_BASENAME_C, flags, 0);
  return descriptor >= 0 ? descriptor : undefined;
}

function existingArtifact(parentDescriptor) {
  const descriptor = openOutputAt(
    parentDescriptor,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  if (descriptor === undefined) return undefined;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) {
      fail("OUTPUT_ARTIFACT_UNSAFE", "The fixed output artifact is unsafe.");
    }
    return readFileSync(descriptor, "utf8");
  } catch (error) {
    if (error instanceof DeployResolutionError) throw error;
    fail("OUTPUT_ARTIFACT_UNSAFE", "The fixed output artifact is unavailable.");
  } finally {
    closeQuietly(descriptor);
  }
}

/**
 * Publish exactly one new artifact with O_EXCL. Existing equal bytes are an
 * idempotent success; different bytes and links are refusals. We intentionally
 * never rename over, truncate, or delete an artifact: a caller must make an
 * explicit, separately authorized replacement decision.
 */
export function publishResolvedStagingArtifact(root, contents, hooks = {}) {
  if (typeof contents !== "string" || Buffer.byteLength(contents, "utf8") > MAX_ARTIFACT_BYTES) {
    fail("OUTPUT_ARTIFACT_INVALID", "The resolved staging artifact is invalid.");
  }
  const parent = outputParent(root);
  try {
    const prior = existingArtifact(parent.descriptor);
    if (prior !== undefined) {
      assertNamedOutputParent(root, parent);
      if (prior === contents) return { published: false, idempotent: true };
      fail("OUTPUT_ARTIFACT_EXISTS_DIFFERENT", "A different fixed output artifact already exists.");
    }

    let descriptor = openOutputAt(
      parent.descriptor,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    );
    if (descriptor === undefined) {
      const raced = existingArtifact(parent.descriptor);
      if (raced === contents) {
        assertNamedOutputParent(root, parent);
        return { published: false, idempotent: true };
      }
      if (raced !== undefined) {
        fail(
          "OUTPUT_ARTIFACT_EXISTS_DIFFERENT",
          "A different fixed output artifact already exists.",
        );
      }
      fail("OUTPUT_ARTIFACT_UNSAFE", "The fixed output artifact is unsafe.");
    }

    try {
      // openat(2) created the fixed basename relative to the held directory
      // identity, so replacing the pathname cannot redirect the descriptor.
      // Containment is revalidated below before these bytes are committed.
      fchmodSync(descriptor, 0o600);
      if (hooks.beforeWrite !== undefined) {
        if (typeof hooks.beforeWrite !== "function") {
          fail("OUTPUT_ARTIFACT_INVALID", "The publication hook is invalid.");
        }
        hooks.beforeWrite({ outputParent: parent.path });
      }
      // Re-prove that the held directory still has the fixed repository path
      // after the only in-process mutation seam and before committing bytes.
      // An unrelated process can still rename a directory in the microscopic
      // interval between this check and write(2); preventing that requires a
      // stronger platform primitive than Node/Bun currently exposes here.
      assertNamedOutputParent(root, parent);
      writeFileSync(descriptor, contents, "utf8");
      fsyncSync(descriptor);
    } catch (error) {
      if (error instanceof DeployResolutionError) throw error;
      fail("OUTPUT_ARTIFACT_PUBLISH_FAILED", "The fixed output artifact could not be published.");
    } finally {
      closeQuietly(descriptor);
      descriptor = undefined;
    }
    fsyncSync(parent.descriptor);
    assertNamedOutputParent(root, parent);
    return { published: true, idempotent: false };
  } finally {
    if (parent.descriptor !== undefined) {
      try {
        closeSync(parent.descriptor);
      } catch {
        // Publication has already failed closed or durably completed.
      }
    }
  }
}

export function parseResolverArguments(argv) {
  let environment;
  let mode;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--env") {
      if (environment !== undefined || index + 1 >= argv.length) {
        fail("INVALID_ARGUMENT", "Resolver arguments are invalid.");
      }
      environment = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--check" || argument === "--write") {
      if (mode !== undefined) fail("INVALID_ARGUMENT", "Resolver arguments are invalid.");
      mode = argument.slice(2);
      continue;
    }
    fail("INVALID_ARGUMENT", "Resolver arguments are invalid.");
  }
  if (environment !== STAGING_ENVIRONMENT) {
    fail("STAGING_ENVIRONMENT_REQUIRED", "Only staging deploy resolution is supported.");
  }
  if (mode !== "check" && mode !== "write") {
    fail("INVALID_ARGUMENT", "Resolver arguments are invalid.");
  }
  return { environment, mode };
}

export function resolutionDiagnostic(status, startedAt, details = {}) {
  return {
    tool: "bun",
    package: "infra",
    suite: "staging-wrangler-deploy-resolution",
    version: Bun.version,
    duration_ms: Math.round(performance.now() - startedAt),
    status,
    environment: STAGING_ENVIRONMENT,
    ...details,
  };
}

function main() {
  const startedAt = performance.now();
  try {
    const { mode } = parseResolverArguments(process.argv.slice(2));
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const resolved = resolveStagingArtifact(root, readStagingDeployInputs());
    if (mode === "write") {
      const publication = publishResolvedStagingArtifact(root, resolved);
      process.stdout.write(
        `${JSON.stringify(resolutionDiagnostic("pass", startedAt, { mode, ...publication }))}\n`,
      );
      return;
    }
    process.stdout.write(
      `${JSON.stringify(resolutionDiagnostic("pass", startedAt, { mode, resolved: true }))}\n`,
    );
  } catch (error) {
    const code = error instanceof DeployResolutionError ? error.code : "UNEXPECTED";
    process.stderr.write(`${JSON.stringify(resolutionDiagnostic("fail", startedAt, { code }))}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
