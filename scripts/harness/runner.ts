/**
 * Shared, local test-harness runner for OPS.2a.
 *
 * This is deliberately a harness substrate, not a product-flow claim. It executes
 * explicitly supplied synthetic steps, emits a redacted JSONL ledger plus JUnit, and
 * uses a repository-contained, validated run directory for its artifacts. Product
 * workstreams opt into it later; a green self-test means only that this runner works.
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export const HARNESS_SCHEMA_VERSION = "1.0";
export const HARNESS_BLOCKED_EXIT_CODE = 78;
export const MAX_CAPTURED_OUTPUT_CHARS = 4_096;
export const MAX_DIFF_CHARS = 1_024;
export const MAX_FAILURE_ARTIFACT_CHARS = 8_192;
export const MAX_RESUME_HISTORY_BYTES = 64 * 1024;
/** Fixed per-run bound: successful runs retain metadata/JUnit only, never child output. */
export const MAX_STEPS_PER_RUN = 64;

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const STEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const XML_ESCAPE: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

export type StepStatus = "pass" | "fail" | "blocked" | "timeout" | "cancelled" | "skipped";

export interface HarnessStep {
  /** Stable, path-safe identifier. Steps are sorted by scenario then id before execution. */
  id: string;
  scenario: string;
  command: readonly string[];
  /** A run can retry or resume this operation only when this is true. */
  replaySafe: boolean;
  retries?: number;
  timeoutMs?: number;
  expected?: string;
  actual?: string;
  assertion?: string;
  requestId?: string;
  eventId?: string;
}

export interface HarnessRunOptions {
  root: string;
  runId: string;
  suite: string;
  steps: readonly HarnessStep[];
  /** Supplying a seed makes fixture selection reproducible; omitted derives from suite + run id. */
  seed?: number;
  resume?: boolean;
  signal?: AbortSignal;
  /** Called with redacted child output. Defaults to visible stderr. */
  onOutput?: (text: string) => void;
  /** Called with every already-redacted JSONL record. Defaults to stdout. */
  onEvent?: (record: HarnessEvent) => void;
}

export interface HarnessEvent {
  schema_version: typeof HARNESS_SCHEMA_VERSION;
  record: "step" | "summary" | "self_test";
  run_id: string;
  suite: string;
  scenario: string;
  step: string;
  seed: number;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  attempt: number;
  retry: number;
  replay_safe: boolean;
  status: StepStatus | "pass" | "fail" | "blocked";
  code: string;
  reproduce: string;
  argv?: string[];
  exit_code?: number;
  request_id?: string;
  event_id?: string;
  assertion?: string;
  diff?: string;
  output_chars?: number;
  output_truncated?: boolean;
  artifact_digest?: string;
  detail?: string;
}

export interface HarnessArtifacts {
  directory: string;
  jsonl: string;
  junit: string;
  failureLogs: string[];
}

export interface HarnessRunResult {
  exitCode: 0 | 1 | typeof HARNESS_BLOCKED_EXIT_CODE;
  events: HarnessEvent[];
  artifacts: HarnessArtifacts;
  seed: number;
}

export class HarnessError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HarnessError";
  }
}

class ArtifactStore {
  readonly directory: string;
  readonly jsonl: string;
  readonly failureLogs: string[] = [];
  private readonly physicalRoot: string;

  constructor(
    root: string,
    readonly runId: string,
    resume: boolean,
  ) {
    if (!validateRunId(runId)) {
      throw new HarnessError("RUN_ID_INVALID", "run_id must be one safe path component.");
    }

    const resolvedRoot = resolve(root);
    this.physicalRoot = realDirectory(resolvedRoot, "REPOSITORY_ROOT_INVALID");
    const e2e = ensureDirectDirectory(this.physicalRoot, "e2e");
    const artifacts = ensureDirectDirectory(e2e, "artifacts");
    this.directory = ensureDirectDirectory(artifacts, runId);
    this.jsonl = join(this.directory, "events.jsonl");
    assertRegularOrAbsent(this.jsonl, "ARTIFACT_PATH_UNSAFE");
    if (!resume && existsSync(this.jsonl)) {
      throw new HarnessError("RUN_ID_EXISTS", "run_id already has a harness event ledger.");
    }
    if (!existsSync(this.jsonl)) {
      const descriptor = openSync(this.jsonl, "wx");
      closeSync(descriptor);
    }
  }

