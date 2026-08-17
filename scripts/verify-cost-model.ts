/**
 * S-7's deliberately narrow cost-model verifier.
 *
 * It reproduces Fable §15's worked arithmetic and decodes one future, retained
 * S-2 measurement receipt. It intentionally cannot turn a local S-2 result
 * into a deployed-cost or performance claim: all unavailable dimensions remain
 * named unknowns and the verifier's terminal status stays blocked.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import {
  MAX_S2_COST_EVIDENCE_MANIFEST_BYTES,
  MAX_S2_COST_RECEIPT_BYTES,
  parseS2CostEvidenceManifestBytes,
  parseS2CostMeasurementReceiptBytes,
  parseS2CostReceiptPublicationBytes,
  parseS2CostReceiptPublicationCommitBytes,
  type REQUIRED_ROW_TOTAL_EXCLUSIONS,
  S2_COST_EVIDENCE_MANIFEST_VERSION,
  S2_COST_MANIFEST_RELATIVE_PATH,
  type S2_COST_METRIC_SCOPE,
  S2_COST_PUBLICATION_COMMIT_RELATIVE_PATH,
  S2_COST_PUBLICATION_RELATIVE_PATH,
  S2_COST_RECEIPT_RELATIVE_PATH,
  type S2_FAILED_RETRY_SCOPE,
  type S2_LOCAL_SCOPE,
  type S2_SUCCESSFUL_BATCH_SCOPE,
  type S2_WRITE_CLAIM_SCOPE,
  type S2CostMeasurementReceipt,
  S2CostReceiptContractError,
} from "@asimposium/contracts";
import {
  HARNESS_SCHEMA_VERSION,
  type HarnessEvent,
  validateHarnessEvent,
} from "./harness/runner.ts";

export {
  MAX_S2_COST_RECEIPT_BYTES,
  REQUIRED_ROW_TOTAL_EXCLUSIONS,
  S2_COST_DURABLE_PUBLICATION_RESERVED_BYTES,
  S2_COST_DURABLE_PUBLICATION_RESERVED_NAMES,
  S2_COST_EVIDENCE_MANIFEST_VERSION,
  S2_COST_MANIFEST_RELATIVE_PATH,
  S2_COST_METRIC_SCOPE,
  S2_COST_PUBLICATION_COMMIT_RECORD,
  S2_COST_PUBLICATION_COMMIT_RELATIVE_PATH,
  S2_COST_PUBLICATION_COMMIT_SCHEMA_VERSION,
  S2_COST_PUBLICATION_RECORD,
  S2_COST_PUBLICATION_RELATIVE_PATH,
  S2_COST_PUBLICATION_SCHEMA_VERSION,
  S2_COST_RECEIPT_RECORD,
  S2_COST_RECEIPT_RELATIVE_PATH,
  S2_COST_RECEIPT_SCHEMA_VERSION,
  S2_FAILED_RETRY_SCOPE,
  S2_LOCAL_SCOPE,
  S2_SUCCESSFUL_BATCH_SCOPE,
  S2_WRITE_CLAIM_SCOPE,
  type S2CostEvidenceManifest,
  type S2CostMeasurementReceipt,
  type S2CostReceiptPublication,
  type S2CostReceiptPublicationCommit,
} from "@asimposium/contracts";

const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/**
 * The official billing statements this model depends on, transcribed once with
 * their retrieval date. They are pinned rather than fetched: this verifier makes
 * no provider call, and a quote that can silently change is not a citation.
 *
 * The distinction they establish is the one Fable §15 collapses — a cache HIT
 * still costs a request, and only CPU is avoided.
 */
export interface PinnedSourceRecord {
  readonly url: string;
  /** ISO date the page state below was established. */
  readonly retrieved: string;
  readonly verification: "current-primary-text" | "unverified-not-primary-text";
  /**
   * Verbatim and short, present ONLY for `current-primary-text`. Paraphrase is
   * where this model's original error entered, and an unverifiable quote is
   * worse than none: it reads as a citation while resting on nothing.
   */
  readonly quote?: string;
  /** Present only when unverified. No quote is fabricated to fill the gap. */
  readonly unverified_reason?: string;
}

export const COST_MODEL_PINNED_SOURCES: readonly PinnedSourceRecord[] = [
  {
    url: "https://developers.cloudflare.com/workers/platform/pricing/",
    retrieved: "2026-08-17",
    verification: "current-primary-text",
    quote:
      "When Workers Caching is enabled, requests served from the Worker's cache are billed at the same per-request rate as requests that invoke the Worker.",
  },
  {
    url: "https://developers.cloudflare.com/cache/interaction-cloudflare-products/workers/",
    retrieved: "2026-08-17",
    verification: "current-primary-text",
    quote: "When a request arrives, it hits the Worker before the cache is checked.",
  },
  {
    url: "https://developers.cloudflare.com/workers/reference/how-the-cache-works/",
    retrieved: "2026-08-17",
    verification: "current-primary-text",
    quote: "Cloudflare Workers run before the cache",
  },
  {
    // Mandated by the bead, but this path now resolves to a landing/redirect
    // rather than primary text, so the sentence the bead attributes to it could
    // not be confirmed. Flagged, not quoted, and not silently swapped for a
    // different page: substituting a source to keep a citation count is how an
    // unverifiable claim survives a review.
    url: "https://developers.cloudflare.com/workers/cache/",
    retrieved: "2026-08-17",
    verification: "unverified-not-primary-text",
    unverified_reason:
      "Resolves to a landing/redirect page; the bead's attributed sentence was not present in current primary text.",
  },
];

/** True only when every mandated source carries confirmed primary-page text. */
export function pinnedSourcesFullyVerified(
  sources: readonly PinnedSourceRecord[] = COST_MODEL_PINNED_SOURCES,
): boolean {
  return sources.every(
    (source) => source.verification === "current-primary-text" && source.quote !== undefined,
  );
}

/**
 * Peak rate is derived from the lurker count and cadence, so it is not an
 * operator input. Duration and frequency are NOT derivable from anything in the
 * plan, and this verifier refuses to invent them: without them a "peak rate" is
 * an unlabelled number that reconciles with any monthly total you like.
 *
 * Absent burst input is therefore reported, not defaulted. See
 * `FABLE_BURST_SHAPE_UNDECLARED`.
 */
export interface FableBurstInput {
  readonly seconds_per_occurrence: number;
  readonly occurrences_per_day: number;
}

/**
 * What §10.1's 1,000-Fellow sizing line does and does not account for.
 *
 * The line is a pack-read figure. Every other request class the same population
 * would generate is absent from it, so the ~45M/mo row cannot be decomposed into
 * "scenario + leftover". Naming the omissions is what keeps that from looking
 * like an oversight instead of the reason a headroom number is withheld.
 */
export const SIZING_LINE_ENUMERATED_REQUEST_CLASSES: readonly string[] = ["pack_reads"];

export const SIZING_LINE_UNENUMERATED_REQUEST_CLASSES: readonly string[] = [
  "workshop_pushes",
  "promotions",
  "cursor_polls",
  "session_opens_and_closes",
  "promotion_validation_reads",
  "public_face_reads",
];

