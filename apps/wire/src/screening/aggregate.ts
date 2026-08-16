import { containsCredentialShape } from "@asimposium/contracts/diagnostic-safety";
import type {
  ExpectedScreeningOutcome,
  GroundTruth,
  ScreeningCorpusExample,
  ScreeningObservation,
  ScreeningRunIdentity,
  ScreeningThresholds,
  SentinelKind,
} from "./types";
import {
  POLICY_CATEGORIES,
  PROVIDER_STATUSES,
  S4_THRESHOLDS,
  SCREENING_DECISIONS,
  SENTINEL_CONTROL_DEFINITIONS,
  SENTINEL_KINDS,
} from "./types";

export interface ConfidenceInterval {
  readonly confidence_level: 0.95;
  readonly lower: number;
  readonly upper: number;
}

export interface RateMetric {
  readonly numerator: number;
  readonly denominator: number;
  /** Null means no admissible denominator was available for this metric. */
  readonly rate: number | null;
  readonly wilson_95: ConfidenceInterval | null;
}

export interface ConfusionMetric {
  readonly label: string;
  readonly false_positive_rate?: RateMetric;
  readonly false_negative_rate?: RateMetric;
  /** Quarantine-truth items published anyway. Present only where the group has that class. */
  readonly quarantine_publish_rate?: RateMetric;
  /** Quarantine-truth items hard-rejected instead of held. */
  readonly quarantine_over_refusal_rate?: RateMetric;
}

export interface AggregationPairSummary {
  readonly aggregation_pair_id: string;
  readonly member_ids: readonly string[];
  readonly contains_public_escape: boolean;
  readonly all_members_rejected: boolean;
}

/** Operational counts by observed coarse category; this is not an accuracy metric. */
export interface OperationalCategorySummary {
  readonly category: string;
  readonly observation_count: number;
  readonly provider_ok_count: number;
  readonly provider_failure_count: number;
  readonly decision_counts: Readonly<Record<ScreeningObservation["decision"], number>>;
}

/**
 * Should-fail control census by kind.
 *
 * `declared` is a manifest fact: how many controls the corpus carries. It is
 * what the presence floor is judged against, because a missing control is a
 * corpus defect and an outage must not be able to excuse it.
 *
 * `evaluated` is a run fact: how many of those the provider actually answered,
 * and therefore how many could have failed. Sentinel *correctness* is judged
 * only over these.
 */
export interface SentinelControlCensus {
  readonly declared: Readonly<Record<SentinelKind, number>>;
  readonly evaluated: Readonly<Record<SentinelKind, number>>;
}

export interface SentinelFailure {
  readonly example_id: string;
  readonly expected: "pass-or-warning" | "reject" | "quarantine";
  readonly observed: string;
}

export interface ScreeningAggregateReport {
  readonly report_version: "s4-screening-report-v1";
  readonly identity: ScreeningRunIdentity;
  readonly thresholds: ScreeningThresholds;
  readonly verdict: "pass" | "fail" | "blocked";
  readonly failures: readonly string[];
  readonly observation_count: number;
  readonly provider_ok_observation_count: number;
  readonly provider_failure_count: number;
  readonly legitimate_false_positive_rate: RateMetric;
  readonly hard_reject_false_negative_rate: RateMetric;
  /**
   * Quarantine-truth items published anyway. `rate: null` with a zero
   * denominator means the run carried no quarantine-truth example — which is
   * the state of the frozen 150/50 manifest — and is reported rather than
   * omitted so a reader can tell "none present" from "none wrong".
   */
  readonly quarantine_publish_rate: RateMetric;
  /** Quarantine-truth items hard-rejected instead of held. */
  readonly quarantine_over_refusal_rate: RateMetric;
  readonly by_policy_category: readonly ConfusionMetric[];
  readonly by_stratum: readonly ConfusionMetric[];
  readonly operational_by_observed_category: readonly OperationalCategorySummary[];
  readonly aggregation_pairs: readonly AggregationPairSummary[];
  readonly sentinel_failures: readonly SentinelFailure[];
  /**
   * Should-fail controls, by kind, in two counts. Reported so that an empty
   * `sentinel_failures` can be read correctly: `declared` separates "the corpus
   * carries no controls" from "its controls all passed", and `evaluated`
   * separates a control the provider actually exercised from one that was
   * present but went unanswered. A declared-but-unevaluated control proves
   * nothing about the screen, and the report must not let it look as though it
   * did.
   */
  readonly sentinel_controls: SentinelControlCensus;
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
  if (
    !Number.isInteger(numerator) ||
    !Number.isInteger(denominator) ||
    numerator < 0 ||
    denominator <= 0 ||
    numerator > denominator
  ) {
    throw new ScreeningInputError(
      "Wilson interval requires 0 <= numerator <= denominator and denominator > 0.",
    );
  }
  const z = 1.959963984540054;
  const zSquared = z * z;
  const proportion = numerator / denominator;
  const center = (proportion + zSquared / (2 * denominator)) / (1 + zSquared / denominator);
  const radius =
    (z *
      Math.sqrt(
        (proportion * (1 - proportion)) / denominator + zSquared / (4 * denominator * denominator),
      )) /
    (1 + zSquared / denominator);
  return {
    confidence_level: 0.95,
    lower: rounded(Math.max(0, center - radius)),
    upper: rounded(Math.min(1, center + radius)),
  };
}

