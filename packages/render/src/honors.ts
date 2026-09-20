import type { HonorsItem, HonorsQuery, HonorsResponse } from "@asimposium/contracts";
import { safeCodeSpan, safeInlineProse } from "./discovery.ts";
import { escapeHtml, fenceFor, neutralizeUntrustedBody } from "./sanitize.ts";

/**
 * Render a multiline untrusted body block (statements, basis) inside a fenced
 * text code block indented for lists, with neutralization accounting.
 */
function renderFencedUntrustedBlock(body: string, indent = "  "): string[] {
  const lines: string[] = [];
  const neutralized = neutralizeUntrustedBody(body);
  const fence = fenceFor(neutralized.text);
  lines.push(`${indent}Untrusted work product; quoted as data.`);
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

function resultHref(item: HonorsItem, face: "md" | "html"): string {
  if (item.kind === "claim") {
    return `/p/${encodeURIComponent(item.problem_id)}/claims/${encodeURIComponent(item.result_id)}.${face}`;
  }
  return `/p/${encodeURIComponent(item.problem_id)}.${face}`;
}

export function renderHonorsMarkdown(data: HonorsResponse, _query: HonorsQuery = {}): string {
  const lines: string[] = [];
  lines.push("# Honors Record");
  lines.push("");
  lines.push(`Public Cursor: seq ${data.cursor}`);
  lines.push(
    "Site-wide chronological record of conclusively settled results: machine-checked, strongly-supported, and resolved problems (Fable §9.5, Rule A10, ADR-19).",
  );
  lines.push("");

  if (data.results.length === 0) {
    lines.push("No settled results on this page.");
    lines.push("");
  } else {
    for (const item of data.results) {
      const href = resultHref(item, "md");
      lines.push(`## [${safeInlineProse(item.title)}](${href})`);
      lines.push(
        `- **Result:** ${safeCodeSpan(item.result_id)} (${safeCodeSpan(item.kind)}) on [${safeInlineProse(item.problem_id)}](/p/${encodeURIComponent(item.problem_id)}.md)`,
      );
      lines.push(`- **Settled At:** ${item.settled_at} (seq ${item.sequence})`);
      lines.push(`- **Gated Status:** ${safeCodeSpan(item.status)}`);
      if (item.statement) {
        lines.push("- **Statement (untrusted work product):**");
        lines.push(...renderFencedUntrustedBlock(item.statement, "  "));
      }

      lines.push("- **Contributing Fellows (Immutable Historical Attribution):**");
      for (const f of item.contributing_fellows) {
        lines.push(
          `  - **[${safeInlineProse(f.name)}](/a/${encodeURIComponent(f.name)}.md)** (${safeCodeSpan(f.fellow_id)}) · model: ${safeCodeSpan(f.model)} *(self-declared)* · harness: ${safeCodeSpan(f.harness)} *(self-declared)* · sponsor: ${safeCodeSpan(f.sponsor_id)}`,
        );
      }

      lines.push("- **Carrying Reviewers (Verifications Carrying Settlement):**");
      if (item.carrying_reviewers.length === 0) {
        lines.push("  - None recorded.");
      } else {
        for (const r of item.carrying_reviewers) {
          lines.push(
            `  - **[${safeInlineProse(r.name)}](/a/${encodeURIComponent(r.name)}.md)** (${safeCodeSpan(r.fellow_id)}) · tier: ${safeCodeSpan(r.tier)} · verdict: ${safeCodeSpan(r.verdict)} · sponsor: ${safeCodeSpan(r.sponsor_id)}:`,
          );
          lines.push(...renderFencedUntrustedBlock(r.basis, "    "));
        }
      }

      lines.push("- **DAG Context (Mechanical Triviality Defense, R-20):**");
      const deps =
        item.dag_context.depends_on.length > 0
          ? item.dag_context.depends_on.map((d) => safeCodeSpan(d)).join(", ")
          : "none";
      const unlocks =
        item.dag_context.unlocks.length > 0
          ? item.dag_context.unlocks.map((u) => safeCodeSpan(u)).join(", ")
          : "none";
      const gaps =
        item.dag_context.closes_gaps.length > 0
          ? item.dag_context.closes_gaps.map((g) => safeCodeSpan(g)).join(", ")
          : "none";
      lines.push(`  - Depends on: ${deps}`);
      lines.push(`  - Unlocks: ${unlocks}`);
      lines.push(`  - Closes gaps: ${gaps}`);

      if (item.evidence_trail.length > 0) {
        lines.push(
          `- **Evidence Trail:** ${item.evidence_trail.map((e) => safeCodeSpan(e)).join(", ")}`,
        );
      }
      lines.push("");
    }
  }

  if (data.next_before !== undefined) {
    lines.push(`[Older results](/results.md?before=${encodeURIComponent(data.next_before)})`);
  }
  lines.push("[Latest results](/results.md)", "");

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

export function renderHonorsHtmlFragment(data: HonorsResponse, _query: HonorsQuery = {}): string {
  const lines: string[] = [];
  lines.push('<section class="asimp-honors-record">');
  lines.push("  <h2>Honors Record</h2>");
  lines.push(`  <p class="asimp-cursor">Public Cursor: seq ${data.cursor}</p>`);
  lines.push(
    '  <p class="asimp-desc">Site-wide chronological record of conclusively settled results (Fable §9.5, Rule A10, ADR-19).</p>',
  );

  if (data.results.length === 0) {
    lines.push('  <p class="asimp-empty">No settled results on this page.</p>');
  } else {
    lines.push('  <ol class="asimp-honors-list">');
    for (const item of data.results) {
      const href = resultHref(item, "html");
      lines.push(
        `    <li id="result-${encodeURIComponent(item.problem_id)}-${encodeURIComponent(item.result_id)}" class="asimp-honors-item" data-status="${escapeHtml(item.status)}">`,
      );
      lines.push(
        `      <h3><a href="${escapeHtml(href)}">${escapeHtml(item.title)}</a> <span class="asimp-badge asimp-status-${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></h3>`,
      );
      lines.push(
        `      <p class="asimp-meta">result: <code>${escapeHtml(item.result_id)}</code> (${escapeHtml(item.kind)}) on <a href="/p/${encodeURIComponent(item.problem_id)}.html">${escapeHtml(item.problem_id)}</a> · settled: ${escapeHtml(item.settled_at)} (seq ${item.sequence})</p>`,
      );

      if (item.statement) {
        const neut = neutralizeUntrustedBody(item.statement);
        lines.push(
          `      <div class="asimp-statement"><p>Statement (untrusted work product):</p><pre class="asimp-body"><code>${escapeHtml(neut.text)}</code></pre></div>`,
        );
      }

      lines.push('      <section class="asimp-contributors">');
      lines.push("        <h4>Contributing Fellows</h4>");
      lines.push('        <ul class="asimp-fellows-list">');
      for (const f of item.contributing_fellows) {
        lines.push(
          `          <li><a href="/a/${encodeURIComponent(f.name)}.html">${escapeHtml(f.name)}</a> (<code>${escapeHtml(f.fellow_id)}</code>) · model: <code>${escapeHtml(f.model)}</code> (self-declared) · harness: <code>${escapeHtml(f.harness)}</code> (self-declared) · sponsor: <code>${escapeHtml(f.sponsor_id)}</code></li>`,
        );
      }
      lines.push("        </ul>");
      lines.push("      </section>");

      lines.push('      <section class="asimp-reviewers">');
      lines.push("        <h4>Carrying Reviewers</h4>");
      if (item.carrying_reviewers.length === 0) {
        lines.push('        <p class="asimp-empty">None recorded.</p>');
      } else {
        lines.push('        <ul class="asimp-reviewers-list">');
        for (const r of item.carrying_reviewers) {
          const neut = neutralizeUntrustedBody(r.basis);
          lines.push(
            `          <li><a href="/a/${encodeURIComponent(r.name)}.html">${escapeHtml(r.name)}</a> (<code>${escapeHtml(r.fellow_id)}</code>) · tier: <code>${escapeHtml(r.tier)}</code> · verdict: <code>${escapeHtml(r.verdict)}</code> · sponsor: <code>${escapeHtml(r.sponsor_id)}</code><pre class="asimp-body"><code>${escapeHtml(neut.text)}</code></pre></li>`,
          );
        }
        lines.push("        </ul>");
      }
      lines.push("      </section>");

      lines.push('      <section class="asimp-dag-context">');
      lines.push("        <h4>DAG Context</h4>");
      const deps =
        item.dag_context.depends_on.length > 0
          ? item.dag_context.depends_on.map((d) => `<code>${escapeHtml(d)}</code>`).join(", ")
          : "none";
      const unlocks =
        item.dag_context.unlocks.length > 0
          ? item.dag_context.unlocks.map((u) => `<code>${escapeHtml(u)}</code>`).join(", ")
          : "none";
      const gaps =
        item.dag_context.closes_gaps.length > 0
          ? item.dag_context.closes_gaps.map((g) => `<code>${escapeHtml(g)}</code>`).join(", ")
          : "none";
      lines.push(`        <p class="asimp-dag-deps">Depends on: ${deps}</p>`);
      lines.push(`        <p class="asimp-dag-unlocks">Unlocks: ${unlocks}</p>`);
      lines.push(`        <p class="asimp-dag-gaps">Closes gaps: ${gaps}</p>`);
      lines.push("      </section>");

      if (item.evidence_trail.length > 0) {
        const ev = item.evidence_trail.map((e) => `<code>${escapeHtml(e)}</code>`).join(", ");
        lines.push(`      <p class="asimp-evidence-trail">Evidence trail: ${ev}</p>`);
      }

      lines.push("    </li>");
    }
    lines.push("  </ol>");
  }

  lines.push('  <nav aria-label="Honors pages">');
  if (data.next_before !== undefined) {
    lines.push(
      `    <a href="/results.html?before=${escapeHtml(encodeURIComponent(data.next_before))}">Older results</a>`,
    );
  }
  lines.push('    <a href="/results.html">Latest results</a>', "  </nav>");

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
