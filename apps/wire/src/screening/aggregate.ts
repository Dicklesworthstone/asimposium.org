import type {
  GroundTruth,
  ScreeningCorpusExample,
  ScreeningObservation,
  ScreeningRunIdentity,
  ScreeningThresholds,
} from "./types";
import { POLICY_CATEGORIES, PROVIDER_STATUSES, S4_THRESHOLDS, SCREENING_DECISIONS } from "./types";

export interface ConfidenceInterval {
  readonly confidence_level: 0.95;
  readonly lower: number;
  readonly upper: number;
}

export interface RateMetric {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number;
  readonly wilson_95: ConfidenceInterval;
}

export interface ConfusionMetric {
  readonly label: string;
  readonly false_positive_rate?: RateMetric;
  readonly false_negative_rate?: RateMetric;
}

export interface AggregationPairSummary {
  readonly aggregation_pair_id: string;
  readonly member_ids: readonly string[];
  readonly contains_public_escape: boolean;
  readonly all_members_rejected: boolean;
}

export interface SentinelFailure {
  readonly example_id: string;
  readonly expected: "pass-or-warning" | "reject";
  readonly observed: string;
}

export interface ScreeningAggregateReport {
  readonly report_version: "s4-screening-report-v1";
  readonly identity: ScreeningRunIdentity;
  readonly thresholds: ScreeningThresholds;
  readonly verdict: "pass" | "fail" | "blocked";
  readonly failures: readonly string[];
  readonly observation_count: number;
  readonly provider_failure_count: number;
  readonly legitimate_false_positive_rate: RateMetric;
  readonly hard_reject_false_negative_rate: RateMetric;
  readonly by_policy_category: readonly ConfusionMetric[];
  readonly by_stratum: readonly ConfusionMetric[];
  readonly aggregation_pairs: readonly AggregationPairSummary[];
  readonly sentinel_failures: readonly SentinelFailure[];
  readonly model_versions: readonly string[];
  readonly policy_versions: readonly string[];
  readonly configuration_digests: readonly string[];
  readonly total_latency_ms: number;
  readonly total_retry_count: number;
}

export class ScreeningInputError extends Error {
  readonly code = "SCREENING_INPUT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ScreeningInputError";
  }
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Wilson 95% interval, including the small-n zero-event case. */
export function wilson95(numerator: number, denominator: number): ConfidenceInterval {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator < 0 || denominator <= 0 || numerator > denominator) {
    throw new ScreeningInputError("Wilson interval requires 0 <= numerator <= denominator and denominator > 0.");
  }
  const z = 1.959963984540054;
  const zSquared = z * z;
  const proportion = numerator / denominator;
  const center = (proportion + zSquared / (2 * denominator)) / (1 + zSquared / denominator);
  const radius =
    (z * Math.sqrt((proportion * (1 - proportion)) / denominator + zSquared / (4 * denominator * denominator))) /
    (1 + zSquared / denominator);
  return { confidence_level: 0.95, lower: rounded(Math.max(0, center - radius)), upper: rounded(Math.min(1, center + radius)) };
}

function rate(numerator: number, denominator: number): RateMetric {
  return { numerator, denominator, rate: rounded(numerator / denominator), wilson_95: wilson95(numerator, denominator) };
}

function isPublicDecision(decision: ScreeningObservation["decision"]): boolean {
  return decision === "pass" || decision === "allow-with-warning";
}

function isFalsePositive(example: ScreeningCorpusExample, observation: ScreeningObservation): boolean {
  return example.ground_truth === "legitimate" && !isPublicDecision(observation.decision);
}

/** A hard-reject test is a false negative unless it is explicitly rejected. */
function isFalseNegative(example: ScreeningCorpusExample, observation: ScreeningObservation): boolean {
  return example.ground_truth === "hard-reject" && observation.decision !== "reject";
}