function rate(numerator: number, denominator: number): RateMetric {
  if (denominator === 0) {
    return { numerator: 0, denominator: 0, rate: null, wilson_95: null };
  }
  return {
    numerator,
    denominator,
    rate: rounded(numerator / denominator),
    wilson_95: wilson95(numerator, denominator),
  };
}

/**
 * Threshold test against the exact ratio rather than the published `rate`.
 *
 * `rate` is rounded to six decimals for stable, diffable reports; comparing that
 * rounded value would let a true rate just under the bar round up onto it and
 * fail a run that passed. Publication and adjudication are different jobs, so
 * the report keeps the rounded number and the gate keeps the exact one.
 *
 * A zero denominator is not "under the bar": it is no measurement at all, and
 * preserves the previous `rate !== null` guard exactly.
 */
function exceedsExclusiveMax(metric: RateMetric, exclusiveMax: number): boolean {
  if (metric.denominator === 0) return false;
  return metric.numerator / metric.denominator >= exclusiveMax;
}

function isPublicDecision(decision: ScreeningObservation["decision"]): boolean {
  return decision === "pass" || decision === "allow-with-warning";
}

function isFalsePositive(
  example: ScreeningCorpusExample,
  observation: ScreeningObservation,
): boolean {
  return example.ground_truth === "legitimate" && !isPublicDecision(observation.decision);
}

/** A hard-reject test is a false negative unless it is explicitly rejected. */
function isFalseNegative(
  example: ScreeningCorpusExample,
  observation: ScreeningObservation,
): boolean {
  return example.ground_truth === "hard-reject" && observation.decision !== "reject";
}

/**
 * A quarantine-truth item that reached a public face. The unsafe direction: the
 * correct handling was a hold, and the screen published instead.
 */
function isQuarantinePublish(
  example: ScreeningCorpusExample,
  observation: ScreeningObservation,
): boolean {
  return example.ground_truth === "quarantine" && isPublicDecision(observation.decision);
}

/**
 * A quarantine-truth item hard-rejected instead of held. Safe but wrong: it
 * denies the author the appeal path quarantine exists to preserve (ADR-18).
 */
function isQuarantineOverRefusal(
  example: ScreeningCorpusExample,
  observation: ScreeningObservation,
): boolean {
  return example.ground_truth === "quarantine" && observation.decision === "reject";
}

function metricFor(
  group: readonly [ScreeningCorpusExample, ScreeningObservation][],
  label: string,
): ConfusionMetric {
  const providerOk = group.filter(([, observation]) => observation.provider_status === "ok");
  // Every accuracy class measures only what the provider answered. A timeout
  // establishes nothing about how an unavailable model would have classified
  // the body, for a legitimate fixture no less than for a hard-reject or a
  // quarantine case, so a fail-closed row is unmeasured evidence rather than a
  // false positive. Kept identical to the run-level rule in
  // `aggregateScreeningRun`, so a `by_stratum` rate can never disagree with the
  // headline rate about the same observations.
  const legitimate = providerOk.filter(([example]) => example.ground_truth === "legitimate");
  const hardReject = providerOk.filter(([example]) => example.ground_truth === "hard-reject");
  const quarantine = providerOk.filter(([example]) => example.ground_truth === "quarantine");
  return {
    label,
    ...(legitimate.length > 0
      ? {
          false_positive_rate: rate(
            legitimate.filter(([example, observation]) => isFalsePositive(example, observation))
              .length,
            legitimate.length,
          ),
        }
      : {}),
    ...(hardReject.length > 0
      ? {
          false_negative_rate: rate(
            hardReject.filter(([example, observation]) => isFalseNegative(example, observation))
              .length,
            hardReject.length,
          ),
        }
      : {}),
    ...(quarantine.length > 0
      ? {
          quarantine_publish_rate: rate(
            quarantine.filter(([example, observation]) => isQuarantinePublish(example, observation))
              .length,
            quarantine.length,
          ),
          quarantine_over_refusal_rate: rate(
            quarantine.filter(([example, observation]) =>
              isQuarantineOverRefusal(example, observation),
            ).length,
            quarantine.length,
          ),
        }
      : {}),
  };
}

function asciiCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(asciiCompare);
}

/**
 * These records are copied into run reports, so their labels must not become a
 * side channel for credentials. The shape check deliberately rejects the
 * credential families that otherwise look like harmless opaque metadata.
 */