export interface FableWorkedExampleInput {
  readonly problems: number;
  readonly working_fellows: number;
  readonly active_seconds_per_fellow_day: number;
  readonly pack_cadence_seconds: number;
  readonly workshop_push_cadence_seconds: number;
  readonly promotions_per_fellow_day: number;
  readonly lurkers: number;
  readonly cursor_poll_seconds: number;
  /**
   * The rate §15 prints beside its own cadence. An input, not a constant: a
   * caller checking a different scenario must be able to state that scenario's
   * printed rate, and a hard-coded 100 would silently compare every workload
   * against the default's prose.
   */
  readonly fable_stated_cursor_requests_per_second: number;
  /**
   * The ROUNDED figures §15 displays, kept separately from the exact arithmetic
   * they approximate. The bead adds these three to reach 29,800 and calls that
   * the base load; the exact components sum to 29,600. Declaring the displayed
   * values as inputs is what lets the verifier state that difference instead of
   * silently preferring one of the two numbers.
   */
  readonly fable_displayed_pack_reads_per_day: number;
  readonly fable_displayed_workshop_pushes_per_day: number;
  readonly fable_displayed_promotions_per_day: number;
  /**
   * Omitted until an operator accepts a burst shape. Absent is a reported state,
   * never a default: a peak with no duration reconciles with any monthly total.
   */
  readonly burst?: FableBurstInput;
  /**
   * The §10.1 sizing line the §15 table figure actually comes from. Kept as an
   * input so the table-scenario and duty-cycle discrepancies are computed from
   * declared numbers rather than asserted in prose.
   */
  readonly sizing_line_fellows: number;
  readonly sizing_line_active_seconds_per_fellow_day: number;
  readonly fable_table_requests_per_month: number;
  /**
   * Which request classes the sizing line accounts for, and which it omits.
   *
   * Inputs rather than constants so an operator who later supplies a complete
   * scenario can clear the storm-room gap by declaring the enumeration, instead
   * of the verifier deciding on their behalf that it has been closed.
   */
  readonly sizing_line_enumerated_request_classes: readonly string[];
  readonly sizing_line_unenumerated_request_classes: readonly string[];
}

/** The implicit four active hours are explicit so Fable's approximations reproduce exactly. */
export const FABLE_WORKED_EXAMPLE: FableWorkedExampleInput = {
  problems: 20,
  working_fellows: 80,
  active_seconds_per_fellow_day: 14_400,
  pack_cadence_seconds: 60,
  workshop_push_cadence_seconds: 120,
  promotions_per_fellow_day: 10,
  lurkers: 10_000,
  cursor_poll_seconds: 10,
  fable_stated_cursor_requests_per_second: 100,
  // §15 prints these to one significant figure; 19,200 and 9,600 are what its
  // own cadences produce. Both are recorded so neither can be quietly adopted
  // as the other.
  fable_displayed_pack_reads_per_day: 19_000,
  fable_displayed_workshop_pushes_per_day: 10_000,
  fable_displayed_promotions_per_day: 800,
  // No `burst`: Fable states no duration or frequency, and inventing one here
  // would manufacture the reconciliation this bead exists to withhold.
  sizing_line_fellows: 1_000,
  // Fable §10.1 states no active-day duration for its 1,000-Fellow line either.
  // A full day is what its ~45M/mo figure actually requires, and recording that
  // is what makes the mismatch with §15's four-hour example computable.
  sizing_line_active_seconds_per_fellow_day: 86_400,
  fable_table_requests_per_month: 45_000_000,
  sizing_line_enumerated_request_classes: SIZING_LINE_ENUMERATED_REQUEST_CLASSES,
  sizing_line_unenumerated_request_classes: SIZING_LINE_UNENUMERATED_REQUEST_CLASSES,
};

export interface CostModelAssumption {
  readonly code: "FABLE_ACTIVE_TIME_INFERRED";
  readonly status: "inferred";
  readonly active_seconds_per_fellow_day: 14_400;
  readonly active_hours_per_fellow_day: 4;
  readonly basis: string;
}

/**
 * §15 gives the daily read total and cadences but does not state an active-day
 * duration. Four hours is inferred from 19,200 reads / (80 fellows × 60 s).
 */
export const FABLE_WORKED_EXAMPLE_ASSUMPTIONS: readonly CostModelAssumption[] = [
  {
    code: "FABLE_ACTIVE_TIME_INFERRED",
    status: "inferred",
    active_seconds_per_fellow_day: 14_400,
    active_hours_per_fellow_day: 4,
    basis:
      "Derived from Fable §15's 19,200 pack reads/day, 80 working Fellows, and 60-second pack cadence; not stated as a plan input.",
  },
];

export interface FableWorkloadArithmetic {
  readonly problems: number;
  readonly pack_reads_per_day: number;
  readonly workshop_pushes_per_day: number;
  readonly promotions_per_day: number;
  readonly cursor_requests_per_second: number;
  /** Fable §15's stated approximation; retained beside the calculation, not copied into it. */
  readonly fable_stated_cursor_requests_per_second: number;
  /** Sustained-at-peak totals, stated so the 45M row can be compared against them. */
  readonly cursor_requests_per_30_days_at_computed_peak: number;
  readonly cursor_requests_per_30_days_at_stated_rate: number;
  /**
   * The §15 worked example's own base load: 19,200 + 9,600 + 800 = 29,600,
   * computed from the declared cadences. This is the exact figure.
   */
  readonly base_load_per_day: number;
  /**
   * The sum of the ROUNDED values §15 displays: 19,000 + 10,000 + 800 = 29,800.
   * Reported so the bead's 29,800 is visible as what it is — a sum of rounded
   * display figures — and never mistaken for the exact base load above.
   */
  readonly fable_displayed_base_load_per_day: number;
  /** The individual rounded values §15 prints, kept beside their exact counterparts. */
  readonly fable_displayed_pack_reads_per_day: number;
  readonly fable_displayed_workshop_pushes_per_day: number;
  readonly fable_displayed_promotions_per_day: number;
  /** What the §15 table figure implies per day. */
  readonly fable_table_requests_per_day: number;
  /**
   * The §10.1 line the table figure comes from, at its own implied duty cycle,
   * and the same population at §15's four-hour one. These differ by ~6x, which
   * is the whole of the duty-cycle discrepancy.
   *
   * Both count PACK READS ONLY. The sizing line names no other request class,
   * which is precisely why nothing here is subtracted from the table row.
   */
  readonly sizing_line_requests_per_day: number;
  readonly sizing_line_requests_per_day_at_worked_example_duty_cycle: number;
  /**
   * The request classes the §10.1 sizing line actually enumerates, and those it
   * does not. Recorded because the missing classes are the reason no storm room,
   * burst duration, or headroom figure is published: a remainder computed from
   * an incomplete enumeration is not a measurement of what is left over.
   */
  readonly sizing_line_enumerated_request_classes: readonly string[];
  readonly sizing_line_unenumerated_request_classes: readonly string[];
  /**
   * The duty cycles the two scenarios imply, carried here so discrepancy
   * detection reads this workload rather than the module's default constant.
   */
  readonly worked_example_active_seconds_per_fellow_day: number;
  readonly sizing_line_active_seconds_per_fellow_day: number;
  /**
   * Present only when an operator has accepted a burst shape. `undefined` means
   * the reconciliation is still open — it never means zero.
   *
   * Even when present this is only the burst's own volume; it is NOT compared
   * against any headroom, because no accepted headroom figure exists.
   */
  readonly declared_burst_requests_per_day?: number;
}

export interface ExpectedReceiptProvenance {
  readonly run_id?: string;
  readonly revision?: string;
  readonly dirty_state?: "clean" | "dirty";
  readonly source_digest?: string;
}

