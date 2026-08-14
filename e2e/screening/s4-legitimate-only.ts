/**
 * S-4 partial run: measure the corpus half that actually exists.
 *
 * The frozen manifest reserves 50 hard-reject examples whose bodies are
 * deliberately absent from this repository (`source.availability: "blocked"`).
 * Until staging supplies them, the bead's zero-false-negative half cannot be
 * measured at all.
 *
 * The runner previously refused the *whole* corpus on that basis, and that threw
 * away something real: the 150 legitimate weird-mathematics bodies are present
 * and inline, and the false-positive half of the acceptance criterion needs
 * neither protected content nor a hard-reject example to be meaningful.
 * Measuring nothing while a measurable half sits on disk is not caution.
 *
 * ## Why this does not call `aggregateScreeningRun`
 *
 * That function refuses a corpus without both ground-truth classes
 * (`aggregate.ts`, "Frozen corpus must contain both legitimate and hard-reject
 * examples"). That refusal is correct and is left alone: it is what stops a
 * half-corpus from being reported through the full-run type. Relaxing it would
 * weaken the complete-run gate to serve the partial case.
 *
 * So this module composes the *exported* primitives — `verifyObservationBodyBindings`
 * for input validation and `truthMetricFor` for the confusion arithmetic — and
 * returns `S4PartialScreeningReport`, a distinct type. None of the metric maths
 * is reimplemented here, and a partial report cannot be passed where a
 * `ScreeningAggregateReport` is expected, because its `verdict` union has no
 * `"pass"` member at all. The gate cannot go green through this path by any
 * value it could produce.
 *
 * ## Evidence class
 *
 * Every result carries a required `evidence_class`. A number produced by an
 * in-process fixture provider and a number produced by staging's real model are
 * both useful and are not the same claim, so they are never allowed to look
 * alike: the label rides on the report and on every emitted record, and
 * `assertPartialRunNotGreen` checks it is present.
 */
import {
  assertScreeningRunIdentity,
  type ConfusionMetric,
  type GroundTruth,
  type RateMetric,
  S4_THRESHOLDS,
  type ScreeningCorpusExample,
  type ScreeningObservation,
  type ScreeningProvider,
  type ScreeningRunIdentity,
  type ScreeningThresholds,
  screenWithProvider,
  truthMetricFor,
  verifyObservationBodyBindings,
} from "../../apps/wire/src/screening/index";

/** No hard-reject half means no complete run, whatever else went right. */
export const PARTIAL_BLOCKED_EXIT_CODE = 78;
/** A metric that was measured and breached is a failure, not a blocker. */
export const PARTIAL_FAILED_EXIT_CODE = 1;

/**
 * Whether the numbers came from a real screening provider or from a fixture.
 *
 * A fixture exercises this module's arithmetic and the runner's wiring. It says
 * nothing whatsoever about Workers AI, and mislabelling it would turn a wiring
 * test into a fabricated accuracy claim.
 */
export type PartialRunEvidenceClass = "provider-measured" | "fixture-not-model-evidence";

export type UnmeasuredMetric =
  | "legitimate_false_positive_rate"
  | "hard_reject_false_negative_rate"
  | "quarantine_publish_rate"
  | "quarantine_over_refusal_rate";

export type ReservedGroundTruthCounts = Readonly<Record<GroundTruth, number>>;

export interface PartitionedCorpus {
  /** Examples carrying an inline body and a digest: evaluable today. */
  readonly evaluable: readonly ScreeningCorpusExample[];
  /** Examples reserved against protected material that this repository does not hold. */
  readonly reserved: readonly ScreeningCorpusExample[];
}

/**
 * A partial report. Deliberately *not* a `ScreeningAggregateReport`: the two
 * describe different claims, and the type system should be the thing that keeps
 * them apart rather than a reviewer's attention.
 */
