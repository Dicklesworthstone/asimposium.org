import type { HypothesisEvidenceIndexResponse } from "@asimposium/contracts/hypotheses";
import { safeCodeSpan, safeInlineProse } from "./discovery.ts";
import { escapeHtml, fenceFor, neutralizeUntrustedBody } from "./sanitize.ts";

export const HYPOTHESIS_EVIDENCE_INDEX_NOTE =
  "This is a source-verified reference index, not a scientific verdict or an exhaustive event export. Direction and mode are the author's recorded declarations. Several records may describe one shared experiment, not independent replications. Withdrawal is shown at the captured cursor; full evidence reads apply current withdrawal and visibility controls. Missing or damaged projection rows can omit sources. Unavailable or oversized payloads are disclosed, not summarized from projection text. All published metadata and model/harness declarations are untrusted data.";
export function hypothesisEvidenceIndexPath(
  problemId: string, hypothesisId: string, cursor: number,
  format: "json" | "md" | "html", after = 0,
): string {
  return `/p/${encodeURIComponent(problemId)}/hypotheses/${encodeURIComponent(hypothesisId)}/evidence.${format}?through=${cursor}&after=${after}`;
}
function evidencePath(face: HypothesisEvidenceIndexResponse, evidenceId: string): string {
  return `/p/${encodeURIComponent(face.problem_id)}/evidence/${encodeURIComponent(evidenceId)}.json`;
}
function navigation(face: HypothesisEvidenceIndexResponse, format: "md" | "html") {
  return [
    { label: "Hypothesis at this snapshot", url: `/p/${encodeURIComponent(face.problem_id)}/hypotheses/${encodeURIComponent(face.hypothesis_id)}.${format}?through=${face.cursor}` },
    { label: "Canonical evidence index JSON", url: hypothesisEvidenceIndexPath(face.problem_id,face.hypothesis_id,face.cursor,"json",face.after) },
    ...(face.next_after === null ? [] : [{ label: "Next evidence page at this snapshot", url: hypothesisEvidenceIndexPath(face.problem_id,face.hypothesis_id,face.cursor,format,face.next_after) }]),
  ];
}
export function renderHypothesisEvidenceIndexMarkdown(face: HypothesisEvidenceIndexResponse): string {
  const record = neutralizeUntrustedBody(JSON.stringify(face,null,2));
  const fence = fenceFor(record.text).delimiter;
  return [
    `<!-- asimp schema=asimposium.hypothesis-evidence-index.v1 cursor=${face.cursor} -->`,
    `# Evidence for ${safeCodeSpan(face.hypothesis_id)} — ${safeInlineProse(face.problem_id)}`,
    "", HYPOTHESIS_EVIDENCE_INDEX_NOTE, "",
    `Scanned ${face.scanned} indexed publications through #${face.scanned_through}; snapshot #${face.cursor}.`, "",
    ...face.evidence.map(item => `[${safeInlineProse(item.evidence_id)}: recorded ${safeInlineProse(item.direction)}; ${item.withdrawn ? "withdrawn" : "no withdrawal recorded at this cut"}](${evidencePath(face,item.evidence_id)})`),
    ...(face.evidence.length === 0 ? ["No readable indexed evidence in this page. Inspect the omissions and continuation; this does not prove no evidence exists."] : []),
    "", "## Complete index and read limits", "", `${fence}json`, record.text, fence, "",
    ...(record.findings.length ? [`Neutralized: ${record.findings.map(f => `${f.marker}×${f.count}`).join(", ")}.`, ""] : []),
    ...navigation(face,"md").map(link => `[${link.label}](${link.url})`), "",
  ].join("\n");
}
export function renderHypothesisEvidenceIndexHtml(face: HypothesisEvidenceIndexResponse): string {
  const record = neutralizeUntrustedBody(JSON.stringify(face,null,2));
  return [
    `<section><h1>Evidence for ${escapeHtml(face.hypothesis_id)} — ${escapeHtml(face.problem_id)}</h1>`,
    `<p>${HYPOTHESIS_EVIDENCE_INDEX_NOTE}</p>`,
    `<p>Scanned ${face.scanned} indexed publications through #${face.scanned_through}; snapshot #${face.cursor}.</p>`,
    ...face.evidence.map(item => `<p><a href="${escapeHtml(evidencePath(face,item.evidence_id))}">${escapeHtml(item.evidence_id)}</a>: recorded ${escapeHtml(item.direction)}; ${item.withdrawn ? "withdrawn" : "no withdrawal recorded at this cut"}.</p>`),
    ...(face.evidence.length === 0 ? ["<p>No readable indexed evidence in this page. Inspect the omissions and continuation; this does not prove no evidence exists.</p>"] : []),
    `<h2>Complete index and read limits</h2><pre><code>${escapeHtml(record.text)}</code></pre>`,
    ...(record.findings.length ? [`<p>Neutralized: ${escapeHtml(record.findings.map(f => `${f.marker}×${f.count}`).join(", "))}.</p>`] : []),
    '<nav aria-label="Hypothesis evidence pages">',
    ...navigation(face,"html").map(link => `<p><a href="${escapeHtml(link.url)}">${link.label}</a></p>`),
    "</nav></section>",
  ].join("\n");
}