export interface ExactObservedRatio {
  readonly numerator: number;
  readonly denominator: number;
  readonly unit: "observed rows / selected settled write receipt";
}

export interface AcceptedLocalMeasurement {
  readonly state: "accepted-local";
  readonly artifact_digest: string;
  /** Provenance asserted by the receipt, not the verifier process's current Git state. */
  readonly receipt_provenance: {
    readonly run_id: string;
    readonly revision: string;
    readonly source_digest: string;
    readonly dirty_state: "clean" | "dirty";
  };
  readonly scope: typeof S2_LOCAL_SCOPE;
  readonly bindings: {
    readonly d1: "DB";
    readonly durable_object: "KRATER_OUTBOX";
    readonly r2: null;
  };
  readonly metric_scope: typeof S2_COST_METRIC_SCOPE;
  readonly successful_batch_metric_scope: typeof S2_SUCCESSFUL_BATCH_SCOPE;
  readonly failed_retry_batch_metrics: typeof S2_FAILED_RETRY_SCOPE;
  readonly write_claim_wall_scope: typeof S2_WRITE_CLAIM_SCOPE;
  readonly write_receipt_count: number;
  /** Counters observed in the receipt; none is promoted to a complete D1-row total. */
  readonly measured_counters: {
    readonly write_receipt_count: number;
    readonly sum_successful_batch_rows_read: number;
    readonly sum_successful_batch_rows_written: number;
    readonly sum_preflight_rows_read: number;
    readonly sum_preflight_rows_written: number;
    readonly sum_preflight_statements: number;
    readonly sum_retry_count: number;
  };
  readonly known_settled_batch_rows_read: number;
  readonly known_settled_batch_rows_written: number;
  readonly known_preflight_rows_read: number;
  readonly known_preflight_rows_written: number;
  readonly observed_rows_per_selected_settled_write_receipt: {
    readonly settled_batch_read: ExactObservedRatio;
    readonly settled_batch_written: ExactObservedRatio;
    readonly preflight_read: ExactObservedRatio;
    readonly preflight_written: ExactObservedRatio;
  };
  readonly local_p95_ms: {
    readonly write_phase: number;
    readonly preflight_wall: number;
    readonly write_claim_wall: number;
  };
  readonly known_row_total_exclusions: readonly (typeof REQUIRED_ROW_TOTAL_EXCLUSIONS)[number][];
}

export interface UnavailableMeasurement {
  readonly state: "unavailable" | "invalid";
  readonly artifact_digest: null;
}

export type CostVerificationCode =
  | "S2_COST_MEASUREMENT_UNAVAILABLE"
  | "S2_COST_RECEIPT_UNREADABLE"
  | "S2_COST_RECEIPT_INVALID"
  | "S2_COST_RECEIPT_TOO_LARGE"
  | "COST_MODEL_ARGUMENT_INVALID"
  | "COST_MODEL_EXTERNAL_MEASUREMENTS_UNAVAILABLE";

export interface CostVerificationResult {
  readonly status: "blocked";
  readonly code: CostVerificationCode;
  readonly workload: FableWorkloadArithmetic;
  readonly s2: AcceptedLocalMeasurement | UnavailableMeasurement;
  readonly source_discrepancies: readonly SourceDiscrepancy[];
  readonly assumptions: readonly CostModelAssumption[];
  readonly unknowns: readonly string[];
  /** Pinned billing citations, including any that could not be verified. */
  readonly pinned_sources: readonly PinnedSourceRecord[];
  /** False while any mandated source lacks confirmed primary-page text. */
  readonly pinned_sources_fully_verified: boolean;
}

/**
 * Six independent findings, deliberately not merged.
 *
 * Correcting the 10x cursor slip does not reconcile the table; correcting the
 * table does not settle which duty cycle the plan means; settling the duty
 * cycle does not supply a burst shape; and none of those makes the ~45M row
 * decomposable into storm room. The rounded-display mismatch is separate again:
 * it is a labelling defect, not an arithmetic one. A single code would let one
 * fix look like six, and each of these is cleared by a different input — which
 * the independence test asserts one at a time.
 */
export type SourceDiscrepancy =
  | {
      /** §15 states ~100 req/s; 10,000 lurkers / 10 s is 1,000. */
      readonly code: "FABLE_CURSOR_RATE_MISMATCH";
      readonly stated: number;
      readonly computed: number;
      readonly unit: "requests / second";
    }
  | {
      /**
       * The ~45M/mo table row is §10.1's 1,000-Fellow sizing line, not the
       * §15 worked example (20 problems / 80 Fellows). The storm never enters
       * the table arithmetic at all, so "room inside 45M" cannot be obtained by
       * subtracting the worked example's base load from it.
       */
      readonly code: "FABLE_TABLE_SCENARIO_MISMATCH";
      readonly table_requests_per_day: number;
      readonly sizing_line_requests_per_day: number;
      readonly worked_example_base_load_per_day: number;
      readonly unit: "requests / day";
    }
  | {
      /**
       * §15's example implies four active hours; §10.1's sizing line implies a
       * full day. The plan never states either, and the storm room swings by
       * more than an order of magnitude depending on which is meant.
       */
      readonly code: "FABLE_DUTY_CYCLE_MISMATCH";
      readonly worked_example_active_seconds: number;
      readonly sizing_line_active_seconds: number;
      readonly sizing_line_requests_per_day: number;
      readonly sizing_line_requests_per_day_at_worked_example_duty_cycle: number;
      readonly unit: "requests / day";
    }
  | {
      /**
       * Not an arithmetic error: a missing operator decision. Peak is derived,
       * duration and frequency are not, and this verifier refuses to supply
       * them. Until they are accepted, no monthly reconciliation exists.
       */
      readonly code: "FABLE_BURST_SHAPE_UNDECLARED";
      readonly computed_peak_requests_per_second: number;
      readonly required_operator_inputs: readonly ["seconds_per_occurrence", "occurrences_per_day"];
    }
  | {
      /**
       * Why no storm room, burst duration, or headroom number is published.
       *
       * The ~45M/mo row is §10.1's 1,000-Fellow sizing line, and that line
       * enumerates PACK READS ONLY — it states nothing about workshop pushes,
       * promotions, cursor polls, session opens, or promotion validation for
       * that population. Subtracting it from the row therefore does not yield
       * "room for the storm"; it yields the row minus one unnamed fraction of
       * its own scenario.
       *
       * Both candidate figures are refused for that reason: 60,000/day (row
       * minus the pack-read line) and 1,470,200/day (row minus the §15 worked
       * example, a different and smaller scenario). Each is arithmetically
       * derivable and neither is a headroom, so the verifier reports the
       * decision as outstanding instead of picking one.
       */
      readonly code: "FABLE_STORM_ROOM_UNRESOLVED";
      readonly table_requests_per_day: number;
      readonly sizing_line_requests_per_day: number;
      readonly enumerated_request_classes: readonly string[];
      readonly unenumerated_request_classes: readonly string[];
      readonly reason: string;
      readonly required_operator_inputs: readonly [
        "accepted_scenario_with_complete_request_class_enumeration",
      ];
    }
  | {
      /**
       * §15 displays rounded figures; the bead sums those and reports 29,800.
       * The exact cadences give 29,600. Neither number is wrong for what it is,
       * and the 200/day gap is small — but it is the difference between a sum of
       * display values and a computed base load, and the acceptance criterion
       * currently encodes the former as if it were the latter.
       */
      readonly code: "FABLE_ROUNDED_DISPLAY_BASE_LOAD_MISMATCH";
      readonly exact_base_load_per_day: number;
      readonly rounded_display_sum_per_day: number;
      readonly difference_per_day: number;
      readonly exact_components: {
        readonly pack_reads_per_day: number;
        readonly workshop_pushes_per_day: number;
        readonly promotions_per_day: number;
      };
      readonly rounded_display_components: {
        readonly pack_reads_per_day: number;
        readonly workshop_pushes_per_day: number;
        readonly promotions_per_day: number;
      };
      readonly authority: "exact_components";
      readonly unit: "requests / day";
    };

