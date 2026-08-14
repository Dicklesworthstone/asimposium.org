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

async function runLive(): Promise<void> {
  const corpus = await createS4Corpus();
  assertS4CorpusShape(corpus);
  const readiness = inspectS4ManifestReadiness(corpus);
  if (readiness.status === "blocked") {
    throw new RunnerFailure(
      readiness.blockers.includes("PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE")
        ? "PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE"
        : "S4_MANIFEST_NOT_EVALUATION_READY",
      78,
    );
  }
  await assertS4ManifestReadyForLiveRun(corpus);
  const screeningUrl = requiredHttpsUrl("S4_STAGING_SCREENING_URL");
  const oauthUrl = requiredHttpsUrl("S4_STAGING_OAUTH_DRY_CHECK_URL");
  const bearer = requiredBearer();
  const digestBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(corpus))),
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
        examples: corpus,
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
    verifyObservationBodyBindings(corpus, screening.observations);
  } catch {
    throw new RunnerFailure("STAGING_BODY_DIGEST_BINDING_MISMATCH", 1);
  }
  const report = aggregateScreeningRun(corpus, screening.observations, identity);
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
  // Safe NDJSON only; no origin, bearer, protected body, prompt, or raw score.
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

const command = process.argv[2];
if (command === "self-test") {
  const corpus = await createS4Corpus();
  assertS4CorpusShape(corpus);
  const readiness = inspectS4ManifestReadiness(corpus);
  process.stdout.write(
    `${JSON.stringify({
      suite: "s4-screening-oauth",
      status: readiness.status,
      code:
        readiness.status === "blocked"
          ? "PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE"
          : "S4_MANIFEST_READY",
      detail: "manifest validation only; no screening accuracy metric was evaluated",
    })}\n`,
  );
  process.exitCode = readiness.status === "blocked" ? 78 : 0;
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
