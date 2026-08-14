/**
 * A deterministic, in-process `ScreeningProvider` for exercising the S-4 partial
 * path without a Workers AI binding.
 *
 * ## This is not a model, and nothing it returns is accuracy evidence
 *
 * It cannot be: a provider receives a digest, never a body, so this fixture has
 * literally nothing to classify. It answers from a caller-supplied decision
 * table. Its whole purpose is to prove that the runner wiring, the digest
 * binding, the confusion arithmetic, and the never-green guard all work — the
 * things that are true regardless of which model answers.
 *
 * The separation is enforced rather than documented: this file lives outside
 * `apps/wire/src/screening/**`, every run it feeds must be labelled
 * `fixture-not-model-evidence`, and that label rides on the report and on every
 * emitted NDJSON record. A reader of the logs can always tell which kind of
 * number they are looking at.
 */
import type {
  PolicyCategory,
  ScoreBand,
  ScreeningDecision,
  ScreeningProvider,
} from "../../apps/wire/src/screening/index";

/** The identity a fixture-driven run must declare, so logs name their source. */
export const FIXTURE_MODEL_VERSION = "fixture-deterministic-v1-not-a-model";
export const FIXTURE_POLICY_VERSION = "s4-policy-fixture-v1";
export const FIXTURE_CONFIGURATION_DIGEST = `sha256:${"f".repeat(64)}`;

/**
 * All eight policy categories, written as an exhaustive record so the compiler
 * fails if the policy enum grows and this fixture is not updated with it — the
 * provider contract requires every key to be present.
 */
const NO_SIGNAL_BANDS: Readonly<Record<PolicyCategory, ScoreBand | undefined>> = {
  "benign-context": "low",
  "spam-commercial": "low",
  injection: "low",
  "dual-use-boundary": "low",
  "operational-harm": "low",
  harassment: "low",
  "sexual-content": "low",
  "provider-unavailable": undefined,
};

const REJECT_BANDS: Readonly<Record<PolicyCategory, ScoreBand | undefined>> = {
  ...NO_SIGNAL_BANDS,
  "dual-use-boundary": "high",
};

export interface FixtureProviderOptions {
  /**
   * Decision for a given example id. Defaults to `pass`, which is the correct
   * answer for every legitimate weird-mathematics body in the frozen manifest —
   * so the default fixture run produces a zero false-positive rate *by
   * construction*, and that number is meaningful only as a wiring check.
   */
  readonly decide?: (exampleId: string) => ScreeningDecision;
  /** Optional per-call hook, used by tests to simulate provider unavailability. */
  readonly onScreen?: (exampleId: string) => void | Promise<void>;
}

function bandsFor(
  decision: ScreeningDecision,
): Readonly<Record<PolicyCategory, ScoreBand | undefined>> {
  return decision === "pass" || decision === "allow-with-warning" ? NO_SIGNAL_BANDS : REJECT_BANDS;
}

function categoryFor(decision: ScreeningDecision): PolicyCategory {
  return decision === "pass" || decision === "allow-with-warning"
    ? "benign-context"
    : "dual-use-boundary";
}

export function createFixtureScreeningProvider(
  options: FixtureProviderOptions = {},
): ScreeningProvider {
  const decide = options.decide ?? (() => "pass" as const);
  return {
    async screen(request, signal) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      await options.onScreen?.(request.example_id);
      const decision = decide(request.example_id);
      return {
        decision,
        coarse_category: categoryFor(decision),
        category_score_bands: bandsFor(decision),
      };
    },
  };
}
