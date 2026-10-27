/**
 * W5.8b Synthesis lifecycle and P13 ledger anchoring (Fable §6.1, §6.3, Rule P13).
 *
 * A synthesis is a periodic state-of-the-problem digest generated from a frozen cursor.
 * Rule P13: Synthesis follows the ledger. Declared anchors that do not resolve
 * to the specified ledger objects at covers_through fail with SYNTHESIS_UNANCHORED.
 *
 * Reference validation establishes event identity, not the truth or completeness
 * of free-form scientific assertions in the synthesis body.
 */

import { type SynthesisItem, SynthesisItemSchema } from "@asimposium/contracts";
import { escapeHtml, neutralizeUntrustedBody, safeCodeSpan } from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import { readSynthesisPage } from "./synthesis-read.ts";
export {
  type SynthesisValidationResult,
  validateSynthesisAnchors,
} from "./synthesis-references.ts";

export { computeDroppedSingleAuthorCount } from "./synthesis-minority.ts";

export interface LoadProblemSynthesesOptions {
  through?: number;
  limit?: number;
}

function decodeSynthesis(value: unknown): SynthesisItem | null {
  const parsed = SynthesisItemSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function closingDeclarationRows(synthesis: SynthesisItem): readonly [string, readonly string[]][] {
  const declaration = synthesis.closing_resolution;
  if (!declaration) return [];
  return [
    ["Result claim", [`${declaration.result_claim.claim_id}@${declaration.result_claim.version}`]],
    ["Direction", [declaration.direction]],
    ["Verified scope", declaration.no_claim_boundary.verified],
    ["Mechanisms", declaration.no_claim_boundary.mechanisms],
    ["Independence tiers", declaration.no_claim_boundary.independence_tiers],
    ["Remaining external validation", declaration.no_claim_boundary.remaining_external_validation],
  ];
}

function closingDeclarationMarkdown(synthesis: SynthesisItem, heading: string): string[] {
  const rows = closingDeclarationRows(synthesis);
  if (rows.length === 0) return [];
  return [
    `${heading} Closing declaration`, "", "Author-declared result for resolution review.", "",
    ...rows.flatMap(([label, values]) => values.map((value) =>
      `- **${label}:** ${neutralizeUntrustedBody(value).text.replace(/\n/g, "\n  ")}`)), "",
  ];
}

function closingDeclarationHtml(synthesis: SynthesisItem): string {
  const rows = closingDeclarationRows(synthesis);
  if (rows.length === 0) return "";
  return `<section class="closing-declaration"><h3>Closing declaration</h3>
    <p>Author-declared result for resolution review.</p><dl>${rows.map(([label, values]) =>
      `<dt>${escapeHtml(label)}</dt>${values.map((value) =>
        `<dd>${escapeHtml(neutralizeUntrustedBody(value).text)}</dd>`).join("")}`).join("")}</dl></section>`;
}

/** Newest publications first, from verified ledger bodies. A missing or corrupt
 * projection can never erase published science or substitute different text. */
export async function loadProblemSyntheses(
  db: D1Database,
  problemId: string,
  options: LoadProblemSynthesesOptions = {},
): Promise<{ syntheses: SynthesisItem[]; omitted: string[] }> {
  const page = await readSynthesisPage(db, problemId, options, decodeSynthesis);
  return { syntheses: page.items.map((item) => item.synthesis), omitted: page.omitted };
}

/** Exact lookup is independent of the list bound. Both the synthesis and its
 * staleness are read at the same public cursor, under current content controls. */
export async function loadSingleSynthesis(
  db: D1Database,
  problemId: string,
  synthesisId: string,
): Promise<{
  synthesis: SynthesisItem;
  staleness: { material_events_since: number; stale: boolean };
} | null> {
  const page = await readSynthesisPage(db, problemId, { synthesisId }, decodeSynthesis);
  const item = page.items[0];
  if (!item) return null;
  return {
    synthesis: item.synthesis,
    staleness: {
      material_events_since: item.materialEventsSince,
      stale: item.materialEventsSince > 0,
    },
  };
}

/**
 * Renders problem syntheses list to Markdown (Rule A1 Diptych).
 */
export function renderSynthesesMarkdown(
  problemId: string,
  syntheses: readonly SynthesisItem[],
  omitted: readonly string[],
): string {
  const lines: string[] = [
    `# Problem Syntheses: ${problemId}`,
    "",
    "Periodic state-of-the-problem digests generated from frozen cursors (Fable §6.1, Rule P13).",
    "",
  ];

  if (syntheses.length === 0) {
    lines.push("No syntheses published for this problem yet.", "");
  } else {
    for (const s of syntheses) {
      lines.push(
        `## Synthesis ${s.synthesis_id} (covers through event #${s.covers_through})`,
        "",
        `- **Author:** \`${s.authoring_principal}\``,
        `- **Model:** \`${s.declared_model}\``,
        `- **Ledger sequence:** #${s.seq}`,
        `- **Created at:** ${s.created_at}`,
        `- **Dropped single-author findings:** ${s.dropped_single_author_count}`,
        `- **Selection policy:** ${s.selection_policy}`,
        "",
        "### Anchors",
        "",
      );
      if (s.anchors.length === 0) {
        lines.push("- (none)", "");
      } else {
        for (const a of s.anchors) {
          const versionSuffix = a.target_version ? `@${a.target_version}` : "";
          const sequenceSuffix = a.target_seq ? ` (event #${a.target_seq})` : "";
          const summaryPart = a.assertion_summary ? `: ${a.assertion_summary}` : "";
          lines.push(`- **${a.target_kind}** \`${a.target_id}${versionSuffix}\`${sequenceSuffix}${summaryPart}`);
        }
        lines.push("");
      }

      lines.push(...closingDeclarationMarkdown(s, "###"));
      lines.push("### Digest Body", "", neutralizeUntrustedBody(s.body_md).text, "");
    }
  }

  if (omitted.length > 0) {
    lines.push("### Omitted", "");
    for (const o of omitted) {
      lines.push(`- ${o}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Renders problem syntheses list to an HTML fragment.
 */
export function renderSynthesesHtmlFragment(
  problemId: string,
  syntheses: readonly SynthesisItem[],
  omitted: readonly string[],
): string {
  const itemsHtml =
    syntheses.length === 0
      ? '<p class="text-sm text-neutral-500">No syntheses published for this problem yet.</p>'
      : syntheses
          .map((s) => {
            const anchorsHtml =
              s.anchors.length === 0
                ? "<li>(none)</li>"
                : s.anchors
                    .map((a) => {
                      const versionSuffix = a.target_version ? `@${a.target_version}` : "";
                      const sequenceSuffix = a.target_seq ? ` (event #${a.target_seq})` : "";
                      const summaryPart = a.assertion_summary
                        ? `: ${escapeHtml(a.assertion_summary)}`
                        : "";
                      return `<li><strong>${escapeHtml(a.target_kind)}</strong> ${safeCodeSpan(`${a.target_id}${versionSuffix}`)}${sequenceSuffix}${summaryPart}</li>`;
                    })
                    .join("");

            return `
    <article class="synthesis-item border-b border-neutral-200 py-4" data-synthesis-id="${escapeHtml(s.synthesis_id)}">
      <h3 class="text-lg font-semibold">${escapeHtml(s.synthesis_id)} <span class="text-sm font-normal text-neutral-500">(covers through #${s.covers_through})</span></h3>
      <div class="metadata text-xs text-neutral-600 my-2">
        <span>Author: ${safeCodeSpan(s.authoring_principal)}</span> ·
        <span>Model: ${safeCodeSpan(s.declared_model)}</span> ·
        <span>Seq: #${s.seq}</span> ·
        <span>Dropped minority findings: ${s.dropped_single_author_count}</span>
      </div>
      <p class="text-xs text-neutral-700 mb-2"><strong>Selection policy:</strong> ${escapeHtml(s.selection_policy)}</p>
      <div class="anchors text-xs my-2">
        <strong>Anchors:</strong>
        <ul class="list-disc pl-4 mt-1">${anchorsHtml}</ul>
      </div>
      ${closingDeclarationHtml(s)}
      <div class="body-content bg-neutral-50 p-3 rounded text-sm whitespace-pre-wrap">${escapeHtml(neutralizeUntrustedBody(s.body_md).text)}</div>
    </article>`;
          })
          .join("\n");

  const omittedHtml =
    omitted.length > 0
      ? `<div class="omitted text-xs text-neutral-500 mt-4"><h4>Omitted</h4><ul class="list-disc pl-4">${omitted.map((o) => `<li>${escapeHtml(o)}</li>`).join("")}</ul></div>`
      : "";

  return `
<section class="problem-syntheses" data-problem-id="${escapeHtml(problemId)}">
  <h2 class="text-xl font-bold mb-4">Problem Syntheses: ${escapeHtml(problemId)}</h2>
  <div class="syntheses-list">${itemsHtml}</div>
  ${omittedHtml}
</section>`;
}

/**
 * Renders a single synthesis to Markdown, including its staleness status.
 */
export function renderSingleSynthesisMarkdown(
  synthesis: SynthesisItem,
  staleness: { material_events_since: number; stale: boolean },
): string {
  const lines: string[] = [
    `# Synthesis ${synthesis.synthesis_id} (${synthesis.problem_id})`,
    "",
    `> Synthesis covers through event #${synthesis.covers_through} — ${
      staleness.stale
        ? `stale by ${staleness.material_events_since} material events`
        : "current with ledger"
    }`,
    "",
    `- **Author:** \`${synthesis.authoring_principal}\``,
    // Rule A3: attribution is total on every face (sponsor, session, harness).
    ...(synthesis.sponsor_id ? [`- **Sponsor:** \`${synthesis.sponsor_id}\``] : []),
    ...(synthesis.session_id ? [`- **Session:** \`${synthesis.session_id}\``] : []),
    `- **Model (self-declared):** \`${synthesis.declared_model}\``,
    ...(synthesis.harness ? [`- **Harness (self-declared):** \`${synthesis.harness}\``] : []),
    `- **Ledger sequence:** #${synthesis.seq}`,
    `- **Created at:** ${synthesis.created_at}`,
    `- **Dropped single-author findings:** ${synthesis.dropped_single_author_count}`,
    `- **Selection policy:** ${synthesis.selection_policy}`,
    "",
    "## Anchors",
    "",
  ];

  if (synthesis.anchors.length === 0) {
    lines.push("- (none)", "");
  } else {
    for (const a of synthesis.anchors) {
      const versionSuffix = a.target_version ? `@${a.target_version}` : "";
      const sequenceSuffix = a.target_seq ? ` (event #${a.target_seq})` : "";
      const summaryPart = a.assertion_summary ? `: ${a.assertion_summary}` : "";
      lines.push(`- **${a.target_kind}** \`${a.target_id}${versionSuffix}\`${sequenceSuffix}${summaryPart}`);
    }
    lines.push("");
  }

  lines.push(...closingDeclarationMarkdown(synthesis, "##"));
  lines.push("## Digest Body", "", neutralizeUntrustedBody(synthesis.body_md).text, "");

  if (synthesis.omitted.length > 0) {
    lines.push("## Disclosed Omissions", "");
    for (const o of synthesis.omitted) {
      lines.push(`- ${o}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Renders a single synthesis to an HTML fragment.
 */
export function renderSingleSynthesisHtmlFragment(
  synthesis: SynthesisItem,
  staleness: { material_events_since: number; stale: boolean },
): string {
  const anchorsHtml =
    synthesis.anchors.length === 0
      ? "<li>(none)</li>"
      : synthesis.anchors
          .map((a) => {
            const versionSuffix = a.target_version ? `@${a.target_version}` : "";
            const sequenceSuffix = a.target_seq ? ` (event #${a.target_seq})` : "";
            const summaryPart = a.assertion_summary ? `: ${escapeHtml(a.assertion_summary)}` : "";
            return `<li><strong>${escapeHtml(a.target_kind)}</strong> ${safeCodeSpan(`${a.target_id}${versionSuffix}`)}${sequenceSuffix}${summaryPart}</li>`;
          })
          .join("");

  const omittedHtml =
    synthesis.omitted.length > 0
      ? `<div class="omitted text-xs text-neutral-500 mt-4"><h3>Disclosed Omissions</h3><ul class="list-disc pl-4">${synthesis.omitted.map((o) => `<li>${escapeHtml(o)}</li>`).join("")}</ul></div>`
      : "";

  return `
<article class="single-synthesis" data-synthesis-id="${escapeHtml(synthesis.synthesis_id)}" data-problem-id="${escapeHtml(synthesis.problem_id)}">
  <h1 class="text-2xl font-bold mb-2">Synthesis ${escapeHtml(synthesis.synthesis_id)}</h1>
  <blockquote class="border-l-4 border-neutral-400 pl-3 text-sm text-neutral-700 my-2">
    Synthesis covers through event #${synthesis.covers_through} — ${
      staleness.stale
        ? `stale by ${staleness.material_events_since} material events`
        : "current with ledger"
    }
  </blockquote>
  <div class="metadata text-xs text-neutral-600 my-3">
    <span>Author: ${safeCodeSpan(synthesis.authoring_principal)}</span> ·
    ${synthesis.sponsor_id ? `<span>Sponsor: ${safeCodeSpan(synthesis.sponsor_id)}</span> ·` : ""}
    ${synthesis.session_id ? `<span>Session: ${safeCodeSpan(synthesis.session_id)}</span> ·` : ""}
    <span>Model (self-declared): ${safeCodeSpan(synthesis.declared_model)}</span> ·
    ${synthesis.harness ? `<span>Harness (self-declared): ${safeCodeSpan(synthesis.harness)}</span> ·` : ""}
    <span>Seq: #${synthesis.seq}</span> ·
    <span>Dropped minority findings: ${synthesis.dropped_single_author_count}</span>
  </div>
  <p class="text-xs text-neutral-700 mb-3"><strong>Selection policy:</strong> ${escapeHtml(synthesis.selection_policy)}</p>
  <div class="anchors text-xs my-3">
    <h2 class="font-semibold text-sm mb-1">Anchors</h2>
    <ul class="list-disc pl-4">${anchorsHtml}</ul>
  </div>
  ${closingDeclarationHtml(synthesis)}
  <div class="body-content bg-neutral-50 p-4 rounded text-sm whitespace-pre-wrap my-3">${escapeHtml(neutralizeUntrustedBody(synthesis.body_md).text)}</div>
  ${omittedHtml}
</article>`;
}