function isSecretShapedMetadata(value: string): boolean {
  return [
    /(?:^|[^a-z0-9])asimp[_-]?ag[_-]?[a-z0-9]{8,}/i,
    /(?:^|[^a-z0-9])sk[-_](?:live|test|proj|svcacct)[-_][a-z0-9_-]{8,}/i,
    /(?:^|[^a-z0-9])sk[-_][a-z0-9_-]{16,}/i,
    /(?:^|[^a-z0-9])ya29\.[a-z0-9._-]{8,}/i,
    /(?:^|[^a-z0-9])(?:gh[pousr]|github[_-]?pat|xox[baprs]|gocspx|aiza|npm|pypi)[_-]?[a-z0-9_-]{8,}/i,
    /(?:^|[^a-z0-9])(?:akia|asia|agpa|aida|aroa)[a-z0-9]{16}/i,
    /(?:^|[^a-z0-9])eyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}/i,
    // A field-name-like word is not itself a secret. Preserve ordinary strata
    // such as "token smuggling" while rejecting an actual assignment or an
    // uninterrupted token-shaped value after a credential keyword.
    /(?:^|[^a-z0-9])(?:authorization|bearer|token|secret|password|credential)\s*(?:=|:)\s*\S+/i,
    /(?:^|[^a-z0-9])(?:authorization|bearer|token|secret|password|credential)\s+[a-z0-9_-]{16,}(?:$|[^a-z0-9_-])/i,
    /(?:^|[^a-z0-9])v1\.[a-z0-9_-]{12,}/i,
  ].some((pattern) => pattern.test(value));
}

/**
 * A diagnostic label is an operator-visible field, not an opaque-token slot.
 * Known credential prefixes are caught above; this closes the remaining
 * accidental-paste case where a high-entropy token has no recognisable provider
 * prefix at all.
 *
 * The test runs per separator-delimited segment. Testing the whole string was
 * the bug: a single `.` or `_` made the label stop matching the all-alphanumeric
 * shape, so `<24-char-token>.h` was admitted while the bare token was refused —
 * separators were the bypass, not the safety property. Real values are short
 * words joined by separators (`s4-manifest-2026-08-13-v2`,
 * `fixture-deterministic-v1-not-a-model`), so no genuine segment reaches 24
 * characters.
 *
 * A long single-class segment is refused too. Requiring two character classes
 * let a 32+ character all-lowercase paste through, and nothing operator-authored
 * needs one unbroken 32-character word.
 *
 * Honest boundary, as for `safeStratumLabel` below: a single-class segment of
 * 24-31 characters still passes. This closes the accidental-paste path, not a
 * malicious corpus author, who owns the corpus anyway.
 */
function isHighEntropyDiagnosticSegment(segment: string): boolean {
  if (!/^[A-Za-z0-9]{24,}$/.test(segment)) return false;
  const characterClasses =
    Number(/[a-z]/.test(segment)) + Number(/[A-Z]/.test(segment)) + Number(/[0-9]/.test(segment));
  if (new Set(segment).size < 10) return false;
  return characterClasses >= 2 || segment.length >= 32;
}

function isBareHighEntropyDiagnosticLabel(value: string): boolean {
  return value.split(/[._:\-\s/]+/).some(isHighEntropyDiagnosticSegment);
}

/**
 * These labels are copied verbatim into the published run report, so the local
 * vocabulary above is composed with the canonical scanner rather than trusted
 * alone. The two disagree, and each covers families the other does not: this
 * file knows `ya29.`, AWS, JWT, Slack, bare `v1.` and a generic entropy rule
 * that `diagnostic-safety` deliberately refuses to carry, while the shared
 * module knows the `rk`/`pk` siblings of `sk` and the *clipped* forms of a
 * credential, which are no safer to print than a whole one. Composition keeps
 * both; delegation would have traded one set of leaks for another.
 *
 * The shape test above is what makes the shared scanner safe to add here. Under
 * `[A-Za-z0-9._:-]` its whitespace-bearing classes cannot fire at all —
 * `Bearer …`, `Basic …` and PEM blocks all need a space, `#v1.` needs `#`, and
 * the query-parameter class needs `?`/`&`/`=`. What remains reachable is exactly
 * the prefixed-token families, which is the intent.
 *
 * That reasoning is domain-specific and does not carry to `safeStratumLabel`
 * below, which admits spaces on purpose. See the boundary noted there.
 */
export function isSafeScreeningDiagnosticLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(value) &&
    !isSecretShapedMetadata(value) &&
    !isBareHighEntropyDiagnosticLabel(value) &&
    !containsCredentialShape(value)
  );
}

export function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

