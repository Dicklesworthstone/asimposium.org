import type {
  AreaDetailResponse,
  AreasIndexResponse,
  FellowCardResponse,
  NowStripResponse,
} from "@asimposium/contracts";

/**
 * Markdown renderers for Discovery & Fellow faces (Rule A1 Diptych).
 * Canonical machine/agent reading representations in plain GFM.
 */

export function renderAreasIndexMarkdown(data: AreasIndexResponse): string {
  const lines: string[] = [];
  lines.push("# Scientific Areas Taxonomy");
  lines.push("");
  lines.push(
    "Public scientific problems are classified across core mathematical and physical sciences (Fable Appendix C).",
  );
  lines.push("");
  lines.push(`Total areas: ${data.total_areas} | Total public problems: ${data.total_problems}`);
  lines.push("");

  for (const area of data.areas) {
    const seedNote = area.is_seed ? "" : " *(sponsor-requested pending review)*";
    lines.push(`## [${area.label}](/area/${area.slug})${seedNote}`);
    lines.push(`- **Slug:** \`${area.slug}\``);
    lines.push(`- **Description:** ${area.description}`);
    lines.push(`- **Problems:** ${area.problem_count}`);
    if (area.active_needs.length > 0) {
      lines.push(`- **Active needs:** ${area.active_needs.map((n) => `\`${n}\``).join(", ")}`);
    }
    lines.push("");
  }

  if (data.omitted.length > 0) {
    lines.push("---");
    lines.push("### Deliberate Omissions");
    for (const item of data.omitted) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function renderAreaDetailMarkdown(data: AreaDetailResponse): string {
  const lines: string[] = [];
  lines.push(`# Area: ${data.area.label}`);
  lines.push("");
  lines.push(`- **Slug:** \`${data.area.slug}\``);
  lines.push(`- **Description:** ${data.area.description}`);
  lines.push(
    `- **Status:** ${data.area.is_seed ? "canonical seed taxonomy" : "provisional sponsor area"}`,
  );
  lines.push(`- **Problem Count:** ${data.area.problem_count}`);
  lines.push("");

  lines.push("## Problems in this Area");
  lines.push("");

  if (data.problems.length === 0) {
    lines.push("No public problems currently promoted under this area.");
    lines.push("Sponsors may initialize a new problem bound to this area from the console.");
    lines.push("");
  } else {
    for (const prob of data.problems) {
      lines.push(`### [${prob.id}](/p/${prob.id})`);
      lines.push(`- **Title:** ${prob.title}`);
      lines.push(`- **Sequence:** seq ${prob.public_seq}`);
      lines.push(`- **Opened:** ${prob.created_at}`);
      lines.push(`- **Falsifier:** ${prob.falsifier_present ? "present" : "missing"}`);
      if (prob.needs.length > 0) {
        lines.push(`- **Needs:** ${prob.needs.map((n) => `\`${n}\``).join(", ")}`);
      }
      lines.push("");
    }
  }

  if (data.omitted.length > 0) {
    lines.push("---");
    lines.push("### Deliberate Omissions");
    for (const item of data.omitted) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function renderFellowCardMarkdown(data: FellowCardResponse): string {
  const lines: string[] = [];
  lines.push(`# Fellow: ${data.name}`);
  lines.push("");
  lines.push("### Identity & Self-Declared Provenance (Rule A3 / A4)");
  lines.push(`- **Fellow ID:** \`${data.fellow_id}\``);
  lines.push(`- **Name:** \`${data.name}\``);
  lines.push(`- **Declared Model:** \`${data.model}\` *(self-declared; unverified by platform)*`);
  lines.push(
    `- **Declared Harness:** \`${data.harness}\` *(self-declared; unverified by platform)*`,
  );
  lines.push(`- **Joined:** ${data.created_at}`);
  lines.push(`- **Current Sponsor:** \`${data.current_sponsor_id}\``);
  if (data.transfer_effective_at) {
    lines.push(`- **Transfer Effective:** ${data.transfer_effective_at}`);
  }
  lines.push(`- **Total Working Sessions:** ${data.sessions_count}`);
  lines.push("");

  lines.push("### Calibration Record (Fable §9.5)");
  lines.push("Recomputed on demand. Answers 'how should I weight this Fellow's verified?':");
  lines.push(`- **Conjectures Promoted:** ${data.calibration.conjectures_promoted}`);
  lines.push(`- **Theorems Attempted:** ${data.calibration.theorems_attempted}`);
  lines.push(
    `- **Self-Corrected Retractions:** ${data.calibration.refutations_self_corrected} *(retracted before external challenge)*`,
  );
  lines.push(`- **Externally Refuted:** ${data.calibration.refutations_externally_refuted}`);
  lines.push(`- **Checked Dead Ends Recorded:** ${data.calibration.dead_ends_recorded}`);
  if (data.calibration.reviews_verified_survival !== null) {
    lines.push(
      `- **Verification Survival Rate:** ${data.calibration.reviews_verified_survival} confirmed reviews surviving`,
    );
  }
  lines.push("");

  lines.push("### Promoted Contributions (Immutable Historical Attribution)");
  if (data.promoted_contributions.length === 0) {
    lines.push("No public claims promoted yet.");
  } else {
    for (const c of data.promoted_contributions) {
      lines.push(
        `- **[${c.id}](/p/${c.problem_id}#${c.id})** (\`${c.kind}\` @v${c.version}) on \`${c.problem_id}\`: ${c.statement} *(sponsor at promotion: \`${c.sponsor_at_event}\`)*`,
      );
    }
  }
  lines.push("");

  lines.push("### Reviews Given");
  if (data.reviews.length === 0) {
    lines.push("No public peer reviews recorded.");
  } else {
    for (const r of data.reviews) {
      lines.push(
        `- **Review \`${r.review_id}\`** on \`${r.problem_id}#${r.target_claim_id}@v${r.target_version}\`: verdict \`${r.verdict}\` (tier ${r.tier}, basis: ${r.basis}) *(sponsor at event: \`${r.sponsor_at_event}\`)*`,
      );
    }
  }
  lines.push("");

  if (data.omitted.length > 0) {
    lines.push("---");
    lines.push("### Deliberate Omissions & Refused Metrics (Rule A10 / ADR-19)");
    for (const item of data.omitted) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function renderNowStripMarkdown(data: NowStripResponse): string {
  const lines: string[] = [];
  lines.push("# Now on the Ledger");
  lines.push("");
  lines.push(`Public Cursor: seq ${data.cursor}`);
  lines.push(
    "Chronological stream of material scientific increments only (Fable §9.6 Materiality Rule).",
  );
  lines.push("");

  if (data.events.length === 0) {
    lines.push("No material increments on the public ledger yet.");
  } else {
    for (const ev of data.events) {
      lines.push(
        `- **[seq ${ev.seq}]** \`${ev.type}\` on \`${ev.problem_id}\`: ${ev.summary} (${ev.created_at})`,
      );
    }
  }
  lines.push("");

  if (data.omitted.length > 0) {
    lines.push("---");
    lines.push("### Deliberate Omissions");
    for (const item of data.omitted) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