export class CostVerifierError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CostVerifierError";
  }
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!isSafeInteger(value)) {
    throw new CostVerifierError(
      "WORKLOAD_INPUT_INVALID",
      `${field} must be a non-negative integer.`,
    );
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const parsed = requireNonNegativeInteger(value, field);
  if (parsed === 0) {
    throw new CostVerifierError("WORKLOAD_INPUT_INVALID", `${field} must be positive.`);
  }
  return parsed;
}

function checkedProduct(left: number, right: number, field: string): number {
  const product = left * right;
  if (!Number.isSafeInteger(product)) {
    throw new CostVerifierError(
      "WORKLOAD_INPUT_INVALID",
      `${field} exceeds the safe integer range.`,
    );
  }
  return product;
}

/**
 * Request-class names are compared and reported, so a malformed list must fail
 * loudly rather than reach a discrepancy record as `undefined` entries that
 * would silently shorten the "what is missing" census.
 */
function requireRequestClasses(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) {
    throw new CostVerifierError(
      "WORKLOAD_INPUT_INVALID",
      `${field} must be an array of non-empty strings.`,
    );
  }
  return [...(value as readonly string[])];
}

function exactQuotient(numerator: number, denominator: number, field: string): number {
  if (numerator % denominator !== 0) {
    throw new CostVerifierError(
      "WORKLOAD_CADENCE_NOT_INTEGRAL",
      `${field} would require rounding, which this verifier forbids.`,
    );
  }
  return numerator / denominator;
}

const SECONDS_PER_DAY = 86_400;
const DAYS_PER_MONTH = 30;

/**
 * A burst is either fully declared or absent. A half-declared one — a duration
 * with no frequency, or the reverse — is refused rather than completed with a
 * default, because the default would become the reconciliation.
 */
function requireBurstOrUndeclared(burst: FableBurstInput | undefined): FableBurstInput | undefined {
  if (burst === undefined) return undefined;
  return {
    seconds_per_occurrence: requirePositiveInteger(
      burst.seconds_per_occurrence,
      "burst.seconds_per_occurrence",
    ),
    occurrences_per_day: requirePositiveInteger(
      burst.occurrences_per_day,
      "burst.occurrences_per_day",
    ),
  };
}

export function calculateFableWorkload(input: FableWorkedExampleInput): FableWorkloadArithmetic {
  const problems = requirePositiveInteger(input.problems, "problems");
  const fellows = requireNonNegativeInteger(input.working_fellows, "working_fellows");
  const activeSeconds = requirePositiveInteger(
    input.active_seconds_per_fellow_day,
    "active_seconds_per_fellow_day",
  );
  if (activeSeconds > 86_400) {
    throw new CostVerifierError(
      "WORKLOAD_INPUT_INVALID",
      "active_seconds_per_fellow_day must not exceed one day.",
    );
  }
  const packCadence = requirePositiveInteger(input.pack_cadence_seconds, "pack_cadence_seconds");
  const workshopCadence = requirePositiveInteger(
    input.workshop_push_cadence_seconds,
    "workshop_push_cadence_seconds",
  );
  const promotionsPerFellow = requireNonNegativeInteger(
    input.promotions_per_fellow_day,
    "promotions_per_fellow_day",
  );
  const lurkers = requireNonNegativeInteger(input.lurkers, "lurkers");
  const cursorPoll = requirePositiveInteger(input.cursor_poll_seconds, "cursor_poll_seconds");
  const statedCursorRate = requireNonNegativeInteger(
    input.fable_stated_cursor_requests_per_second,
    "fable_stated_cursor_requests_per_second",
  );
  const displayedPackReads = requireNonNegativeInteger(
    input.fable_displayed_pack_reads_per_day,
    "fable_displayed_pack_reads_per_day",
  );
  const displayedWorkshopPushes = requireNonNegativeInteger(
    input.fable_displayed_workshop_pushes_per_day,
    "fable_displayed_workshop_pushes_per_day",
  );
  const displayedPromotions = requireNonNegativeInteger(
    input.fable_displayed_promotions_per_day,
    "fable_displayed_promotions_per_day",
  );

  const sizingFellows = requirePositiveInteger(input.sizing_line_fellows, "sizing_line_fellows");
  const sizingActiveSeconds = requirePositiveInteger(
    input.sizing_line_active_seconds_per_fellow_day,
    "sizing_line_active_seconds_per_fellow_day",
  );
  const tablePerMonth = requirePositiveInteger(
    input.fable_table_requests_per_month,
    "fable_table_requests_per_month",
  );
  const burst = requireBurstOrUndeclared(input.burst);

  const activeFellowSeconds = checkedProduct(
    fellows,
    activeSeconds,
    "working_fellows × active_seconds_per_fellow_day",
  );
  const cursorPerSecond = exactQuotient(lurkers, cursorPoll, "cursor_requests_per_second");
  const packReadsPerDay = exactQuotient(activeFellowSeconds, packCadence, "pack_reads_per_day");
  const workshopPushesPerDay = exactQuotient(
    activeFellowSeconds,
    workshopCadence,
    "workshop_pushes_per_day",
  );
  const promotionsPerDay = checkedProduct(
    fellows,
    promotionsPerFellow,
    "working_fellows × promotions_per_fellow_day",
  );
  const baseLoadPerDay = packReadsPerDay + workshopPushesPerDay + promotionsPerDay;
  const tablePerDay = exactQuotient(tablePerMonth, DAYS_PER_MONTH, "fable_table_requests_per_day");
  const sizingPerDay = exactQuotient(
    checkedProduct(sizingFellows, sizingActiveSeconds, "sizing fellows × sizing seconds"),
    packCadence,
    "sizing_line_requests_per_day",
  );
  // No storm-room subtraction is performed. `tablePerDay - sizingPerDay` is
  // arithmetically available and deliberately not taken: the sizing line
  // enumerates one request class, so the remainder is not headroom. See
  // FABLE_STORM_ROOM_UNRESOLVED.
  return {
    problems,
    pack_reads_per_day: exactQuotient(activeFellowSeconds, packCadence, "pack_reads_per_day"),
    workshop_pushes_per_day: exactQuotient(
      activeFellowSeconds,
      workshopCadence,
      "workshop_pushes_per_day",
    ),
    promotions_per_day: checkedProduct(
      fellows,
      promotionsPerFellow,
      "working_fellows × promotions_per_fellow_day",
    ),
    cursor_requests_per_second: cursorPerSecond,
    fable_stated_cursor_requests_per_second: statedCursorRate,
    cursor_requests_per_30_days_at_computed_peak: checkedProduct(
      checkedProduct(cursorPerSecond, SECONDS_PER_DAY, "peak × seconds/day"),
      DAYS_PER_MONTH,
      "peak × seconds/day × days",
    ),
    cursor_requests_per_30_days_at_stated_rate: checkedProduct(
      checkedProduct(statedCursorRate, SECONDS_PER_DAY, "stated × seconds/day"),
      DAYS_PER_MONTH,
      "stated × seconds/day × days",
    ),
    base_load_per_day: baseLoadPerDay,
    fable_displayed_base_load_per_day:
      displayedPackReads + displayedWorkshopPushes + displayedPromotions,
    fable_displayed_pack_reads_per_day: displayedPackReads,
    fable_displayed_workshop_pushes_per_day: displayedWorkshopPushes,
    fable_displayed_promotions_per_day: displayedPromotions,
    fable_table_requests_per_day: tablePerDay,
    sizing_line_requests_per_day: sizingPerDay,
    sizing_line_requests_per_day_at_worked_example_duty_cycle: exactQuotient(
      checkedProduct(sizingFellows, activeSeconds, "sizing fellows × worked-example seconds"),
      packCadence,
      "sizing_line_requests_per_day_at_worked_example_duty_cycle",
    ),
    sizing_line_enumerated_request_classes: requireRequestClasses(
      input.sizing_line_enumerated_request_classes,
      "sizing_line_enumerated_request_classes",
    ),
    sizing_line_unenumerated_request_classes: requireRequestClasses(
      input.sizing_line_unenumerated_request_classes,
      "sizing_line_unenumerated_request_classes",
    ),
    worked_example_active_seconds_per_fellow_day: activeSeconds,
    sizing_line_active_seconds_per_fellow_day: sizingActiveSeconds,
    ...(burst === undefined
      ? {}
      : {
          declared_burst_requests_per_day: checkedProduct(
            checkedProduct(cursorPerSecond, burst.seconds_per_occurrence, "peak × burst seconds"),
            burst.occurrences_per_day,
            "peak × burst seconds × occurrences",
          ),
        }),
  };
}

