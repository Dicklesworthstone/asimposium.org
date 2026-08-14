/**
 * Structured, secret-safe gate diagnostics.
 *
 * Every quality gate in this package emits exactly one machine-readable record:
 * tool, package, suite, version, duration, status, and a reproduction command
 * that a reader can paste. Nothing else is added, because everything else is a
 * leak risk: Fable §14.3 makes redaction a layer, not a habit, and the OPS.1
 * acceptance criteria forbid environment values, secrets, and local absolute
 * paths in committed output.
 *
 * Pure functions only — `scripts/gate.ts` supplies the process plumbing. This
 * split exists so the redaction layer is unit-testable against planted
 * secret-shaped inputs rather than trusted.
 */

export type GateStatus = "pass" | "fail" | "not_implemented";

export interface GateRecordInput {
  suite: string;
  tool: string;
  toolVersion: string;
  status: GateStatus;
  exitCode: number;
  durationMs: number;
  repro: string;
  /** Present only for `not_implemented`: what must land before this suite can. */
  blockedOn?: string;
  note?: string;
}

export interface GateRecord extends GateRecordInput {
  /** Schema marker so CI can grep one line out of interleaved tool output. */
  gate: 1;
  package: string;
  /** Repository-relative package path. Never an absolute path. */
  packagePath: string;
  runner: string;
  runnerVersion: string;
}

export const GATE_PACKAGE = "@asimposium/web";
export const GATE_PACKAGE_PATH = "apps/web";
export const GATE_PREFIX = "ASIMP-GATE";

/**
 * Redaction layer (Fable §14.3, "never-log list"). Applied to every string that
 * reaches a gate record, and available to callers that need to echo tool output
 * into an artifact.
 *
 * Each pattern is targeted. A greedy "redact anything long" rule would mangle
 * legitimate diagnostics and teach readers to ignore the output.
 */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // Fellow bearer tokens (Fable §5.5) — masked, never printed.
  [/asimp_ag_[A-Za-z0-9_-]+/g, "asimp_ag_<redacted>"],
  // Enrollment secret from a join URL fragment (ADR-20).
  [/#v1\.[A-Za-z0-9._-]+/g, "#v1.<redacted>"],
  // Authorization headers in any casing.
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <redacted>"],
  // `NAME=value` / `NAME: value` for secret-shaped names.
  [
    /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|CLIENT_ID|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/g,
    "$1=<redacted>",
  ],
  // POSIX absolute paths that identify a machine or a home directory.
  [
    /(?<![\w:/])\/(?:Users|home|root|private|var|tmp|opt)\/[^\s"'`,;)\]]*/g,
    "<path>",
  ],
  // Windows absolute paths.
  [/\b[A-Za-z]:\\[^\s"'`,;)\]]*/g, "<path>"],
];

export function scrubDiagnostic(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function buildGateRecord(
  input: GateRecordInput,
  runtime: { runner: string; runnerVersion: string },
): GateRecord {
  const record: GateRecord = {
    gate: 1,
    package: GATE_PACKAGE,
    packagePath: GATE_PACKAGE_PATH,
    suite: scrubDiagnostic(input.suite),
    tool: scrubDiagnostic(input.tool),
    toolVersion: scrubDiagnostic(input.toolVersion),
    runner: runtime.runner,
    runnerVersion: runtime.runnerVersion,
    status: input.status,
    exitCode: input.exitCode,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    repro: scrubDiagnostic(input.repro),
  };
  if (input.blockedOn !== undefined) {
    record.blockedOn = scrubDiagnostic(input.blockedOn);
  }
  if (input.note !== undefined) {
    record.note = scrubDiagnostic(input.note);
  }
  return record;
}

export function formatGateRecord(record: GateRecord): string {
  return `${GATE_PREFIX} ${JSON.stringify(record)}`;
}
