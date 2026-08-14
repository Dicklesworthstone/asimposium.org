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
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export const HARNESS_SCHEMA_VERSION = "1.0";
export const HARNESS_BLOCKED_EXIT_CODE = 78;
export const MAX_CAPTURED_OUTPUT_CHARS = 4_096;
export const MAX_DIFF_CHARS = 1_024;
export const MAX_FAILURE_ARTIFACT_CHARS = 8_192;
export const MAX_FAILURE_DETAIL_CHARS = 1_024;
export const MAX_RESUME_HISTORY_BYTES = 64 * 1024;
export const MAX_EVENT_BYTES = 8 * 1024;
export const MAX_EVENT_LEDGER_BYTES = 2 * 1024 * 1024;
export const MAX_FAILURE_ARTIFACTS_PER_RUN = 32;
export const MAX_JUNIT_ARTIFACTS_PER_RUN = 8;
export const MAX_STEPS_PER_RUN = 64;
export const MAX_RETRIES_PER_STEP = 3;
export const MAX_TIMEOUT_MS = 60_000;
export const MAX_COMMAND_ARGUMENTS = 16;
export const MAX_COMMAND_ARGUMENT_CHARS = 4_096;
export const MAX_COMMAND_CHARS = 8_192;
export const MAX_METADATA_CHARS = 256;
export const MAX_ROUTE_TEMPLATE_CHARS = 256;
export const MAX_DIFF_INPUT_CHARS = 16 * 1024;

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
export type HarnessAdapter = "process" | "d1" | "http" | "browser";

export interface HttpContext {
  method: string;
  routeTemplate: string;
  cursor?: number;
  seq?: number;
}

export interface HarnessStep {
  /** Stable, path-safe identifier. Steps are sorted by scenario then id before execution. */
  id: string;
  scenario: string;
  /** OPS.2a executes only direct process steps. Other adapter kinds are explicitly withheld. */
  adapter?: HarnessAdapter;
  command?: readonly string[];
  /** A run can retry or resume this operation only when this is true. */
  replaySafe: boolean;
  retries?: number;
  timeoutMs?: number;
  expected?: string;
  actual?: string;
  assertion?: string;
  requestId?: string;
  eventId?: string;
  http?: HttpContext;
}