function sourceDiscrepancies(workload: FableWorkloadArithmetic): readonly SourceDiscrepancy[] {
  const found: SourceDiscrepancy[] = [];
  if (workload.cursor_requests_per_second !== workload.fable_stated_cursor_requests_per_second) {
    found.push({
      code: "FABLE_CURSOR_RATE_MISMATCH",
      stated: workload.fable_stated_cursor_requests_per_second,
      computed: workload.cursor_requests_per_second,
      unit: "requests / second",
    });
  }
  // The table row is the sizing line, not the worked example. Detected by the
  // row matching the former and not the latter, rather than asserted.
  if (workload.fable_table_requests_per_day !== workload.base_load_per_day) {
    found.push({
      code: "FABLE_TABLE_SCENARIO_MISMATCH",
      table_requests_per_day: workload.fable_table_requests_per_day,
      sizing_line_requests_per_day: workload.sizing_line_requests_per_day,
      worked_example_base_load_per_day: workload.base_load_per_day,
      unit: "requests / day",
    });
  }
  // Read from the workload, never from the module default: a caller checking a
  // non-default scenario must be told about THAT scenario's duty cycles.
  if (
    workload.sizing_line_requests_per_day !==
    workload.sizing_line_requests_per_day_at_worked_example_duty_cycle
  ) {
    found.push({
      code: "FABLE_DUTY_CYCLE_MISMATCH",
      worked_example_active_seconds: workload.worked_example_active_seconds_per_fellow_day,
      sizing_line_active_seconds: workload.sizing_line_active_seconds_per_fellow_day,
      sizing_line_requests_per_day: workload.sizing_line_requests_per_day,
      sizing_line_requests_per_day_at_worked_example_duty_cycle:
        workload.sizing_line_requests_per_day_at_worked_example_duty_cycle,
      unit: "requests / day",
    });
  }
  if (workload.declared_burst_requests_per_day === undefined) {
    found.push({
      code: "FABLE_BURST_SHAPE_UNDECLARED",
      computed_peak_requests_per_second: workload.cursor_requests_per_second,
      required_operator_inputs: ["seconds_per_occurrence", "occurrences_per_day"],
    });
  }
  // Raised whenever the sizing line leaves request classes unaccounted for. It
  // does not depend on the burst shape: even a fully declared burst would not
  // make the row decomposable, so declaring one must not clear this.
  if (workload.sizing_line_unenumerated_request_classes.length > 0) {
    found.push({
      code: "FABLE_STORM_ROOM_UNRESOLVED",
      table_requests_per_day: workload.fable_table_requests_per_day,
      sizing_line_requests_per_day: workload.sizing_line_requests_per_day,
      enumerated_request_classes: workload.sizing_line_enumerated_request_classes,
      unenumerated_request_classes: workload.sizing_line_unenumerated_request_classes,
      reason:
        "The ~45M/mo row is a 1,000-Fellow sizing line that enumerates pack reads only, so subtracting it from the row does not yield storm room. No storm-room, burst-duration, or headroom figure is established until an operator supplies an internally complete scenario.",
      required_operator_inputs: ["accepted_scenario_with_complete_request_class_enumeration"],
    });
  }
  if (workload.fable_displayed_base_load_per_day !== workload.base_load_per_day) {
    found.push({
      code: "FABLE_ROUNDED_DISPLAY_BASE_LOAD_MISMATCH",
      exact_base_load_per_day: workload.base_load_per_day,
      rounded_display_sum_per_day: workload.fable_displayed_base_load_per_day,
      difference_per_day: workload.fable_displayed_base_load_per_day - workload.base_load_per_day,
      exact_components: {
        pack_reads_per_day: workload.pack_reads_per_day,
        workshop_pushes_per_day: workload.workshop_pushes_per_day,
        promotions_per_day: workload.promotions_per_day,
      },
      rounded_display_components: {
        pack_reads_per_day: workload.fable_displayed_pack_reads_per_day,
        workshop_pushes_per_day: workload.fable_displayed_workshop_pushes_per_day,
        promotions_per_day: workload.fable_displayed_promotions_per_day,
      },
      authority: "exact_components",
      unit: "requests / day",
    });
  }
  return found;
}

/** Exposed so each finding's independence can be cleared and asserted separately. */
export function costModelSourceDiscrepancies(
  workload: FableWorkloadArithmetic,
): readonly SourceDiscrepancy[] {
  return sourceDiscrepancies(workload);
}

/**
 * The billing identity, at the pure-arithmetic seam.
 *
 * A billed request is an INBOUND request to the Worker route. Cache hits and
 * misses are billed alike; only CPU is avoided on a hit, and D1 is not read at
 * all. So this deliberately ignores `handlerExecutions` and `d1RowsRead` — they
 * are accepted only to make the independence explicit and checkable, and a
 * caller that expected billing to fall with execution gets the same number.
 *
 * This is arithmetic over supplied counts, NOT a measurement: nothing here
 * observes a real edge. `billed_worker_requests` and
 * `worker_cache_hit_billing_rate` remain unknowns for exactly that reason.
 */
export function billedRequestsForInbound(
  inboundRequests: number,
  handlerExecutions: number,
  d1RowsRead: number,
): number {
  const inbound = requireNonNegativeInteger(inboundRequests, "inboundRequests");
  const executions = requireNonNegativeInteger(handlerExecutions, "handlerExecutions");
  requireNonNegativeInteger(d1RowsRead, "d1RowsRead");
  if (executions > inbound) {
    throw new CostVerifierError(
      "WORKLOAD_INPUT_INVALID",
      "A Worker cannot execute more times than it was entered.",
    );
  }
  return inbound;
}

