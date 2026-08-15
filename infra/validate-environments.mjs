import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

/**
 * Environment topology validator (bead asimposiumorg-p1g, OPS.3).
 *
 * Reads `infra/environments.toml` and enforces the separation rules that make a
 * staging plane safe to deploy and a production plane safe to leave alone. It
 * is a static check: it opens no socket, holds no credential, and proves
 * nothing about resources that may or may not exist in a Cloudflare account.
 *
 * Runs under the repository's pinned Bun (semantic TOML parsing, matching
 * validate-scaffold.mjs).
 */

export class EnvironmentValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "EnvironmentValidationError";
  }
}

function fail(code, message) {
  throw new EnvironmentValidationError(code, message);
}

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function isOutside(root, target) {
  const relation = relative(root, target);
  return relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation);
}

/**
 * Contain a caller-supplied path inside the repository, lexically and then
 * physically.
 *
 * The lexical check stops `../../etc/passwd`. The physical check stops the same
 * escape wearing a symlink: `resolve()` is purely textual, so a symlinked
 * directory anywhere in the path resolves to an in-repo string while the real
 * file sits outside. Both checks are needed; neither is sufficient alone.
 */
export function assertRepositoryContained(root, workspacePath, label) {
  if (isAbsolute(workspacePath)) {
    fail("PATH_ESCAPE", `${label} must be repository-relative.`);
  }
  const target = resolve(root, workspacePath);
  if (isOutside(root, target)) {
    fail("PATH_ESCAPE", `${label} resolves outside the repository.`);
  }
  if (!existsSync(target)) {
    return target;
  }
  let physicalRoot;
  let physicalTarget;
  try {
    physicalRoot = realpathSync(root);
    physicalTarget = realpathSync(target);
  } catch {
    fail("PATH_ESCAPE", `${label} could not be resolved to a real repository path.`);
  }
  if (isOutside(physicalRoot, physicalTarget)) {
    fail("PATH_ESCAPE", `${label} resolves outside the repository after symlink resolution.`);
  }
  return target;
}

/**
 * Close a table to exactly the keys it is allowed to carry.
 *
 * An unknown key is a refusal rather than something ignored: a misspelled
 * `custom_domian` that is silently dropped reads as "no public domain" and
 * would quietly pass the rule it was meant to trip.
 */
function assertExactKeys(record, allowed, source) {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      fail(
        "UNKNOWN_CONFIG_KEY",
        `${source} carries unknown key "${key}"; allowed keys are ${allowed.join(", ")}.`,
      );
    }
  }
}

const ROOT_KEYS = ["schema_version", "policy", "vercel", "env"];
const POLICY_KEYS = [
  "required_r2_roles",
  "publishable_role",
  "production_artifact_hostname",
  "rollback_policy",
  "outbox_cron",
  "required_bindings",
];
const VERCEL_KEYS = ["production_environment", "preview_environment"];
const ENVIRONMENT_KEYS = [
  "kind",
  "worker_origin",
  "is_preview",
  "may_hold_production_keys",
  "destructive_operations_allowed",
  "d1",
  "r2",
  "durable_objects",
  "outbox",
  "keys",
];
const D1_KEYS = ["binding", "database_name", "database_id"];
const R2_KEYS = ["binding", "role", "bucket_name", "custom_domain"];
const DURABLE_OBJECT_KEYS = ["binding", "class_name", "script_namespace"];
const OUTBOX_KEYS = ["binding", "class_name"];
const KEY_KEYS = [
  "current_kid",
  "previous_kid",
  "service_envelope_current_kid",
  "service_envelope_previous_kid",
];

/** Local dev may use loopback http; anything remote must be https. */
const WORKER_ORIGIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$|^http:\/\/127\.0\.0\.1:\d{2,5}$/;

/** `${VAR}` deploy-time reference — the only legal id form for a remote env. */
const VAR_REFERENCE = /^\$\{[A-Z][A-Z0-9_]*\}$/;
/** The documented local sentinel. */
const ZERO_SENTINEL = "00000000-0000-0000-0000-000000000000";
/** Public identifier, deliberately narrow so a key body can never pass as one. */
const KID = /^[a-z][a-z0-9-]{2,39}$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const RESOURCE_NAME = /^[a-z][a-z0-9-]{2,63}$/;
const BINDING_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const CLASS_NAME = /^[A-Z][A-Za-z0-9]{1,63}$/;

