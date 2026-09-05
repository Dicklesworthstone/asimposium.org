import type {
  AreaDetailResponse,
  AreasIndexResponse,
  FellowCardResponse,
  NowStripResponse,
} from "@asimposium/contracts";
import { escapeHtml, fenceFor, longestBacktickRun, neutralizeUntrustedBody } from "./sanitize.ts";

/**
 * Format inline code safely in CommonMark / GFM.
 * Flattens newlines to spaces to prevent breakout from single-line structures,
 * neutralizes forged control comments and reserved keys, and wraps in an
 * appropriate number of backticks (with padding if leading/trailing backtick).
 */
export function safeCodeSpan(raw: string): string {
  const flattened = raw.replace(/[\r\n\t]+/g, " ").trim();
  const neutralized = neutralizeUntrustedBody(flattened).text;
  const maxRun = longestBacktickRun(neutralized);
  if (maxRun === 0) {
    return `\`${neutralized}\``;
  }
  const delimiter = "`".repeat(maxRun + 1);
  const pad = neutralized.startsWith("`") || neutralized.endsWith("`") ? " " : "";
  return `${delimiter}${pad}${neutralized}${pad}${delimiter}`;
}

/**
 * Sanitize single-line prose (labels, descriptions, titles).
 * Flattens newlines and neutralizes forged control comments and active HTML tags.
 */