export function receiptDigest(receiptBytes: Uint8Array): string {
  return createHash("sha256").update(receiptBytes).digest("hex");
}

function assertExpectedProvenance(
  receipt: S2CostMeasurementReceipt,
  expected: ExpectedReceiptProvenance | undefined,
): void {
  if (expected !== undefined) {
    if (
      (expected.run_id !== undefined && receipt.run_id !== expected.run_id) ||
      (expected.revision !== undefined && receipt.revision !== expected.revision) ||
      (expected.dirty_state !== undefined && receipt.dirty_state !== expected.dirty_state) ||
      (expected.source_digest !== undefined && receipt.source_digest !== expected.source_digest)
    ) {
      throw new CostVerifierError("S2_COST_RECEIPT_INVALID", "receipt provenance does not match.");
    }
  }
}

function ratio(numerator: number, denominator: number): ExactObservedRatio {
  return {
    numerator,
    denominator,
    unit: "observed rows / selected settled write receipt",
  };
}

const COST_MODEL_UNKNOWNS = [
  // The quantity the whole reconciliation turns on. A cache HIT is still a
  // billed request, so "it lands on the cheapest path" is true of CPU and D1
  // and false of the request line. Listing it is the minimum honesty: the
  // previous census had ten entries and omitted the one that is unbounded.
  "billed_worker_requests",
  "worker_cache_hit_billing_rate",
  // Confirmed for requests by pinned primary text; the CPU half of the same
  // distinction has no verified current quote, so it stays unknown rather than
  // being asserted from a transcription.
  "cpu_billing_on_cache_hit_primary_text",
  // One bead-mandated URL no longer resolves to primary text; see
  // COST_MODEL_PINNED_SOURCES.
  "mandated_source_primary_text_unverified",
  // Withheld, not zero. The ~45M/mo row enumerates one request class, so no
  // remainder computed from it is a headroom; and with no accepted burst
  // duration or frequency, no sustainable-duration figure exists either.
  "storm_room_per_day",
  "burst_duration_and_frequency",
  "monthly_request_headroom",
  "complete_write_row_totals",
  "pack_delta_and_cursor_rows",
  "worker_cpu_ms",
  "r2_operations_and_storage",
  "durable_object_alarm_cost",
  "edge_cache_hit_rate",
  "deployed_traffic",
  "provider_price",
  "route_to_receipt_mapping",
  "deployed_performance_budget_verdict",
] as const;

function unavailableResult(
  workload: FableWorkloadArithmetic,
  state: UnavailableMeasurement["state"],
  code: CostVerificationCode,
): CostVerificationResult {
  return {
    status: "blocked",
    code,
    workload,
    s2: { state, artifact_digest: null },
    source_discrepancies: sourceDiscrepancies(workload),
    assumptions: FABLE_WORKED_EXAMPLE_ASSUMPTIONS,
    unknowns: COST_MODEL_UNKNOWNS,
    pinned_sources: COST_MODEL_PINNED_SOURCES,
    pinned_sources_fully_verified: pinnedSourcesFullyVerified(),
  };
}

export function verifyCostModel(
  workloadInput: FableWorkedExampleInput = FABLE_WORKED_EXAMPLE,
  receiptBytes?: Uint8Array,
  expectedProvenance?: ExpectedReceiptProvenance,
): CostVerificationResult {
  const workload = calculateFableWorkload(workloadInput);
  if (receiptBytes === undefined) {
    return unavailableResult(workload, "unavailable", "S2_COST_MEASUREMENT_UNAVAILABLE");
  }

  let receipt: S2CostMeasurementReceipt;
  try {
    receipt = parseS2CostMeasurementReceiptBytes(receiptBytes);
    assertExpectedProvenance(receipt, expectedProvenance);
  } catch (error) {
    if (error instanceof S2CostReceiptContractError || error instanceof CostVerifierError) {
      const code =
        error.code === "S2_COST_RECEIPT_TOO_LARGE"
          ? "S2_COST_RECEIPT_TOO_LARGE"
          : "S2_COST_RECEIPT_INVALID";
      return unavailableResult(workload, "invalid", code);
    }
    throw error;
  }

  const count = receipt.write_receipt_count;
  return {
    // A local Workerd receipt is calculation evidence only. It cannot validate §15's deployed
    // p95, edge-cache, CPU, R2, DO, or price claims, so even an accepted receipt remains blocked.
    status: "blocked",
    code: "COST_MODEL_EXTERNAL_MEASUREMENTS_UNAVAILABLE",
    workload,
    s2: {
      state: "accepted-local",
      artifact_digest: receiptDigest(receiptBytes),
      receipt_provenance: {
        run_id: receipt.run_id,
        revision: receipt.revision,
        source_digest: receipt.source_digest,
        dirty_state: receipt.dirty_state,
      },
      scope: receipt.scope,
      bindings: receipt.bindings,
      metric_scope: receipt.metric_scope,
      successful_batch_metric_scope: receipt.successful_batch_metric_scope,
      failed_retry_batch_metrics: receipt.failed_retry_batch_metrics,
      write_claim_wall_scope: receipt.write_claim_wall_scope,
      write_receipt_count: count,
      measured_counters: {
        write_receipt_count: count,
        sum_successful_batch_rows_read: receipt.sum_successful_batch_rows_read,
        sum_successful_batch_rows_written: receipt.sum_successful_batch_rows_written,
        sum_preflight_rows_read: receipt.sum_preflight_rows_read,
        sum_preflight_rows_written: receipt.sum_preflight_rows_written,
        sum_preflight_statements: receipt.sum_preflight_statements,
        sum_retry_count: receipt.sum_retry_count,
      },
      known_settled_batch_rows_read: receipt.sum_successful_batch_rows_read,
      known_settled_batch_rows_written: receipt.sum_successful_batch_rows_written,
      known_preflight_rows_read: receipt.sum_preflight_rows_read,
      known_preflight_rows_written: receipt.sum_preflight_rows_written,
      observed_rows_per_selected_settled_write_receipt: {
        settled_batch_read: ratio(receipt.sum_successful_batch_rows_read, count),
        settled_batch_written: ratio(receipt.sum_successful_batch_rows_written, count),
        preflight_read: ratio(receipt.sum_preflight_rows_read, count),
        preflight_written: ratio(receipt.sum_preflight_rows_written, count),
      },
      local_p95_ms: {
        write_phase: receipt.p95_write_phase_ms,
        preflight_wall: receipt.p95_preflight_wall_ms,
        write_claim_wall: receipt.p95_write_claim_wall_ms,
      },
      known_row_total_exclusions: receipt.known_row_total_exclusions,
    },
    source_discrepancies: sourceDiscrepancies(workload),
    assumptions: FABLE_WORKED_EXAMPLE_ASSUMPTIONS,
    unknowns: COST_MODEL_UNKNOWNS,
    pinned_sources: COST_MODEL_PINNED_SOURCES,
    pinned_sources_fully_verified: pinnedSourcesFullyVerified(),
  };
}

export interface CostVerifierDiagnostic extends HarnessEvent {
  readonly cost_model: CostVerificationResult;
}