  append(event: HarnessEvent): void {
    appendFileSync(this.jsonl, `${JSON.stringify(event)}\n`, "utf8");
  }

  writeFailureLog(step: HarnessStep, attempt: number, output: string): string | undefined {
    if (output.length === 0) return undefined;
    const safeStep = validateStepId(step.id) ? step.id : "invalid-step";
    for (let collision = 0; collision < 100; collision += 1) {
      const suffix = collision === 0 ? "" : `.${collision}`;
      const path = join(this.directory, `failure-${safeStep}-attempt-${attempt}${suffix}.log`);
      assertContained(this.physicalRoot, path, "ARTIFACT_PATH_UNSAFE");
      if (existsSync(path) || isSymbolicLink(path)) continue;
      writeFileSync(path, clip(output, MAX_FAILURE_ARTIFACT_CHARS), {
        encoding: "utf8",
        flag: "wx",
      });
      this.failureLogs.push(path);
      return path;
    }
    throw new HarnessError("FAILURE_ARTIFACT_LIMIT", "no bounded failure artifact slot remains.");
  }

  writeJUnit(events: readonly HarnessEvent[]): string {
    let attempt = 0;
    while (attempt < 100) {
      const name = attempt === 0 ? "junit.xml" : `junit.${attempt}.xml`;
      const path = join(this.directory, name);
      assertContained(this.physicalRoot, path, "ARTIFACT_PATH_UNSAFE");
      if (existsSync(path) || isSymbolicLink(path)) {
        attempt += 1;
        continue;
      }
      writeFileSync(path, junitXml(events), { encoding: "utf8", flag: "wx" });
      return path;
    }
    throw new HarnessError(
      "JUNIT_ARTIFACT_LIMIT",
      "no bounded JUnit artifact slot remains for this run.",
    );
  }

  loadResumeStates(): Map<string, StepStatus> {
    const bytes = readFileSync(this.jsonl);
    if (bytes.byteLength > MAX_RESUME_HISTORY_BYTES) {
      throw new HarnessError(
        "RUN_HISTORY_TOO_LARGE",
        "run history exceeds the bounded resume ledger size.",
      );
    }
    const states = new Map<string, StepStatus>();
    for (const line of bytes.toString("utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const event = JSON.parse(line) as Partial<HarnessEvent>;
        if (event.record !== "step" || typeof event.step !== "string") continue;
        if (isStepStatus(event.status)) states.set(event.step, event.status);
      } catch {
        throw new HarnessError(
          "RUN_HISTORY_INVALID",
          "run history contains an invalid JSONL record.",
        );
      }
    }
    return states;
  }
}

export function validateRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId);
}

export function validateStepId(stepId: string): boolean {
  return STEP_ID_PATTERN.test(stepId);
}

