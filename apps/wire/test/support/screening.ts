import { POLICY_CATEGORIES, type ScreeningObservation } from "../../src/screening/types";
import {
  type PublicationScreeningObservation,
  promotionScreeningBinding,
  type WorkersAIPromotionInput,
} from "../../src/screening/workers-ai";

/** Synthetic classifier provenance for local tests; never live-provider proof. */
export async function syntheticScreeningObservation(
  input: WorkersAIPromotionInput,
  decision: Pick<ScreeningObservation, "decision" | "coarse_category" | "provider_status">,
): Promise<PublicationScreeningObservation> {
  const binding = await promotionScreeningBinding(input);
  return {
    example_id: "synthetic-publication",
    evaluated_body_digest: binding.bodyDigest,
    evaluated_context_digest: binding.contextDigest,
    category_score_bands: Object.fromEntries(
      POLICY_CATEGORIES.map((category) => [category, undefined]),
    ) as ScreeningObservation["category_score_bands"],
    model_version: "synthetic-local-model:v1",
    policy_version: "synthetic-local-policy:v1",
    configuration_digest: `sha256:${"c".repeat(64)}`,
    decision_path:
      decision.provider_status === "timeout"
        ? "provider-timeout-fail-closed"
        : decision.provider_status === "error"
          ? "provider-error-fail-closed"
          : "provider",
    status_code:
      decision.provider_status === "timeout"
        ? "SCREENING_PROVIDER_TIMEOUT"
        : decision.provider_status === "error"
          ? "SCREENING_PROVIDER_ERROR"
          : "SCREENED",
    latency_ms: 0,
    retry_count: 0,
    ...decision,
  };
}
