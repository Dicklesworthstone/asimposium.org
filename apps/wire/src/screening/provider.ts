import { isSafeScreeningDiagnosticLabel, isSha256Digest } from "./aggregate";
import { contextualScreeningInputDigest, normalizeContextualScreeningInput } from "./context";
import type {
  ContextualScreeningIdentity,
  ContextualScreeningInput,
  ContextualScreeningProvider,
  ContextualScreeningResult,
  DirectContentScreeningVerdict,
  PolicyCategory,
  ProviderStatus,
  ScreeningObservation,
  ScreeningProvider,
  ScreeningProviderRequest,
} from "./types";
import { POLICY_CATEGORIES, SCREENING_DECISIONS } from "./types";

export interface ProviderScreenOptions {
  readonly timeout_ms: number;
  /** Injected for deterministic unit tests; never use a local clock as staging evidence. */
  readonly now_ms?: () => number;
}

export interface ContextualProviderScreenOptions extends ProviderScreenOptions {
  readonly identity: ContextualScreeningIdentity;
  /** Direct-content safety runs first; contextual assembly never overrides it. */
  readonly direct_content: DirectContentScreeningVerdict;
}

const MAX_PROVIDER_TIMEOUT_MS = 60_000;
const SCORE_BANDS = ["low", "elevated", "high"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class ProviderDeadlineExceeded extends Error {
  constructor() {
    super("provider deadline exceeded");
    this.name = "ProviderDeadlineExceeded";
  }
}

const EMPTY_SCORE_BANDS: Readonly<Record<PolicyCategory, undefined>> = {
  "benign-context": undefined,
  "spam-commercial": undefined,
  injection: undefined,
  "dual-use-boundary": undefined,
  "operational-harm": undefined,
  harassment: undefined,
  "sexual-content": undefined,
  "provider-unavailable": undefined,
};

function providerFailureObservation(
  request: ScreeningProviderRequest,
  providerStatus: Exclude<ProviderStatus, "ok">,
  latencyMs: number,
  retryCount: number,
): ScreeningObservation {
  const timedOut = providerStatus === "timeout";
  return {
    example_id: request.example_id,
    evaluated_body_digest: request.body_digest,
    // The Worker must never publish on an unavailable screening dependency.
    decision: "quarantine",
    coarse_category: "provider-unavailable",
    category_score_bands: EMPTY_SCORE_BANDS,
    model_version: request.identity.model_version,
    policy_version: request.identity.policy_version,
    configuration_digest: request.identity.configuration_digest,
    provider_status: providerStatus,
    decision_path: timedOut ? "provider-timeout-fail-closed" : "provider-error-fail-closed",
    status_code: timedOut ? "SCREENING_PROVIDER_TIMEOUT" : "SCREENING_PROVIDER_ERROR",
    latency_ms: latencyMs,
    retry_count: retryCount,
  };
}

function boundContextualResult(
  inputDigest: string,
  identity: ContextualScreeningIdentity,
  result: Omit<
    ContextualScreeningResult,
    "input_digest" | "model_version" | "policy_version" | "configuration_digest"
  >,
): ContextualScreeningResult {
  return {
    input_digest: inputDigest,
    model_version: identity.model_version,
    policy_version: identity.policy_version,
    configuration_digest: identity.configuration_digest,
    ...result,
  };
}

function contextualProviderFailure(
  inputDigest: string,
  identity: ContextualScreeningIdentity,
  providerStatus: Exclude<ProviderStatus, "ok">,
): ContextualScreeningResult {
  const timedOut = providerStatus === "timeout";
  return boundContextualResult(inputDigest, identity, {
    // Contextual risk is deliberately a hold. This slice never turns an
    // assembly signal into a detailed policy rejection.
    decision: "quarantine",
    coarse_category: "provider-unavailable",
    provider_status: providerStatus,
    decision_path: timedOut ? "provider-timeout-fail-closed" : "provider-error-fail-closed",
    status_code: timedOut ? "SCREENING_PROVIDER_TIMEOUT" : "SCREENING_PROVIDER_ERROR",
  });
}

function decisionRank(decision: ContextualScreeningResult["decision"]): number {
  switch (decision) {
    case "reject":
      return 3;
    case "quarantine":
      return 2;
    case "allow-with-warning":
      return 1;
    case "pass":
      return 0;
  }
}

function directContentResult(
  inputDigest: string,
  identity: ContextualScreeningIdentity,
  verdict: DirectContentScreeningVerdict,
): ContextualScreeningResult {
  return boundContextualResult(inputDigest, identity, {
    decision: verdict.decision,
    coarse_category: verdict.coarse_category,
    provider_status: "ok",
    decision_path:
      verdict.decision === "reject"
        ? "direct-content-reject"
        : verdict.decision === "quarantine"
          ? "direct-content-hold"
          : "direct-content-warning",
    status_code: "SCREENED",
  });
}

function contextualProviderResult(
  inputDigest: string,
  identity: ContextualScreeningIdentity,
  response: Awaited<ReturnType<ContextualScreeningProvider["screenContextually"]>>,
): ContextualScreeningResult {
  if (response.decision === "pass" || response.decision === "allow-with-warning") {
    return boundContextualResult(inputDigest, identity, {
      decision: response.decision,
      coarse_category: response.coarse_category,
      provider_status: "ok",
      decision_path: "provider",
      status_code: "SCREENED",
    });
  }
  // Contextual aggregation is deliberately a private, appealable hold. It
  // may never produce a detailed public rejection, even when a provider uses
  // its internal reject class for the assembled text.
  return boundContextualResult(inputDigest, identity, {
    decision: "quarantine",
    coarse_category: response.coarse_category,
    provider_status: "ok",
    decision_path: "provider-contextual-hold",
    status_code: "SCREENED",
  });
}

/**
 * Compose independent direct and contextual verdicts monotonically. A
 * contextual pass cannot soften a direct warning; ties retain direct-content
 * responsibility except for pass/pass, where the provider receipt remains the
 * useful decision path.
 */
function composeContextualResult(
  direct: ContextualScreeningResult,
  contextual: ContextualScreeningResult,
): ContextualScreeningResult {
  const directRank = decisionRank(direct.decision);
  const contextualRank = decisionRank(contextual.decision);
  if (directRank > contextualRank || (directRank === 1 && contextualRank === 1)) {
    return direct;
  }
  return contextual;
}

function assertProviderOptions(options: ProviderScreenOptions): void {
  if (
    !Number.isInteger(options.timeout_ms) ||
    options.timeout_ms < 1 ||
    options.timeout_ms > MAX_PROVIDER_TIMEOUT_MS
  ) {
    throw new TypeError(`timeout_ms must be an integer from 1 to ${MAX_PROVIDER_TIMEOUT_MS}.`);
  }
}

function assertProviderRequest(request: ScreeningProviderRequest): void {
  if (
    !isSafeScreeningDiagnosticLabel(request.example_id) ||
    !isSha256Digest(request.body_digest) ||
    !isSha256Digest(request.context_digest) ||
    !isSha256Digest(request.identity.corpus_digest) ||
    !isSha256Digest(request.identity.configuration_digest) ||
    !isSafeScreeningDiagnosticLabel(request.identity.corpus_revision) ||
    !isSafeScreeningDiagnosticLabel(request.identity.model_version) ||
    !isSafeScreeningDiagnosticLabel(request.identity.policy_version)
  ) {
    throw new TypeError("Screening request metadata is unsafe or malformed.");
  }
}

function assertContextualIdentity(
  identity: unknown,
): asserts identity is ContextualScreeningIdentity {
  if (!isRecord(identity)) throw new TypeError("Contextual screening identity is malformed.");
  if (
    typeof identity.model_version !== "string" ||
    typeof identity.policy_version !== "string" ||
    typeof identity.configuration_digest !== "string" ||
    !isSafeScreeningDiagnosticLabel(identity.model_version) ||
    !isSafeScreeningDiagnosticLabel(identity.policy_version) ||
    !isSha256Digest(identity.configuration_digest)
  ) {
    throw new TypeError("Contextual screening identity is unsafe or malformed.");
  }
}

function assertDirectContentVerdict(
  verdict: unknown,
): asserts verdict is DirectContentScreeningVerdict {
  if (!isRecord(verdict)) throw new TypeError("Direct-content screening verdict is malformed.");
  if (
    typeof verdict.decision !== "string" ||
    typeof verdict.coarse_category !== "string" ||
    !(SCREENING_DECISIONS as readonly string[]).includes(verdict.decision as string) ||
    !isPolicyCategory(verdict.coarse_category)
  ) {
    throw new TypeError("Direct-content screening verdict is invalid.");
  }
}

function isPolicyCategory(value: unknown): value is PolicyCategory {
  return typeof value === "string" && (POLICY_CATEGORIES as readonly string[]).includes(value);
}

function assertProviderResponse(
  value: unknown,
): asserts value is Awaited<ReturnType<ScreeningProvider["screen"]>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Provider response must be an object.");
  }
  const response = value as Record<string, unknown>;
  if (
    !(SCREENING_DECISIONS as readonly string[]).includes(response.decision as string) ||
    !isPolicyCategory(response.coarse_category) ||
    response.category_score_bands === null ||
    typeof response.category_score_bands !== "object" ||
    Array.isArray(response.category_score_bands)
  ) {
    throw new TypeError("Provider response has an invalid decision or category.");
  }
  const record = response.category_score_bands as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [...POLICY_CATEGORIES].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError("Provider response has invalid score-band keys.");
  }
  for (const category of POLICY_CATEGORIES) {
    const band = record[category];
    if (band !== undefined && !(SCORE_BANDS as readonly string[]).includes(band as string)) {
      throw new TypeError("Provider response has an invalid score band.");
    }
  }
}