export function deterministicSeed(suite: string, runId: string): number {
  let hash = 2_166_136_261;
  for (const character of `${suite}\u0000${runId}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function orderSteps(steps: readonly HarnessStep[]): HarnessStep[] {
  return [...steps].sort((left, right) => {
    const scenarioOrder = asciiCompare(left.scenario, right.scenario);
    return scenarioOrder === 0 ? asciiCompare(left.id, right.id) : scenarioOrder;
  });
}

/** Redact all never-log classes before data is emitted, shown, or retained. */
export function redactNeverLog(text: string, root: string): string {
  let output = text;
  for (const absolute of [resolve(root), homedir(), tmpdir()]) {
    if (absolute.length > 1) output = output.split(absolute).join("<path>");
  }
  const patterns: readonly RegExp[] = [
    /asimp_ag_[A-Za-z0-9_-]{4,}/g,
    /#v1\.[A-Za-z0-9._~-]{4,}/g,
    /\bBearer\s+[A-Za-z0-9._~+/-]{4,}={0,2}/gi,
    /\b(?:authorization|cookie|set-cookie|token|access_token|refresh_token|id_token|secret|password|signature|sig|authorization_code|directive_body|workshop_body)\s*(?:=|:)\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
    /\bAIza[0-9A-Za-z_-]{20,}/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  ];
  for (const pattern of patterns) {
    output = output.replace(pattern, "<redacted>");
  }
  output = output.replace(
    /([?&](?:token|access_token|code|signature|sig)=)[^&#\s]+/gi,
    "$1<redacted>",
  );
  return output;
}

export function boundedDiff(expected: string, actual: string, root: string): string {
  const safeExpected = redactNeverLog(expected, root);
  const safeActual = redactNeverLog(actual, root);
  const prefix = commonPrefix(safeExpected, safeActual);
  const head = prefix.length > 80 ? `…${prefix.slice(-80)}` : prefix;
  return clip(
    `common_prefix=${JSON.stringify(head)}\nexpected=${JSON.stringify(safeExpected.slice(prefix.length))}\nactual=${JSON.stringify(safeActual.slice(prefix.length))}`,
    MAX_DIFF_CHARS,
  );
}

export function safeReproductionCommand(runId: string, resume: boolean): string {
  if (!validateRunId(runId)) throw new HarnessError("RUN_ID_INVALID", "run_id must be safe.");
  return `scripts/e2e-test-harness.sh --run-id ${runId}${resume ? " --resume" : ""}`;
}

export async function runHarness(options: HarnessRunOptions): Promise<HarnessRunResult> {
  if (options.steps.length > MAX_STEPS_PER_RUN) {
    throw new HarnessError(
      "RUN_STEP_LIMIT",
      "harness runs may contain at most the bounded step limit.",
    );
  }
  const seed = options.seed ?? deterministicSeed(options.suite, options.runId);
  const store = new ArtifactStore(options.root, options.runId, options.resume === true);
  const output = options.onOutput ?? ((text: string) => process.stderr.write(text));
  const eventSink =
    options.onEvent ??
    ((event: HarnessEvent) => process.stdout.write(`${JSON.stringify(event)}\n`));
  const priorStates =
    options.resume === true ? store.loadResumeStates() : new Map<string, StepStatus>();
  const events: HarnessEvent[] = [];

  const seenStepIds = new Set<string>();
  for (const step of orderSteps(options.steps)) {
    if (!validateStepId(step.id)) {
      throw new HarnessError("STEP_ID_INVALID", "step id must be one safe path component.");
    }
    if (seenStepIds.has(step.id)) {
      throw new HarnessError(
        "STEP_ID_DUPLICATE",
        "step ids must be unique within one harness run.",
      );
    }
    seenStepIds.add(step.id);
    const prior = priorStates.get(step.id);
    if (options.resume === true && prior !== undefined) {
      if (prior === "pass") {
        const event = skippedEvent(
          options,
          step,
          seed,
          "RESUME_ALREADY_COMPLETED",
          "already completed",
        );
        recordEvent(store, events, eventSink, event);
        continue;
      }
      if (!step.replaySafe) {
        const event = skippedEvent(
          options,
          step,
          seed,
          "UNSAFE_REPLAY_WITHHELD",
          "previous incomplete operation is not replay-safe",
          "blocked",
        );
        recordEvent(store, events, eventSink, event);
        continue;
      }
    }

    const retries = step.replaySafe ? Math.max(0, step.retries ?? 0) : 0;
    let finalEvent: HarnessEvent | undefined;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      finalEvent = await runAttempt(options, step, seed, attempt, retries, output);
      if (finalEvent.status !== "pass" && finalEvent.status !== "blocked") {
        const mergedOutput = finalEvent.detail ?? "";
        store.writeFailureLog(step, attempt + 1, mergedOutput);
      }
      recordEvent(store, events, eventSink, finalEvent);
      if (finalEvent.status === "pass" || finalEvent.status === "blocked") break;
    }
  }

  const junit = store.writeJUnit(events);
  const digest = createHash("sha256").update(readFileSync(junit)).digest("hex");
  const finishedAt = new Date().toISOString();
  const summary = summaryEvent(options, seed, events, finishedAt, digest);
  recordEvent(store, events, eventSink, summary);

  const statuses = finalStepEvents(events).map((event) => event.status);
  const exitCode: HarnessRunResult["exitCode"] = statuses.some(
    (status) => status === "fail" || status === "timeout" || status === "cancelled",
  )
    ? 1
    : statuses.some((status) => status === "blocked")
      ? HARNESS_BLOCKED_EXIT_CODE
      : 0;
  return {
    exitCode,
    events,
    artifacts: {
      directory: store.directory,
      jsonl: store.jsonl,
      junit,
      failureLogs: store.failureLogs,
    },
    seed,
  };
}

async function runAttempt(
  options: HarnessRunOptions,
  step: HarnessStep,
  seed: number,
  attempt: number,
  retries: number,
  emitOutput: (text: string) => void,
): Promise<HarnessEvent> {
  const started = new Date();
  const startedAt = performance.now();
  let termination: "timeout" | "cancelled" | undefined;
  const child = Bun.spawn({
    cmd: [...step.command],
    cwd: resolve(options.root),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const terminate = (reason: "timeout" | "cancelled") => {
    if (termination !== undefined) return;
    termination = reason;
    try {
      child.kill("SIGTERM");
    } catch {
      // The child already completed between the scheduler tick and the kill attempt.
    }
    forceKill = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // A normal SIGTERM exit is the expected cleanup path.
      }
    }, 250);
  };
  const timeout = setTimeout(() => terminate("timeout"), Math.max(1, step.timeoutMs ?? 30_000));
  const abort = () => terminate("cancelled");
  options.signal?.addEventListener("abort", abort, { once: true });

  const [stdout, stderr, exitCode] = await Promise.all([
    readBounded(child.stdout, MAX_CAPTURED_OUTPUT_CHARS),
    readBounded(child.stderr, MAX_CAPTURED_OUTPUT_CHARS),
    child.exited,
  ]);
  clearTimeout(timeout);
  if (forceKill !== undefined) clearTimeout(forceKill);
  options.signal?.removeEventListener("abort", abort);

  const visibleOutput = redactNeverLog(`${stdout.text}${stderr.text}`, options.root);
  if (visibleOutput.length > 0) emitOutput(visibleOutput);
  const finished = new Date();
  const duration = Math.round(performance.now() - startedAt);
  const status: StepStatus =
    termination === "timeout"
      ? "timeout"
      : termination === "cancelled"
        ? "cancelled"
        : exitCode === 0
          ? "pass"
          : exitCode === HARNESS_BLOCKED_EXIT_CODE
            ? "blocked"
            : "fail";
  const code =
    status === "pass"
      ? "STEP_PASSED"
      : status === "blocked"
        ? "STEP_BLOCKED"
        : status === "timeout"
          ? "STEP_TIMEOUT"
          : status === "cancelled"
            ? "STEP_CANCELLED"
            : "STEP_FAILED";
  const outputChars = stdout.text.length + stderr.text.length;
  const detail =
    status === "pass"
      ? undefined
      : redactNeverLog(
          clip(
            `${stdout.text.length > 0 ? `stdout:\n${stdout.text}\n` : ""}${stderr.text.length > 0 ? `stderr:\n${stderr.text}` : ""}`,
            MAX_FAILURE_ARTIFACT_CHARS,
          ),
          options.root,
        );
  return {
    schema_version: HARNESS_SCHEMA_VERSION,
    record: "step",
    run_id: options.runId,
    suite: safeMetadata(options.suite, options.root),
    scenario: safeMetadata(step.scenario, options.root),
    step: step.id,
    seed,
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    duration_ms: duration,
    attempt: attempt + 1,
    retry: retries === 0 ? 0 : attempt,
    replay_safe: step.replaySafe,
    status,
    code,
    reproduce: safeReproductionCommand(options.runId, options.resume === true),
    argv: safeArgv(step.command, options.root),
    exit_code: exitCode,
    ...(step.requestId === undefined
      ? {}
      : { request_id: safeMetadata(step.requestId, options.root) }),
    ...(step.eventId === undefined ? {} : { event_id: safeMetadata(step.eventId, options.root) }),
    ...(step.assertion === undefined
      ? {}
      : { assertion: safeMetadata(step.assertion, options.root) }),
    ...(step.expected === undefined || step.actual === undefined
      ? {}
      : { diff: boundedDiff(step.expected, step.actual, options.root) }),
    output_chars: outputChars,
    output_truncated: stdout.truncated || stderr.truncated,
    ...(detail === undefined ? {} : { detail }),
  };
}

function skippedEvent(
  options: HarnessRunOptions,
  step: HarnessStep,
  seed: number,
  code: string,
  detail: string,
  status: "skipped" | "blocked" = "skipped",
): HarnessEvent {
  const now = new Date().toISOString();
  return {
    schema_version: HARNESS_SCHEMA_VERSION,
    record: "step",
    run_id: options.runId,
    suite: safeMetadata(options.suite, options.root),
    scenario: safeMetadata(step.scenario, options.root),
    step: step.id,
    seed,
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    attempt: 0,
    retry: 0,
    replay_safe: step.replaySafe,
    status,
    code,
    reproduce: safeReproductionCommand(options.runId, true),
    detail,
  };
}

function summaryEvent(
  options: HarnessRunOptions,
  seed: number,
  events: readonly HarnessEvent[],
  finishedAt: string,
  junitDigest: string,
): HarnessEvent {
  const steps = finalStepEvents(events);
  const hasFailure = steps.some(
    (event) =>
      event.status === "fail" || event.status === "timeout" || event.status === "cancelled",
  );
  const hasBlocked = steps.some((event) => event.status === "blocked");
  return {
    schema_version: HARNESS_SCHEMA_VERSION,
    record: "summary",
    run_id: options.runId,
    suite: safeMetadata(options.suite, options.root),
    scenario: "run",
    step: "summary",
    seed,
    started_at: finishedAt,
    finished_at: finishedAt,
    duration_ms: steps.reduce((total, event) => total + event.duration_ms, 0),
    attempt: 1,
    retry: 0,
    replay_safe: true,
    status: hasFailure ? "fail" : hasBlocked ? "blocked" : "pass",
    code: hasFailure ? "RUN_FAILED" : hasBlocked ? "RUN_BLOCKED" : "RUN_PASSED",
    reproduce: safeReproductionCommand(options.runId, true),
    artifact_digest: junitDigest,
    detail:
      "Harness output is redacted and bounded; a passing harness run is not product correctness.",
  };
}

function recordEvent(
  store: ArtifactStore,
  events: HarnessEvent[],
  sink: (event: HarnessEvent) => void,
  event: HarnessEvent,
): void {
  store.append(event);
  events.push(event);
  sink(event);
}

function junitXml(events: readonly HarnessEvent[]): string {
  const steps = finalStepEvents(events);
  const failures = steps.filter(
    (event) =>
      event.status === "fail" || event.status === "timeout" || event.status === "cancelled",
  );
  const blocked = steps.filter((event) => event.status === "blocked");
  const body = steps
    .map((event) => {
      const attributes = `classname="${xml(event.scenario)}" name="${xml(event.step)}" time="${(event.duration_ms / 1000).toFixed(3)}"`;
      if (event.status === "pass" || event.status === "skipped")
        return `  <testcase ${attributes}/>`;
      if (event.status === "blocked") {
        return `  <testcase ${attributes}><skipped message="${xml(event.code)}">${xml(event.detail ?? "")}</skipped></testcase>`;
      }
      return `  <testcase ${attributes}><failure message="${xml(event.code)}">${xml(event.detail ?? "")}</failure></testcase>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="asimposium-harness" tests="${steps.length}" failures="${failures.length}" skipped="${blocked.length}">\n${body}\n</testsuite>\n`;
}

/** Intermediate retry failures remain in JSONL for diagnosis, but only the last attempt decides a run. */
function finalStepEvents(events: readonly HarnessEvent[]): HarnessEvent[] {
  const final = new Map<string, HarnessEvent>();
  for (const event of events) {
    if (event.record === "step") final.set(event.step, event);
  }
  return [...final.values()];
}

function xml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => XML_ESCAPE[character] ?? character);
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 15))}\n…<truncated>`;
}

function commonPrefix(left: string, right: string): string {
  let index = 0;
  const bound = Math.min(left.length, right.length);
  while (index < bound && left[index] === right[index]) index += 1;
  return left.slice(0, index);
}

/**
 * A command line can itself embed a request body or a token. The executable name is enough
 * to identify the tool; every argument is intentionally withheld from JSONL and artifacts.
 */
function safeArgv(commandLine: readonly string[], root: string): string[] {
  return commandLine.map((argument, index) =>
    index === 0 ? redactNeverLog(basename(argument), root) : "<redacted-argument>",
  );
}

function safeMetadata(value: string, root: string): string {
  return clip(redactNeverLog(value, root), 256);
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isStepStatus(value: unknown): value is StepStatus {
  return ["pass", "fail", "blocked", "timeout", "cancelled", "skipped"].includes(String(value));
}

function isOutside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation);
}

