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
import { redactCredentials } from "@asimposium/contracts/diagnostic-safety";

/**
 * `blocked` means the package deliberately refused a gate it cannot yet satisfy and said
 * so with the root-owned exit code (`BLOCKED_EXIT_CODE`, policy.ts). It is never green:
 * it is counted separately, rendered with its own label, and still exits the run non-zero.
 */
export type UnitStatus = "pass" | "fail" | "blocked" | "missing" | "skip";

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
  /** `blocked` only when nothing genuinely failed: a real fail or missing outranks it. */
  status: "pass" | "fail" | "blocked";
  reproduce: string;
  code: string;
  totals: {
    total: number;
    executed: number;
    pass: number;
    fail: number;
    blocked: number;
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

/**
 * Replace absolute filesystem locations and credential-shaped runs with stable tokens.
 *
 * Path masking stays here because it needs a caller-supplied repository root and
 * the process home directory. The credential vocabulary does not: it is the
 * shared never-log scanner in `@asimposium/contracts` (OPS.2a), so the
 * dispatcher and every package refuse exactly the same shapes. Order is
 * unchanged — paths first, then credentials — because a masked path must not
 * hide a credential that followed it.
 */
export function redact(text: string, root: string): string {
  let output = text;
  const home = homedir();
  for (const [absolute, token] of [
    [root, "<repo>"],
    [home, "<home>"],
  ] as const) {
    if (absolute.length > 1) output = output.split(absolute).join(token);
  }
  return redactCredentials(output);
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

/** Redact every string reachable from a record, leaving numbers and structure untouched. */
function redactDeep(value: unknown, root: string): unknown {
  if (typeof value === "string") return redact(value, root);
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, root));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactDeep(entry, root);
    }
    return out;
  }
  return value;
}

/**
 * Redaction runs on the field values, never on the serialized JSON text: rewriting the
 * text would have to reason about JSON escaping, and a redactor that can corrupt its own
 * output is worse than none.
 */
export function serialize(diagnostic: Diagnostic, root: string): string {
  return JSON.stringify(redactDeep(diagnostic, root));
}

const STATUS_LABEL: Readonly<Record<UnitStatus, string>> = {
  pass: "PASS   ",
  fail: "FAIL   ",
  blocked: "BLOCKED",
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
    `${totals.blocked} blocked · ${totals.missing} missing · ${totals.skip} skip · ` +
    `${totals.executed} executed · ` +
    `${seconds(diagnostic.duration_ms)} · ${diagnostic.status.toUpperCase()}`;
  return redact(line, root);
}
