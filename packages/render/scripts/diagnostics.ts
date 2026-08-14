/**
 * Secret-safe suite diagnostics.
 *
 * Provisional and package-local: the shared harness is OPS.2a
 * (asimposiumorg-233). When it lands, both packages should import that instead
 * of keeping a copy.
 *
 * The record answers the question a build log has to answer: which tool, which
 * package, which suite, which version, how long, pass or fail, and how do I run
 * it again. It answers nothing else — `assertSecretSafe` refuses to emit a
 * record carrying a local absolute path, a credential-shaped string, or the
 * value of a sensitive environment variable.
 */

export interface SuiteDiagnostic {
  readonly tool: string;
  readonly tool_version: string;
  readonly runtime: string;
  readonly package: string;
  readonly suite: string;
  readonly duration_ms: number;
  readonly status: "pass" | "fail";
  readonly exit_code: number;
  /** Repo-relative reproduction command. Never absolute. */
  readonly repro: string;
}

export class DiagnosticSafetyError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`refusing to emit diagnostic: field ${field} ${reason}`);
    this.name = "DiagnosticSafetyError";
    this.field = field;
  }
}

/** POSIX absolute path or Windows drive path appearing anywhere in a value. */
const ABSOLUTE_PATH = /(^|[\s"'=(:])(\/[A-Za-z0-9._~-]+\/|[A-Za-z]:\\)/;

/** Credential shapes this project mints or carries (Fable §5.5, §14.2). */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /asimp_ag_[A-Za-z0-9]/,
  /#v1\.[A-Za-z0-9]/,
  /\bBearer\s+\S/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|rk|pk)(?:[-_](?:live|test))?[-_][A-Za-z0-9_-]{12,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
];

const GENERIC_HIGH_ENTROPY_TOKEN = /[A-Za-z0-9_-]{32,}/g;
const LONG_HEX_TOKEN = /[0-9a-f]{32,}/i;

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SAFE_S5_SEED = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const GIT_REVISION = /^(?:unknown|[0-9a-f]{7,40})$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const FNV1A64_DIGEST = /^fnv1a64:[0-9a-f]{16}$/;
const REPRESENTATION_ETAG = /^(?:W\/)?"sha256:[0-9a-f]{64}"$/;

const SENSITIVE_ENV_NAME = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|COOKIE|AUTH|CREDENTIAL|SESSION/i;

function sensitiveEnvValues(env: Record<string, string | undefined>): readonly string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value.length >= 8 && SENSITIVE_ENV_NAME.test(name))
      values.push(value);
  }
  return values;
}

function hasGenericSecretToken(value: string): boolean {
  for (const match of value.matchAll(GENERIC_HIGH_ENTROPY_TOKEN)) {
    const candidate = match[0];
    // Separators describe ordinary S-5 identifiers such as
    // `s5-s5-long-legitimate-seed-0123-PID`; they do not establish entropy. A generic
    // bearer-looking value must mix upper case and lower case plus either digits or a
    // separator. Validated seed/run_id fields are handled separately below, after known
    // credential families have still been rejected.
    const classes = [/[a-z]/.test(candidate), /[A-Z]/.test(candidate), /\d/.test(candidate)].filter(
      Boolean,
    );
    if (classes.length >= 3) return true;
    if (/[a-z]/.test(candidate) && /[A-Z]/.test(candidate) && /[-_]/.test(candidate)) return true;
  }
  return false;
}

function hasLongHexToken(value: string): boolean {
  return LONG_HEX_TOKEN.test(value);
}

function isExactPublicDigestField(field: string, value: string): boolean {
  if (field === "revision") return GIT_REVISION.test(value);
  if (field === "source_digest") return SHA256_DIGEST.test(value);
  if (["served_digest", "local_digest", "canary_digest"].includes(field))
    return FNV1A64_DIGEST.test(value);
  if (field === "digests") {
    const digest = "(?:fnv1a64:[0-9a-f]{16}|sha256:[0-9a-f]{64})";
    return new RegExp(`^[a-z][a-z-]*=${digest}(?: [a-z][a-z-]*=${digest})*$`).test(value);
  }
  return /(?:^|_)etag$/.test(field) && REPRESENTATION_ETAG.test(value);
}