export interface HarnessRunOptions {
  root: string;
  runId: string;
  suite: string;
  steps: readonly HarnessStep[];
  /** Supplying a seed makes fixture selection reproducible; omitted derives from suite + run id. */
  seed?: number;
  resume?: boolean;
  /** A real revision if supplied by the caller; unavailable is recorded rather than guessed. */
  gitRevision?: string;
  /** Binding versions are caller supplied metadata only; they are never inherited into children. */
  bindingVersions?: Readonly<Record<string, string>>;
  /** Only a registered CLI scenario may be represented as executable reproduction. */
  reproduction?: "self-test";
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
  adapter: HarnessAdapter;
  status: StepStatus | "pass" | "fail" | "blocked";
  code: string;
  reproduce: string;
  git_revision: string;
  environment: {
    runtime: "bun";
    runtime_version: string;
    platform: string;
    binding_versions: Record<string, string>;
  };
  http_method: string | null;
  route_template: string | null;
  cursor: number | null;
  seq: number | null;
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
  private failureArtifactCount: number;

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
    this.failureArtifactCount = readdirSync(this.directory).filter((name) =>
      /^failure-[A-Za-z0-9._-]+-attempt-\d+(?:\.\d+)?\.log$/.test(name),
    ).length;
  }

  append(event: HarnessEvent): void {
    const serialized = `${JSON.stringify(event)}\n`;
    const eventBytes = Buffer.byteLength(serialized, "utf8");
    if (eventBytes > MAX_EVENT_BYTES) {
      throw new HarnessError("EVENT_TOO_LARGE", "a redacted event exceeds the fixed event size.");
    }
    if (statSync(this.jsonl).size + eventBytes > MAX_EVENT_LEDGER_BYTES) {
      throw new HarnessError(
        "EVENT_LEDGER_LIMIT",
        "the bounded event ledger is full; retain the existing evidence without deletion.",
      );
    }
    appendFileSync(this.jsonl, serialized, "utf8");
  }

  writeFailureLog(step: HarnessStep, attempt: number, output: string): string | undefined {
    if (output.length === 0) return undefined;
    if (this.failureArtifactCount >= MAX_FAILURE_ARTIFACTS_PER_RUN) return undefined;
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
      this.failureArtifactCount += 1;
      return path;
    }
    throw new HarnessError("FAILURE_ARTIFACT_LIMIT", "no bounded failure artifact slot remains.");
  }

  writeJUnit(events: readonly HarnessEvent[]): string {
    let attempt = 0;
    while (attempt < MAX_JUNIT_ARTIFACTS_PER_RUN) {
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
      "no bounded JUnit artifact slot remains; existing retained artifacts are not deleted.",
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
        const event = JSON.parse(line) as HarnessEvent;
        validateHarnessEvent(event);
        if (event.record === "step") states.set(event.step, event.status);
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
    /\b[A-Za-z0-9]{32,}\b/g,
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

export function safeReproductionCommand(reproduction?: HarnessRunOptions["reproduction"]): string {
  if (reproduction === "self-test") return "scripts/e2e-test-harness.sh --self-test";
  return "unavailable: no registered CLI scenario";
}

/** Validate the public runner input before any artifact directory or child process is created. */
export function validateHarnessRunOptions(options: HarnessRunOptions): void {
  if (typeof options !== "object" || options === null) {
    throw new HarnessError("RUN_OPTIONS_INVALID", "run options must be an object.");
  }
  if (!validateRunId(options.runId)) {
    throw new HarnessError("RUN_ID_INVALID", "run_id must be one safe path component.");
  }
  assertSafeMetadata(options.suite, "SUITE_INVALID", "suite");
  if (!Array.isArray(options.steps) || options.steps.length > MAX_STEPS_PER_RUN) {
    throw new HarnessError(
      "RUN_STEP_LIMIT",
      "harness runs may contain at most the bounded step limit.",
    );
  }
  if (
    options.seed !== undefined &&
    (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff)
  ) {
    throw new HarnessError("SEED_INVALID", "seed must be an unsigned 32-bit integer.");
  }
  if (options.gitRevision !== undefined && !isGitRevision(options.gitRevision)) {
    throw new HarnessError(
      "GIT_REVISION_INVALID",
      "git revision must be a commit hash or unavailable.",
    );
  }
  if (options.reproduction !== undefined && options.reproduction !== "self-test") {
    throw new HarnessError("REPRODUCTION_INVALID", "only registered CLI reproduction is allowed.");
  }
  validateBindingVersions(options.bindingVersions);
  const seenStepIds = new Set<string>();
  for (const step of options.steps) {
    validateHarnessStep(step);
    if (seenStepIds.has(step.id)) {
      throw new HarnessError(
        "STEP_ID_DUPLICATE",
        "step ids must be unique within one harness run.",
      );
    }
    seenStepIds.add(step.id);
  }
}

/** Validate the step contract, including bounded command inputs that can reach a process table. */
export function validateHarnessStep(step: HarnessStep): void {
  if (typeof step !== "object" || step === null || Array.isArray(step)) {
    throw new HarnessError("STEP_SCHEMA_INVALID", "step must be an object.");
  }
  if (!validateStepId(step.id)) {
    throw new HarnessError("STEP_ID_INVALID", "step id must be one safe path component.");
  }
  assertSafeMetadata(step.scenario, "SCENARIO_INVALID", "scenario");
  if (typeof step.replaySafe !== "boolean") {
    throw new HarnessError("REPLAY_SAFETY_INVALID", "replay_safe must be explicit.");
  }
  const adapter = step.adapter ?? "process";
  if (!isHarnessAdapter(adapter)) {
    throw new HarnessError("ADAPTER_INVALID", "adapter must be process, d1, http, or browser.");
  }
  if (adapter === "process") {
    validateCommand(step.command);
  } else if (step.command !== undefined) {
    throw new HarnessError(
      "ADAPTER_COMMAND_FORBIDDEN",
      "withheld adapters cannot claim execution through a process command.",
    );
  }
  if (!isBoundedInteger(step.retries ?? 0, 0, MAX_RETRIES_PER_STEP)) {
    throw new HarnessError("RETRY_LIMIT", "retries must be a bounded non-negative integer.");
  }
  if (step.timeoutMs !== undefined && !isBoundedInteger(step.timeoutMs, 1, MAX_TIMEOUT_MS)) {
    throw new HarnessError("TIMEOUT_LIMIT", "timeout_ms must be within the fixed harness bound.");
  }
  for (const [field, value] of Object.entries({
    assertion: step.assertion,
    request_id: step.requestId,
    event_id: step.eventId,
  })) {
    if (value !== undefined) assertSafeMetadata(value, "METADATA_INVALID", field);
  }
  if ((step.expected === undefined) !== (step.actual === undefined)) {
    throw new HarnessError("DIFF_INVALID", "expected and actual must be supplied together.");
  }
  if (step.expected !== undefined) assertBoundedInputText(step.expected, "expected");
  if (step.actual !== undefined) assertBoundedInputText(step.actual, "actual");
  if (step.http !== undefined) validateHttpContext(step.http);
}

/** Runtime schema guard for every JSONL/JUnit-facing event, not only TypeScript callers. */
export function validateHarnessEvent(event: HarnessEvent): void {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event must be an object.");
  }
  if (
    event.schema_version !== HARNESS_SCHEMA_VERSION ||
    !["step", "summary", "self_test"].includes(event.record)
  ) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event record is not recognized.");
  }
  if (!validateRunId(event.run_id) || !validateStepId(event.step)) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event identifiers are invalid.");
  }
  for (const [field, value] of Object.entries({
    suite: event.suite,
    scenario: event.scenario,
    code: event.code,
    reproduce: event.reproduce,
    git_revision: event.git_revision,
  })) {
    assertSafeMetadata(value, "EVENT_SCHEMA_INVALID", field);
  }
  if (
    !isBoundedInteger(event.seed, 0, 0xffffffff) ||
    !isBoundedInteger(event.duration_ms, 0, MAX_TIMEOUT_MS + 250) ||
    Number.isNaN(Date.parse(event.started_at)) ||
    Number.isNaN(Date.parse(event.finished_at))
  ) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event numeric fields are out of bounds.");
  }
  if (
    !isBoundedInteger(event.attempt, 0, MAX_RETRIES_PER_STEP + 1) ||
    !isBoundedInteger(event.retry, 0, MAX_RETRIES_PER_STEP)
  ) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event retry fields are out of bounds.");
  }
  if (
    !isStepStatus(event.status) ||
    !isHarnessAdapter(event.adapter) ||
    !isGitRevision(event.git_revision)
  ) {
    throw new HarnessError(
      "EVENT_SCHEMA_INVALID",
      "event status, adapter, or revision is invalid.",
    );
  }
  if (!isValidReproduction(event.reproduce)) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event reproduction is not truthful.");
  }
  validateEnvironment(event.environment);
  validateNullableHttpContext(event.http_method, event.route_template, event.cursor, event.seq);
  for (const [field, value] of Object.entries({
    request_id: event.request_id,
    event_id: event.event_id,
    assertion: event.assertion,
  })) {
    if (value !== undefined) assertSafeMetadata(value, "EVENT_SCHEMA_INVALID", field);
  }
  if (event.detail !== undefined)
    assertSafeEventText(event.detail, MAX_FAILURE_DETAIL_CHARS, "detail");
  if (event.diff !== undefined && event.diff.length > MAX_DIFF_CHARS) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event diff exceeds its fixed bound.");
  }
  if (
    event.output_chars !== undefined &&
    !isBoundedInteger(event.output_chars, 0, MAX_CAPTURED_OUTPUT_CHARS * 2)
  ) {
    throw new HarnessError(
      "EVENT_SCHEMA_INVALID",
      "event output metadata exceeds its fixed bound.",
    );
  }
  if (
    event.argv !== undefined &&
    (!Array.isArray(event.argv) ||
      event.argv.some(
        (argument) => typeof argument !== "string" || argument.length > MAX_COMMAND_ARGUMENT_CHARS,
      ))
  ) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event argv metadata exceeds its fixed bound.");
  }
  if (event.output_truncated !== undefined && typeof event.output_truncated !== "boolean") {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event output truncation metadata is invalid.");
  }
  if (event.exit_code !== undefined && !isBoundedInteger(event.exit_code, -255, 255)) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event exit code is out of bounds.");
  }
}

