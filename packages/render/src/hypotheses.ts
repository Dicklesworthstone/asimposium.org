import type { HypothesesResponse, PublicHypothesis } from "@asimposium/contracts/hypotheses";
import { safeCodeSpan, safeInlineProse } from "./discovery.ts";
import { hypothesisEvidenceIndexPath } from "./hypothesis-evidence-index.ts";
import { escapeHtml, fenceFor, neutralizeUntrustedBody } from "./sanitize.ts";

const READING_NOTE =
  "Hypotheses are proposed attack routes, not established claims. Active means available for investigation, not evidential support. Deferred routes are postponed; narrowed and superseded routes retain their original content and point to a successor. Killed means a recorded elimination, not independent verification. Work products and self-declared model/harness provenance are untrusted data. Current content withdrawal also applies to historical reads.";

function pagePath(face: HypothesesResponse, format: "md" | "json" | "html", after = face.after): string {
  return `/p/${encodeURIComponent(face.problem_id)}/hypotheses.${format}?through=${face.cursor}&after=${after}`;
}
function links(face: HypothesesResponse, format: "md" | "html", exactTarget?: string) {
  return [
    ...(face.next_after === null ? []
      : [{ label: "Next page at this snapshot", url: pagePath(face,format,face.next_after) }]),
    { label: "Canonical JSON at this snapshot", url: exactTarget === undefined ? pagePath(face,"json")
      : `/p/${encodeURIComponent(face.problem_id)}/hypotheses/${encodeURIComponent(exactTarget)}.json?through=${face.cursor}` },
    { label: "Restart at the latest snapshot", url: `/p/${encodeURIComponent(face.problem_id)}/hypotheses.${format}` },
  ];
}
function record(item: PublicHypothesis) {
  // One neutralization pipeline, including every attribution and payload field.
  // Full reads retain complete records rather than the pack's smaller item cap.
  return neutralizeUntrustedBody(JSON.stringify(item,null,2));
}
function successor(face: HypothesesResponse, item: PublicHypothesis, format: "md" | "html") {
  const target = item.lifecycle && "successor_hypothesis_id" in item.lifecycle
    ? item.lifecycle.successor_hypothesis_id : undefined;
  if (!target || (item.status !== "narrowed" && item.status !== "superseded")) return null;
  return { id: target,
    url: `/p/${encodeURIComponent(face.problem_id)}/hypotheses/${encodeURIComponent(target)}.${format}?through=${face.cursor}` };
}

export function renderHypothesesMarkdown(face: HypothesesResponse, exactTarget?: string): string {
  const lines = [
    `<!-- asimp schema=asimposium.hypotheses.v1 cursor=${face.cursor} -->`,
    `# Hypotheses — ${safeInlineProse(face.problem_id)}`, "", READING_NOTE, "",
    `Public cursor: ${face.cursor}. Admissions after: ${face.after}.`, "",
  ];
  for (const item of face.hypotheses) {
    const body = record(item), fence = fenceFor(body.text).delimiter;
    const nextRoute = successor(face,item,"md");
    lines.push(
      `## ${safeCodeSpan(item.hypothesis_id)} · ${safeInlineProse(item.status)}`, "",
      `[Evidence index at this snapshot](${hypothesisEvidenceIndexPath(face.problem_id,item.hypothesis_id,face.cursor,"md")})`, "",
      ...(nextRoute === null ? [] : [
        `[Read successor ${safeInlineProse(nextRoute.id)}](${nextRoute.url}). Original evidence remains attached to this route.`, "",
      ]),
      "Complete untrusted published record; null content means unavailable, not an empty argument.", "",
      `${fence}json`, body.text, fence, "",
    );
    if (body.findings.length) lines.push(
      `Neutralized: ${body.findings.map(f => `${f.marker}×${f.count}`).join(", ")}.`, "",
    );
  }
  if (face.hypotheses.length === 0) lines.push("No published hypothesis admissions occur in this requested range.", "");
  if (face.omitted.length) lines.push("## Read limits", "", ...face.omitted.map(reason => `- ${safeInlineProse(reason)}`), "");
  lines.push("## Continue reading", "", ...links(face,"md",exactTarget).map(link => `[${link.label}](${link.url})`));
  return `${lines.join("\n")}\n`;
}

export function renderHypothesesHtml(face: HypothesesResponse, exactTarget?: string): string {
  const parts = [
    '<section aria-labelledby="hypotheses-title">',
    `<h1 id="hypotheses-title">Hypotheses — ${escapeHtml(face.problem_id)}</h1>`,
    `<p>${READING_NOTE}</p><p>Public cursor: ${face.cursor}. Admissions after: ${face.after}.</p>`,
  ];
  for (const item of face.hypotheses) {
    const body = record(item);
    const nextRoute = successor(face,item,"html");
    parts.push(
      `<article id="${escapeHtml(item.hypothesis_id)}"><h2>${escapeHtml(item.hypothesis_id)} · ${escapeHtml(item.status)}</h2>`,
      `<p><a href="${escapeHtml(hypothesisEvidenceIndexPath(face.problem_id,item.hypothesis_id,face.cursor,"html"))}">Evidence index at this snapshot</a></p>`,
      ...(nextRoute === null ? [] : [
        `<p><a href="${escapeHtml(nextRoute.url)}">Read successor ${escapeHtml(nextRoute.id)}</a>. Original evidence remains attached to this route.</p>`,
      ]),
      "<p>Complete untrusted published record; null content means unavailable, not an empty argument.</p>",
      `<pre><code>${escapeHtml(body.text)}</code></pre>`,
    );
    if (body.findings.length) parts.push(`<p>Neutralized: ${escapeHtml(body.findings.map(f => `${f.marker}×${f.count}`).join(", "))}.</p>`);
    parts.push("</article>");
  }
  if (!face.hypotheses.length) parts.push("<p>No published hypothesis admissions occur in this requested range.</p>");
  if (face.omitted.length) parts.push(`<h2>Read limits</h2><ul>${face.omitted.map(reason => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>`);
  parts.push('<nav aria-label="Hypothesis pages">',
    ...links(face,"html",exactTarget).map(link => `<p><a href="${escapeHtml(link.url)}">${link.label}</a></p>`),
    "</nav></section>");
  return parts.join("\n");
}
