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
];

const SENSITIVE_ENV_NAME = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|COOKIE|AUTH|CREDENTIAL|SESSION/i;

function sensitiveEnvValues(env: Record<string, string | undefined>): readonly string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value.length >= 8 && SENSITIVE_ENV_NAME.test(name)) values.push(value);
  }
  return values;
}

/**
 * Throw unless every string field of `record` is safe to commit to a build log.
 * Called before every emit; a failure is a defect in the caller, not a warning.
 */
export function assertSecretSafe(
  record: SuiteDiagnostic,
  env: Record<string, string | undefined> = process.env,
): void {
  const secrets = sensitiveEnvValues(env);
  for (const [field, value] of Object.entries(record)) {
    if (typeof value !== "string") continue;
    if (ABSOLUTE_PATH.test(value)) {
      throw new DiagnosticSafetyError(field, "contains a local absolute path");
    }
    for (const shape of CREDENTIAL_SHAPES) {
      if (shape.test(value)) throw new DiagnosticSafetyError(field, "contains a credential-shaped string");
    }
    for (const secret of secrets) {
      if (value.includes(secret)) throw new DiagnosticSafetyError(field, "contains an environment secret value");
    }
  }
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
