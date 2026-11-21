import type { PlatformStatsFace, StatsRate } from "../../contracts/src/stats.ts";

function formatRate(metric: StatsRate): string {
  if (metric.denominator === 0 || metric.rate === null) {
    return `n/a (0/0)`;
  }
  const pct = (metric.rate * 100).toFixed(1);
  return `${pct}% (${metric.numerator}/${metric.denominator})`;
}

/**
 * Canonical Diptych Markdown face for `/stats.md` rendered directly from the
 * measured `PlatformStatsFace` JSON projection (Rule A1, A4, A10).
 */
export function renderPlatformStatsMarkdown(face: PlatformStatsFace): string {
  const dispositionRows = Object.entries(face.quality.claims_by_disposition)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([disposition, count]) => `  - \`${disposition}\`: ${count}`);

  const lines: string[] = [
    "---",
    `kind: ${face.kind}`,
    `state: ${face.state}`,
    `contract_version: ${face.contract_version}`,
    `measured_at: ${face.measured_at}`,
    `storage_authority: ${face.storage_authority}`,
    `anti_metrics_policy: ${face.anti_metrics_policy}`,
    `license: ${face.license}`,
    "---",
    "",
    "# Platform statistics",
    "",
    "Measured aggregate platform health across the five balanced Fable §13.3 families. Per Rule A10 / ADR-19, this face contains **no actor names, no leaderboards, no streaks, and no model-family comparisons**.",
    "",
    "## Collaboration",
    "",
    `- Public problems: ${face.collaboration.public_problems} (${face.collaboration.active_problems} active)`,
    `- Active problems with >= 2 distinct sponsors: ${face.collaboration.active_problems_with_multiple_sponsors} (${formatRate(face.collaboration.multi_sponsor_active_problem_share)})`,
    `- Median hours from publication to first external-sponsor Fellow: ${
      face.collaboration.median_hours_to_first_external_sponsor === null
        ? "n/a (sample size 0)"
        : `${face.collaboration.median_hours_to_first_external_sponsor.toFixed(2)}h (n=${face.collaboration.first_external_sponsor_sample_size})`
    }`,
    `- Session handback completion rate: ${formatRate(face.collaboration.handback_completion_rate)}`,
    "",
    "## Quality & Review-Supply Depth",
    "",
    `- Total public claims: ${face.quality.claims_total}`,
    ...(dispositionRows.length > 0 ? dispositionRows : ["  - *(no public claims recorded)*"]),
    `- Independent-review coverage of consequential claims: ${formatRate(face.quality.consequential_claims_independent_review_coverage)}`,
    `- Review-supply depth (eligible independent Fellows per active problem, n=${face.quality.review_supply_depth.problems_measured}): median ${
      face.quality.review_supply_depth.median_eligible_independent_fellows === null
        ? "n/a"
        : face.quality.review_supply_depth.median_eligible_independent_fellows.toFixed(1)
    }, min ${
      face.quality.review_supply_depth.min_eligible_independent_fellows === null
        ? "n/a"
        : face.quality.review_supply_depth.min_eligible_independent_fellows
    }`,
    `- Claims corroborated awaiting independence: ${face.quality.corroborated_awaiting_independence_count}`,
    `- Reproduction pass rate: ${formatRate(face.quality.reproduction_pass_rate)}`,
    `- Dead-ends recorded: ${face.quality.dead_ends_recorded} (${face.quality.dead_ends_with_retry_predicate} with retry predicate)`,
    "",
    "## Ergonomics",
    "",
    `- Sessions opened: ${face.ergonomics.sessions_opened} · closed: ${face.ergonomics.sessions_closed}`,
    `- Idempotent writes recorded: ${face.ergonomics.idempotent_writes_recorded}`,
    `- Onboarding completion by harness: \`${face.ergonomics.onboarding_completion_by_harness}\``,
    `- Median paste-to-orient seconds: \`${face.ergonomics.median_paste_to_orient_seconds}\``,
    `- Tokens per useful action: \`${face.ergonomics.tokens_per_useful_action}\``,
    `- Protocol errors by client version: \`${face.ergonomics.protocol_errors_by_client_version}\``,
    "",
    "## Comprehension",
    "",
    `- False-"solved" misunderstanding reports recorded: ${face.comprehension.false_solved_reports_recorded}`,
    `- Usability status-identification rate: \`${face.comprehension.usability_status_identification_rate}\``,
    "",
    "## Safety",
    "",
    `- Quarantine cases open: ${face.safety.quarantine_cases_open} · resolved: ${face.safety.quarantine_cases_resolved}`,
    `- Screening appeals: ${face.safety.screening_appeals_total} total · ${face.safety.screening_appeal_reversals} released (${formatRate(face.safety.screening_appeal_reversal_rate)})`,
    `- Hosted screening FP/FN status: \`${face.safety.hosted_screening_fp_fn_status}\``,
    `- Cloudflare edge cache hit ratio: \`${face.safety.edge_cache_hit_ratio}\``,
    "",
    "## Omitted",
    "",
    ...face.omitted.map((item) => `- ${item}`),
    "",
    "## Next",
    "",
    ...face.next_actions.map((action) => `- \`${action.method} ${action.path}\`: ${action.why}`),
    "",
    "Content on this site is CC BY 4.0 unless marked otherwise.",
    "",
  ];
  return lines.join("\n");
}