/**
 * Credential shapes. This is the "no secrets in the repo" gate: the topology
 * file is committed, so anything key-shaped in it is a leak by construction.
 */
const CREDENTIAL_SHAPES = [
  [/-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)/, "a PEM block"],
  [/\basimp_ag_[A-Za-z0-9]/, "a Fellow bearer token"],
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/, "a provider secret key"],
  [/\bghp_[A-Za-z0-9]{20,}/, "a GitHub token"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, "a JWT"],
  [/\b[A-Fa-f0-9]{64,}\b/, "a long hex secret"],
  [/\b[A-Za-z0-9+/]{60,}={0,2}\b/, "a long base64 blob"],
];

/**
 * Control bytes have no business in a configuration file.
 *
 * This exists because a NUL byte reached this very source file through a
 * scripted edit and turned it into `data` as far as `file(1)` and git were
 * concerned — silently, because nothing looked for one. A NUL also truncates
 * strings in a good deal of downstream tooling, so a value like
 * `asimposium-artifacts-prod\0-decoy` can read as one name to a validator and
 * another to whatever consumes it later.
 *
 * Tab, newline and carriage return are the only C0 bytes a TOML file needs.
 */
const ALLOWED_CONTROL_BYTES = new Set(["\t", "\n", "\r"]);

export function findControlBytes(text) {
  const found = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const code = character.codePointAt(0);
    if ((code <= 0x1f || code === 0x7f) && !ALLOWED_CONTROL_BYTES.has(character)) {
      found.push({ offset: index, code });
    }
  }
  return found;
}

function assertNoControlBytes(text, source) {
  const found = findControlBytes(text);
  if (found.length > 0) {
    const first = found[0];
    // Report the position and the code point, never the surrounding bytes: the
    // neighbourhood of a control byte is exactly where a smuggled value sits.
    fail(
      "CONTROL_BYTE_IN_CONFIG",
      `${source} contains a control byte (U+${first.code.toString(16).toUpperCase().padStart(4, "0")}) at offset ${first.offset}; ${found.length} found in total.`,
    );
  }
}

function assertNoCredentialShapes(text, source) {
  for (const [pattern, description] of CREDENTIAL_SHAPES) {
    if (pattern.test(text)) {
      // The matched text is never echoed: reporting it would put the secret in
      // the log this check exists to keep clean.
      fail("CREDENTIAL_IN_REPOSITORY", `${source} contains what looks like ${description}.`);
    }
  }
}