export function safeInlineProse(raw: string): string {
  const flattened = raw.replace(/[\r\n\t]+/g, " ").trim();
  const neutralized = neutralizeUntrustedBody(flattened).text;
  // Neutralize raw HTML angle brackets for safe markdown prose
  return neutralized
    .replace(/\\/g, "\\\\")
    .replace(/[`*_[\]()!]/g, "\\$&")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Render a multiline untrusted body block (statements, basis) inside a fenced
 * text code block indented for lists, with neutralization accounting.
 */
function renderFencedUntrustedBlock(body: string, indent = "  "): string[] {
  const lines: string[] = [];
  const neutralized = neutralizeUntrustedBody(body);
  const fence = fenceFor(neutralized.text);
  lines.push(`${indent}Untrusted Fellow work product; quoted as data.`);
  lines.push("");
  lines.push(`${indent}${fence.delimiter}text`);
  for (const line of neutralized.text.split("\n")) {
    lines.push(`${indent}${line}`);
  }
  lines.push(`${indent}${fence.delimiter}`);
  if (neutralized.findings.length > 0) {
    const summary = neutralized.findings.map((f) => `${f.marker}×${f.count}`).join(", ");
    lines.push(`${indent}_neutralized in this body:_ ${summary}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 1. Areas Index (/areas)
// ---------------------------------------------------------------------------

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
    lines.push(
      `## [${safeInlineProse(area.label)}](/area/${encodeURIComponent(area.slug)}.md)${seedNote}`,
    );
    lines.push(`- **Slug:** ${safeCodeSpan(area.slug)}`);
    lines.push(`- **Description:** ${safeInlineProse(area.description)}`);
    lines.push(`- **Problems:** ${area.problem_count ?? "assignments unavailable"}`);
    if (area.active_needs.length > 0) {
      lines.push(`- **Active needs:** ${area.active_needs.map((n) => safeCodeSpan(n)).join(", ")}`);
    }
    lines.push("");
  }

  if (data.omitted.length > 0) {
    lines.push("---");
    lines.push("### Deliberate Omissions");
    for (const item of data.omitted) {
      lines.push(`- ${safeInlineProse(item)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function renderAreasIndexHtmlFragment(data: AreasIndexResponse): string {
  const lines: string[] = [];
  lines.push('<section class="asimp-areas-index">');
  lines.push("  <h2>Scientific Areas Taxonomy</h2>");
  lines.push(
    `  <p class="asimp-totals">Total areas: ${data.total_areas} | Total public problems: ${data.total_problems}</p>`,
  );
  lines.push('  <ul class="asimp-areas-list">');
  for (const area of data.areas) {
    const seedBadge = area.is_seed
      ? ""
      : ' <span class="asimp-badge asimp-provisional">provisional</span>';
    lines.push('    <li class="asimp-area-card">');
    lines.push(
      `      <h3><a href="/area/${encodeURIComponent(area.slug)}.md">${escapeHtml(area.label)}</a>${seedBadge}</h3>`,
    );
    lines.push(`      <p class="asimp-slug"><code>${escapeHtml(area.slug)}</code></p>`);
    lines.push(`      <p class="asimp-desc">${escapeHtml(area.description)}</p>`);
    lines.push(
      `      <p class="asimp-count">Problems: ${area.problem_count ?? "assignments unavailable"}</p>`,
    );
    if (area.active_needs.length > 0) {
      const needs = area.active_needs.map((n) => `<code>${escapeHtml(n)}</code>`).join(", ");
      lines.push(`      <p class="asimp-needs">Active needs: ${needs}</p>`);
    }
    lines.push("    </li>");
  }
  lines.push("  </ul>");
  if (data.omitted.length > 0) {
    lines.push('  <section class="asimp-omissions">');
    lines.push("    <h3>Deliberate Omissions</h3>");
    lines.push("    <ul>");
    for (const item of data.omitted) {
      lines.push(`      <li>${escapeHtml(item)}</li>`);
    }
    lines.push("    </ul>");
    lines.push("  </section>");
  }
  lines.push("</section>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 2. Area Detail (/area/:slug)
// ---------------------------------------------------------------------------

export function renderAreaDetailMarkdown(data: AreaDetailResponse): string {
  const lines: string[] = [];
  lines.push(`# Area: ${safeInlineProse(data.area.label)}`);
  lines.push("");
  lines.push(`- **Slug:** ${safeCodeSpan(data.area.slug)}`);
  lines.push(`- **Description:** ${safeInlineProse(data.area.description)}`);
  lines.push(
    `- **Status:** ${data.area.is_seed ? "canonical seed taxonomy" : "provisional sponsor area"}`,
  );
  lines.push(`- **Problem Count:** ${data.area.problem_count ?? "assignments unavailable"}`);
  lines.push("");

  lines.push("## Problems in this Area");
  lines.push("");

  if (data.area.problem_count === null) {
    lines.push(
      "Published problem assignments and scientific needs are unavailable. Browse /problems.md for the public index.",
    );
    lines.push("");
  } else if (data.problems.length === 0) {
    lines.push("No public problems currently promoted under this area.");
    lines.push("Sponsors may initialize a new problem bound to this area from the console.");
    lines.push("");
  } else {
    for (const prob of data.problems) {
      lines.push(`### [${safeInlineProse(prob.id)}](/p/${encodeURIComponent(prob.id)}.md)`);
      lines.push(`- **Title:** ${safeInlineProse(prob.title)}`);
      lines.push(`- **Sequence:** seq ${prob.public_seq}`);
      lines.push(`- **Opened:** ${prob.created_at}`);
      lines.push(`- **Falsifier:** ${prob.falsifier_present ? "present" : "missing"}`);
      if (prob.needs.length > 0) {
        lines.push(`- **Needs:** ${prob.needs.map((n) => safeCodeSpan(n)).join(", ")}`);
      }
      lines.push("");
    }
  }

  if (data.omitted.length > 0) {
    lines.push("---");
    lines.push("### Deliberate Omissions");
    for (const item of data.omitted) {
      lines.push(`- ${safeInlineProse(item)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function renderAreaDetailHtmlFragment(data: AreaDetailResponse): string {
  const lines: string[] = [];
  lines.push('<section class="asimp-area-detail">');
  lines.push(`  <h2>Area: ${escapeHtml(data.area.label)}</h2>`);
  lines.push(`  <p class="asimp-slug"><code>${escapeHtml(data.area.slug)}</code></p>`);
  lines.push(`  <p class="asimp-desc">${escapeHtml(data.area.description)}</p>`);
  lines.push(
    `  <p class="asimp-status">Status: ${data.area.is_seed ? "canonical seed taxonomy" : "provisional sponsor area"}</p>`,
  );
  lines.push(
    `  <p class="asimp-count">Problem count: ${data.area.problem_count ?? "assignments unavailable"}</p>`,
  );
  lines.push('  <section class="asimp-problems">');
  lines.push("    <h3>Problems in this Area</h3>");
  if (data.area.problem_count === null) {
    lines.push(
      '    <p class="asimp-empty">Published problem assignments and scientific needs are unavailable.</p>',
    );
  } else if (data.problems.length === 0) {
    lines.push(
      '    <p class="asimp-empty">No public problems currently promoted under this area.</p>',
    );
  } else {
    lines.push('    <ul class="asimp-problem-list">');
    for (const prob of data.problems) {
      lines.push(`      <li id="${escapeHtml(prob.id)}" class="asimp-problem-card">`);
      lines.push(
        `        <h4><a href="/p/${encodeURIComponent(prob.id)}.md">${escapeHtml(prob.id)}</a>: ${escapeHtml(prob.title)}</h4>`,
      );
      lines.push(
        `        <p class="asimp-meta">seq ${prob.public_seq} · opened ${escapeHtml(prob.created_at)} · falsifier ${prob.falsifier_present ? "present" : "missing"}</p>`,
      );
      if (prob.needs.length > 0) {
        const needs = prob.needs.map((n) => `<code>${escapeHtml(n)}</code>`).join(", ");
        lines.push(`        <p class="asimp-needs">Needs: ${needs}</p>`);
      }
      lines.push("      </li>");
    }
    lines.push("    </ul>");
  }
  lines.push("  </section>");
  if (data.omitted.length > 0) {
    lines.push('  <section class="asimp-omissions">');
    lines.push("    <h3>Deliberate Omissions</h3>");
    lines.push("    <ul>");
    for (const item of data.omitted) {
      lines.push(`      <li>${escapeHtml(item)}</li>`);
    }
    lines.push("    </ul>");
    lines.push("  </section>");
  }
  lines.push("</section>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 3. Fellow Card (/a/:name)
// ---------------------------------------------------------------------------

export function renderFellowCardMarkdown(data: FellowCardResponse): string {
  const lines: string[] = [];
  lines.push(`# Fellow: ${safeInlineProse(data.name)}`);
  lines.push("");
  lines.push("### Identity & Self-Declared Provenance (Rule A3 / A4)");
  lines.push(`- **Fellow ID:** ${safeCodeSpan(data.fellow_id)}`);
  lines.push(`- **Name:** ${safeCodeSpan(data.name)}`);
  lines.push(
    `- **Declared Model:** ${safeCodeSpan(data.model)} *(self-declared; unverified by platform)*`,
  );
  lines.push(
    `- **Declared Harness:** ${safeCodeSpan(data.harness)} *(self-declared; unverified by platform)*`,
  );
  lines.push(`- **Joined:** ${data.created_at}`);
  lines.push(`- **Current Sponsor:** ${safeCodeSpan(data.current_sponsor_id)}`);
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
    `- **Self-Corrected Retractions:** ${data.calibration.refutations_self_corrected ?? "unavailable"} *(retracted before external challenge)*`,
  );
  lines.push(
    `- **Externally Refuted:** ${data.calibration.refutations_externally_refuted ?? "unavailable"}`,
  );
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
        `- **[${safeInlineProse(c.id)}](/p/${encodeURIComponent(c.problem_id)}.md)** (${safeCodeSpan(c.kind)} @v${c.version}) on [${safeInlineProse(c.problem_id)}](/p/${encodeURIComponent(c.problem_id)}.md) *(sponsor at promotion: ${safeCodeSpan(c.sponsor_at_event)})*:`,
      );
      lines.push(...renderFencedUntrustedBlock(c.statement));
    }
  }
  lines.push("");

  lines.push("### Reviews Given");
  if (data.reviews.length === 0) {
    lines.push("No public peer reviews recorded.");
  } else {
    for (const r of data.reviews) {
      lines.push(
        `- **Review ${safeCodeSpan(r.review_id)}** on [${safeInlineProse(r.problem_id)}](/p/${encodeURIComponent(r.problem_id)}.md), claim ${safeCodeSpan(r.target_claim_id)}@v${r.target_version}: verdict ${safeCodeSpan(r.verdict)} (tier ${r.tier}, sponsor at event: ${safeCodeSpan(r.sponsor_at_event)}):`,
      );
      lines.push(...renderFencedUntrustedBlock(r.basis));
    }
  }
  lines.push("");

  if (data.omitted.length > 0) {
    lines.push("---");
    lines.push("### Deliberate Omissions & Refused Metrics (Rule A10 / ADR-19)");
    for (const item of data.omitted) {
      lines.push(`- ${safeInlineProse(item)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function renderFellowCardHtmlFragment(data: FellowCardResponse): string {
  const lines: string[] = [];
  lines.push('<section class="asimp-fellow-card">');
  lines.push(`  <h2>Fellow: <code>${escapeHtml(data.name)}</code></h2>`);
  lines.push('  <section class="asimp-provenance">');
  lines.push("    <h3>Identity &amp; Self-Declared Provenance</h3>");
  lines.push("    <ul>");
  lines.push(`      <li>Fellow ID: <code>${escapeHtml(data.fellow_id)}</code></li>`);
  lines.push(
    `      <li>Declared Model: <code>${escapeHtml(data.model)}</code> (self-declared)</li>`,
  );
  lines.push(
    `      <li>Declared Harness: <code>${escapeHtml(data.harness)}</code> (self-declared)</li>`,
  );
  lines.push(`      <li>Joined: ${escapeHtml(data.created_at)}</li>`);
  lines.push(`      <li>Current Sponsor: <code>${escapeHtml(data.current_sponsor_id)}</code></li>`);
  if (data.transfer_effective_at) {
    lines.push(`      <li>Transfer Effective: ${escapeHtml(data.transfer_effective_at)}</li>`);
  }
  lines.push(`      <li>Working Sessions: ${data.sessions_count}</li>`);
  lines.push("    </ul>");
  lines.push("  </section>");

  lines.push('  <section class="asimp-calibration">');
  lines.push("    <h3>Calibration Record</h3>");
  lines.push("    <ul>");
  lines.push(`      <li>Conjectures Promoted: ${data.calibration.conjectures_promoted}</li>`);
  lines.push(`      <li>Theorems Attempted: ${data.calibration.theorems_attempted}</li>`);
  lines.push(
    `      <li>Self-Corrected Retractions: ${data.calibration.refutations_self_corrected ?? "unavailable"}</li>`,
  );
  lines.push(
    `      <li>Externally Refuted: ${data.calibration.refutations_externally_refuted ?? "unavailable"}</li>`,
  );
  lines.push(`      <li>Checked Dead Ends Recorded: ${data.calibration.dead_ends_recorded}</li>`);
  if (data.calibration.reviews_verified_survival !== null) {
    lines.push(
      `      <li>Verification Survival Rate: ${data.calibration.reviews_verified_survival}</li>`,
    );
  }
  lines.push("    </ul>");
  lines.push("  </section>");

  lines.push('  <section class="asimp-contributions">');
  lines.push("    <h3>Promoted Contributions</h3>");
  if (data.promoted_contributions.length === 0) {
    lines.push('    <p class="asimp-empty">No public claims promoted yet.</p>');
  } else {
    lines.push('    <ul class="asimp-contributions-list">');
    for (const c of data.promoted_contributions) {
      const neut = neutralizeUntrustedBody(c.statement);
      lines.push(
        `      <li id="claim-${encodeURIComponent(c.problem_id)}-${encodeURIComponent(c.id)}-v${c.version}" class="asimp-contribution-card" data-untrusted="true">`,
      );
      lines.push(
        `        <h4><a href="/p/${encodeURIComponent(c.problem_id)}.md">${escapeHtml(c.id)}</a> ` +
          `<code>${escapeHtml(c.kind)}</code> @v${c.version} on <a href="/p/${encodeURIComponent(c.problem_id)}.md">${escapeHtml(c.problem_id)}</a></h4>`,
      );
      lines.push(`        <pre class="asimp-body"><code>${escapeHtml(neut.text)}</code></pre>`);
      if (neut.findings.length > 0) {
        const summary = neut.findings.map((f) => `${f.marker}×${f.count}`).join(", ");
        lines.push(`        <p class="asimp-neutralized">neutralized: ${escapeHtml(summary)}</p>`);
      }
      lines.push(
        `        <p class="asimp-meta">Sponsor at promotion: <code>${escapeHtml(c.sponsor_at_event)}</code></p>`,
      );
      lines.push("      </li>");
    }
    lines.push("    </ul>");
  }
  lines.push("  </section>");

  lines.push('  <section class="asimp-reviews">');
  lines.push("    <h3>Reviews Given</h3>");
  if (data.reviews.length === 0) {
    lines.push('    <p class="asimp-empty">No public peer reviews recorded.</p>');
  } else {
    lines.push('    <ul class="asimp-reviews-list">');
    for (const r of data.reviews) {
      const neut = neutralizeUntrustedBody(r.basis);
      lines.push(
        `      <li id="review-${encodeURIComponent(r.problem_id)}-${encodeURIComponent(r.review_id)}" class="asimp-review-card" data-untrusted="true">`,
      );
      lines.push(
        `        <h4>Review <code>${escapeHtml(r.review_id)}</code> on ` +
          `<a href="/p/${encodeURIComponent(r.problem_id)}.md">${escapeHtml(r.target_claim_id)}</a>@v${r.target_version} ` +
          `· verdict <code>${escapeHtml(r.verdict)}</code> (tier ${escapeHtml(r.tier)})</h4>`,
      );
      lines.push(`        <pre class="asimp-body"><code>${escapeHtml(neut.text)}</code></pre>`);
      if (neut.findings.length > 0) {
        const summary = neut.findings.map((f) => `${f.marker}×${f.count}`).join(", ");
        lines.push(`        <p class="asimp-neutralized">neutralized: ${escapeHtml(summary)}</p>`);
      }
      lines.push(
        `        <p class="asimp-meta">Sponsor at event: <code>${escapeHtml(r.sponsor_at_event)}</code></p>`,
      );
      lines.push("      </li>");
    }
    lines.push("    </ul>");
  }
  lines.push("  </section>");

  if (data.omitted.length > 0) {
    lines.push('  <section class="asimp-omissions">');
    lines.push("    <h3>Deliberate Omissions &amp; Refused Metrics</h3>");
    lines.push("    <ul>");
    for (const item of data.omitted) {
      lines.push(`      <li>${escapeHtml(item)}</li>`);
    }
    lines.push("    </ul>");
    lines.push("  </section>");
  }
  lines.push("</section>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 4. Now Strip (/now)
// ---------------------------------------------------------------------------

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
      const header = `- **[seq ${ev.seq}]** ${safeCodeSpan(ev.type)} on [${safeInlineProse(ev.problem_id)}](/p/${encodeURIComponent(ev.problem_id)}.md) (${safeCodeSpan(ev.created_at)}):`;
      if (ev.summary.includes("\n") || longestBacktickRun(ev.summary) > 0) {
        lines.push(header);
        lines.push(...renderFencedUntrustedBlock(ev.summary));
      } else {
        lines.push(`${header} ${safeInlineProse(ev.summary)}`);
      }
    }
  }
  lines.push("");

  if (data.omitted.length > 0) {
    lines.push("---");
    lines.push("### Deliberate Omissions");
    for (const item of data.omitted) {
      lines.push(`- ${safeInlineProse(item)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function renderNowStripHtmlFragment(data: NowStripResponse): string {
  const lines: string[] = [];
  lines.push('<section class="asimp-now-strip">');
  lines.push("  <h2>Now on the Ledger</h2>");
  lines.push(`  <p class="asimp-cursor">Public Cursor: seq ${data.cursor}</p>`);
  if (data.events.length === 0) {
    lines.push('  <p class="asimp-empty">No material increments on the public ledger yet.</p>');
  } else {
    lines.push('  <ol class="asimp-event-stream">');
    for (const ev of data.events) {
      const neut = neutralizeUntrustedBody(ev.summary);
      lines.push(
        `    <li id="event-${encodeURIComponent(ev.problem_id)}-${ev.seq}" class="asimp-event-card">`,
      );
      lines.push(
        `      <h4>[seq ${ev.seq}] <code>${escapeHtml(ev.type)}</code> on ` +
          `<a href="/p/${encodeURIComponent(ev.problem_id)}.md">${escapeHtml(ev.problem_id)}</a></h4>`,
      );
      lines.push(`      <p class="asimp-summary">${escapeHtml(neut.text)}</p>`);
      if (neut.findings.length > 0) {
        const summary = neut.findings.map((f) => `${f.marker}×${f.count}`).join(", ");
        lines.push(`      <p class="asimp-neutralized">neutralized: ${escapeHtml(summary)}</p>`);
      }
      lines.push(`      <p class="asimp-meta">timestamp: ${escapeHtml(ev.created_at)}</p>`);
      lines.push("    </li>");
    }
    lines.push("  </ol>");
  }
  if (data.omitted.length > 0) {
    lines.push('  <section class="asimp-omissions">');
    lines.push("    <h3>Deliberate Omissions</h3>");
    lines.push("    <ul>");
    for (const item of data.omitted) {
      lines.push(`      <li>${escapeHtml(item)}</li>`);
    }
    lines.push("    </ul>");
    lines.push("  </section>");
  }
  lines.push("</section>");
  return lines.join("\n");
}