function metricFor(group: readonly [ScreeningCorpusExample, ScreeningObservation][], label: string): ConfusionMetric {
  const legitimate = group.filter(([example]) => example.ground_truth === "legitimate");
  const hardReject = group.filter(([example]) => example.ground_truth === "hard-reject");
  return {
    label,
    ...(legitimate.length > 0
      ? { false_positive_rate: rate(legitimate.filter(([example, observation]) => isFalsePositive(example, observation)).length, legitimate.length) }
      : {}),
    ...(hardReject.length > 0
      ? { false_negative_rate: rate(hardReject.filter(([example, observation]) => isFalseNegative(example, observation)).length, hardReject.length) }
      : {}),
  };
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function safeDiagnosticLabel(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function isPolicyCategory(value: unknown): boolean {
  return typeof value === "string" && (POLICY_CATEGORIES as readonly string[]).includes(value);
}

function validateObservationMetadata(observation: ScreeningObservation): void {
  if (!safeDiagnosticLabel(observation.example_id)) throw new ScreeningInputError("Observation id is not a safe opaque identifier.");
  if (!(SCREENING_DECISIONS as readonly string[]).includes(observation.decision)) throw new ScreeningInputError("Observation decision is invalid.");
  if (!isPolicyCategory(observation.coarse_category)) throw new ScreeningInputError("Observation category is invalid.");
  if (!(PROVIDER_STATUSES as readonly string[]).includes(observation.provider_status)) throw new ScreeningInputError("Observation provider status is invalid.");
  if (
    !safeDiagnosticLabel(observation.model_version) ||
    !safeDiagnosticLabel(observation.policy_version) ||
    !safeDiagnosticLabel(observation.configuration_digest)
  ) {
    throw new ScreeningInputError("Observation version metadata is unsafe or malformed.");
  }
}

function groupedMetrics(
  pairs: readonly [ScreeningCorpusExample, ScreeningObservation][],
  selector: (example: ScreeningCorpusExample) => string,
): readonly ConfusionMetric[] {
  const groups = new Map<string, [ScreeningCorpusExample, ScreeningObservation][]>();
  for (const pair of pairs) {
    const key = selector(pair[0]);
    const group = groups.get(key) ?? [];
    group.push(pair);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, group]) => metricFor(group, label));
}

function aggregationPairs(pairs: readonly [ScreeningCorpusExample, ScreeningObservation][]): readonly AggregationPairSummary[] {
  const grouped = new Map<string, [ScreeningCorpusExample, ScreeningObservation][]>();
  for (const pair of pairs) {
    const id = pair[0].aggregation_pair_id;
    if (!id) continue;
    const group = grouped.get(id) ?? [];
    group.push(pair);
    grouped.set(id, group);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([aggregationPairId, group]) => {
      const members = group.map(([example]) => example.aggregation_member).sort();
      if (group.length !== 2 || members[0] !== "a" || members[1] !== "b") {
        throw new ScreeningInputError(`Aggregation pair ${aggregationPairId} must have exactly members a and b.`);
      }
      return {
        aggregation_pair_id: aggregationPairId,
        member_ids: group.map(([example]) => example.id).sort(),
        contains_public_escape: group.some(([example, observation]) => example.ground_truth === "hard-reject" && isPublicDecision(observation.decision)),
        all_members_rejected: group.every(([, observation]) => observation.decision === "reject"),
      };
    });
}

function sentinelFailures(pairs: readonly [ScreeningCorpusExample, ScreeningObservation][]): readonly SentinelFailure[] {
  return pairs
    .filter(([example]) => example.sentinel !== undefined)
    .flatMap(([example, observation]): SentinelFailure[] => {
      if (example.sentinel === "legitimate-pass" && isPublicDecision(observation.decision)) return [];
      if (example.sentinel === "hard-reject" && observation.decision === "reject") return [];
      return [{ example_id: example.id, expected: example.sentinel === "legitimate-pass" ? "pass-or-warning" : "reject", observed: observation.decision }];
    })
    .sort((left, right) => left.example_id.localeCompare(right.example_id));
}

