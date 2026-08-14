import type {
  PolicyCategory,
  ProviderStatus,
  ScreeningObservation,
  ScreeningProvider,
  ScreeningProviderRequest,
} from "./types";

export interface ProviderScreenOptions {
  readonly timeout_ms: number;
  readonly retry_count?: number;
  /** Injected for deterministic unit tests; never use a local clock as staging evidence. */
  readonly now_ms?: () => number;
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
  const now = options.now_ms ?? Date.now;
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout_ms);
  const retryCount = options.retry_count ?? 0;

  try {
    const response = await provider.screen(request, controller.signal);
    return {
      example_id: request.example_id,
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
      controller.signal.aborted || (error instanceof Error && error.name === "AbortError") ? "timeout" : "error";
    return providerFailureObservation(request, providerStatus, Math.max(0, now() - started), retryCount);
  } finally {
    clearTimeout(timer);
  }
}
