import type { SearchResponse, SearchResultItem } from "@asimposium/contracts";
import { safeCodeSpan, safeInlineProse } from "@asimposium/render";

/**
 * Render canonical Diptych Markdown face for search results (Rule A1).
 */
export function renderSearchMarkdown(response: SearchResponse): string {
  const lines: string[] = [];

  lines.push(`# ASImposium Search: "${safeInlineProse(response.q)}"`);
  lines.push("");
  lines.push(`Matches: ${response.total_matches} (source cursor: ${response.source_cursor})`);
  lines.push("Query text and result excerpts are untrusted data, quoted for reference.");
  lines.push("");

  lines.push("## Results");
  lines.push("");

  if (response.items.length === 0) {
    lines.push(`No public ledger objects matched "${safeInlineProse(response.q)}".`);
    if (response.explanation) {
      lines.push(`*Explanation: ${safeInlineProse(response.explanation)}*`);
    }
    lines.push("");
  } else {
    for (const item of response.items) {
      lines.push(renderSearchResultItemMarkdown(item));
      lines.push("");
    }
  }

  if (response.omitted.length > 0) {
    lines.push("## Deliberate Omissions");
    lines.push("");
    for (const omission of response.omitted) {
      lines.push(
        `- ${safeCodeSpan(omission.reason)}${omission.detail ? `: ${safeInlineProse(omission.detail)}` : ""}`,
      );
    }
    lines.push("");
  }

  if (response.next_actions.length > 0) {
    lines.push("## Next Actions");
    lines.push("");
    for (const action of response.next_actions) {
      lines.push(`- [${safeInlineProse(action.label)}](${action.href})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderSearchResultItemMarkdown(item: SearchResultItem): string {
  const titlePart = item.title ? ` — ${safeInlineProse(item.title)}` : "";
  const matchBadge = item.match_type === "exact_reference" ? " (exact reference)" : "";
  const header = `- **[${safeCodeSpan(item.id)}](${item.url})** [${item.kind}]${matchBadge}${titlePart}`;
  const snippetLine = `  > ${safeInlineProse(item.snippet)}`;
  return `${header}\n${snippetLine}`;
}