function assertContained(root: string, target: string, code: string): void {
  if (isOutside(root, target))
    throw new HarnessError(code, "artifact path resolves outside the repository.");
}

function realDirectory(path: string, code: string): string {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe directory");
    return realpathSync(path);
  } catch {
    throw new HarnessError(code, "expected a real repository directory.");
  }
}

function ensureDirectDirectory(parent: string, child: string): string {
  const target = join(parent, child);
  assertContained(parent, target, "ARTIFACT_PATH_UNSAFE");
  if (existsSync(target) || isSymbolicLink(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new HarnessError(
        "ARTIFACT_PATH_UNSAFE",
        "artifact directory is not a direct real directory.",
      );
    }
  } else {
    mkdirSync(target);
  }
  const physical = realDirectory(target, "ARTIFACT_PATH_UNSAFE");
  assertContained(parent, physical, "ARTIFACT_PATH_UNSAFE");
  return physical;
}

function assertRegularOrAbsent(path: string, code: string): void {
  if (!existsSync(path) && !isSymbolicLink(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new HarnessError(code, "artifact file path is not a regular file.");
  }
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  if (stream === null) return { text: "", truncated: false };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    const decoded = decoder.decode(result.value, { stream: true });
    if (text.length < limit) {
      const remaining = limit - text.length;
      text += decoded.slice(0, remaining);
      truncated ||= decoded.length > remaining;
    } else {
      truncated = true;
    }
  }
  const ending = decoder.decode();
  if (text.length < limit) {
    const remaining = limit - text.length;
    text += ending.slice(0, remaining);
    truncated ||= ending.length > remaining;
  } else if (ending.length > 0) {
    truncated = true;
  }
  return { text, truncated };
}