export async function runHarness(options: HarnessRunOptions): Promise<HarnessRunResult> {
  validateHarnessRunOptions(options);
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
    validateHarnessStep(step);
    if (seenStepIds.has(step.id)) {
      throw new HarnessError(
        "STEP_ID_DUPLICATE",
        "step ids must be unique within one harness run.",
      );
    }
    seenStepIds.add(step.id);
    if ((step.adapter ?? "process") !== "process") {
      const event = unavailableAdapterEvent(options, step, seed);
      recordEvent(store, events, eventSink, event);
      continue;
    }
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

    const retries = step.replaySafe ? (step.retries ?? 0) : 0;
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
  const commandLine = step.command;
  if (commandLine === undefined) {
    throw new HarnessError("COMMAND_MISSING", "a process step requires a validated command.");
  }
  const child = Bun.spawn({
    cmd: [...commandLine],
    cwd: resolve(options.root),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: true,
    env: scrubbedChildEnvironment(),
  });
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const terminate = (reason: "timeout" | "cancelled") => {
    if (termination !== undefined) return;
    termination = reason;
    killChildGroup(child, "SIGTERM");
    forceKill = setTimeout(() => {
      killChildGroup(child, "SIGKILL");
    }, 250);
  };
  const timeout = setTimeout(() => terminate("timeout"), Math.max(1, step.timeoutMs ?? 30_000));
  const abort = () => terminate("cancelled");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();

  const [stdout, stderr, exitCode] = await Promise.all([
    readBounded(child.stdout, MAX_CAPTURED_OUTPUT_CHARS),
    readBounded(child.stderr, MAX_CAPTURED_OUTPUT_CHARS),
    child.exited,
  ]);
  clearTimeout(timeout);
  if (forceKill !== undefined) {
    clearTimeout(forceKill);
    // The leader may have exited after SIGTERM while a descendant remains in its process group.
    killChildGroup(child, "SIGKILL");
  }
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
            MAX_FAILURE_DETAIL_CHARS,
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
    reproduce: safeReproductionCommand(options.reproduction),
    argv: safeArgv(commandLine, options.root),
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
    ...eventContext(options, step),
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
    reproduce: safeReproductionCommand(options.reproduction),
    detail,
    ...eventContext(options, step),
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
    reproduce: safeReproductionCommand(options.reproduction),
    artifact_digest: junitDigest,
    detail:
      "Harness output is redacted and bounded; a passing harness run is not product correctness.",
    ...eventContext(options),
  };
}

