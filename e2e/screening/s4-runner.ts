import {
  aggregateScreeningRun,
  assertScreeningRunIdentity,
  type ScreeningCorpusExample,
  type ScreeningObservation,
  type ScreeningRunIdentity,
  screeningOpsJsonl,
  verifyObservationBodyBindings,
} from "../../apps/wire/src/screening/index";
import { assertProductionOAuthDryCheck, OAuthDryCheckFailure } from "./oauth-dry-check";
import {
  assertS4CorpusShape,
  assertS4ManifestReadyForLiveRun,
  createS4Corpus,
  deriveS4EvaluatedCorpusIdentity,
  inspectS4ManifestReadiness,
  S4_CORPUS_REVISION,
} from "./s4-corpus";
import {
  createFixtureScreeningProvider,
  FIXTURE_CONFIGURATION_DIGEST,
  FIXTURE_MODEL_VERSION,
  FIXTURE_POLICY_VERSION,
} from "./s4-fixture-provider";
import {
  aggregatePartialScreeningRun,
  assertEvaluableBodiesBindTheirDigests,
  assertPartialRunNotGreen,
  isPartialRunEligible,
  type S4PartialScreeningReport as PartialReport,
  partialRunOpsJsonl,
  partitionEvaluableCorpus,
  runLegitimateOnlyScreening,
} from "./s4-legitimate-only";

const LIVE_REQUEST_TIMEOUT_MS = 15_000;
const MAX_LIVE_JSON_BYTES = 1_048_576;

class RunnerFailure extends Error {
  constructor(
    readonly code: string,
    readonly exit_code: 1 | 78,
  ) {
    super(code);
    this.name = "RunnerFailure";
  }
}

interface StagingScreeningResponse {
  readonly corpus_revision: string;
  readonly corpus_digest: string;
  readonly model_version: string;
  readonly policy_version: string;
  readonly configuration_digest: string;
  readonly observations: readonly ScreeningObservation[];
}

export class BoundedLiveJsonError extends Error {
  constructor(
    readonly code:
      | "S4_LIVE_RESPONSE_TIMEOUT"
      | "S4_LIVE_RESPONSE_TOO_LARGE"
      | "S4_LIVE_RESPONSE_INVALID_JSON"
      | "S4_LIVE_RESPONSE_UNAVAILABLE",
  ) {
    super(code);
    this.name = "BoundedLiveJsonError";
  }
}

export interface BoundedLiveJsonOptions {
  readonly timeout_ms?: number;
  readonly max_bytes?: number;
}

interface BoundedResponseReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

/**
 * Best-effort cleanup must never replace the bounded request outcome. In
 * particular, some stream implementations throw from `releaseLock()` after an
 * abort; that is cleanup telemetry, not a reason to turn a timeout into an
 * unrelated runner failure.
 */
export function cleanupBoundedResponseReader(
  reader: Pick<BoundedResponseReader, "cancel" | "releaseLock">,
): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // A synchronous cleanup exception is deliberately contained as well.
  }
  try {
    reader.releaseLock();
  } catch {
    // Preserve the original bounded failure.
  }
}

function requiredHttpsUrl(name: string): URL {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_MISSING`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name}_INVALID`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash)
    throw new Error(`${name}_INVALID`);
  return parsed;
}

function requiredBearer(): string {
  const token = process.env.S4_STAGING_BEARER_TOKEN;
  if (!token || token.trim().length < 16) throw new Error("S4_STAGING_BEARER_TOKEN_MISSING");
  return token;
}

/**
 * Reads an entire successful JSON response under one deadline and byte ceiling.
 * `fetch()` resolving only proves headers arrived; it does not prove a body will
 * ever finish. The screening and OAuth attestation are not evidence until their
 * complete, bounded JSON documents have arrived and parsed.
 */