function command(code: string): readonly string[] {
  return [process.execPath, "-e", code];
}

export async function runHarnessSelfTest(
  root: string,
  onEvent?: (event: HarnessEvent) => void,
): Promise<0 | 1> {
  const runId = `ops.2a-selftest-${Date.now()}-${process.pid}`;
  const secret = "asimp_ag_01JXYZ_selftest_neverlog_canary";
  const sink =
    onEvent ?? ((record: HarnessEvent) => process.stdout.write(`${JSON.stringify(record)}\n`));
  const result = await runHarness({
    root,
    runId,
    suite: "ops.2a-harness-self-test",
    onEvent: sink,
    steps: [
      {
        id: "unit-assertion",
        scenario: "unit",
        command: command("console.error('assertion failed'); process.exit(1)"),
        replaySafe: true,
        assertion: "seeded unit assertion",
        expected: "promotion accepted",
        actual: "MISSING_FALSIFIER",
        requestId: "req-selftest-unit",
        eventId: "evt-selftest-unit",
      },
      {
        id: "d1-rollback",
        scenario: "integration",
        command: command("console.error('synthetic D1 rollback'); process.exit(1)"),
        replaySafe: true,
        assertion: "seeded D1 rollback",
        requestId: "req-selftest-d1",
        eventId: "evt-selftest-d1",
      },
      {
        id: "http-fault",
        scenario: "integration",
        command: command("console.error('synthetic HTTP 503'); process.exit(1)"),
        replaySafe: true,
        assertion: "seeded HTTP fault",
        requestId: "req-selftest-http",
        eventId: "evt-selftest-http",
      },
      {
        id: "browser-assertion",
        scenario: "e2e",
        command: command("console.error('synthetic browser assertion'); process.exit(1)"),
        replaySafe: true,
        assertion: "seeded browser failure",
        requestId: "req-selftest-browser",
        eventId: "evt-selftest-browser",
      },
      {
        id: "interrupted-safe",
        scenario: "e2e",
        command: command("setTimeout(() => process.exit(0), 500)"),
        replaySafe: true,
        timeoutMs: 20,
        assertion: "interrupted replay-safe step",
        requestId: "req-selftest-interrupt",
        eventId: "evt-selftest-interrupt",
      },
      {
        id: "secret-canary",
        scenario: "security",
        command: command(
          `console.error(${JSON.stringify(`Authorization: Bearer ${secret}`)}); process.exit(1)`,
        ),
        replaySafe: true,
        assertion: "never-log canary",
        requestId: "req-selftest-secret",
        eventId: "evt-selftest-secret",
      },
    ],
  });
  const resumeRunId = `${runId}-resume`;
  const resumeSteps: HarnessStep[] = [
    {
      id: "safe-retry",
      scenario: "resume",
      command: command("console.error('synthetic replay-safe interruption'); process.exit(1)"),
      replaySafe: true,
    },
    {
      id: "unsafe-withheld",
      scenario: "resume",
      command: command("console.error('synthetic non-replay-safe interruption'); process.exit(1)"),
      replaySafe: false,
    },
  ];
  const interrupted = await runHarness({
    root,
    runId: resumeRunId,
    suite: "ops.2a-harness-self-test",
    steps: resumeSteps,
    onEvent: sink,
  });
  const resumed = await runHarness({
    root,
    runId: resumeRunId,
    suite: "ops.2a-harness-self-test",
    steps: resumeSteps,
    resume: true,
    onEvent: sink,
  });
  const artifacts = [
    result.artifacts.jsonl,
    result.artifacts.junit,
    ...result.artifacts.failureLogs,
  ]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  const identifiers = result.events
    .map((event) => `${event.request_id ?? ""}${event.event_id ?? ""}`)
    .join(" ");
  const pass =
    result.exitCode === 1 &&
    !artifacts.includes(secret) &&
    artifacts.includes("<redacted>") &&
    identifiers.includes("req-selftest-unit") &&
    identifiers.includes("evt-selftest-browser") &&
    result.events.every((event) =>
      event.reproduce.startsWith("scripts/e2e-test-harness.sh --run-id "),
    ) &&
    interrupted.exitCode === 1 &&
    resumed.events.some((event) => event.step === "safe-retry" && event.status === "fail") &&
    resumed.events.some(
      (event) => event.step === "unsafe-withheld" && event.code === "UNSAFE_REPLAY_WITHHELD",
    );
  const now = new Date().toISOString();
  const event: HarnessEvent = {
    schema_version: HARNESS_SCHEMA_VERSION,
    record: "self_test",
    run_id: runId,
    suite: "ops.2a-harness-self-test",
    scenario: "harness",
    step: "self-test",
    seed: result.seed,
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    attempt: 1,
    retry: 0,
    replay_safe: true,
    status: pass ? "pass" : "fail",
    code: pass ? "HARNESS_SELF_TEST_HARNESS_ONLY" : "HARNESS_SELF_TEST_FAILED",
    reproduce: "scripts/e2e-test-harness.sh --self-test",
    detail: pass
      ? "Harness-only validation passed; no product session, D1 binding, HTTP origin, browser, or Cloudflare behavior is proven."
      : "Harness self-test invariants failed.",
  };
  sink(event);
  return pass ? 0 : 1;
}