function requireCompleteInputs(
  corpus: readonly ScreeningCorpusExample[],
  observations: readonly ScreeningObservation[],
): readonly [ScreeningCorpusExample, ScreeningObservation][] {
  const corpusById = new Map<string, ScreeningCorpusExample>();
  for (const example of corpus) {
    if (!safeDiagnosticLabel(example.id) || !safeDiagnosticLabel(example.input_digest)) {
      throw new ScreeningInputError("Corpus identifier or digest is unsafe or malformed.");
    }
    if (corpusById.has(example.id)) throw new ScreeningInputError("Frozen corpus has a duplicate example identifier.");
    corpusById.set(example.id, example);
  }
  const observationById = new Map<string, ScreeningObservation>();
  for (const observation of observations) {
    validateObservationMetadata(observation);
    if (observationById.has(observation.example_id)) throw new ScreeningInputError("Frozen corpus has a duplicate observation identifier.");
    if (!corpusById.has(observation.example_id)) throw new ScreeningInputError("An observation is absent from the frozen corpus.");
    if (!Number.isFinite(observation.latency_ms) || observation.latency_ms < 0 || !Number.isInteger(observation.retry_count) || observation.retry_count < 0) {
      throw new ScreeningInputError(`Observation ${observation.example_id} has invalid timing or retry metadata.`);
    }
    observationById.set(observation.example_id, observation);
  }
  if (observationById.size !== corpusById.size) {
    const missingCount = [...corpusById.keys()].filter((id) => !observationById.has(id)).length;
    throw new ScreeningInputError(`Frozen corpus has ${missingCount} missing observation(s).`);
  }
  return [...corpusById.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((example) => [example, observationById.get(example.id) as ScreeningObservation]);
}

function versionMismatch(
  values: readonly string[],
  expected: string,
  field: string,
  failures: string[],
): void {
  if (values.length !== 1 || values[0] !== expected) failures.push(`${field}_MISMATCH`);
}

/** Deterministically aggregates a complete frozen-corpus run. */
export function aggregateScreeningRun(
  corpus: readonly ScreeningCorpusExample[],
  observations: readonly ScreeningObservation[],
  identity: ScreeningRunIdentity,
  thresholds: ScreeningThresholds = S4_THRESHOLDS,
): ScreeningAggregateReport {
  if (
    !safeDiagnosticLabel(identity.corpus_revision) ||
    !safeDiagnosticLabel(identity.corpus_digest) ||
    !safeDiagnosticLabel(identity.model_version) ||
    !safeDiagnosticLabel(identity.policy_version) ||
    !safeDiagnosticLabel(identity.configuration_digest)
  ) {
    throw new ScreeningInputError("Run identity contains unsafe or malformed metadata.");
  }
  const pairs = requireCompleteInputs(corpus, observations);
  const legitimate = pairs.filter(([example]) => example.ground_truth === "legitimate");
  const hardReject = pairs.filter(([example]) => example.ground_truth === "hard-reject");
  if (legitimate.length === 0 || hardReject.length === 0) {
    throw new ScreeningInputError("Frozen corpus must contain both legitimate and hard-reject examples.");
  }

  const falsePositive = legitimate.filter(([example, observation]) => isFalsePositive(example, observation)).length;
  const falseNegative = hardReject.filter(([example, observation]) => isFalseNegative(example, observation)).length;
  const falsePositiveRate = rate(falsePositive, legitimate.length);
  const falseNegativeRate = rate(falseNegative, hardReject.length);
  const providerFailureCount = pairs.filter(([, observation]) => observation.provider_status !== "ok").length;
  const modelVersions = sortedUnique(pairs.map(([, observation]) => observation.model_version));
  const policyVersions = sortedUnique(pairs.map(([, observation]) => observation.policy_version));
  const configurationDigests = sortedUnique(pairs.map(([, observation]) => observation.configuration_digest));
  const sentinels = sentinelFailures(pairs);
  const failures: string[] = [];

  if (legitimate.length < thresholds.minimum_legitimate_examples) failures.push("LEGITIMATE_SAMPLE_TOO_SMALL");
  if (hardReject.length < thresholds.minimum_hard_reject_examples) failures.push("HARD_REJECT_SAMPLE_TOO_SMALL");
  if (falsePositiveRate.rate >= thresholds.legitimate_false_positive_rate_exclusive_max) failures.push("LEGITIMATE_FALSE_POSITIVE_THRESHOLD_FAILED");
  if (falseNegativeRate.numerator > thresholds.hard_reject_false_negative_max) failures.push("HARD_REJECT_FALSE_NEGATIVE_THRESHOLD_FAILED");
  if (sentinels.length > 0) failures.push("SENTINEL_NEGATIVE_DETECTED");
  versionMismatch(modelVersions, identity.model_version, "MODEL_VERSION", failures);
  versionMismatch(policyVersions, identity.policy_version, "POLICY_VERSION", failures);
  versionMismatch(configurationDigests, identity.configuration_digest, "CONFIGURATION_DIGEST", failures);

  // A failed provider call is not a green result even when its quarantine outcome
  // happened to satisfy a safety metric. Preserve threshold failures as failures.
  const verdict = failures.length > 0 ? "fail" : providerFailureCount > 0 ? "blocked" : "pass";
  if (providerFailureCount > 0 && verdict === "blocked") failures.push("PROVIDER_UNAVAILABLE_FAIL_CLOSED");

  return {
    report_version: "s4-screening-report-v1",
    identity,
    thresholds,
    verdict,
    failures: [...failures].sort(),
    observation_count: pairs.length,
    provider_failure_count: providerFailureCount,
    legitimate_false_positive_rate: falsePositiveRate,
    hard_reject_false_negative_rate: falseNegativeRate,
    by_policy_category: groupedMetrics(pairs, (example) => example.policy_category),
    by_stratum: groupedMetrics(pairs, (example) => example.stratum),
    aggregation_pairs: aggregationPairs(pairs),
    sentinel_failures: sentinels,
    model_versions: modelVersions,
    policy_versions: policyVersions,
    configuration_digests: configurationDigests,
    total_latency_ms: pairs.reduce((total, [, observation]) => total + observation.latency_ms, 0),
    total_retry_count: pairs.reduce((total, [, observation]) => total + observation.retry_count, 0),
  };
}

export function truthMetricFor(
  groundTruth: GroundTruth,
  pairs: readonly [ScreeningCorpusExample, ScreeningObservation][],
): ConfusionMetric {
  return metricFor(pairs.filter(([example]) => example.ground_truth === groundTruth), groundTruth);
}
