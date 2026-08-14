import type { ScreeningAggregateReport } from "./aggregate";
import type { ScreeningCorpusExample, ScreeningObservation } from "./types";

/**
 * Safe OPS.2a records. This deliberately omits payloads, prompts, raw detector
 * scores, origins, account data, cookies, tokens, and provider response bodies.
 */
export function screeningOpsJsonl(
  corpus: readonly ScreeningCorpusExample[],
  observations: readonly ScreeningObservation[],
  report: ScreeningAggregateReport,
): string {
  const corpusById = new Map(corpus.map((example) => [example.id, example]));
  const decisionRecords = [...observations]
    .sort((left, right) => {
      if (left.example_id < right.example_id) return -1;
      if (left.example_id > right.example_id) return 1;
      return 0;
    })
    .map((observation) => {
      const example = corpusById.get(observation.example_id);
      if (!example)
        throw new Error(`Observation ${observation.example_id} has no corpus metadata.`);
      return JSON.stringify({
        record_type: "screening-decision",
        report_version: report.report_version,
        corpus_revision: report.identity.corpus_revision,
        corpus_digest: report.identity.corpus_digest,
        example_id: example.id,
        body_digest: example.body_digest,
        ground_truth: example.ground_truth,
        coarse_category: observation.coarse_category,
        decision: observation.decision,
        provider_status: observation.provider_status,
        status_code: observation.status_code,
        decision_path: observation.decision_path,
        model_version: observation.model_version,
        policy_version: observation.policy_version,
        configuration_digest: observation.configuration_digest,
        latency_ms: observation.latency_ms,
        retry_count: observation.retry_count,
      });
    });
  const aggregate = JSON.stringify({
    record_type: "screening-aggregate",
    report_version: report.report_version,
    corpus_revision: report.identity.corpus_revision,
    corpus_digest: report.identity.corpus_digest,
    verdict: report.verdict,
    failures: report.failures,
    observation_count: report.observation_count,
    provider_ok_observation_count: report.provider_ok_observation_count,
    provider_failure_count: report.provider_failure_count,
    legitimate_false_positive_rate: report.legitimate_false_positive_rate,
    hard_reject_false_negative_rate: report.hard_reject_false_negative_rate,
    by_policy_category: report.by_policy_category,
    by_stratum: report.by_stratum,
    operational_by_observed_category: report.operational_by_observed_category,
    aggregation_pairs: report.aggregation_pairs,
    sentinel_failures: report.sentinel_failures,
    model_versions: report.model_versions,
    policy_versions: report.policy_versions,
    configuration_digests: report.configuration_digests,
    total_latency_ms: report.total_latency_ms,
    total_retry_count: report.total_retry_count,
  });
  return [...decisionRecords, aggregate].join("\n");
}