export async function fetchBoundedLiveJson(
  url: URL,
  init: RequestInit,
  options: BoundedLiveJsonOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeout_ms ?? LIVE_REQUEST_TIMEOUT_MS;
  const maxBytes = options.max_bytes ?? MAX_LIVE_JSON_BYTES;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1
  ) {
    throw new TypeError("S-4 live-response bounds must be positive integers.");
  }
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new BoundedLiveJsonError("S4_LIVE_RESPONSE_TIMEOUT"));
    }, timeoutMs);
  });
  let reader: BoundedResponseReader | undefined;
  try {
    const response = await Promise.race([
      // A screening attestation is bound to this exact endpoint. Following a
      // redirect could silently send its bearer/body to a different origin and
      // turn an outage page into a different response class, so reject it.
      fetch(url, { ...init, redirect: "manual", signal: controller.signal }),
      deadline,
    ]);
    if (!response.ok) throw new BoundedLiveJsonError("S4_LIVE_RESPONSE_UNAVAILABLE");
    if (response.body === null) throw new BoundedLiveJsonError("S4_LIVE_RESPONSE_INVALID_JSON");
    reader = response.body.getReader() as unknown as BoundedResponseReader;
    const chunks: Uint8Array[] = [];
    let byteCount = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      if (part.value === undefined) throw new BoundedLiveJsonError("S4_LIVE_RESPONSE_INVALID_JSON");
      byteCount += part.value.byteLength;
      if (byteCount > maxBytes) {
        controller.abort();
        throw new BoundedLiveJsonError("S4_LIVE_RESPONSE_TOO_LARGE");
      }
      chunks.push(part.value);
    }
    const complete = new Uint8Array(byteCount);
    let offset = 0;
    for (const chunk of chunks) {
      complete.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(complete));
    } catch {
      throw new BoundedLiveJsonError("S4_LIVE_RESPONSE_INVALID_JSON");
    }
  } catch (error) {
    if (error instanceof BoundedLiveJsonError) throw error;
    if (timedOut || controller.signal.aborted) {
      throw new BoundedLiveJsonError("S4_LIVE_RESPONSE_TIMEOUT");
    }
    throw new BoundedLiveJsonError("S4_LIVE_RESPONSE_UNAVAILABLE");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (reader !== undefined) {
      cleanupBoundedResponseReader(reader);
    }
  }
}

function safeFailureCode(error: unknown): string {
  const value =
    error instanceof RunnerFailure
      ? error.code
      : error instanceof Error
        ? error.message
        : "S4_RUNNER_UNKNOWN";
  return /^[A-Z0-9_]+$/.test(value) ? value : "S4_RUNNER_REQUEST_FAILED";
}

type LivePhase = () => Promise<void>;
type LiveRecordEmitter = (record: Record<string, unknown>) => void;
type TerminalExitCode = 1 | 64 | 78;

export interface S4TerminalDiagnostic {
  readonly record_type: "s4-runner-terminal";
  readonly suite: "s4-screening-oauth";
  readonly status: "blocked" | "fail";
  readonly code: string;
  readonly exit_code: TerminalExitCode;
}

