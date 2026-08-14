import { aggregateScreeningRun, screeningOpsJsonl, type ScreeningObservation, type ScreeningRunIdentity } from "../../apps/wire/src/screening/index";
import { assertS4CorpusShape, createS4Corpus, S4_CORPUS_REVISION } from "./s4-corpus";

const usage = "bun e2e/screening/s4-runner.ts <self-test|live>";

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

interface OAuthDryCheckResponse {
  readonly environment: string;
  readonly provider: string;
  readonly scopes: readonly string[];
  readonly redirect_uris: readonly string[];
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
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error(`${name}_INVALID`);
  return parsed;
}

function requiredBearer(): string {
  const token = process.env.S4_STAGING_BEARER_TOKEN;
  if (!token || token.trim().length < 16) throw new Error("S4_STAGING_BEARER_TOKEN_MISSING");
  return token;
}

function safeFailureCode(error: unknown): string {
  const value = error instanceof RunnerFailure ? error.code : error instanceof Error ? error.message : "S4_RUNNER_UNKNOWN";
  return /^[A-Z0-9_]+$/.test(value) ? value : "S4_RUNNER_REQUEST_FAILED";
}

function assertOAuthDryCheck(value: unknown): void {
  const response = value as Partial<OAuthDryCheckResponse>;
  const expectedScopes = ["email", "openid", "profile"];
  const scopes = [...(response.scopes ?? [])].sort();
  if (response.environment !== "production" || response.provider !== "google" || JSON.stringify(scopes) !== JSON.stringify(expectedScopes)) {
    throw new Error("OAUTH_DRY_CHECK_SCOPE_OR_PROVIDER_MISMATCH");
  }
  if (!Array.isArray(response.redirect_uris) || response.redirect_uris.length === 0) throw new Error("OAUTH_DRY_CHECK_REDIRECT_MISSING");
  for (const redirect of response.redirect_uris) {
    const parsed = new URL(redirect);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
      throw new Error("OAUTH_DRY_CHECK_REDIRECT_INVALID");
    }
  }
}

async function runLive(): Promise<void> {
  const corpus = await createS4Corpus();
  assertS4CorpusShape(corpus);
  const screeningUrl = requiredHttpsUrl("S4_STAGING_SCREENING_URL");
  const oauthUrl = requiredHttpsUrl("S4_STAGING_OAUTH_DRY_CHECK_URL");
  const bearer = requiredBearer();
  const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(corpus))));
  const corpusDigest = `sha256:${Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const screeningResponse = await fetch(screeningUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    // Staging owns the protected raw bodies. This runner transmits only frozen
    // metadata/digests, so a local stand-in cannot masquerade as a live screen.
    body: JSON.stringify({ corpus_revision: S4_CORPUS_REVISION, corpus_digest, examples: corpus }),
  });
  if (!screeningResponse.ok) throw new RunnerFailure("WORKERS_AI_STAGING_UNAVAILABLE", 78);
  const screening = (await screeningResponse.json()) as StagingScreeningResponse;
  if (screening.corpus_revision !== S4_CORPUS_REVISION || screening.corpus_digest !== corpusDigest) {
    throw new RunnerFailure("STAGING_CORPUS_IDENTITY_MISMATCH", 1);
  }
  const identity: ScreeningRunIdentity = {
    corpus_revision: screening.corpus_revision,
    corpus_digest: screening.corpus_digest,
    model_version: screening.model_version,
    policy_version: screening.policy_version,
    configuration_digest: screening.configuration_digest,
  };
  const report = aggregateScreeningRun(corpus, screening.observations, identity);
  const oauthResponse = await fetch(oauthUrl, { headers: { authorization: `Bearer ${bearer}` } });
  if (!oauthResponse.ok) throw new RunnerFailure("OAUTH_DRY_CHECK_UNAVAILABLE", 78);
  assertOAuthDryCheck(await oauthResponse.json());
  // Safe NDJSON only; no origin, bearer, protected body, prompt, or raw score.
  process.stdout.write(`${screeningOpsJsonl(corpus, screening.observations, report)}\n`);
  if (report.verdict !== "pass") {
    throw new RunnerFailure(report.verdict === "blocked" ? "WORKERS_AI_STAGING_BLOCKED" : "S4_THRESHOLD_OR_SENTINEL_FAILED", report.verdict === "blocked" ? 78 : 1);
  }
}

const command = process.argv[2];
if (command === "self-test") {
  assertS4CorpusShape(await createS4Corpus());
  process.stdout.write(JSON.stringify({ suite: "s4-screening-oauth", status: "pass", code: "S4_CORPUS_SHAPE_OK" }) + "\n");
} else if (command === "live") {
  try {
    await runLive();
  } catch (error) {
    const exitCode = error instanceof RunnerFailure ? error.exit_code : 78;
    process.stderr.write(JSON.stringify({ suite: "s4-screening-oauth", status: exitCode === 78 ? "blocked" : "fail", code: safeFailureCode(error) }) + "\n");
    process.exitCode = exitCode;
  }
} else {
  process.stderr.write(`${usage}\n`);
  process.exitCode = 64;
}