function parseCli(argv: readonly string[]): { selfTest: boolean; root: string } {
  let selfTest = false;
  let root = resolve(import.meta.dir, "..", "..");
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--self-test") {
      selfTest = true;
      continue;
    }
    if (argument === "--root") {
      const value = argv[++index];
      if (value === undefined)
        throw new HarnessError("ROOT_MISSING", "--root requires a directory.");
      root = resolve(value);
      continue;
    }
    throw new HarnessError(
      "UNKNOWN_ARGUMENT",
      "usage: scripts/e2e-test-harness.sh --self-test [--root <dir>]",
    );
  }
  if (!selfTest)
    throw new HarnessError("SELF_TEST_REQUIRED", "only the harness self-test is exposed today.");
  return { selfTest, root };
}

if (import.meta.main) {
  try {
    const options = parseCli(process.argv.slice(2));
    process.exitCode = await runHarnessSelfTest(options.root);
  } catch (error) {
    const code = error instanceof HarnessError ? error.code : "HARNESS_UNEXPECTED";
    process.stderr.write(
      `${JSON.stringify({ tool: "bun", suite: "ops.2a-harness-self-test", status: "fail", code, reproduce: "scripts/e2e-test-harness.sh --self-test" })}\n`,
    );
    process.exitCode = 1;
  }
}