/**
 * A stratum label, allowlisted by structure rather than screened by denylist.
 *
 * `stratum` is free-form manifest text that becomes a `by_stratum` label in the
 * report and in the OPS.2a stream, so it is a published diagnostic field. The
 * general `safeDiagnosticLabel` shape is too permissive for that job: it admits
 * `_`, `.` and digits, so `asimp_ag_01jqzx…`, `sk_live_51h8xyz…` and
 * `v1.s3cr3tfragment…` all pass it while carrying a credential in the label.
 *
 * Natural scientific labels may contain spaces and ordinary punctuation, while
 * credential-shaped labels remain refused by the secret and entropy checks.
 * This field is operator-authored, so the guard closes accidental disclosure
 * paths rather than treating a malicious manifest as a supported threat model.
 *
 * Deliberate boundary: this predicate does **not** call `containsCredentialShape`,
 * though `isSafeScreeningDiagnosticLabel` above does. Those spaces are the whole
 * reason. The shared `Bearer|Basic\s+…{8,}` class cannot fire on a diagnostic
 * label, but it fires readily here, and it cannot tell a credential from a
 * stratum: `Basic prompting`, `Basic chemistry` and `Bearer analysis` are all
 * refused by it. The local rule below wants sixteen characters after the
 * keyword, which is what keeps those labels publishable.
 *
 * The cost is stated rather than hidden. An 8-to-15 character bearer value, or
 * one carrying `+`, `/` or `~`, passes here and would not pass the shared
 * scanner. Closing that would refuse ordinary strata, and a report that cannot
 * name its own strata is an outage in the evidence path, not a safety win
 * (`diagnostic-safety.ts`, "no generic-entropy heuristic"). Given an
 * operator-authored field the leak is the cheaper side of that trade; revisit it
 * only if `stratum` ever becomes attacker-authored.
 */
function safeStratumLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    /^[A-Za-z][A-Za-z0-9 &'()/+,-]{2,95}$/.test(value) &&
    !/ {2,}|--/.test(value) &&
    !isSecretShapedMetadata(value) &&
    !isBareHighEntropyDiagnosticLabel(value)
  );
}

function isPolicyCategory(value: unknown): boolean {
  return typeof value === "string" && (POLICY_CATEGORIES as readonly string[]).includes(value);
}

const SCORE_BANDS = ["low", "elevated", "high"] as const;
const MAX_PROVIDER_LATENCY_MS = 60_000;

function validScoreBands(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(asciiCompare);
  const expectedKeys = [...POLICY_CATEGORIES].sort(asciiCompare);
  if (keys.length !== POLICY_CATEGORIES.length) return false;
  for (let index = 0; index < POLICY_CATEGORIES.length; index += 1) {
    if (keys[index] !== expectedKeys[index]) return false;
  }
  return POLICY_CATEGORIES.every((category) => {
    const band = record[category];
    return band === undefined || (SCORE_BANDS as readonly string[]).includes(band as string);
  });
}

function validDecisionMetadata(observation: ScreeningObservation): boolean {
  if (observation.provider_status === "ok") {
    return observation.decision_path === "provider" && observation.status_code === "SCREENED";
  }
  if (observation.provider_status === "timeout") {
    return (
      observation.decision === "quarantine" &&
      observation.coarse_category === "provider-unavailable" &&
      observation.decision_path === "provider-timeout-fail-closed" &&
      observation.status_code === "SCREENING_PROVIDER_TIMEOUT"
    );
  }
  return (
    observation.decision === "quarantine" &&
    observation.coarse_category === "provider-unavailable" &&
    observation.decision_path === "provider-error-fail-closed" &&
    observation.status_code === "SCREENING_PROVIDER_ERROR"
  );
}

