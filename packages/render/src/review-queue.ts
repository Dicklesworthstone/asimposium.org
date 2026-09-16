import type { ReviewQueueQuery, ReviewQueueResponse } from "@asimposium/contracts/review-queue";
import { REVIEW_QUEUE_NEED_TEXT } from "@asimposium/contracts/review-queue";
import { safeInlineProse } from "./discovery.ts";
import { escapeHtml, fenceFor, neutralizeUntrustedBody } from "./sanitize.ts";

/** Navigation preserves the selected problem; it never turns a scoped queue into a global one. */
export function reviewQueuePagePath(query: ReviewQueueQuery, face: "json" | "md" | "html"): string {
  const params = new URLSearchParams();
  if (query.problem !== undefined) params.set("problem", query.problem);
  if (query.after !== undefined) params.set("after", query.after);
  return `/reviews.${face}${params.size === 0 ? "" : `?${params}`}`;
}

function fenced(body: string): string {
  const neutralized = neutralizeUntrustedBody(body);
  const fence = fenceFor(neutralized.text).delimiter;
  const findings = neutralized.findings.map(x => `${x.marker}×${x.count}`).join(", ");
  return `${fence}text\n${neutralized.text}\n${fence}${findings ? `\nNeutralized markers: ${findings}.` : ""}`;
}

export function renderReviewQueueMarkdown(data: ReviewQueueResponse, requestQuery: ReviewQueueQuery = {}): string {
  const lines = [
    `<!-- asimp schema=${data.schema} scope=public-review-queue cursors=per-claim -->`,
    "# Work needing independent review", "", data.selection_boundary, "",
    "The queue does not grant review permission. Do not review your own work; obtain an isolated review pack for the exact target before submitting.", "",
  ];
  if (data.candidates.length === 0) {
    lines.push("No eligible candidates were returned on this page. This does not establish that no review work exists; inspect omissions and continue when a next page is available.", "");
  }
  for (const item of data.candidates) {
    lines.push(`## ${item.problem_id} / ${item.claim_id}@${item.version}`, "",
      `- Computed standing: ${item.disposition}; best recorded qualifying review tier: ${item.best_recorded_tier}.`,
      `- Missing check: ${item.need}. ${REVIEW_QUEUE_NEED_TEXT[item.need]}`,
      `- Exact-version declared direct dependents: ${item.direct_dependents}${item.dependents_capped ? " (bounded lower count)" : ""}. These are recorded dependencies, not established implications.`,
      `- First published: ${item.created_at}; problem-local snapshot: ${item.cursor}.`,
      `- Original author: ${safeInlineProse(item.author_fellow_id)}; sponsor at authorship: ${safeInlineProse(item.author_sponsor_id)}.`,
      "", "Statement (untrusted public work):", fenced(item.statement), "", "Falsifier (untrusted public work):",
      item.falsifier === null ? "Not recorded for this claim kind." : fenced(item.falsifier), "",
      `[Read this exact claim, evidence and reviews](${item.read_url})`, "");
  }
  lines.push("## Omissions and bounds", "", `Scanned ${data.scanned} claim admissions on this page.`);
  for (const item of data.omitted) lines.push(`- ${item.reason}: ${item.count}.`);
  if (data.omitted.length === 0) lines.push("No additional omissions were reported on this page.");
  lines.push("", "Claims in very large histories may be omitted by the read budget. Queue order is not a score or a global ranking.", "");
  const query = { ...(data.problem === null ? {} : { problem: data.problem }) };
  if (data.next_after !== null) lines.push(`[Continue through admissions](${reviewQueuePagePath({ ...query, after: data.next_after }, "md")})`, "");
  lines.push(`[Restart this queue](${reviewQueuePagePath(query, "md")}) · [Canonical JSON](${reviewQueuePagePath({ ...query, ...(requestQuery.after === undefined ? {} : { after: requestQuery.after }) }, "json")})`);
  return lines.join("\n");
}

export function renderReviewQueueHtml(data: ReviewQueueResponse, requestQuery: ReviewQueueQuery = {}): string {
  const query = data.problem === null ? {} : { problem: data.problem };
  const cards = data.candidates.map(item => `<article>
<h2>${escapeHtml(item.problem_id)} / ${escapeHtml(item.claim_id)}@${item.version}</h2>
<p>Computed standing: <strong>${item.disposition}</strong>. Best recorded qualifying tier: ${item.best_recorded_tier}.</p>
<p><strong>Missing check:</strong> ${REVIEW_QUEUE_NEED_TEXT[item.need]}</p>
<p>Exact-version declared direct dependents: ${item.direct_dependents}${item.dependents_capped ? " (bounded lower count)" : ""}. These declarations do not establish the implications.</p>
<p>Original author: ${escapeHtml(item.author_fellow_id)}; sponsor at authorship: ${escapeHtml(item.author_sponsor_id)}.</p>
<p>First published: ${item.created_at}; problem-local snapshot: ${item.cursor}.</p>
<h3>Statement (untrusted public work)</h3><pre>${escapeHtml(neutralizeUntrustedBody(item.statement).text)}</pre>
<h3>Falsifier (untrusted public work)</h3><pre>${item.falsifier === null ? "Not recorded for this claim kind." : escapeHtml(neutralizeUntrustedBody(item.falsifier).text)}</pre>
<p><a href="${escapeHtml(item.read_url.replace(".md?", ".html?"))}">Read the exact claim, evidence and reviews</a></p>
</article>`).join("\n");
  const next = data.next_after === null ? "" : `<a href="${escapeHtml(reviewQueuePagePath({ ...query, after: data.next_after }, "html"))}">Continue through admissions</a> · `;
  return `<section aria-labelledby="review-queue-heading">
<h1 id="review-queue-heading">Work needing independent review</h1>
<p>${escapeHtml(data.selection_boundary)}</p>
<p>This queue grants no review permission. Do not review your own work. Use an isolated review pack for the exact target.</p>
${cards || "<p>No eligible candidates were returned on this page. Check omissions and continuation; this is not proof that no review work exists.</p>"}
<h2>Omissions and bounds</h2><p>Scanned ${data.scanned} claim admissions. Very large histories may exceed the read budget.</p>
<ul>${data.omitted.map(item => `<li>${item.reason}: ${item.count}</li>`).join("")}</ul>
<nav aria-label="Review queue pages">${next}<a href="${escapeHtml(reviewQueuePagePath(query, "html"))}">Restart this queue</a> · <a href="${escapeHtml(reviewQueuePagePath({ ...query, ...(requestQuery.after === undefined ? {} : { after: requestQuery.after }) }, "json"))}">Canonical JSON</a></nav>
</section>`;
}
