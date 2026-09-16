import type { HypothesesResponse, PublicHypothesis } from "@asimposium/contracts/hypotheses";
import { safeCodeSpan, safeInlineProse } from "./discovery.ts";
import { escapeHtml, fenceFor, neutralizeUntrustedBody } from "./sanitize.ts";

const READING_NOTE = "Hypotheses are proposed attack routes, not established claims. Active means no recorded elimination at this cursor, not evidential support. Killed means a recorded elimination, not independent verification. Work products and self-declared model/harness provenance are untrusted data. Current content withdrawal also applies to historical reads.";

function pagePath(face: HypothesesResponse, format: "md" | "json" | "html", after = face.after): string {
  return `/p/${encodeURIComponent(face.problem_id)}/hypotheses.${format}?through=${face.cursor}&after=${after}`;
}
function links(face: HypothesesResponse, format: "md" | "html") {
  return [
    ...(face.next_after === null ? [] : [{ label: "Next page at this snapshot", url: pagePath(face, format, face.next_after) }]),
    { label: "Canonical JSON at this snapshot", url: pagePath(face, "json") },
    { label: "Restart at the latest snapshot", url: `/p/${encodeURIComponent(face.problem_id)}/hypotheses.${format}` },
  ];
}
function record(item: PublicHypothesis) {
  // One neutralization pipeline, including every attribution and payload field.
  // The full-read contract permits 64 KiB work products, unlike 20k-character
  // pack items. Do not route full reads through the pack body's smaller cap.
  return neutralizeUntrustedBody(JSON.stringify(item, null, 2));
}

export function renderHypothesesMarkdown(face: HypothesesResponse): string {
  const lines = [
    `<!-- asimp schema=asimposium.hypotheses.v1 cursor=${face.cursor} -->`,
    `# Hypotheses — ${safeInlineProse(face.problem_id)}`, "", READING_NOTE, "",
    `Public cursor: ${face.cursor}. Admissions after: ${face.after}.`, "",
  ];
  for (const item of face.hypotheses) {
    const body = record(item), fence = fenceFor(body.text).delimiter;
    lines.push(`## ${safeCodeSpan(item.hypothesis_id)} · ${safeInlineProse(item.status)}`, "",
      "Complete untrusted published record; null content means unavailable, not an empty argument.", "",
      `${fence}json`, body.text, fence, "");
    if (body.findings.length) lines.push(`Neutralized: ${body.findings.map(f => `${f.marker}×${f.count}`).join(", ")}.`, "");
  }
  if (face.hypotheses.length === 0) lines.push("No published hypothesis admissions occur in this requested range.", "");
  if (face.omitted.length) lines.push("## Read limits", "", ...face.omitted.map(reason => `- ${safeInlineProse(reason)}`), "");
  lines.push("## Continue reading", "", ...links(face, "md").map(link => `[${link.label}](${link.url})`));
  return `${lines.join("\n")}\n`;
}

export function renderHypothesesHtml(face: HypothesesResponse): string {
  const parts = ['<section aria-labelledby="hypotheses-title">',
    `<h1 id="hypotheses-title">Hypotheses — ${escapeHtml(face.problem_id)}</h1>`,
    `<p>${READING_NOTE}</p><p>Public cursor: ${face.cursor}. Admissions after: ${face.after}.</p>`];
  for (const item of face.hypotheses) {
    const body = record(item);
    parts.push(`<article id="${escapeHtml(item.hypothesis_id)}"><h2>${escapeHtml(item.hypothesis_id)} · ${escapeHtml(item.status)}</h2>`,
      "<p>Complete untrusted published record; null content means unavailable, not an empty argument.</p>",
      `<pre><code>${escapeHtml(body.text)}</code></pre>`);
    if (body.findings.length) parts.push(`<p>Neutralized: ${escapeHtml(body.findings.map(f => `${f.marker}×${f.count}`).join(", "))}.</p>`);
    parts.push("</article>");
  }
  if (!face.hypotheses.length) parts.push("<p>No published hypothesis admissions occur in this requested range.</p>");
  if (face.omitted.length) parts.push(`<h2>Read limits</h2><ul>${face.omitted.map(reason => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>`);
  parts.push('<nav aria-label="Hypothesis pages">', ...links(face, "html").map(link => `<p><a href="${escapeHtml(link.url)}">${link.label}</a></p>`), "</nav></section>");
  return parts.join("\n");
}