export function buildCostVerifierDiagnostic(
  result: CostVerificationResult,
  runId = "cost-model",
): CostVerifierDiagnostic {
  if (!SAFE_COMPONENT.test(runId)) {
    throw new CostVerifierError("COST_MODEL_ARGUMENT_INVALID", "run_id must be safe.");
  }
  const now = new Date().toISOString();
  const accepted = result.s2.state === "accepted-local" ? result.s2 : undefined;
  const runIdentity = receiptDigest(
    new TextEncoder().encode(
      JSON.stringify({
        runId,
        workload: result.workload,
        receipt: accepted?.artifact_digest ?? "unavailable",
      }),
    ),
  );
  const event: CostVerifierDiagnostic = {
    schema_version: HARNESS_SCHEMA_VERSION,
    record: "summary",
    run_id: runId,
    run_identity_digest: runIdentity,
    suite: "s7-cost-verifier",
    scenario: "fable-worked-example",
    step: "cost-model",
    seed: 0,
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    attempt: 1,
    retry: 0,
    replay_safe: true,
    // This direct checker does not create a retained OPS.2a artifact; a later wrapper may do so.
    storage_authority: "simulation",
    adapter: "process",
    status: "blocked",
    code: result.code,
    reproduce: "unavailable: no registered CLI scenario",
    git_revision: "unavailable",
    environment: {
      runtime: "bun",
      runtime_version: Bun.version,
      platform: process.platform,
      binding_versions:
        accepted === undefined
          ? {}
          : {
              d1: accepted.bindings.d1,
              durable_object: accepted.bindings.durable_object,
              r2: "unavailable",
            },
    },
    http_method: null,
    route_template: null,
    cursor: null,
    seq: null,
    ...(accepted === undefined ? {} : { artifact_digest: accepted.artifact_digest }),
    detail:
      "Arithmetic and local S2 subtotals are reported without a cost or deployed-performance claim.",
    cost_model: result,
  };
  validateHarnessEvent(event);
  return event;
}

export type ReceiptReader = (receiptPath: string) => Uint8Array;

/**
 * The reader owns its bounded descriptor lifecycle; this small structural
 * boundary lets its error paths be tested without a scheduler-dependent
 * regular-file race. The CLI never selects an alternate filesystem.
 */
export interface ReceiptFileSystem {
  readonly open: (receiptPath: string) => number;
  readonly fstat: (descriptor: number) => { readonly size: number; isFile(): boolean };
  readonly read: (
    descriptor: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => number;
  readonly close: (descriptor: number) => void;
}

function readReceiptBytes(
  receiptPath: string,
  fileSystem: ReceiptFileSystem,
  maximumBytes = MAX_S2_COST_RECEIPT_BYTES,
): Uint8Array {
  let descriptor: number | undefined;
  let bytes: Uint8Array | undefined;
  let failure: unknown;
  try {
    // A blocking read-only open on a FIFO waits forever before fstat can reject
    // it as non-regular. O_NONBLOCK makes every operator-supplied path reach
    // the descriptor-type check under the same bounded CLI contract.
    descriptor = fileSystem.open(receiptPath);
    const before = fileSystem.fstat(descriptor);
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0) {
      throw new CostVerifierError("S2_COST_RECEIPT_UNREADABLE", "receipt cannot be read.");
    }
    if (before.size > maximumBytes) {
      throw new CostVerifierError("S2_COST_RECEIPT_TOO_LARGE", "receipt exceeds the byte limit.");
    }

    bytes = new Uint8Array(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = fileSystem.read(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (read === 0) {
        throw new CostVerifierError("S2_COST_RECEIPT_UNREADABLE", "receipt changed while reading.");
      }
      offset += read;
    }

    const after = fileSystem.fstat(descriptor);
    if (!after.isFile() || after.size !== before.size) {
      throw new CostVerifierError("S2_COST_RECEIPT_UNREADABLE", "receipt changed while reading.");
    }
  } catch (error) {
    failure = error;
  } finally {
    if (descriptor !== undefined) {
      try {
        fileSystem.close(descriptor);
      } catch (error) {
        if (failure === undefined) failure = error;
      }
    }
  }

  if (failure !== undefined) {
    if (failure instanceof CostVerifierError) throw failure;
    throw new CostVerifierError("S2_COST_RECEIPT_UNREADABLE", "receipt cannot be read.");
  }
  if (bytes === undefined) {
    throw new CostVerifierError("S2_COST_RECEIPT_UNREADABLE", "receipt cannot be read.");
  }
  return bytes;
}

const NODE_RECEIPT_FILE_SYSTEM: ReceiptFileSystem = {
  open: (receiptPath) => {
    // lstat gives a deterministic failure for an already-present link, while
    // O_NOFOLLOW closes the final-component replacement race before fstat.
    const pathStat = lstatSync(receiptPath);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      throw new CostVerifierError("S2_COST_RECEIPT_UNREADABLE", "receipt cannot be read.");
    }
    return openSync(receiptPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  },
  fstat: (descriptor) => fstatSync(descriptor),
  read: (descriptor, buffer, offset, length, position) =>
    readSync(descriptor, buffer, offset, length, position),
  close: (descriptor) => closeSync(descriptor),
};

export function createReceiptReader(fileSystem: ReceiptFileSystem): ReceiptReader {
  return (receiptPath) => readReceiptBytes(receiptPath, fileSystem);
}

const defaultReceiptReader = createReceiptReader(NODE_RECEIPT_FILE_SYSTEM);
const defaultEvidenceReader: ReceiptReader = (receiptPath) =>
  readReceiptBytes(receiptPath, NODE_RECEIPT_FILE_SYSTEM, MAX_S2_COST_EVIDENCE_MANIFEST_BYTES);

interface CliEvidencePaths {
  readonly receipt: string;
  readonly manifest: string;
  readonly publication: string;
  readonly commit: string;
}

function parseCliArguments(argv: readonly string[]): CliEvidencePaths | undefined {
  if (argv.length === 0) return undefined;
  if (
    argv.length === 8 &&
    argv[0] === "--receipt" &&
    argv[2] === "--manifest" &&
    argv[4] === "--publication" &&
    argv[6] === "--commit" &&
    argv[1] !== undefined &&
    argv[3] !== undefined &&
    argv[5] !== undefined &&
    argv[7] !== undefined &&
    argv[1] !== "" &&
    argv[3] !== "" &&
    argv[5] !== "" &&
    argv[7] !== ""
  ) {
    return { receipt: argv[1], manifest: argv[3], publication: argv[5], commit: argv[7] };
  }
  throw new CostVerifierError("COST_MODEL_ARGUMENT_INVALID", "invalid cost-verifier arguments.");
}

function verifyEvidencePaths(paths: CliEvidencePaths): void {
  const receipt = resolve(paths.receipt);
  const root = dirname(receipt);
  if (
    basename(receipt) !== S2_COST_RECEIPT_RELATIVE_PATH ||
    resolve(paths.manifest) !== resolve(root, S2_COST_MANIFEST_RELATIVE_PATH) ||
    resolve(paths.publication) !== resolve(root, S2_COST_PUBLICATION_RELATIVE_PATH) ||
    resolve(paths.commit) !== resolve(root, S2_COST_PUBLICATION_COMMIT_RELATIVE_PATH)
  ) {
    throw new CostVerifierError("S2_COST_RECEIPT_INVALID", "receipt evidence paths are invalid.");
  }
  try {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new CostVerifierError("S2_COST_RECEIPT_INVALID", "receipt evidence root is invalid.");
    }
  } catch (error) {
    if (error instanceof CostVerifierError) throw error;
    throw new CostVerifierError("S2_COST_RECEIPT_UNREADABLE", "receipt evidence cannot be read.");
  }
}

function safeEvidenceTotal(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - total) {
      throw new CostVerifierError(
        "S2_COST_RECEIPT_INVALID",
        "receipt evidence inventory is invalid.",
      );
    }
    total += value;
  }
  return total;
}

