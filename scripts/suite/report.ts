/**
 * Diagnostic records and secret-safe rendering for the root suite dispatcher
 * (bead asimposiumorg-8xn, OPS.1).
 *
 * Record shape matches the one `infra/validate-scaffold.mjs` already emits
 * (tool / package / suite / version / duration_ms / status / reproduce) so a CI consumer
 * can parse every ASImposium diagnostic with one reader.
 *
 * Two honesty rules hold here:
 *  1. Dispatcher-authored strings are redacted: no absolute paths, no home directory, no
 *     credential-shaped material. These are the records CI stores.
 *  2. Child process stdout/stderr is *streamed verbatim and never suppressed*. Evidence
 *     that hides a tool's own stderr is not evidence.
 */

import { homedir } from "node:os";
import { relative, sep } from "node:path";

export type UnitStatus = "pass" | "fail" | "missing" | "skip";

export interface UnitDiagnostic {
  record: "unit";
  tool: string;
  package: string;
  suite: string;
  version: string;
  duration_ms: number;
  status: UnitStatus;
  reproduce: string;
  dir: string;
  code: string;
  package_version?: string;
  script?: string;
  command?: string;
  exit_code?: number;
  signal?: string;
  detail?: string;
}

export interface SummaryDiagnostic {
  record: "summary";
  tool: string;
  package: string;
  suite: string;
  version: string;
  duration_ms: number;
  status: "pass" | "fail";
  reproduce: string;
  code: string;
  totals: {
    total: number;
    executed: number;
    pass: number;
    fail: number;
    missing: number;
    skip: number;
  };
  detail?: string;
}

/** Emitted by `--list`: what the dispatcher *would* run, without running it. */
export interface PlanDiagnostic {
  record: "plan";
  suite: string;
  package: string;
  dir: string;
  action: "run" | "missing" | "skip";
  code: string;
  script?: string;
  command?: string;
  reproduce?: string;
  detail?: string;
}

export type Diagnostic = UnitDiagnostic | SummaryDiagnostic | PlanDiagnostic;

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // ASImposium Fellow bearer tokens and enrollment fragment secrets (Fable §5.2, §5.5).
  /asimp_ag_[A-Za-z0-9_-]{4,}/g,
  /#v1\.[A-Za-z0-9._~-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi,
  // Common third-party credential shapes, so a misconfigured child never leaks through a
  // dispatcher-authored field.
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Replace absolute filesystem locations and credential-shaped runs with stable tokens. */
export function redact(text: string, root: string): string {
  let output = text;
  const home = homedir();
  for (const [absolute, token] of [
    [root, "<repo>"],
    [home, "<home>"],
  ] as const) {
    if (absolute.length > 1) output = output.split(absolute).join(token);
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    output = output.replace(pattern, "<redacted>");
  }
  return output;
}

/** Repository-relative POSIX display path. Anything outside the root is never printed. */
export function displayPath(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath);
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith(`..${sep}`)) return "<outside-repo>";
  const posix = sep === "/" ? rel : rel.split(sep).join("/");
  return `./${posix}`;
}

/** The command a human or agent can paste to reproduce exactly one unit. */
export function reproduceCommand(dir: string, script: string): string {
  return dir === "." ? `bun run ${script}` : `cd ./${dir} && bun run ${script}`;
}

export function serialize(diagnostic: Diagnostic, root: string): string {
  const cleaned = JSON.parse(redact(JSON.stringify(diagnostic), root)) as Diagnostic;
  return JSON.stringify(cleaned);
}

const STATUS_LABEL: Readonly<Record<UnitStatus, string>> = {
  pass: "PASS   ",
  fail: "FAIL   ",
  missing: "MISSING",
  skip: "SKIP   ",
};

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function seconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(2)}s`;
}

/** Human line: status, package, directory, what ran, tool version, duration. */
export function formatUnitLine(diagnostic: UnitDiagnostic, root: string): string {
  const what =
    diagnostic.command ?? (diagnostic.detail !== undefined ? diagnostic.detail : diagnostic.code);
  const line = [
    `  ${STATUS_LABEL[diagnostic.status]}`,
    pad(diagnostic.package, 26),
    pad(diagnostic.dir === "." ? "./" : `./${diagnostic.dir}`, 22),
    pad(what, 34),
    pad(`${diagnostic.tool}@${diagnostic.version}`, 12),
    seconds(diagnostic.duration_ms),
  ].join(" ");
  return redact(line, root);
}

export function formatSummaryLine(diagnostic: SummaryDiagnostic, root: string): string {
  const totals = diagnostic.totals;
  const line =
    `summary ${diagnostic.suite}: ${totals.pass} pass · ${totals.fail} fail · ` +
    `${totals.missing} missing · ${totals.skip} skip · ${totals.executed} executed · ` +
    `${seconds(diagnostic.duration_ms)} · ${diagnostic.status.toUpperCase()}`;
  return redact(line, root);
}
