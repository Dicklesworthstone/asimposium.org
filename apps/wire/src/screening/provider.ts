import type {
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

const MAX_PROVIDER_TIMEOUT_MS = 60_000;
const SCORE_BANDS = ["low", "elevated", "high"] as const;

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

function assertProviderOptions(options: ProviderScreenOptions): void {
  if (
    !Number.isInteger(options.timeout_ms) ||
    options.timeout_ms < 1 ||
    options.timeout_ms > MAX_PROVIDER_TIMEOUT_MS
  ) {
    throw new TypeError(`timeout_ms must be an integer from 1 to ${MAX_PROVIDER_TIMEOUT_MS}.`);
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