export interface S4PartialScreeningReport {
  readonly report_version: "s4-partial-screening-report-v1";
  readonly identity: ScreeningRunIdentity;
  readonly thresholds: ScreeningThresholds;
  readonly evidence_class: PartialRunEvidenceClass;
  /** No `"pass"` member. A partial run has no way to express success. */
  readonly verdict: "blocked" | "fail";
  readonly failures: readonly string[];
  readonly evaluated_count: number;
  readonly reserved_count: number;
  /** Availability gaps by declared truth; never relabel a legitimate reservation as hard-reject. */
  readonly reserved_by_ground_truth: ReservedGroundTruthCounts;
  readonly provider_ok_count: number;
  readonly provider_failure_count: number;
  /** Actual legitimate bodies observed by the provider. */
  readonly legitimate_observed_count: number;
  readonly legitimate_false_positive_rate: RateMetric;
  readonly quarantine_publish_rate: RateMetric;
  readonly quarantine_over_refusal_rate: RateMetric;
  /** Ground-truth classes the manifest declares but this run could not evaluate. */
  readonly unmeasured: readonly UnmeasuredMetric[];
  /** Named, non-secret reasons the run is partial. */
  readonly blockers: readonly string[];
  readonly exit_code: typeof PARTIAL_BLOCKED_EXIT_CODE | typeof PARTIAL_FAILED_EXIT_CODE;
}

export interface PartialAggregateInput {
  /** The rows that produced actual observations in this run. */
  readonly corpus: readonly ScreeningCorpusExample[];
  /** Manifest rows unavailable to this run; they are availability gaps, never synthetic metrics. */
  readonly reserved: readonly ScreeningCorpusExample[];
  readonly observations: readonly ScreeningObservation[];
  readonly identity: ScreeningRunIdentity;
  readonly evidence_class: PartialRunEvidenceClass;
  readonly thresholds?: ScreeningThresholds;
}