function recordEvent(
  store: ArtifactStore,
  events: HarnessEvent[],
  sink: (event: HarnessEvent) => void,
  event: HarnessEvent,
): void {
  validateHarnessEvent(event);
  store.append(event);
  events.push(event);
  sink(event);
}

function unavailableAdapterEvent(
  options: HarnessRunOptions,
  step: HarnessStep,
  seed: number,
): HarnessEvent {
  const now = new Date().toISOString();
  const adapter = step.adapter ?? "process";
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
    status: "blocked",
    code: "ADAPTER_UNAVAILABLE",
    reproduce: safeReproductionCommand(options.reproduction),
    detail: `${adapter} adapter is not registered in OPS.2a; no ${adapter} behavior was exercised.`,
    ...eventContext(options, step),
  };
}

function eventContext(
  options: HarnessRunOptions,
  step?: HarnessStep,
): Pick<
  HarnessEvent,
  "adapter" | "git_revision" | "environment" | "http_method" | "route_template" | "cursor" | "seq"
> {
  const http = step?.http;
  return {
    adapter: step?.adapter ?? "process",
    git_revision: options.gitRevision ?? "unavailable",
    environment: {
      runtime: "bun",
      runtime_version: Bun.version,
      platform: process.platform,
      binding_versions: orderedBindingVersions(options.bindingVersions),
    },
    http_method: http?.method ?? null,
    route_template: http?.routeTemplate ?? null,
    cursor: http?.cursor ?? null,
    seq: http?.seq ?? null,
  };
}