function assertSafeString(field: string, value: string, secrets: readonly string[]): void {
  if (ABSOLUTE_PATH.test(value)) {
    throw new DiagnosticSafetyError(field, "contains a local absolute path");
  }
  if (CREDENTIAL_SHAPES.some((shape) => shape.test(value)))
    throw new DiagnosticSafetyError(field, "contains a credential-shaped string");
  for (const secret of secrets) {
    if (value.includes(secret))
      throw new DiagnosticSafetyError(field, "contains an environment secret value");
  }
  // A digest is public only in the field whose grammar establishes it as one. A content-only
  // SHA-256 exemption would also admit a raw 64-hex private key in `detail` or a nested
  // response object. Caller-controlled seed/run_id are identifiers only after every same
  // credential, environment-secret, long-hex and entropy check; they are never an exemption.
  if (isExactPublicDigestField(field, value)) return;
  if (hasLongHexToken(value) || hasGenericSecretToken(value))
    throw new DiagnosticSafetyError(field, "contains a credential-shaped string");
}

function assertSafeValue(
  field: string,
  value: unknown,
  secrets: readonly string[],
  seen: WeakSet<object>,
): void {
  if (typeof value === "string") {
    assertSafeString(field, value, secrets);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertSafeValue(`${field}[${index}]`, entry, secrets, seen);
    });
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    assertSafeValue(field === "" ? key : `${field}.${key}`, entry, secrets, seen);
  }
}

/**
 * Throw unless every string field of `record` is safe to commit to a build log.
 * Called before every emit; a failure is a defect in the caller, not a warning.
 */
export function assertSecretSafe(
  // `object` rather than `SuiteDiagnostic`: the scan is structural, and the S-5 spike
  // (asimposiumorg-6jo) emits a wider record. One scanner beats a second copy of these
  // patterns drifting out of step with this one.
  record: object,
  env: Record<string, string | undefined> = process.env,
): void {
  assertSafeValue("", record, sensitiveEnvValues(env), new WeakSet<object>());
}

/** Validate the shared S-5 run identifier before it reaches any diagnostic record. */
export function assertSafeRunId(
  runId: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!SAFE_RUN_ID.test(runId)) {
    throw new DiagnosticSafetyError("run_id", "is not a short safe run identifier");
  }
  assertSecretSafe({ run_id: runId }, env);
}

/** Validate the one S-5 seed grammar before it reaches rendering or a diagnostic record. */
export function assertSafeS5Seed(
  seed: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!SAFE_S5_SEED.test(seed)) {
    throw new DiagnosticSafetyError("seed", "is not a short safe S-5 seed");
  }
  assertSecretSafe({ seed }, env);
}

/** One NDJSON line, key-sorted so build logs diff cleanly. */
export function formatDiagnostic(record: SuiteDiagnostic): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = record[key as keyof SuiteDiagnostic];
  return JSON.stringify(sorted);
}

export interface DiagnosticInput {
  readonly package: string;
  readonly suite: string;
  readonly target: string;
  readonly duration_ms: number;
  readonly exit_code: number;
  readonly tool_version: string;
  readonly runtime: string;
}

export function buildDiagnostic(input: DiagnosticInput): SuiteDiagnostic {
  return {
    tool: "bun test",
    tool_version: input.tool_version,
    runtime: input.runtime,
    package: input.package,
    suite: input.suite,
    duration_ms: input.duration_ms,
    status: input.exit_code === 0 ? "pass" : "fail",
    exit_code: input.exit_code,
    repro: `cd packages/${input.package} && bun test ${input.target}`,
  };
}