function assertContextualProviderResponse(
  value: unknown,
): asserts value is Awaited<ReturnType<ContextualScreeningProvider["screenContextually"]>> {
  if (!isRecord(value)) throw new TypeError("Contextual provider response must be an object.");
  if (
    typeof value.decision !== "string" ||
    typeof value.coarse_category !== "string" ||
    !(SCREENING_DECISIONS as readonly string[]).includes(value.decision as string) ||
    !isPolicyCategory(value.coarse_category)
  ) {
    throw new TypeError("Contextual provider response has an invalid decision or category.");
  }
}

/**
 * Invoke a real provider once one is available. A timeout, thrown error, or
 * rejected transport becomes quarantine; this function cannot return pass on
 * a provider failure.
 */
export async function screenWithProvider(
  provider: ScreeningProvider,
  request: ScreeningProviderRequest,
  options: ProviderScreenOptions,
): Promise<ScreeningObservation> {
  assertProviderOptions(options);
  assertProviderRequest(request);
  const now = options.now_ms ?? Date.now;
  const started = now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderDeadlineExceeded());
    }, options.timeout_ms);
  });
  const retryCount = 0;

  try {
    const response = await Promise.race([provider.screen(request, controller.signal), deadline]);
    assertProviderResponse(response);
    return {
      example_id: request.example_id,
      evaluated_body_digest: request.body_digest,
      decision: response.decision,
      coarse_category: response.coarse_category,
      category_score_bands: response.category_score_bands,
      model_version: request.identity.model_version,
      policy_version: request.identity.policy_version,
      configuration_digest: request.identity.configuration_digest,
      provider_status: "ok",
      decision_path: "provider",
      status_code: "SCREENED",
      latency_ms: Math.max(0, now() - started),
      retry_count: retryCount,
    };
  } catch (error) {
    const providerStatus: Exclude<ProviderStatus, "ok"> =
      error instanceof ProviderDeadlineExceeded ||
      controller.signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
        ? "timeout"
        : "error";
    return providerFailureObservation(
      request,
      providerStatus,
      Math.max(0, now() - started),
      retryCount,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Invoke the live contextual-provider seam without producing a measurement
 * observation. The raw input crosses exactly this function boundary and the
 * provider call; its returned result is safe for a private hold record.
 */
export async function screenContextuallyWithProvider(
  provider: ContextualScreeningProvider,
  input: ContextualScreeningInput,
  options: ContextualProviderScreenOptions,
): Promise<ContextualScreeningResult> {
  assertProviderOptions(options);
  const normalizedInput = normalizeContextualScreeningInput(input);
  assertContextualIdentity(options.identity);
  assertDirectContentVerdict(options.direct_content);
  const inputDigest = await contextualScreeningInputDigest(normalizedInput);
  if (options.direct_content.decision === "reject") {
    return directContentResult(inputDigest, options.identity, options.direct_content);
  }
  if (options.direct_content.decision === "quarantine") {
    return directContentResult(inputDigest, options.identity, options.direct_content);
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderDeadlineExceeded());
    }, options.timeout_ms);
  });

  try {
    const response = await Promise.race([
      provider.screenContextually(normalizedInput, controller.signal),
      deadline,
    ]);
    assertContextualProviderResponse(response);
    return composeContextualResult(
      directContentResult(inputDigest, options.identity, options.direct_content),
      contextualProviderResult(inputDigest, options.identity, response),
    );
  } catch (error) {
    const providerStatus: Exclude<ProviderStatus, "ok"> =
      error instanceof ProviderDeadlineExceeded ||
      controller.signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
        ? "timeout"
        : "error";
    return contextualProviderFailure(inputDigest, options.identity, providerStatus);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