function scrubbedChildEnvironment(): Record<string, string> {
  // Do not inherit process.env: any unlabelled value might be sensitive. These fixed values
  // are sufficient for absolute executables and the standard system command search path.
  return process.platform === "win32"
    ? { PATH: "C:\\Windows\\System32", LANG: "C", TZ: "UTC" }
    : { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" };
}

function killChildGroup(
  child: { pid: number; kill(signal?: string | number): void },
  signal: string,
): void {
  try {
    if (process.platform === "win32") {
      child.kill(signal);
      return;
    }
    // Bun detached=true calls setsid() on POSIX, making the leader PID its process-group ID.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Exit between a timeout tick and signal delivery is an expected race.
    }
  }
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
  return clip(redactNeverLog(value, root), MAX_METADATA_CHARS);
}

function validateCommand(command: readonly string[] | undefined): void {
  if (!Array.isArray(command) || command.length === 0 || command.length > MAX_COMMAND_ARGUMENTS) {
    throw new HarnessError("COMMAND_LIMIT", "command must have a bounded non-empty argv.");
  }
  const totalLength = command.reduce((total, argument) => total + argument.length, 0);
  if (totalLength > MAX_COMMAND_CHARS) {
    throw new HarnessError("COMMAND_LIMIT", "command exceeds the fixed argv character bound.");
  }
  for (const argument of command) {
    if (
      typeof argument !== "string" ||
      argument.length === 0 ||
      argument.length > MAX_COMMAND_ARGUMENT_CHARS
    ) {
      throw new HarnessError(
        "COMMAND_LIMIT",
        "each command argument must be a bounded non-empty string.",
      );
    }
    if (containsForbiddenCommandSecret(argument)) {
      throw new HarnessError(
        "COMMAND_SECRET_FORBIDDEN",
        "secret-bearing argv is forbidden because process tables are not redactable.",
      );
    }
  }
}

function containsForbiddenCommandSecret(value: string): boolean {
  return [
    /asimp_ag_[A-Za-z0-9_-]{4,}/,
    /#v1\.[A-Za-z0-9._~-]{4,}/,
    /\bBearer\s+[A-Za-z0-9._~+/-]{4,}={0,2}/i,
    /\b(?:authorization|cookie|set-cookie|token|access_token|refresh_token|id_token|password|signature|sig|authorization_code|directive_body|workshop_body)\s*(?:=|:)\s*(?:"[^"]{4,}"|'[^']{4,}'|[^\s,;]{4,})/i,
    /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}/,
    /\bgh[pousr]_[A-Za-z0-9]{16,}/,
    /\bAIza[0-9A-Za-z_-]{20,}/,
    /\b[A-Za-z0-9]{32,}\b/,
  ].some((pattern) => pattern.test(value));
}