export interface PartialRunOptions {
  readonly corpus: readonly ScreeningCorpusExample[];
  readonly provider: ScreeningProvider;
  readonly identity: ScreeningRunIdentity;
  readonly evidence_class: PartialRunEvidenceClass;
  readonly timeout_ms?: number;
  readonly now_ms?: () => number;
  readonly thresholds?: ScreeningThresholds;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const EMPTY_RATE: RateMetric = { numerator: 0, denominator: 0, rate: null, wilson_95: null };

/**
 * Split the manifest by whether an example can actually be screened here.
 *
 * An inline body *and* a digest are both required: without a digest the
 * observation cannot be bound to what was screened, so the example is reserved
 * no matter what else it carries.
 */
export function partitionEvaluableCorpus(
  corpus: readonly ScreeningCorpusExample[],
): PartitionedCorpus {
  const evaluable: ScreeningCorpusExample[] = [];
  const reserved: ScreeningCorpusExample[] = [];
  for (const example of corpus) {
    const usable =
      example.source.availability === "available" &&
      typeof example.body === "string" &&
      example.body.length > 0 &&
      typeof example.body_digest === "string" &&
      example.body_digest.length > 0;
    if (usable) evaluable.push(example);
    else reserved.push(example);
  }
  return { evaluable, reserved };
}

/**
 * True when the only thing standing between this manifest and a complete run is
 * protected material that staging owns.
 *
 * Anything else — an inline body that went missing, a malformed entry — is a
 * corpus defect rather than an availability gap, and must keep refusing the
 * whole run instead of quietly downgrading to a partial one.
 */
const PARTIAL_ELIGIBLE_BLOCKERS: ReadonlySet<string> = new Set([
  "PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE",
  "LEGITIMATE_BODY_UNAVAILABLE",
  "QUARANTINE_BODY_UNAVAILABLE",
  "EVALUATED_BODY_DIGEST_MISSING",
]);

export function isPartialRunEligible(blockers: readonly string[]): boolean {
  return (
    blockers.includes("PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE") &&
    blockers.every((blocker) => PARTIAL_ELIGIBLE_BLOCKERS.has(blocker))
  );
}

/**
 * Recompute each evaluable body's digest before anything is sent anywhere.
 *
 * `assertS4ManifestReadyForLiveRun` does this for a complete manifest, but it
 * insists on the full 150/50 shape and so cannot be pointed at a subset. The
 * check itself still has to happen: it is what makes `evaluated_body_digest` an
 * attestation rather than a copied string.
 */
export async function assertEvaluableBodiesBindTheirDigests(
  evaluable: readonly ScreeningCorpusExample[],
): Promise<void> {
  for (const example of evaluable) {
    const bytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(example.body as string)),
    );
    const digest = `sha256:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    if (digest !== example.body_digest) throw new Error("INLINE_SAFE_BODY_DIGEST_MISMATCH");
  }
}

function rateFrom(metric: ConfusionMetric, key: keyof ConfusionMetric): RateMetric {
  const value = metric[key];
  return typeof value === "object" && value !== null ? (value as RateMetric) : EMPTY_RATE;
}

function reservedGroundTruthCounts(
  reserved: readonly ScreeningCorpusExample[],
): ReservedGroundTruthCounts {
  const counts: Record<GroundTruth, number> = { legitimate: 0, "hard-reject": 0, quarantine: 0 };
  for (const example of reserved) counts[example.ground_truth] += 1;
  return counts;
}

function availabilityBlockers(counts: ReservedGroundTruthCounts): readonly string[] {
  const blockers: string[] = [];
  if (counts.legitimate > 0) blockers.push("LEGITIMATE_BODY_UNAVAILABLE");
  if (counts["hard-reject"] > 0) blockers.push("PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE");
  if (counts.quarantine > 0) blockers.push("QUARANTINE_BODY_UNAVAILABLE");
  return blockers;
}

/**
 * Which metrics have no denominator in this run.
 *
 * Derived from the evaluated examples rather than hard-coded, so supplying the
 * protected bodies later shortens this list on its own instead of depending on
 * someone remembering to edit it.
 */
function unmeasuredMetrics(
  evaluated: readonly ScreeningCorpusExample[],
  reserved: ReservedGroundTruthCounts,
  providerFailures: readonly [ScreeningCorpusExample, ScreeningObservation][],
): readonly UnmeasuredMetric[] {
  const present = new Set<GroundTruth>(evaluated.map((example) => example.ground_truth));
  const unmeasured: UnmeasuredMetric[] = [];
  const failedTruths = new Set(providerFailures.map(([example]) => example.ground_truth));
  if (!present.has("legitimate") || reserved.legitimate > 0 || failedTruths.has("legitimate")) {
    unmeasured.push("legitimate_false_positive_rate");
  }
  if (
    !present.has("hard-reject") ||
    reserved["hard-reject"] > 0 ||
    failedTruths.has("hard-reject")
  ) {
    unmeasured.push("hard_reject_false_negative_rate");
  }
  if (!present.has("quarantine") || reserved.quarantine > 0 || failedTruths.has("quarantine")) {
    unmeasured.push("quarantine_publish_rate", "quarantine_over_refusal_rate");
  }
  return unmeasured;
}

function versionMismatch(
  observed: readonly string[],
  expected: string,
  field: string,
  failures: string[],
): void {
  const unique = [...new Set(observed)];
  if (unique.length !== 1 || unique[0] !== expected) failures.push(`${field}_MISMATCH`);
}

/**
 * Aggregate observations that were produced elsewhere (the live staging path
 * already has them over HTTP, and re-screening would be a second, different run).
 */
export function aggregatePartialScreeningRun(
  input: PartialAggregateInput,
): S4PartialScreeningReport {
  const thresholds = input.thresholds ?? S4_THRESHOLDS;
  // This identity is emitted by partialRunOpsJsonl. Validate it before any
  // aggregation/output path, exactly as the complete report does.
  assertScreeningRunIdentity(input.identity);
  // Full input validation, borrowed rather than reimplemented: digest binding,
  // duplicate ids, orphan observations, unsafe labels, timing sanity.
  verifyObservationBodyBindings(input.corpus, input.observations);

  const byId = new Map(
    input.observations.map((observation) => [observation.example_id, observation]),
  );
  const pairs: [ScreeningCorpusExample, ScreeningObservation][] = [...input.corpus]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((example) => [example, byId.get(example.id) as ScreeningObservation]);

  const providerOk = pairs.filter(([, observation]) => observation.provider_status === "ok");
  const providerFailures = pairs.filter(([, observation]) => observation.provider_status !== "ok");
  const providerFailureCount = pairs.length - providerOk.length;
  const reservedByGroundTruth = reservedGroundTruthCounts(input.reserved);
  // A fail-closed operational quarantine is the correct write-path outcome for
  // an unavailable provider, but it is not a classifier result. Likewise, a
  // reserved row was not screened. Neither may be invented as a false positive
  // or folded into an accuracy denominator; both make the FP metric unmeasured.
  const eligibleHardReject = providerOk.filter(
    ([example]) => example.ground_truth === "hard-reject",
  );
  const observedLegitimateCount = providerOk.filter(
    ([example]) => example.ground_truth === "legitimate",
  ).length;
  const eligibleQuarantine = providerOk.filter(
    ([example]) => example.ground_truth === "quarantine",
  );

  const legitimateMetric = truthMetricFor("legitimate", pairs);
  const quarantineMetric = truthMetricFor("quarantine", pairs);
  const observedLegitimateRate = rateFrom(legitimateMetric, "false_positive_rate");
  const legitimateMetricUnmeasured =
    reservedByGroundTruth.legitimate > 0 ||
    providerFailures.some(([example]) => example.ground_truth === "legitimate");
  const falsePositiveRate = legitimateMetricUnmeasured ? EMPTY_RATE : observedLegitimateRate;
  const quarantinePublishRate = rateFrom(quarantineMetric, "quarantine_publish_rate");
  const quarantineOverRefusalRate = rateFrom(quarantineMetric, "quarantine_over_refusal_rate");

  const failures: string[] = [];

  /**
   * The sample-size guards are evaluated exactly as the complete run evaluates
   * them, and are *not* relaxed for the partial case. `HARD_REJECT_SAMPLE_TOO_SMALL`
   * is therefore always present here — that is the point. It is the machine-checkable
   * statement that the zero-false-negative half went unmeasured, and it is what
   * `assertPartialRunNotGreen` keys on.
   */
  // Coverage is a fact about bodies that reached the provider, even when a
  // separate provider failure makes every accuracy conclusion incomplete.
  if (observedLegitimateCount < thresholds.minimum_legitimate_examples)
    failures.push("LEGITIMATE_SAMPLE_TOO_SMALL");

  if (providerFailureCount === 0) {
    if (eligibleHardReject.length < thresholds.minimum_hard_reject_examples)
      failures.push("HARD_REJECT_SAMPLE_TOO_SMALL");
    if (eligibleQuarantine.length < thresholds.minimum_quarantine_examples)
      failures.push("QUARANTINE_SAMPLE_TOO_SMALL");
    if (
      quarantineOverRefusalRate.rate !== null &&
      quarantineOverRefusalRate.rate >= thresholds.quarantine_over_refusal_rate_exclusive_max
    ) {
      failures.push("QUARANTINE_OVER_REFUSAL_THRESHOLD_FAILED");
    }
  }

  // Outside the completeness guard, matching `aggregateScreeningRun`: a publish
  // is a directly observed safety event on an observation the provider did
  // answer, not a statistic another observation's timeout can dilute.
  if (quarantinePublishRate.numerator > thresholds.quarantine_publish_max)
    failures.push("QUARANTINE_PUBLISH_THRESHOLD_FAILED");

  if (
    falsePositiveRate.rate !== null &&
    falsePositiveRate.rate >= thresholds.legitimate_false_positive_rate_exclusive_max
  ) {
    failures.push("LEGITIMATE_FALSE_POSITIVE_THRESHOLD_FAILED");
  }

  // With no provider-success observation there is no version attestation to
  // compare. Treat that as the provider outage it is, not as three fabricated
  // mismatches. If even one result arrived, however, its versions remain
  // evidence and must agree with the run identity.
  if (providerOk.length > 0) {
    versionMismatch(
      providerOk.map(([, observation]) => observation.model_version),
      input.identity.model_version,
      "MODEL_VERSION",
      failures,
    );
    versionMismatch(
      providerOk.map(([, observation]) => observation.policy_version),
      input.identity.policy_version,
      "POLICY_VERSION",
      failures,
    );
    versionMismatch(
      providerOk.map(([, observation]) => observation.configuration_digest),
      input.identity.configuration_digest,
      "CONFIGURATION_DIGEST",
      failures,
    );
  }

  if (providerFailureCount > 0) {
    failures.push("PROVIDER_UNAVAILABLE_FAIL_CLOSED", "ACCURACY_METRICS_INCOMPLETE");
  }
  if (reservedByGroundTruth.legitimate > 0) failures.push("LEGITIMATE_EVIDENCE_UNAVAILABLE");
  if (reservedByGroundTruth["hard-reject"] > 0) failures.push("HARD_REJECT_EVIDENCE_UNAVAILABLE");
  if (reservedByGroundTruth.quarantine > 0) failures.push("QUARANTINE_EVIDENCE_UNAVAILABLE");

  /**
   * A measured breach is a failure; an unmeasured half is a blocker. Fail
   * dominates, so a run that both breached a threshold *and* lacked the
   * hard-reject half reports `fail` — the stricter of the two. Neither branch
   * can reach zero.
   */
  const measuredBreach = failures.some(
    (failure) =>
      failure === "LEGITIMATE_FALSE_POSITIVE_THRESHOLD_FAILED" ||
      failure === "QUARANTINE_OVER_REFUSAL_THRESHOLD_FAILED" ||
      failure === "QUARANTINE_PUBLISH_THRESHOLD_FAILED" ||
      failure.endsWith("_MISMATCH"),
  );
  const verdict: S4PartialScreeningReport["verdict"] = measuredBreach ? "fail" : "blocked";

  return {
    report_version: "s4-partial-screening-report-v1",
    identity: input.identity,
    thresholds,
    evidence_class: input.evidence_class,
    verdict,
    failures: [...failures].sort(),
    evaluated_count: pairs.length,
    reserved_count: input.reserved.length,
    reserved_by_ground_truth: reservedByGroundTruth,
    provider_ok_count: providerOk.length,
    provider_failure_count: providerFailureCount,
    legitimate_observed_count: observedLegitimateCount,
    legitimate_false_positive_rate: falsePositiveRate,
    quarantine_publish_rate: quarantinePublishRate,
    quarantine_over_refusal_rate: quarantineOverRefusalRate,
    unmeasured: unmeasuredMetrics(
      providerOk.map(([example]) => example),
      reservedByGroundTruth,
      providerFailures,
    ),
    blockers: availabilityBlockers(reservedByGroundTruth),
    exit_code: verdict === "fail" ? PARTIAL_FAILED_EXIT_CODE : PARTIAL_BLOCKED_EXIT_CODE,
  };
}

/**
 * Screen every evaluable example through the injected provider, then aggregate.
 *
 * The reserved half is not fabricated or counted as passing. Reserved
 * legitimate examples conservatively count as fail-closed over-refusals, while
 * the truth-specific blocker and `unmeasured` field keep the evidence boundary
 * explicit. Provider outages and reserved examples are not classifier outcomes,
 * so they are never synthesized as false positives; unavailable
 * hard-reject/quarantine examples are never invented either.
 */
export async function runLegitimateOnlyScreening(
  options: PartialRunOptions,
): Promise<S4PartialScreeningReport> {
  const { evaluable, reserved } = partitionEvaluableCorpus(options.corpus);
  const observations: ScreeningObservation[] = [];
  for (const example of evaluable) {
    observations.push(
      await screenWithProvider(
        options.provider,
        {
          example_id: example.id,
          body_digest: example.body_digest as string,
          context_digest: example.body_digest as string,
          identity: options.identity,
        },
        {
          timeout_ms: options.timeout_ms ?? DEFAULT_TIMEOUT_MS,
          ...(options.now_ms === undefined ? {} : { now_ms: options.now_ms }),
        },
      ),
    );
  }
  return aggregatePartialScreeningRun({
    corpus: evaluable,
    reserved,
    observations,
    identity: options.identity,
    evidence_class: options.evidence_class,
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
  });
}

export class PartialRunGreenError extends Error {
  readonly code = "S4_PARTIAL_RUN_REPORTED_GREEN";
  constructor(message: string) {
    super(message);
    this.name = "PartialRunGreenError";
  }
}

/**
 * A partial run must never read as a complete one.
 *
 * This is the guard the module hangs on. A measured false-positive rate is
 * genuine progress and it is also precisely the number someone could quote as
 * "S-4 passing", so several independent conditions have to hold at once — the
 * missing-sample failure is recorded, the hard-reject evidence is named absent,
 * the metric is declared unmeasured, the evidence class is stated, and the exit
 * code is non-zero. No single edit can quietly turn the gate green.
 */
export function assertPartialRunNotGreen(report: S4PartialScreeningReport): void {
  if (report.reserved_count === 0) return; // a complete corpus is not this module's claim
  const require = (condition: boolean, message: string): void => {
    if (!condition) throw new PartialRunGreenError(message);
  };
  const reserved = report.reserved_by_ground_truth;
  require(reserved.legitimate + reserved["hard-reject"] + reserved.quarantine ===
    report.reserved_count, "a partial report's reserved truth counts do not match its reserved total.");
  if (reserved.legitimate > 0) {
    require(report.failures.includes(
      "LEGITIMATE_EVIDENCE_UNAVAILABLE",
    ), "a run with reserved legitimate examples did not name LEGITIMATE_EVIDENCE_UNAVAILABLE.");
    require(report.blockers.includes(
      "LEGITIMATE_BODY_UNAVAILABLE",
    ), "a run with reserved legitimate examples did not carry the legitimate-body blocker.");
  }
  if (reserved["hard-reject"] > 0) {
    require(report.failures.includes("HARD_REJECT_SAMPLE_TOO_SMALL") ||
      report.failures.includes(
        "ACCURACY_METRICS_INCOMPLETE",
      ), "a run missing hard-reject examples recorded neither HARD_REJECT_SAMPLE_TOO_SMALL nor ACCURACY_METRICS_INCOMPLETE.");
    require(report.failures.includes(
      "HARD_REJECT_EVIDENCE_UNAVAILABLE",
    ), "a run with reserved hard-reject examples did not name HARD_REJECT_EVIDENCE_UNAVAILABLE.");
    require(report.unmeasured.includes(
      "hard_reject_false_negative_rate",
    ), "the false-negative metric was not declared unmeasured despite reserved hard-reject examples.");
    require(report.blockers.includes(
      "PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE",
    ), "a run with reserved hard-reject examples did not carry the protected-bodies blocker.");
  }
  require(report.evidence_class === "provider-measured" ||
    report.evidence_class ===
      "fixture-not-model-evidence", "the report does not state an evidence class.");
  // The exit-code union already excludes 0, so this can only fire on a value
  // that arrived from outside the type system — a parsed record, a hand-built
  // object. That is exactly the case worth checking.
  require((report.exit_code as number) !== 0, "a partial run produced a success exit code.");
}

/**
 * One safe NDJSON line. Carries counts, versions, rates, and named blockers —
 * never a body, an excerpt, a detector prompt, or a score band, so a partial-run
 * log cannot become the pattern oracle the full report is careful not to be.
 */
export function partialRunOpsJsonl(report: S4PartialScreeningReport): string {
  assertScreeningRunIdentity(report.identity);
  return JSON.stringify({
    record_type: "screening-partial-aggregate",
    report_version: report.report_version,
    corpus_revision: report.identity.corpus_revision,
    corpus_digest: report.identity.corpus_digest,
    model_version: report.identity.model_version,
    policy_version: report.identity.policy_version,
    configuration_digest: report.identity.configuration_digest,
    evidence_class: report.evidence_class,
    verdict: report.verdict,
    failures: report.failures,
    evaluated_count: report.evaluated_count,
    reserved_count: report.reserved_count,
    reserved_by_ground_truth: report.reserved_by_ground_truth,
    provider_ok_count: report.provider_ok_count,
    provider_failure_count: report.provider_failure_count,
    legitimate_observed_count: report.legitimate_observed_count,
    legitimate_false_positive_rate: report.legitimate_false_positive_rate,
    quarantine_publish_rate: report.quarantine_publish_rate,
    quarantine_over_refusal_rate: report.quarantine_over_refusal_rate,
    unmeasured: report.unmeasured,
    blockers: report.blockers,
    exit_code: report.exit_code,
    detail:
      "Partial S-4 run: only evaluable bodies were screened. Reserved rows and provider outages are not synthesized into accuracy metrics; metrics named in `unmeasured` remain incomplete and this run can never report pass.",
  });
}