function emitLiveRecord(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

/** One typed, redacted terminal outcome instead of an Error stack or prose. */
export function s4TerminalDiagnostic(
  error: unknown,
  exitCode: TerminalExitCode,
): S4TerminalDiagnostic {
  return {
    record_type: "s4-runner-terminal",
    suite: "s4-screening-oauth",
    status: exitCode === 78 ? "blocked" : "fail",
    code: safeFailureCode(error),
    exit_code: exitCode,
  };
}

function emitTerminalDiagnostic(error: unknown, exitCode: TerminalExitCode): void {
  process.stderr.write(`${JSON.stringify(s4TerminalDiagnostic(error, exitCode))}\n`);
}

function phaseFailure(error: unknown): RunnerFailure {
  if (error instanceof RunnerFailure) return error;
  return new RunnerFailure(safeFailureCode(error), 78);
}

/**
 * Screening and OAuth are independent attestations. A failed or blocked screen
 * must not skip the OAuth dry check, and each phase records only a fixed,
 * secret-safe status/code diagnostic. Successful screening emits its richer
 * OPS.2a evidence inside the screening phase before this function advances to
 * OAuth.
 */
export async function runIndependentLivePhases(
  screening: LivePhase,
  oauth: LivePhase,
  emit: LiveRecordEmitter = emitLiveRecord,
): Promise<void> {
  let screeningFailure: RunnerFailure | undefined;
  try {
    await screening();
  } catch (error) {
    screeningFailure = phaseFailure(error);
    emit({
      record_type: "screening-live-diagnostic",
      status: screeningFailure.exit_code === 78 ? "blocked" : "fail",
      code: screeningFailure.code,
    });
  }

  let oauthFailure: RunnerFailure | undefined;
  try {
    await oauth();
    emit({ record_type: "oauth-dry-check", status: "pass", code: "OAUTH_DRY_CHECK_GREEN" });
  } catch (error) {
    oauthFailure = phaseFailure(error);
    emit({
      record_type: "oauth-dry-check",
      status: oauthFailure.exit_code === 78 ? "blocked" : "fail",
      code: oauthFailure.code,
    });
  }

  // Preserve the screening outcome as the primary terminal reason while still
  // having executed and recorded OAuth. An OAuth-only failure remains terminal.
  if (screeningFailure !== undefined) throw screeningFailure;
  if (oauthFailure !== undefined) throw oauthFailure;
}

/**
 * The production-configuration dry check, which is independent of screening
 * accuracy: a partial screening run still has to prove OAuth is configured the
 * way the bead requires, and an OAuth defect is a failure in either run shape.
 */
async function assertOAuthDryCheck(oauthUrl: URL, bearer: string): Promise<void> {
  try {
    assertProductionOAuthDryCheck(
      await fetchBoundedLiveJson(oauthUrl, { headers: { authorization: `Bearer ${bearer}` } }),
    );
  } catch (error) {
    if (error instanceof OAuthDryCheckFailure) throw new RunnerFailure(error.code, 1);
    if (
      error instanceof BoundedLiveJsonError &&
      (error.code === "S4_LIVE_RESPONSE_INVALID_JSON" ||
        error.code === "S4_LIVE_RESPONSE_TOO_LARGE")
    ) {
      throw new RunnerFailure("OAUTH_DRY_CHECK_INVALID_RESPONSE", 1);
    }
    if (error instanceof RunnerFailure) throw error;
    throw new RunnerFailure("OAUTH_DRY_CHECK_UNAVAILABLE", 78);
  }
}

export interface LiveScreeningOptions {
  /** Test-only injection for a future ready protected manifest; production creates the frozen manifest. */
  readonly corpus?: readonly ScreeningCorpusExample[];
  /** Test-only transport injection; production uses bounded HTTPS fetch. */
  readonly fetch_live_json?: typeof fetchBoundedLiveJson;
  /** Keeps focused tests from writing staged-shaped records to process stdout. */
  readonly write?: (line: string) => void;
  readonly screening_url?: URL;
  readonly bearer?: string;
}

export async function runLiveScreening(options: LiveScreeningOptions = {}): Promise<void> {
  const corpus = options.corpus ?? (await createS4Corpus());
  assertS4CorpusShape(corpus);
  const readiness = inspectS4ManifestReadiness(corpus);
  /**
   * A blocked manifest used to refuse the entire run here, before staging was
   * ever contacted. That discarded the measurable half: the 150 legitimate
   * bodies are inline and available, and the false-positive criterion does not
   * need a hard-reject example to mean something.
   *
   * So a manifest blocked *only* by protected staging material now proceeds as a
   * partial run. Any other blocker — a missing inline body, a malformed entry —
   * is a corpus defect rather than an availability gap and still refuses
   * everything, because there is nothing trustworthy to partially measure.
   */
  const partial = readiness.status === "blocked";
  if (partial && !isPartialRunEligible(readiness.blockers)) {
    throw new RunnerFailure("S4_MANIFEST_NOT_EVALUATION_READY", 78);
  }
  const { evaluable, reserved } = partitionEvaluableCorpus(corpus);
  const submitted = partial ? evaluable : corpus;
  if (partial) await assertEvaluableBodiesBindTheirDigests(evaluable);
  else await assertS4ManifestReadyForLiveRun(corpus);
  const screeningUrl = options.screening_url ?? requiredHttpsUrl("S4_STAGING_SCREENING_URL");
  const bearer = options.bearer ?? requiredBearer();
  const fetchLiveJson = options.fetch_live_json ?? fetchBoundedLiveJson;
  const write = options.write ?? ((line: string) => process.stdout.write(line));
  const corpusIdentity = await deriveS4EvaluatedCorpusIdentity(submitted);
  let screening: StagingScreeningResponse;
  try {
    screening = (await fetchLiveJson(screeningUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      // Staging owns protected bodies. This request carries safe inline bodies
      // plus protected locators/digests, never a substitute response.
      body: JSON.stringify({
        corpus_revision: S4_CORPUS_REVISION,
        corpus_digest: corpusIdentity.corpus_digest,
        // A partial run submits only what it can bind to a digest. Sending the
        // reserved entries would invite staging to answer for bodies neither
        // side holds.
        partial_run: partial,
        examples: submitted,
      }),
    })) as StagingScreeningResponse;
  } catch (error) {
    if (
      error instanceof BoundedLiveJsonError &&
      (error.code === "S4_LIVE_RESPONSE_INVALID_JSON" ||
        error.code === "S4_LIVE_RESPONSE_TOO_LARGE")
    ) {
      throw new RunnerFailure("WORKERS_AI_STAGING_INVALID_RESPONSE", 1);
    }
    throw new RunnerFailure("WORKERS_AI_STAGING_UNAVAILABLE", 78);
  }
  if (
    screening.corpus_revision !== S4_CORPUS_REVISION ||
    screening.corpus_digest !== corpusIdentity.corpus_digest
  ) {
    throw new RunnerFailure("STAGING_CORPUS_IDENTITY_MISMATCH", 1);
  }
  const identity: ScreeningRunIdentity = {
    corpus_revision: screening.corpus_revision,
    corpus_digest: screening.corpus_digest,
    model_version: screening.model_version,
    policy_version: screening.policy_version,
    configuration_digest: screening.configuration_digest,
  };
  try {
    assertScreeningRunIdentity(identity);
  } catch {
    throw new RunnerFailure("STAGING_RUN_IDENTITY_INVALID", 1);
  }
  try {
    verifyObservationBodyBindings(submitted, screening.observations);
  } catch {
    throw new RunnerFailure("STAGING_BODY_DIGEST_BINDING_MISMATCH", 1);
  }
  // Safe NDJSON only on either branch; no origin, bearer, protected body,
  // prompt, or raw score.
  if (partial) {
    const partialReport: PartialReport = aggregatePartialScreeningRun({
      corpus: evaluable,
      reserved,
      observations: screening.observations,
      identity,
      evidence_class: "provider-measured",
    });
    // Evidence first: an OAuth assertion or partial terminal result must never
    // discard the screening record that was actually measured.
    write(`${partialRunOpsJsonl(partialReport)}\n`);
    // Belt and braces: the verdict union has no `pass` member, and this
    // re-checks that the named blockers survived aggregation regardless.
    assertPartialRunNotGreen(partialReport);
    // Always non-zero. A measured breach is a failure; an unmeasured half is a
    // blocker; there is no third outcome available from this branch.
    throw new RunnerFailure(
      partialReport.verdict === "fail"
        ? "S4_PARTIAL_RUN_THRESHOLD_FAILED"
        : "S4_PARTIAL_RUN_HARD_REJECT_UNMEASURED",
      partialReport.exit_code,
    );
  }
  const report = aggregateScreeningRun(corpus, screening.observations, identity);
  // Write the full OPS.2a result before any independent OAuth phase can fail.
  write(`${screeningOpsJsonl(corpus, screening.observations, report)}\n`);
  if (report.verdict !== "pass") {
    throw new RunnerFailure(
      report.verdict === "blocked"
        ? "WORKERS_AI_STAGING_BLOCKED"
        : "S4_THRESHOLD_OR_SENTINEL_FAILED",
      report.verdict === "blocked" ? 78 : 1,
    );
  }
}