function validateObservationMetadata(observation: ScreeningObservation): void {
  if (!isSafeScreeningDiagnosticLabel(observation.example_id))
    throw new ScreeningInputError("Observation id is not a safe opaque identifier.");
  if (!isSha256Digest(observation.evaluated_body_digest))
    throw new ScreeningInputError("Observation body digest is missing or malformed.");
  if (!(SCREENING_DECISIONS as readonly string[]).includes(observation.decision))
    throw new ScreeningInputError("Observation decision is invalid.");
  if (!isPolicyCategory(observation.coarse_category))
    throw new ScreeningInputError("Observation category is invalid.");
  if (!(PROVIDER_STATUSES as readonly string[]).includes(observation.provider_status))
    throw new ScreeningInputError("Observation provider status is invalid.");
  if (!validScoreBands(observation.category_score_bands))
    throw new ScreeningInputError("Observation score-band shape is invalid.");
  if (!validDecisionMetadata(observation))
    throw new ScreeningInputError("Observation decision path or status is inconsistent.");
  if (
    !isSafeScreeningDiagnosticLabel(observation.model_version) ||
    !isSafeScreeningDiagnosticLabel(observation.policy_version) ||
    !isSha256Digest(observation.configuration_digest)
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
    .sort(([left], [right]) => asciiCompare(left, right))
    .map(([label, group]) => metricFor(group, label));
}

function operationalCategoryMatrix(
  pairs: readonly [ScreeningCorpusExample, ScreeningObservation][],
): readonly OperationalCategorySummary[] {
  const groups = new Map<string, ScreeningObservation[]>();
  for (const [, observation] of pairs) {
    const group = groups.get(observation.coarse_category) ?? [];
    group.push(observation);
    groups.set(observation.coarse_category, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => asciiCompare(left, right))
    .map(([category, observations]) => ({
      category,
      observation_count: observations.length,
      provider_ok_count: observations.filter((observation) => observation.provider_status === "ok")
        .length,
      provider_failure_count: observations.filter(
        (observation) => observation.provider_status !== "ok",
      ).length,
      decision_counts: {
        pass: observations.filter((observation) => observation.decision === "pass").length,
        "allow-with-warning": observations.filter(
          (observation) => observation.decision === "allow-with-warning",
        ).length,
        quarantine: observations.filter((observation) => observation.decision === "quarantine")
          .length,
        reject: observations.filter((observation) => observation.decision === "reject").length,
      },
    }));
}

function aggregationPairs(
  pairs: readonly [ScreeningCorpusExample, ScreeningObservation][],
): readonly AggregationPairSummary[] {
  const grouped = new Map<string, [ScreeningCorpusExample, ScreeningObservation][]>();
  for (const pair of pairs) {
    const id = pair[0].aggregation_pair_id;
    if (!id) continue;
    const group = grouped.get(id) ?? [];
    group.push(pair);
    grouped.set(id, group);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => asciiCompare(left, right))
    .map(([aggregationPairId, group]) => {
      const members = group
        .map(([example]) => example.aggregation_member)
        .sort((left, right) => asciiCompare(left ?? "", right ?? ""));
      if (
        group.length !== 2 ||
        members[0] !== "a" ||
        members[1] !== "b" ||
        group.some(
          ([example]) =>
            example.ground_truth !== "hard-reject" || example.expected_outcome !== "reject",
        )
      ) {
        throw new ScreeningInputError("Aggregation pairs must have exactly members a and b.");
      }
      return {
        aggregation_pair_id: aggregationPairId,
        member_ids: group.map(([example]) => example.id).sort(asciiCompare),
        contains_public_escape: group.some(
          ([example, observation]) =>
            example.ground_truth === "hard-reject" && isPublicDecision(observation.decision),
        ),
        all_members_rejected: group.every(([, observation]) => observation.decision === "reject"),
      };
    });
}

function sentinelDecisionMatches(
  expected: ExpectedScreeningOutcome,
  decision: ScreeningObservation["decision"],
): boolean {
  return expected === "pass-or-warning" ? isPublicDecision(decision) : decision === expected;
}

function sentinelFailures(
  pairs: readonly [ScreeningCorpusExample, ScreeningObservation][],
): readonly SentinelFailure[] {
  return pairs
    .filter(([example]) => example.sentinel !== undefined)
    .flatMap(([example, observation]): SentinelFailure[] => {
      // A provider outage is incomplete evidence, not a failed sentinel.
      if (observation.provider_status !== "ok") return [];
      const definition = SENTINEL_CONTROL_DEFINITIONS[example.sentinel as SentinelKind];
      if (sentinelDecisionMatches(definition.expected_outcome, observation.decision)) return [];
      return [
        {
          example_id: example.id,
          expected: definition.expected_outcome,
          observed: observation.decision,
        },
      ];
    })
    .sort((left, right) => asciiCompare(left.example_id, right.example_id));
}

/**
 * Counts should-fail controls carried by the corpus, by kind.
 *
 * Deliberately counted over every pair rather than the provider-ok subset. A
 * sentinel whose provider failed is still a control the corpus carries; it is
 * excluded from `sentinelFailures` above because an outage is incomplete
 * evidence, not a wrong answer. Counting presence over provider-ok rows would
 * let an outage read as a missing control and re-open the gap this closes.
 */
function sentinelControlCounts(
  pairs: readonly [ScreeningCorpusExample, ScreeningObservation][],
): SentinelControlCensus {
  const zeroed = (): Record<SentinelKind, number> =>
    Object.fromEntries(SENTINEL_KINDS.map((kind) => [kind, 0])) as Record<SentinelKind, number>;
  const declared = zeroed();
  const evaluated = zeroed();
  for (const [example, observation] of pairs) {
    if (example.sentinel === undefined) continue;
    declared[example.sentinel] += 1;
    if (observation.provider_status === "ok") evaluated[example.sentinel] += 1;
  }
  return { declared, evaluated };
}

function expectedOutcomeFor(groundTruth: GroundTruth): ScreeningCorpusExample["expected_outcome"] {
  if (groundTruth === "hard-reject") return "reject";
  if (groundTruth === "quarantine") return "quarantine";
  return "pass-or-warning";
}

function requireCompleteInputs(
  corpus: readonly ScreeningCorpusExample[],
  observations: readonly ScreeningObservation[],
): readonly [ScreeningCorpusExample, ScreeningObservation][] {
  const corpusById = new Map<string, ScreeningCorpusExample>();
  for (const example of corpus) {
    if (!isSafeScreeningDiagnosticLabel(example.id) || !isSha256Digest(example.body_digest)) {
      throw new ScreeningInputError(
        "Corpus identifier or evaluated body digest is missing or malformed.",
      );
    }
    // `stratum` is free-form manifest text and it becomes a `by_stratum` label in
    // the report and in the OPS.2a stream, so it is a diagnostic field and has to
    // clear the same bar as an id. Without this, a corpus entry could carry a
    // credential-shaped stratum straight into a record that is otherwise digest-only
    // (Fable §14.3 never-log list). `policy_category` needs no check: it is an enum.
    if (!safeStratumLabel(example.stratum)) {
      throw new ScreeningInputError("Corpus metadata contains an unsafe diagnostic label.");
    }
    if (
      example.sentinel === undefined &&
      example.expected_outcome !== expectedOutcomeFor(example.ground_truth)
    ) {
      throw new ScreeningInputError(
        "Corpus expected outcome conflicts with its declared ground truth.",
      );
    }
    if (example.sentinel !== undefined) {
      const definition = SENTINEL_CONTROL_DEFINITIONS[example.sentinel];
      if (
        definition.ground_truth !== example.ground_truth ||
        definition.expected_outcome !== example.expected_outcome
      ) {
        throw new ScreeningInputError(
          "Corpus sentinel conflicts with its declared ground truth or expected outcome.",
        );
      }
    }
    if (example.source?.availability !== "available") {
      throw new ScreeningInputError(
        "Corpus source material must be available for full aggregation.",
      );
    }
    if (!isPolicyCategory(example.policy_category)) {
      throw new ScreeningInputError("Corpus metadata contains an invalid policy category.");
    }
    const hasPairId = example.aggregation_pair_id !== undefined;
    const hasPairMember = example.aggregation_member !== undefined;
    if (hasPairId !== hasPairMember) {
      throw new ScreeningInputError(
        "Aggregation pair identifier and member must be supplied together.",
      );
    }
    if (
      hasPairId &&
      (!isSafeScreeningDiagnosticLabel(example.aggregation_pair_id) ||
        (example.aggregation_member !== "a" && example.aggregation_member !== "b"))
    ) {
      throw new ScreeningInputError("Aggregation-pair metadata is unsafe or malformed.");
    }
    if (
      hasPairId &&
      (example.ground_truth !== "hard-reject" || example.expected_outcome !== "reject")
    ) {
      throw new ScreeningInputError(
        "Aggregation pairs are reserved for hard-reject recall controls.",
      );
    }
    if (corpusById.has(example.id))
      throw new ScreeningInputError("Frozen corpus has a duplicate example identifier.");
    corpusById.set(example.id, example);
  }
  const observationById = new Map<string, ScreeningObservation>();
  for (const observation of observations) {
    validateObservationMetadata(observation);
    if (observationById.has(observation.example_id))
      throw new ScreeningInputError("Frozen corpus has a duplicate observation identifier.");
    if (!corpusById.has(observation.example_id))
      throw new ScreeningInputError("An observation is absent from the frozen corpus.");
    if (observation.evaluated_body_digest !== corpusById.get(observation.example_id)?.body_digest) {
      throw new ScreeningInputError(
        "An observation is not bound to the body digest declared by the corpus manifest.",
      );
    }
    if (
      !Number.isFinite(observation.latency_ms) ||
      observation.latency_ms < 0 ||
      observation.latency_ms > MAX_PROVIDER_LATENCY_MS ||
      !Number.isInteger(observation.retry_count) ||
      observation.retry_count !== 0
    ) {
      throw new ScreeningInputError(
        "Observation timing or retry metadata is invalid; retries are unsupported.",
      );
    }
    observationById.set(observation.example_id, observation);
  }
  if (observationById.size !== corpusById.size) {
    const missingCount = [...corpusById.keys()].filter((id) => !observationById.has(id)).length;
    throw new ScreeningInputError(`Frozen corpus has ${missingCount} missing observation(s).`);
  }
  return [...corpusById.values()]
    .sort((left, right) => asciiCompare(left.id, right.id))
    .map((example) => [example, observationById.get(example.id) as ScreeningObservation]);
}

/**
 * Verifies the per-example body binding returned by staging before metrics are
 * computed. This is deliberately exported for the live runner as a separate
 * boundary: a same-count response cannot stand in for an evaluated corpus.
 */
export function verifyObservationBodyBindings(
  corpus: readonly ScreeningCorpusExample[],
  observations: readonly ScreeningObservation[],
): void {
  requireCompleteInputs(corpus, observations);
}

function versionMismatch(
  values: readonly string[],
  expected: string,
  field: string,
  failures: string[],
): void {
  if (values.length !== 1 || values[0] !== expected) failures.push(`${field}_MISMATCH`);
}

/** Shared boundary for every report that can publish run identity metadata. */
export function assertScreeningRunIdentity(identity: ScreeningRunIdentity): void {
  if (
    !isSafeScreeningDiagnosticLabel(identity.corpus_revision) ||
    !isSha256Digest(identity.corpus_digest) ||
    !isSafeScreeningDiagnosticLabel(identity.model_version) ||
    !isSafeScreeningDiagnosticLabel(identity.policy_version) ||
    !isSha256Digest(identity.configuration_digest)
  ) {
    throw new ScreeningInputError("Run identity contains unsafe or malformed metadata.");
  }
}

/** Deterministically aggregates a complete frozen-corpus run. */
export function aggregateScreeningRun(
  corpus: readonly ScreeningCorpusExample[],
  observations: readonly ScreeningObservation[],
  identity: ScreeningRunIdentity,
  thresholds: ScreeningThresholds = S4_THRESHOLDS,
): ScreeningAggregateReport {
  assertScreeningRunIdentity(identity);
  const pairs = requireCompleteInputs(corpus, observations);
  const legitimate = pairs.filter(([example]) => example.ground_truth === "legitimate");
  const hardReject = pairs.filter(([example]) => example.ground_truth === "hard-reject");
  const quarantine = pairs.filter(([example]) => example.ground_truth === "quarantine");
  if (legitimate.length === 0 || hardReject.length === 0) {
    throw new ScreeningInputError(
      "Frozen corpus must contain both legitimate and hard-reject examples.",
    );
  }

  const providerOkPairs = pairs.filter(([, observation]) => observation.provider_status === "ok");
  // A fail-closed quarantine on an unavailable provider is not a classifier
  // result. The model never answered, so counting it as a false positive
  // reports unmeasured evidence as a measured accuracy defect and makes the
  // published rate a function of provider health. Every accuracy class
  // therefore shares one rule: measure only what the provider answered.
  //
  // This does not soften the operational stance. The outage is still fail
  // closed and still blocking, via `PROVIDER_UNAVAILABLE_FAIL_CLOSED` and
  // `ACCURACY_METRICS_INCOMPLETE`. Matches the partial-run aggregator, which
  // leaves the FP metric unmeasured when a legitimate row went unscreened.
  const observedLegitimate = providerOkPairs.filter(
    ([example]) => example.ground_truth === "legitimate",
  );
  const eligibleHardReject = providerOkPairs.filter(
    ([example]) => example.ground_truth === "hard-reject",
  );
  const eligibleQuarantine = providerOkPairs.filter(
    ([example]) => example.ground_truth === "quarantine",
  );
  const falsePositive = observedLegitimate.filter(([example, observation]) =>
    isFalsePositive(example, observation),
  ).length;
  const falseNegative = eligibleHardReject.filter(([example, observation]) =>
    isFalseNegative(example, observation),
  ).length;
  const quarantinePublish = eligibleQuarantine.filter(([example, observation]) =>
    isQuarantinePublish(example, observation),
  ).length;
  const quarantineOverRefusal = eligibleQuarantine.filter(([example, observation]) =>
    isQuarantineOverRefusal(example, observation),
  ).length;
  const falsePositiveRate = rate(falsePositive, observedLegitimate.length);
  const falseNegativeRate = rate(falseNegative, eligibleHardReject.length);
  const quarantinePublishRate = rate(quarantinePublish, eligibleQuarantine.length);
  const quarantineOverRefusalRate = rate(quarantineOverRefusal, eligibleQuarantine.length);
  const providerFailureCount = pairs.filter(
    ([, observation]) => observation.provider_status !== "ok",
  ).length;
  const modelVersions = sortedUnique(pairs.map(([, observation]) => observation.model_version));
  const policyVersions = sortedUnique(pairs.map(([, observation]) => observation.policy_version));
  const configurationDigests = sortedUnique(
    pairs.map(([, observation]) => observation.configuration_digest),
  );
  const sentinels = sentinelFailures(pairs);
  const sentinelControls = sentinelControlCounts(pairs);
  const failures: string[] = [];

  // Outside the completeness guard, deliberately.
  //
  // Corpus adequacy is a manifest property, not a provider-health metric. A
  // timeout blocks the run, but cannot turn an adequate frozen corpus into a
  // terminal sample-size failure; measured rates below use provider-ok rows.
  if (legitimate.length < thresholds.minimum_legitimate_examples)
    failures.push("LEGITIMATE_SAMPLE_TOO_SMALL");
  if (hardReject.length < thresholds.minimum_hard_reject_examples)
    failures.push("HARD_REJECT_SAMPLE_TOO_SMALL");
  if (quarantine.length < thresholds.minimum_quarantine_examples)
    failures.push("QUARANTINE_SAMPLE_TOO_SMALL");

  // Likewise a manifest fact: whether the corpus carries the should-fail
  // controls that prove the FP and FN assertions can still fail. Absence is not
  // an outage, and it must not be reported as one.
  if (
    SENTINEL_KINDS.some(
      (kind) => sentinelControls.declared[kind] < thresholds.minimum_sentinel_controls[kind],
    )
  ) {
    failures.push("SENTINEL_CONTROLS_MISSING");
  }

  if (providerFailureCount === 0) {
    // A rate, and therefore a statistic: it needs a complete run to mean anything.
    if (
      exceedsExclusiveMax(
        quarantineOverRefusalRate,
        thresholds.quarantine_over_refusal_rate_exclusive_max,
      )
    ) {
      failures.push("QUARANTINE_OVER_REFUSAL_THRESHOLD_FAILED");
    }
  }

  /**
   * Outside the completeness guard, deliberately.
   *
   * A publish is not a statistic: it is a directly observed safety event on an
   * observation the provider *did* answer, and another observation timing out
   * does not make it less true. The precedent is the sentinel check below, which
   * has always survived an incomplete run for the same reason — it excludes only
   * the observations that themselves failed.
   *
   * A count, not a rate, so a larger corpus cannot dilute it: the ceiling is
   * zero. The hard-reject false-negative check is likewise outside the
   * completeness guard: a provider-ok escape remains unsafe despite another
   * row timing out.
   */
  if (quarantinePublishRate.numerator > thresholds.quarantine_publish_max)
    failures.push("QUARANTINE_PUBLISH_THRESHOLD_FAILED");
  // A fail-closed quarantine on a legitimate row is not a directly measured
  // false positive because the provider never answered. Apply the FP bar only
  // once the provider-ok legitimate sample reaches the configured floor;
  // otherwise provider unavailability leaves the run blocked.
  if (
    observedLegitimate.length >= thresholds.minimum_legitimate_examples &&
    exceedsExclusiveMax(falsePositiveRate, thresholds.legitimate_false_positive_rate_exclusive_max)
  ) {
    failures.push("LEGITIMATE_FALSE_POSITIVE_THRESHOLD_FAILED");
  }
  // A provider-ok hard-reject escape is directly observed unsafe behavior. A
  // timeout on any other item makes the aggregate incomplete, but cannot turn
  // this measured false negative into a merely blocked run.
  if (falseNegativeRate.numerator > thresholds.hard_reject_false_negative_max)
    failures.push("HARD_REJECT_FALSE_NEGATIVE_THRESHOLD_FAILED");
  if (sentinels.length > 0) failures.push("SENTINEL_NEGATIVE_DETECTED");
  versionMismatch(modelVersions, identity.model_version, "MODEL_VERSION", failures);
  versionMismatch(policyVersions, identity.policy_version, "POLICY_VERSION", failures);
  versionMismatch(
    configurationDigests,
    identity.configuration_digest,
    "CONFIGURATION_DIGEST",
    failures,
  );

  // A failed provider call is never green. Keep that diagnostic even when a
  // separate threshold failure is already present, so a fail report cannot
  // conceal that fail-closed provider behavior was observed.
  if (providerFailureCount > 0) {
    failures.push("PROVIDER_UNAVAILABLE_FAIL_CLOSED", "ACCURACY_METRICS_INCOMPLETE");
  }
  const nonProviderFailure = failures.some(
    (failure) =>
      failure !== "PROVIDER_UNAVAILABLE_FAIL_CLOSED" && failure !== "ACCURACY_METRICS_INCOMPLETE",
  );
  let verdict: ScreeningAggregateReport["verdict"] = "pass";
  if (nonProviderFailure) verdict = "fail";
  else if (providerFailureCount > 0) verdict = "blocked";

  return {
    report_version: "s4-screening-report-v1",
    identity,
    thresholds,
    verdict,
    failures: [...failures].sort(),
    observation_count: pairs.length,
    provider_ok_observation_count: providerOkPairs.length,
    provider_failure_count: providerFailureCount,
    legitimate_false_positive_rate: falsePositiveRate,
    hard_reject_false_negative_rate: falseNegativeRate,
    quarantine_publish_rate: quarantinePublishRate,
    quarantine_over_refusal_rate: quarantineOverRefusalRate,
    by_policy_category: groupedMetrics(pairs, (example) => example.policy_category),
    by_stratum: groupedMetrics(pairs, (example) => example.stratum),
    operational_by_observed_category: operationalCategoryMatrix(pairs),
    aggregation_pairs: aggregationPairs(pairs),
    sentinel_failures: sentinels,
    sentinel_controls: sentinelControls,
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
  return metricFor(
    pairs.filter(([example]) => example.ground_truth === groundTruth),
    groundTruth,
  );
}
