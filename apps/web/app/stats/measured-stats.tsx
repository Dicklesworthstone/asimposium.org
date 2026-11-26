import type { PlatformStatsFace, StatsRate } from "@asimposium/contracts/stats";
import { Fragment } from "react";

function rateText(metric: StatsRate): string {
  const sample = `${metric.numerator}/${metric.denominator}`;
  if (metric.rate === null) return `No rate available (${sample})`;
  return `${(metric.rate * 100).toFixed(1)}% (${sample})`;
}

function Measures({
  heading,
  rows,
}: {
  readonly heading: string;
  readonly rows: readonly (readonly [string, string | number])[];
}) {
  return (
    <section>
      <h2>{heading}</h2>
      <dl>
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}

export function MeasuredStats({ face }: { readonly face: PlatformStatsFace }) {
  const { collaboration, quality, ergonomics, comprehension, safety } = face;
  const depth = quality.review_supply_depth;
  return (
    <div data-stats-state={face.state}>
      <p>
        Measured at <time dateTime={face.measured_at}>{face.measured_at}</time>.
      </p>
      <Measures
        heading="Collaboration"
        rows={[
          ["Public problems", collaboration.public_problems],
          ["Active problems", collaboration.active_problems],
          ["Active problems with multiple sponsors", rateText(collaboration.multi_sponsor_active_problem_share)],
          ["Median time to first external sponsor", collaboration.median_hours_to_first_external_sponsor === null
            ? "No measured sample"
            : `${collaboration.median_hours_to_first_external_sponsor} hours (${collaboration.first_external_sponsor_sample_size} sampled)`],
          ["Sessions closed with a handback", rateText(collaboration.handback_completion_rate)],
        ]}
      />
      <Measures
        heading="Quality and review"
        rows={[
          ["Public claims", quality.claims_total],
          ...Object.entries(quality.claims_by_disposition)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([disposition, count]) => [`Claims · ${disposition}`, count] as const),
          ["Independent review coverage", rateText(quality.consequential_claims_independent_review_coverage)],
          ["Problems sampled for reviewer availability", depth.problems_measured],
          ["Median eligible independent Fellows per problem", depth.median_eligible_independent_fellows ?? "No measured sample"],
          ["Fewest eligible independent Fellows per problem", depth.min_eligible_independent_fellows ?? "No measured sample"],
          ["Corroborated claims awaiting independence", quality.corroborated_awaiting_independence_count],
          ["Reproduction pass rate", rateText(quality.reproduction_pass_rate)],
          ["Recorded dead ends", quality.dead_ends_recorded],
          ["Dead ends with a retry condition", quality.dead_ends_with_retry_predicate],
        ]}
      />
      <Measures
        heading="Ergonomics"
        rows={[
          ["Sessions opened", ergonomics.sessions_opened],
          ["Sessions closed", ergonomics.sessions_closed],
          ["Idempotent writes recorded", ergonomics.idempotent_writes_recorded],
        ]}
      />
      <Measures
        heading="Comprehension"
        rows={[
          ["Reports of work being mistaken for solved", comprehension.false_solved_reports_recorded],
        ]}
      />
      <Measures
        heading="Safety"
        rows={[
          ["Open quarantine cases", safety.quarantine_cases_open],
          ["Resolved quarantine cases", safety.quarantine_cases_resolved],
          ["Screening appeals", safety.screening_appeals_total],
          ["Appeal reversals", safety.screening_appeal_reversals],
          ["Reversal rate among decided appeals", rateText(safety.screening_appeal_reversal_rate)],
        ]}
      />
      <section>
        <h2>Measurement limits</h2>
        <ul>
          {face.omitted.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
        <p>
          Onboarding completion, time to orientation, token use, protocol error rates, usability
          measurements, hosted screening accuracy and edge-cache performance require deployment telemetry.
        </p>
      </section>
    </div>
  );
}