function assertSafeMetadata(value: unknown, code: string, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_METADATA_CHARS) {
    throw new HarnessError(code, `${field} must be a bounded non-empty string.`);
  }
  if (/\p{Cc}/u.test(value) || containsForbiddenCommandSecret(value)) {
    throw new HarnessError(code, `${field} contains unsafe metadata.`);
  }
}

function assertSafeEventText(
  value: unknown,
  maximum: number,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    containsForbiddenCommandSecret(value)
  ) {
    throw new HarnessError(
      "EVENT_SCHEMA_INVALID",
      `${field} is unsafe or exceeds its fixed bound.`,
    );
  }
}

function assertBoundedInputText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length > MAX_DIFF_INPUT_CHARS) {
    throw new HarnessError("DIFF_INPUT_LIMIT", `${field} exceeds the fixed diff-input bound.`);
  }
}

function validateBindingVersions(bindingVersions: unknown): void {
  if (bindingVersions === undefined) return;
  if (
    typeof bindingVersions !== "object" ||
    bindingVersions === null ||
    Array.isArray(bindingVersions)
  ) {
    throw new HarnessError("BINDING_VERSION_INVALID", "binding versions must be an object.");
  }
  const entries = Object.entries(bindingVersions);
  if (entries.length > 16) {
    throw new HarnessError(
      "BINDING_VERSION_LIMIT",
      "binding version metadata has a fixed entry limit.",
    );
  }
  for (const [key, value] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) {
      throw new HarnessError("BINDING_VERSION_INVALID", "binding version key is invalid.");
    }
    assertSafeMetadata(value, "BINDING_VERSION_INVALID", "binding version");
  }
}

function orderedBindingVersions(
  bindingVersions: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(bindingVersions ?? {}).sort(([left], [right]) => asciiCompare(left, right)),
  );
}

function validateHttpContext(http: HttpContext): void {
  if (typeof http !== "object" || http === null || Array.isArray(http)) {
    throw new HarnessError("HTTP_CONTEXT_INVALID", "HTTP context must be an object.");
  }
  if (!/^[A-Z]{3,10}$/.test(http.method)) {
    throw new HarnessError("HTTP_CONTEXT_INVALID", "HTTP method must be an uppercase token.");
  }
  if (
    http.routeTemplate.length === 0 ||
    http.routeTemplate.length > MAX_ROUTE_TEMPLATE_CHARS ||
    !http.routeTemplate.startsWith("/") ||
    /[?#\s]/.test(http.routeTemplate)
  ) {
    throw new HarnessError(
      "HTTP_CONTEXT_INVALID",
      "route template must be a bounded path without query data.",
    );
  }
  if (http.cursor !== undefined && !isBoundedInteger(http.cursor, 0, Number.MAX_SAFE_INTEGER)) {
    throw new HarnessError("HTTP_CONTEXT_INVALID", "cursor must be a non-negative integer.");
  }
  if (http.seq !== undefined && !isBoundedInteger(http.seq, 0, Number.MAX_SAFE_INTEGER)) {
    throw new HarnessError("HTTP_CONTEXT_INVALID", "seq must be a non-negative integer.");
  }
}

function validateNullableHttpContext(
  method: string | null,
  routeTemplate: string | null,
  cursor: number | null,
  seq: number | null,
): void {
  if (
    (method !== null && typeof method !== "string") ||
    (routeTemplate !== null && typeof routeTemplate !== "string") ||
    (cursor !== null && typeof cursor !== "number") ||
    (seq !== null && typeof seq !== "number")
  ) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event HTTP context has invalid field types.");
  }
  if ((method === null) !== (routeTemplate === null)) {
    throw new HarnessError(
      "EVENT_SCHEMA_INVALID",
      "HTTP method and route template must appear together.",
    );
  }
  if (method !== null && routeTemplate !== null)
    validateHttpContext({
      method,
      routeTemplate,
      cursor: cursor ?? undefined,
      seq: seq ?? undefined,
    });
  if (cursor !== null && !isBoundedInteger(cursor, 0, Number.MAX_SAFE_INTEGER)) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event cursor is invalid.");
  }
  if (seq !== null && !isBoundedInteger(seq, 0, Number.MAX_SAFE_INTEGER)) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event seq is invalid.");
  }
}