function parseToml(content, source) {
  try {
    const parsed = Bun.TOML.parse(content);
    if (!isRecord(parsed)) {
      fail("MALFORMED_TOML", `${source} must parse to a TOML object.`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof EnvironmentValidationError) throw error;
    fail("MALFORMED_TOML", `${source} must be valid TOML.`);
  }
}

function requireString(record, key, source, pattern, label) {
  const value = record[key];
  if (typeof value !== "string") {
    fail("MISSING_CONFIG_KEY", `${source} must define ${key} as a string.`);
  }
  if (pattern && !pattern.test(value)) {
    fail("UNSAFE_CONFIG_VALUE", `${source} ${key} must be ${label}.`);
  }
  return value;
}

function requireBoolean(record, key, source) {
  const value = record[key];
  if (typeof value !== "boolean") {
    fail("MISSING_CONFIG_KEY", `${source} must define ${key} as a boolean.`);
  }
  return value;
}

function requireRecord(record, key, source) {
  const value = record[key];
  if (!isRecord(value)) {
    fail("MISSING_CONFIG_TABLE", `${source} must define [${key}] as a table.`);
  }
  return value;
}

/** Records a uniqueness claim; the second claimant of a value is the failure. */
function claim(registry, kind, value, environment) {
  const key = `${kind}:${value}`;
  const held = registry.get(key);
  if (held !== undefined) {
    fail(
      "SHARED_RESOURCE",
      `${kind} "${value}" is used by both ${held} and ${environment}; environments must not share resources.`,
    );
  }
  registry.set(key, environment);
}

function validateD1(d1, name, source, registry, kind) {
  assertExactKeys(d1, D1_KEYS, source);
  const binding = requireString(d1, "binding", source, BINDING_NAME, "an uppercase binding name");
  const databaseName = requireString(
    d1,
    "database_name",
    source,
    RESOURCE_NAME,
    "a lowercase resource name",
  );
  const databaseId = requireString(d1, "database_id", source);

  if (kind === "local") {
    if (databaseId !== ZERO_SENTINEL) {
      fail(
        "UNSAFE_CONFIG_VALUE",
        `${source} database_id must be the all-zero sentinel for a local environment.`,
      );
    }
  } else if (!VAR_REFERENCE.test(databaseId)) {
    // A literal id here would mean a real resource identifier was committed.
    fail(
      "LITERAL_RESOURCE_ID",
      `${source} database_id must be a \${VAR} deploy-time reference for a remote environment, not a literal id.`,
    );
  }

  claim(registry, "d1 database_name", databaseName, name);
  claim(registry, "d1 database_id", databaseId, name);
  return { binding, database_name: databaseName, database_id: databaseId };
}

function validateR2(entries, name, source, registry, policy) {
  if (!Array.isArray(entries)) {
    fail("MISSING_CONFIG_TABLE", `${source} must define [[env.${name}.r2]] entries.`);
  }
  const buckets = [];
  const seenRoles = new Set();

  for (const [index, entry] of entries.entries()) {
    const where = `${source} r2[${index}]`;
    if (!isRecord(entry)) fail("UNSAFE_CONFIG_TABLE", `${where} must be a table.`);
    assertExactKeys(entry, R2_KEYS, where);

    const binding = requireString(
      entry,
      "binding",
      where,
      BINDING_NAME,
      "an uppercase binding name",
    );
    const role = requireString(entry, "role", where);
    const bucketName = requireString(
      entry,
      "bucket_name",
      where,
      RESOURCE_NAME,
      "a lowercase resource name",
    );
    const customDomain = requireString(entry, "custom_domain", where);

    if (!policy.required_r2_roles.includes(role)) {
      fail(
        "UNKNOWN_R2_ROLE",
        `${where} role "${role}" is not one of ${policy.required_r2_roles.join(", ")}.`,
      );
    }
    if (seenRoles.has(role)) {
      fail("DUPLICATE_R2_ROLE", `${source} declares the R2 role "${role}" more than once.`);
    }
    seenRoles.add(role);

    // The rule the bead is built around: a private bucket is reachable only
    // through the authenticated Worker binding. A custom domain on it would put
    // every private object one URL guess away from the public internet.
    if (role !== policy.publishable_role && customDomain !== "") {
      fail(
        "PRIVATE_BUCKET_PUBLISHED",
        `${where} has role "${role}" and a custom domain; only the "${policy.publishable_role}" role may be published.`,
      );
    }
    if (role === policy.publishable_role && customDomain !== "") {
      if (!HOSTNAME.test(customDomain)) {
        fail("UNSAFE_CONFIG_VALUE", `${where} custom_domain must be a hostname.`);
      }
      claim(registry, "r2 custom_domain", customDomain, name);
    }

    claim(registry, "r2 bucket_name", bucketName, name);
    buckets.push({ binding, role, bucket_name: bucketName, custom_domain: customDomain });
  }

  for (const role of policy.required_r2_roles) {
    if (!seenRoles.has(role)) {
      fail("MISSING_R2_ROLE", `${source} does not declare the required R2 role "${role}".`);
    }
  }
  return buckets;
}

function validateDurableObjects(durableObjects, name, source, registry) {
  assertExactKeys(durableObjects, DURABLE_OBJECT_KEYS, source);
  const binding = requireString(
    durableObjects,
    "binding",
    source,
    BINDING_NAME,
    "an uppercase binding name",
  );
  const className = requireString(durableObjects, "class_name", source, CLASS_NAME, "a class name");
  const namespace = requireString(
    durableObjects,
    "script_namespace",
    source,
    RESOURCE_NAME,
    "a lowercase resource name",
  );
  claim(registry, "durable object script_namespace", namespace, name);
  return { binding, class_name: className, script_namespace: namespace };
}

function validateOutbox(outbox, source) {
  assertExactKeys(outbox, OUTBOX_KEYS, source);
  return {
    binding: requireString(outbox, "binding", source, BINDING_NAME, "an uppercase binding name"),
    class_name: requireString(outbox, "class_name", source, CLASS_NAME, "a class name"),
  };
}

function validateKeys(keys, name, source, registry, isPreview, mayHoldProductionKeys) {
  assertExactKeys(keys, KEY_KEYS, source);
  const currentKid = requireString(keys, "current_kid", source, KID, "a lowercase key id");
  const previousKid = requireString(keys, "previous_kid", source);
  if (previousKid !== "" && !KID.test(previousKid)) {
    fail("UNSAFE_CONFIG_VALUE", `${source} previous_kid must be a lowercase key id or empty.`);
  }

  // The service-envelope key signs Agora → Worker calls (Fable §14.1). It is a
  // different key from the content-signing key and must never be the same id,
  // or a compromise of one silently becomes a compromise of both.
  const serviceCurrent = requireString(
    keys,
    "service_envelope_current_kid",
    source,
    KID,
    "a lowercase key id",
  );
  const servicePrevious = requireString(keys, "service_envelope_previous_kid", source);
  if (servicePrevious !== "" && !KID.test(servicePrevious)) {
    fail(
      "UNSAFE_CONFIG_VALUE",
      `${source} service_envelope_previous_kid must be a lowercase key id or empty.`,
    );
  }
  if (servicePrevious !== "" && servicePrevious === serviceCurrent) {
    fail(
      "KID_OVERLAP_INVALID",
      `${source} service_envelope_previous_kid must differ from service_envelope_current_kid to form a rotation overlap.`,
    );
  }
  for (const serviceKid of [serviceCurrent, servicePrevious]) {
    if (serviceKid !== "" && (serviceKid === currentKid || serviceKid === previousKid)) {
      fail(
        "KEY_ROLE_COLLISION",
        `${source} reuses "${serviceKid}" as both a signing key and a service-envelope key; the two roles must not share a key id.`,
      );
    }
  }
  // Overlap is the point of carrying two: during rotation both verify. Two
  // identical kids is not an overlap window, it is a typo.
  if (previousKid !== "" && previousKid === currentKid) {
    fail(
      "KID_OVERLAP_INVALID",
      `${source} previous_kid must differ from current_kid to form a rotation overlap.`,
    );
  }
  if (isPreview && mayHoldProductionKeys) {
    fail(
      "PREVIEW_HOLDS_PRODUCTION_KEYS",
      `${source} is a preview environment and must not be permitted to hold production keys.`,
    );
  }
  // A kid is an identifier, so a shared kid means a shared key.
  claim(registry, "key kid", currentKid, name);
  if (previousKid !== "") claim(registry, "key kid", previousKid, name);
  claim(registry, "key kid", serviceCurrent, name);
  if (servicePrevious !== "") claim(registry, "key kid", servicePrevious, name);
  return {
    current_kid: currentKid,
    previous_kid: previousKid,
    service_envelope_current_kid: serviceCurrent,
    service_envelope_previous_kid: servicePrevious,
  };
}

export function validateEnvironments(
  rootDirectory,
  configWorkspacePath = "infra/environments.toml",
) {
  const root = resolve(rootDirectory);
  const configPath = assertRepositoryContained(
    root,
    configWorkspacePath,
    "The environment topology path",
  );
  if (!existsSync(configPath)) {
    fail("MISSING_CONFIG_FILE", `Expected ${configWorkspacePath}.`);
  }
  // Containment above already resolved symlinks; what remains is to refuse a
  // non-regular file (fifo, device, socket), which could block the read or hand
  // back something that is not a configuration.
  if (!lstatSync(realpathSync(configPath)).isFile()) {
    fail("UNSAFE_CONFIG_FILE", "The environment topology path must be a regular file.");
  }

  const raw = readFileSync(configPath, "utf8");
  // Before anything parses or pattern-matches: a control byte can make one
  // reader see a different value than the next.
  assertNoControlBytes(raw, configWorkspacePath);
  assertNoCredentialShapes(raw, configWorkspacePath);
  const parsed = parseToml(raw, configWorkspacePath);

  assertExactKeys(parsed, ROOT_KEYS, configWorkspacePath);
  if (parsed.schema_version !== 1) {
    fail("UNSUPPORTED_SCHEMA", `${configWorkspacePath} must declare schema_version = 1.`);
  }

  const policyTable = requireRecord(parsed, "policy", configWorkspacePath);
  assertExactKeys(policyTable, POLICY_KEYS, `${configWorkspacePath} [policy]`);
  const requiredRoles = policyTable.required_r2_roles;
  if (
    !Array.isArray(requiredRoles) ||
    requiredRoles.length === 0 ||
    !requiredRoles.every((r) => typeof r === "string")
  ) {
    fail(
      "MISSING_CONFIG_KEY",
      `${configWorkspacePath} policy.required_r2_roles must be a non-empty string array.`,
    );
  }
  const policy = {
    required_r2_roles: requiredRoles,
    publishable_role: requireString(
      policyTable,
      "publishable_role",
      `${configWorkspacePath} policy`,
    ),
    production_artifact_hostname: requireString(
      policyTable,
      "production_artifact_hostname",
      `${configWorkspacePath} policy`,
      HOSTNAME,
      "a hostname",
    ),
    rollback_policy: requireString(policyTable, "rollback_policy", `${configWorkspacePath} policy`),
    outbox_cron: requireString(policyTable, "outbox_cron", `${configWorkspacePath} policy`),
    required_bindings: policyTable.required_bindings,
  };
  if (
    !Array.isArray(policy.required_bindings) ||
    policy.required_bindings.length === 0 ||
    !policy.required_bindings.every((b) => typeof b === "string" && BINDING_NAME.test(b))
  ) {
    fail(
      "MISSING_CONFIG_KEY",
      `${configWorkspacePath} policy.required_bindings must be a non-empty array of binding names.`,
    );
  }
  if (!requiredRoles.includes(policy.publishable_role)) {
    fail(
      "UNKNOWN_R2_ROLE",
      `${configWorkspacePath} policy.publishable_role must appear in required_r2_roles.`,
    );
  }
  if (policy.rollback_policy !== "forward-only") {
    fail(
      "UNSAFE_ROLLBACK_POLICY",
      `${configWorkspacePath} policy.rollback_policy must be "forward-only"; down-migrations are not supported.`,
    );
  }
  if (policy.outbox_cron !== "*/5 * * * *") {
    fail(
      "UNSAFE_OUTBOX_CRON",
      `${configWorkspacePath} policy.outbox_cron must be "*/5 * * * *" so recovery is bounded to five minutes.`,
    );
  }

  const envTable = requireRecord(parsed, "env", configWorkspacePath);
  const names = Object.keys(envTable);
  for (const required of ["local", "staging", "production"]) {
    if (!names.includes(required)) {
      fail("MISSING_ENVIRONMENT", `${configWorkspacePath} must define [env.${required}].`);
    }
  }

  const registry = new Map();
  const environments = {};

  for (const name of names) {
    const source = `${configWorkspacePath} [env.${name}]`;
    const entry = envTable[name];
    if (!isRecord(entry)) fail("UNSAFE_CONFIG_TABLE", `${source} must be a table.`);
    assertExactKeys(entry, ENVIRONMENT_KEYS, source);

    const kind = requireString(entry, "kind", source);
    if (kind !== "local" && kind !== "remote") {
      fail("UNSAFE_CONFIG_VALUE", `${source} kind must be "local" or "remote".`);
    }
    const workerOrigin = requireString(
      entry,
      "worker_origin",
      source,
      WORKER_ORIGIN,
      "an https origin (or loopback http for local)",
    );
    if (kind === "remote" && !workerOrigin.startsWith("https://")) {
      fail(
        "UNSAFE_CONFIG_VALUE",
        `${source} worker_origin must be https for a remote environment.`,
      );
    }
    // Two environments answering on one origin is the same class of mistake as
    // two environments sharing a bucket.
    claim(registry, "worker origin", workerOrigin, name);
    const isPreview = requireBoolean(entry, "is_preview", source);
    const mayHoldProductionKeys = requireBoolean(entry, "may_hold_production_keys", source);
    const destructiveAllowed = requireBoolean(entry, "destructive_operations_allowed", source);

    if (name === "production" && !mayHoldProductionKeys) {
      fail(
        "UNSAFE_CONFIG_VALUE",
        `${source} production must be permitted to hold production keys.`,
      );
    }
    if (name !== "production" && mayHoldProductionKeys) {
      fail(
        "PRODUCTION_KEYS_OUTSIDE_PRODUCTION",
        `${source} must not be permitted to hold production keys; only production may.`,
      );
    }
    // A destructive operation against production is never a routine deploy step.
    if (name === "production" && destructiveAllowed) {
      fail("PRODUCTION_DESTRUCTIVE_ALLOWED", `${source} must not allow destructive operations.`);
    }

    const d1 = validateD1(requireRecord(entry, "d1", source), name, `${source}.d1`, registry, kind);
    const r2 = validateR2(entry.r2, name, source, registry, policy);
    const durableObjects = validateDurableObjects(
      requireRecord(entry, "durable_objects", source),
      name,
      `${source}.durable_objects`,
      registry,
    );
    const outbox = validateOutbox(requireRecord(entry, "outbox", source), `${source}.outbox`);
    const keys = validateKeys(
      requireRecord(entry, "keys", source),
      name,
      `${source}.keys`,
      registry,
      isPreview,
      mayHoldProductionKeys,
    );

    const published = r2.find((b) => b.role === policy.publishable_role);
    if (name === "production") {
      if (published.custom_domain !== policy.production_artifact_hostname) {
        fail(
          "ARTIFACT_HOSTNAME_MISMATCH",
          `${source} must publish ${policy.production_artifact_hostname} from its "${policy.publishable_role}" bucket.`,
        );
      }
    } else if (published.custom_domain === policy.production_artifact_hostname) {
      fail(
        "ARTIFACT_HOSTNAME_MISMATCH",
        `${source} must not claim ${policy.production_artifact_hostname}; that hostname belongs to production.`,
      );
    }

    // The binding roster is the Worker's contract with every environment: the
    // exact set, so a missing PUBLIC_ARTIFACTS or an extra stray binding is a
    // refusal rather than a surprise at deploy time.
    const declaredBindings = [
      d1.binding,
      ...r2.map((b) => b.binding),
      durableObjects.binding,
      outbox.binding,
    ].sort();
    const requiredBindings = [...policy.required_bindings].sort();
    if (declaredBindings.join(",") !== requiredBindings.join(",")) {
      fail(
        "BINDING_SET_MISMATCH",
        `${source} binds ${declaredBindings.join(", ")}; policy.required_bindings is ${requiredBindings.join(", ")}.`,
      );
    }

    environments[name] = {
      kind,
      worker_origin: workerOrigin,
      is_preview: isPreview,
      may_hold_production_keys: mayHoldProductionKeys,
      destructive_operations_allowed: destructiveAllowed,
      d1,
      r2,
      durable_objects: durableObjects,
      outbox,
      keys,
    };
  }

  // Parity is by ROLE, never by resource name: the Worker's code path must be
  // identical everywhere, while the resources behind it must be disjoint.
  const reference = "production";
  const referenceRoles = new Map(environments[reference].r2.map((b) => [b.role, b.binding]));
  for (const [name, environment] of Object.entries(environments)) {
    if (name === reference) continue;
    const source = `${configWorkspacePath} [env.${name}]`;
    for (const [role, binding] of referenceRoles) {
      const match = environment.r2.find((b) => b.role === role);
      if (match === undefined) {
        fail(
          "BINDING_PARITY_MISMATCH",
          `${source} is missing the "${role}" R2 role that ${reference} declares.`,
        );
      }
      if (match.binding !== binding) {
        fail(
          "BINDING_PARITY_MISMATCH",
          `${source} binds the "${role}" role as ${match.binding}, but ${reference} binds it as ${binding}; binding names must match by role.`,
        );
      }
    }
    if (environment.d1.binding !== environments[reference].d1.binding) {
      fail("BINDING_PARITY_MISMATCH", `${source} D1 binding must match ${reference}'s.`);
    }
    if (environment.durable_objects.binding !== environments[reference].durable_objects.binding) {
      fail(
        "BINDING_PARITY_MISMATCH",
        `${source} Durable Object binding must match ${reference}'s.`,
      );
    }
    if (
      environment.durable_objects.class_name !== environments[reference].durable_objects.class_name
    ) {
      fail("BINDING_PARITY_MISMATCH", `${source} Durable Object class must match ${reference}'s.`);
    }
    if (environment.outbox.binding !== environments[reference].outbox.binding) {
      fail("BINDING_PARITY_MISMATCH", `${source} outbox binding must match ${reference}'s.`);
    }
    if (environment.outbox.class_name !== environments[reference].outbox.class_name) {
      fail("BINDING_PARITY_MISMATCH", `${source} outbox class must match ${reference}'s.`);
    }
  }

  // Vercel wiring: which environment each deployment target calls. A preview
  // that reaches production is the cross-plane failure ADR-2 exists to prevent.
  const vercelTable = requireRecord(parsed, "vercel", configWorkspacePath);
  assertExactKeys(vercelTable, VERCEL_KEYS, `${configWorkspacePath} [vercel]`);
  const vercel = {
    production_environment: requireString(
      vercelTable,
      "production_environment",
      `${configWorkspacePath} [vercel]`,
    ),
    preview_environment: requireString(
      vercelTable,
      "preview_environment",
      `${configWorkspacePath} [vercel]`,
    ),
  };
  for (const [field, value] of Object.entries(vercel)) {
    if (environments[value] === undefined) {
      fail(
        "UNKNOWN_ENVIRONMENT",
        `${configWorkspacePath} [vercel].${field} names unknown environment "${value}".`,
      );
    }
  }
  if (vercel.production_environment !== "production") {
    fail(
      "VERCEL_WIRING_INVALID",
      `${configWorkspacePath} [vercel].production_environment must be "production".`,
    );
  }
  if (vercel.preview_environment === vercel.production_environment) {
    fail(
      "PREVIEW_TARGETS_PRODUCTION",
      `${configWorkspacePath} [vercel].preview_environment must not be the production environment.`,
    );
  }
  if (!environments[vercel.preview_environment].is_preview) {
    fail(
      "VERCEL_WIRING_INVALID",
      `${configWorkspacePath} [vercel].preview_environment "${vercel.preview_environment}" is not declared is_preview.`,
    );
  }
  if (environments[vercel.preview_environment].may_hold_production_keys) {
    fail(
      "PREVIEW_HOLDS_PRODUCTION_KEYS",
      `${configWorkspacePath} [vercel].preview_environment must not be permitted production keys.`,
    );
  }

  return {
    config: configWorkspacePath,
    policy,
    vercel,
    environments: Object.fromEntries(
      Object.entries(environments).map(([name, environment]) => [
        name,
        {
          kind: environment.kind,
          is_preview: environment.is_preview,
          may_hold_production_keys: environment.may_hold_production_keys,
          destructive_operations_allowed: environment.destructive_operations_allowed,
          worker_origin: environment.worker_origin,
          d1: environment.d1,
          d1_binding: environment.d1.binding,
          r2: environment.r2,
          r2_roles: environment.r2.map((b) => `${b.role}:${b.binding}`),
          published_hostname: environment.r2.find((b) => b.role === policy.publishable_role)
            .custom_domain,
          durable_objects: environment.durable_objects,
          durable_object_binding: environment.durable_objects.binding,
          outbox: environment.outbox,
          key_ids: [environment.keys.current_kid, environment.keys.previous_kid].filter(Boolean),
          service_envelope_key_ids: [
            environment.keys.service_envelope_current_kid,
            environment.keys.service_envelope_previous_kid,
          ].filter(Boolean),
        },
      ]),
    ),
  };
}

/** The environment a caller may act on, or a refusal. Selection is explicit. */
export function selectEnvironment(report, requested) {
  if (requested === undefined || requested === "") {
    fail(
      "ENVIRONMENT_NOT_SELECTED",
      `An environment must be named explicitly: one of ${Object.keys(report.environments).join(", ")}.`,
    );
  }
  const environment = report.environments[requested];
  if (environment === undefined) {
    fail(
      "UNKNOWN_ENVIRONMENT",
      `Unknown environment "${requested}"; expected one of ${Object.keys(report.environments).join(", ")}.`,
    );
  }
  return environment;
}

function diagnostic(status, startedAt, details = {}) {
  return {
    tool: "bun",
    package: "infra",
    suite: "environment-topology-static",
    version: Bun.version,
    duration_ms: Math.round(performance.now() - startedAt),
    status,
    reproduce: "bun infra/validate-environments.mjs",
    ...details,
  };
}

function main() {
  const startedAt = performance.now();
  try {
    const args = process.argv.slice(2);
    let config = "infra/environments.toml";
    if (args.length === 2 && args[0] === "--config") config = args[1];
    else if (args.length !== 0) {
      fail(
        "INVALID_ARGUMENT",
        "Usage: bun infra/validate-environments.mjs [--config <repository-relative-path>]",
      );
    }
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    process.stdout.write(
      `${JSON.stringify(diagnostic("pass", startedAt, validateEnvironments(root, config)))}\n`,
    );
  } catch (error) {
    const details =
      error instanceof EnvironmentValidationError
        ? { code: error.code, detail: error.message }
        : { code: "UNEXPECTED", detail: "Unexpected environment validation failure." };
    process.stderr.write(`${JSON.stringify(diagnostic("fail", startedAt, details))}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
