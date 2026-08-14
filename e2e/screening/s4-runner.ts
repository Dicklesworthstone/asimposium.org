import {
  aggregateScreeningRun,
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

const usage = "bun e2e/screening/s4-runner.ts <self-test|live>";
const LIVE_REQUEST_TIMEOUT_MS = 15_000;

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

/** Bounds staging I/O; callers translate timeout/error into a BLOCKED run. */
async function fetchLive(url: URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
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

/**
 * The production-configuration dry check, which is independent of screening
 * accuracy: a partial screening run still has to prove OAuth is configured the
 * way the bead requires, and an OAuth defect is a failure in either run shape.
 */
async function assertOAuthDryCheck(oauthUrl: URL, bearer: string): Promise<void> {
  let oauthResponse: Response;
  try {
    oauthResponse = await fetchLive(oauthUrl, { headers: { authorization: `Bearer ${bearer}` } });
  } catch {
    throw new RunnerFailure("OAUTH_DRY_CHECK_UNAVAILABLE", 78);
  }
  if (!oauthResponse.ok) throw new RunnerFailure("OAUTH_DRY_CHECK_UNAVAILABLE", 78);
  try {
    assertProductionOAuthDryCheck(await oauthResponse.json());
  } catch (error) {
    if (error instanceof RunnerFailure) throw error;
    if (error instanceof OAuthDryCheckFailure) throw new RunnerFailure(error.code, 1);
    throw new RunnerFailure("OAUTH_DRY_CHECK_INVALID_RESPONSE", 1);
  }
}

async function runLive(): Promise<void> {
  const corpus = await createS4Corpus();
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
  const screeningUrl = requiredHttpsUrl("S4_STAGING_SCREENING_URL");
  const oauthUrl = requiredHttpsUrl("S4_STAGING_OAUTH_DRY_CHECK_URL");
  const bearer = requiredBearer();
  const digestBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(submitted))),
  );
  const corpusDigest = `sha256:${Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  let screeningResponse: Response;
  try {
    screeningResponse = await fetchLive(screeningUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      // Staging owns protected bodies. This request carries safe inline bodies
      // plus protected locators/digests, never a substitute response.
      body: JSON.stringify({
        corpus_revision: S4_CORPUS_REVISION,
        corpus_digest: corpusDigest,
        // A partial run submits only what it can bind to a digest. Sending the
        // reserved entries would invite staging to answer for bodies neither
        // side holds.
        partial_run: partial,
        examples: submitted,
      }),
    });
  } catch {
    throw new RunnerFailure("WORKERS_AI_STAGING_UNAVAILABLE", 78);
  }
  if (!screeningResponse.ok) throw new RunnerFailure("WORKERS_AI_STAGING_UNAVAILABLE", 78);
  const screening = (await screeningResponse.json()) as StagingScreeningResponse;
  if (
    screening.corpus_revision !== S4_CORPUS_REVISION ||
    screening.corpus_digest !== corpusDigest
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
    verifyObservationBodyBindings(submitted, screening.observations);
  } catch {
    throw new RunnerFailure("STAGING_BODY_DIGEST_BINDING_MISMATCH", 1);
  }
  // Safe NDJSON only on either branch; no origin, bearer, protected body,
  // prompt, or raw score.
  if (partial) {
    const partialReport: PartialReport = aggregatePartialScreeningRun({
      corpus: evaluable,
      observations: screening.observations,
      identity,
      evidence_class: "provider-measured",
      reserved_count: reserved.length,
    });
    // Belt and braces: the verdict union has no `pass` member, and this
    // re-checks that the named blockers survived aggregation regardless.
    assertPartialRunNotGreen(partialReport);
    await assertOAuthDryCheck(oauthUrl, bearer);
    process.stdout.write(`${partialRunOpsJsonl(partialReport)}\n`);
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
  await assertOAuthDryCheck(oauthUrl, bearer);
  process.stdout.write(`${screeningOpsJsonl(corpus, screening.observations, report)}\n`);
  if (report.verdict !== "pass") {
    throw new RunnerFailure(
      report.verdict === "blocked"
        ? "WORKERS_AI_STAGING_BLOCKED"
        : "S4_THRESHOLD_OR_SENTINEL_FAILED",
      report.verdict === "blocked" ? 78 : 1,
    );
  }
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
  const report = await runLegitimateOnlyScreening({
    corpus,
    provider: createFixtureScreeningProvider(),
    identity: {
      corpus_revision: S4_CORPUS_REVISION,
      corpus_digest: `sha256:${"0".repeat(64)}`,
      model_version: FIXTURE_MODEL_VERSION,
      policy_version: FIXTURE_POLICY_VERSION,
      configuration_digest: FIXTURE_CONFIGURATION_DIGEST,
    },
    evidence_class: "fixture-not-model-evidence",
  });
  assertPartialRunNotGreen(report);
  process.stdout.write(`${partialRunOpsJsonl(report)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      suite: "s4-screening-oauth",
      status: readiness.status,
      code:
        readiness.status === "blocked"
          ? "PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE"
          : "S4_MANIFEST_READY",
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

const command = process.argv[2];
if (command === "self-test") {
  process.exitCode = await runSelfTest();
} else if (command === "live") {
  try {
    await runLive();
  } catch (error) {
    const exitCode = error instanceof RunnerFailure ? error.exit_code : 78;
    process.stderr.write(
      `${JSON.stringify({
        suite: "s4-screening-oauth",
        status: exitCode === 78 ? "blocked" : "fail",
        code: safeFailureCode(error),
      })}\n`,
    );
    process.exitCode = exitCode;
  }
} else {
  process.stderr.write(`${usage}\n`);
  process.exitCode = 64;
}