async function runLiveOAuth(): Promise<void> {
  const oauthUrl = requiredHttpsUrl("S4_STAGING_OAUTH_DRY_CHECK_URL");
  await assertOAuthDryCheck(oauthUrl, requiredBearer());
}

async function runLive(): Promise<void> {
  await runIndependentLivePhases(runLiveScreening, runLiveOAuth);
}

/**
 * Local self-test: manifest validation, plus a real end-to-end exercise of the
 * partial path over the 150 available bodies.
 *
 * No Workers AI binding exists here, so the provider is the declared fixture and
 * the run is labelled `fixture-not-model-evidence` in the report and in every
 * emitted record. What this proves is the wiring — digest binding, confusion
 * arithmetic, the never-green guard — none of which depends on which model
 * answers. What it does not prove is anything at all about screening accuracy,
 * and the label is there so no reader can mistake the one for the other.
 */
async function runSelfTest(): Promise<number> {
  const corpus = await createS4Corpus();
  assertS4CorpusShape(corpus);
  const readiness = inspectS4ManifestReadiness(corpus);
  const { evaluable, reserved } = partitionEvaluableCorpus(corpus);
  await assertEvaluableBodiesBindTheirDigests(evaluable);
  // A fixture run still needs the same binding claim as a staging run: its
  // report identity names the exact available bodies it actually screened, not
  // a request-shaped placeholder digest.
  const corpusIdentity = await deriveS4EvaluatedCorpusIdentity(evaluable);
  const report = await runLegitimateOnlyScreening({
    corpus,
    provider: createFixtureScreeningProvider(),
    identity: {
      corpus_revision: corpusIdentity.corpus_revision,
      corpus_digest: corpusIdentity.corpus_digest,
      model_version: FIXTURE_MODEL_VERSION,
      policy_version: FIXTURE_POLICY_VERSION,
      configuration_digest: FIXTURE_CONFIGURATION_DIGEST,
    },
    evidence_class: "fixture-not-model-evidence",
  });
  // Preserve the measured, typed evidence even if the never-green contract
  // itself catches a future report-shape regression.
  process.stdout.write(`${partialRunOpsJsonl(report)}\n`);
  assertPartialRunNotGreen(report);
  process.stdout.write(
    `${JSON.stringify({
      record_type: "screening-self-test-summary",
      suite: "s4-screening-oauth",
      status: readiness.status,
      code:
        readiness.status === "blocked"
          ? "PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE"
          : "S4_MANIFEST_READY",
      corpus_revision: corpusIdentity.corpus_revision,
      corpus_digest: corpusIdentity.corpus_digest,
      evaluated_count: report.evaluated_count,
      reserved_count: reserved.length,
      evidence_class: report.evidence_class,
      unmeasured: report.unmeasured,
      detail:
        "manifest validated and the partial path exercised over the available bodies with a declared fixture provider; no model-derived accuracy metric was produced and the zero-false-negative half remains unmeasured",
    })}\n`,
  );
  // The manifest is still incomplete and the fixture is not evidence, so this
  // command has no path to zero while protected bodies are absent.
  return readiness.status === "blocked" ? 78 : report.exit_code;
}

async function runCommand(command: string | undefined): Promise<number> {
  try {
    if (command === "self-test") return await runSelfTest();
    if (command === "live") {
      await runLive();
      return 0;
    }
    emitTerminalDiagnostic(new Error("S4_RUNNER_USAGE"), 64);
    return 64;
  } catch (error) {
    const exitCode = error instanceof RunnerFailure ? error.exit_code : 78;
    emitTerminalDiagnostic(error, exitCode);
    return exitCode;
  }
}

if (import.meta.main) {
  process.exitCode = await runCommand(process.argv[2]);
}