function validateEnvironment(environment: HarnessEvent["environment"]): void {
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event environment must be an object.");
  }
  if (
    environment.runtime !== "bun" ||
    !/^\d+\.\d+\.\d+/.test(environment.runtime_version) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(environment.platform)
  ) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event environment is invalid.");
  }
  validateBindingVersions(environment.binding_versions);
}

function isGitRevision(value: string): boolean {
  return value === "unavailable" || /^[0-9a-f]{7,64}$/i.test(value);
}

function isValidReproduction(value: string): boolean {
  return (
    value === "scripts/e2e-test-harness.sh --self-test" ||
    value === "unavailable: no registered CLI scenario"
  );
}

function isHarnessAdapter(value: unknown): value is HarnessAdapter {
  return ["process", "d1", "http", "browser"].includes(String(value));
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
  );
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

function secretEmitterCommand(): readonly string[] {
  return [process.execPath, resolve(import.meta.dir, "self-test-secret-emitter.ts")];
}

export async function runHarnessSelfTest(
  root: string,
  onEvent?: (event: HarnessEvent) => void,
): Promise<0 | 1> {
  const runId = `ops.2a-selftest-${Date.now()}-${process.pid}`;
  const secret = ["asimp", "ag", "01JXYZ", "selftest", "neverlog", "canary"].join("_");
  const sink =
    onEvent ?? ((record: HarnessEvent) => process.stdout.write(`${JSON.stringify(record)}\n`));
  const result = await runHarness({
    root,
    runId,
    suite: "ops.2a-harness-self-test",
    reproduction: "self-test",
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
        id: "d1-adapter-unavailable",
        scenario: "integration",
        adapter: "d1",
        replaySafe: false,
        assertion: "D1 adapter intentionally unavailable",
      },
      {
        id: "http-adapter-unavailable",
        scenario: "integration",
        adapter: "http",
        replaySafe: false,
        assertion: "HTTP adapter intentionally unavailable",
      },
      {
        id: "browser-adapter-unavailable",
        scenario: "e2e",
        adapter: "browser",
        replaySafe: false,
        assertion: "browser adapter intentionally unavailable",
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
        command: secretEmitterCommand(),
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
    reproduction: "self-test",
    steps: resumeSteps,
    onEvent: sink,
  });
  const resumed = await runHarness({
    root,
    runId: resumeRunId,
    suite: "ops.2a-harness-self-test",
    reproduction: "self-test",
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
    result.events.every((event) => event.reproduce === "scripts/e2e-test-harness.sh --self-test") &&
    result.events.filter((item) => item.code === "ADAPTER_UNAVAILABLE").length === 3 &&
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
    adapter: "process",
    status: pass ? "pass" : "fail",
    code: pass ? "HARNESS_SELF_TEST_HARNESS_ONLY" : "HARNESS_SELF_TEST_FAILED",
    reproduce: "scripts/e2e-test-harness.sh --self-test",
    git_revision: "unavailable",
    environment: {
      runtime: "bun",
      runtime_version: Bun.version,
      platform: process.platform,
      binding_versions: {},
    },
    http_method: null,
    route_template: null,
    cursor: null,
    seq: null,
    detail: pass
      ? "Harness-only validation passed; D1, HTTP, and browser adapters are blocked and no product behavior is proven."
      : "Harness self-test invariants failed.",
  };
  validateHarnessEvent(event);
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