function attestedReceiptBytes(
  paths: CliEvidencePaths,
  readReceipt: ReceiptReader,
  readEvidence: ReceiptReader,
): { readonly receipt: Uint8Array; readonly provenance: ExpectedReceiptProvenance } {
  verifyEvidencePaths(paths);
  const receipt = readReceipt(paths.receipt);
  const manifestBytes = readEvidence(paths.manifest);
  const publicationBytes = readReceipt(paths.publication);
  const commitBytes = readReceipt(paths.commit);
  const manifest = parseS2CostEvidenceManifestBytes(manifestBytes);
  const publication = parseS2CostReceiptPublicationBytes(publicationBytes);
  const commit = parseS2CostReceiptPublicationCommitBytes(commitBytes);
  const digest = receiptDigest(receipt);
  const retainedBytes = safeEvidenceTotal(manifest.files.map((file) => file.bytes));
  const retainedFilesWithReservation = safeEvidenceTotal([
    manifest.files.length,
    manifest.retention.durable_publication_reservation.retained_names.length,
  ]);
  const retainedBytesWithReservation = safeEvidenceTotal([
    retainedBytes,
    manifest.retention.durable_publication_reservation.reserved_bytes_upper_bound,
  ]);
  if (
    manifest.manifest_version !== S2_COST_EVIDENCE_MANIFEST_VERSION ||
    manifest.exit_code !== 78 ||
    manifest.retention.retained_files_before_manifest !== manifest.files.length ||
    manifest.retention.retained_bytes_before_manifest !== retainedBytes ||
    manifest.files.some((file) =>
      manifest.retention.durable_publication_reservation.retained_names.includes(
        file.path as (typeof manifest.retention.durable_publication_reservation.retained_names)[number],
      ),
    ) ||
    retainedFilesWithReservation > manifest.retention.max_files_per_run ||
    retainedBytesWithReservation > manifest.retention.max_bytes_per_run ||
    manifest.s2_cost_receipt === null ||
    manifest.s2_cost_receipt.path !== S2_COST_RECEIPT_RELATIVE_PATH ||
    manifest.s2_cost_receipt.digest !== digest ||
    manifest.s2_cost_receipt.bytes !== receipt.byteLength ||
    publication.manifest.digest !== receiptDigest(manifestBytes) ||
    publication.receipt.digest !== digest ||
    publication.receipt.bytes !== receipt.byteLength ||
    commit.manifest.digest !== receiptDigest(manifestBytes) ||
    commit.receipt.digest !== digest ||
    commit.receipt.bytes !== receipt.byteLength ||
    commit.publication.digest !== receiptDigest(publicationBytes) ||
    publication.provenance.run_id !== manifest.run_id ||
    publication.provenance.revision !== manifest.revision ||
    publication.provenance.dirty_state !== manifest.dirty_state ||
    publication.provenance.source_digest !== manifest.source_digest ||
    publication.local_phase_status.exercise !== manifest.local_phase_status.exercise ||
    publication.local_phase_status.restart_verify !== manifest.local_phase_status.restart_verify ||
    publication.local_phase_status.upgrade_existing !==
      manifest.local_phase_status.upgrade_existing ||
    publication.local_phase_status.upgrade_empty !== manifest.local_phase_status.upgrade_empty ||
    publication.local_phase_status.upgrade_journal_existing !==
      manifest.local_phase_status.upgrade_journal_existing ||
    publication.local_phase_status.upgrade_journal_empty !==
      manifest.local_phase_status.upgrade_journal_empty ||
    Object.values(manifest.local_phase_status).some((status) => status !== "pass")
  ) {
    throw new CostVerifierError(
      "S2_COST_RECEIPT_INVALID",
      "receipt evidence does not attest local phases.",
    );
  }
  return {
    receipt,
    provenance: {
      run_id: manifest.run_id,
      revision: manifest.revision,
      dirty_state: manifest.dirty_state,
      source_digest: manifest.source_digest,
    },
  };
}

function cliFailureResult(error: unknown): CostVerificationResult {
  const workload = calculateFableWorkload(FABLE_WORKED_EXAMPLE);
  if (!(error instanceof CostVerifierError)) {
    return unavailableResult(workload, "invalid", "S2_COST_RECEIPT_INVALID");
  }
  if (error.code === "COST_MODEL_ARGUMENT_INVALID") {
    return unavailableResult(workload, "invalid", "COST_MODEL_ARGUMENT_INVALID");
  }
  if (error.code === "S2_COST_MEASUREMENT_UNAVAILABLE") {
    return unavailableResult(workload, "unavailable", "S2_COST_MEASUREMENT_UNAVAILABLE");
  }
  if (error.code === "S2_COST_RECEIPT_UNREADABLE") {
    return unavailableResult(workload, "unavailable", "S2_COST_RECEIPT_UNREADABLE");
  }
  if (error.code === "S2_COST_RECEIPT_TOO_LARGE") {
    return unavailableResult(workload, "invalid", "S2_COST_RECEIPT_TOO_LARGE");
  }
  return unavailableResult(workload, "invalid", "S2_COST_RECEIPT_INVALID");
}

export function runCostVerifierCli(
  argv: readonly string[] = process.argv.slice(2),
  readReceipt: ReceiptReader = defaultReceiptReader,
  readEvidence: ReceiptReader = defaultEvidenceReader,
): CostVerifierDiagnostic {
  let result: CostVerificationResult;
  try {
    const paths = parseCliArguments(argv);
    if (paths === undefined) {
      result = verifyCostModel();
    } else {
      const attested = attestedReceiptBytes(paths, readReceipt, readEvidence);
      result = verifyCostModel(FABLE_WORKED_EXAMPLE, attested.receipt, attested.provenance);
    }
  } catch (error) {
    result = cliFailureResult(error);
  }
  return buildCostVerifierDiagnostic(result);
}

/**
 * The transport boundary between this process and whoever captures it.
 *
 * `process.stdout.write` on a pipe is buffered and may be flushed after the
 * runtime decides the event loop is empty, so a process that sets an exit code
 * and returns can die with a partial line still queued. A reader then sees
 * exit 78 next to unparseable bytes and reports a verifier defect that is
 * really a lost write.
 *
 * This awaits the stdout completion callback before returning, so the process
 * cannot exit while bytes are still queued. The callback is itself bounded: a
 * reader that never drains stdout must produce a typed write failure rather
 * than park or spin this CLI forever.
 */
export type DiagnosticLineWriter = (line: string, callback: (error?: Error | null) => void) => void;

const stdoutDiagnosticLineWriter: DiagnosticLineWriter = (line, callback) => {
  process.stdout.write(line, callback);
};

export async function writeDiagnosticLine(
  line: string,
  timeoutMs = 2_000,
  write: DiagnosticLineWriter = stdoutDiagnosticLineWriter,
): Promise<number> {
  const bytes = Buffer.byteLength(line, "utf8");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        write(line, (error) => {
          if (error === null || error === undefined) resolve();
          else reject(error);
        });
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new CostVerifierError(
                "COST_MODEL_DIAGNOSTIC_WRITE_FAILED",
                "diagnostic line did not drain within its fixed deadline.",
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return bytes;
}

if (import.meta.main) {
  const diagnostic = runCostVerifierCli();
  await writeDiagnosticLine(`${JSON.stringify(diagnostic)}\n`);
  process.exitCode = 78;
}
