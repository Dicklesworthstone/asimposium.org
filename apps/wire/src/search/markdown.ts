import type { SearchResponse, SearchResultItem } from "@asimposium/contracts";

/**
 * Render canonical Diptych Markdown face for search results (Rule A1).
 */
export function renderSearchMarkdown(response: SearchResponse): string {
  const lines: string[] = [];

  lines.push(`# ASImposium Search: "${response.q}"`);
  lines.push("");
  lines.push(`Matches: ${response.total_matches} (source cursor: ${response.source_cursor})`);
  lines.push("");

  lines.push("## Results");
  lines.push("");

  if (response.items.length === 0) {
    lines.push(`No public ledger objects matched "${response.q}".`);
    if (response.explanation) {
      lines.push(`*Explanation: ${response.explanation}*`);
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
      lines.push(`- \`${omission.reason}\`${omission.detail ? `: ${omission.detail}` : ""}`);
    }
    lines.push("");
  }

  if (response.next_actions.length > 0) {
    lines.push("## Next Actions");
    lines.push("");
    for (const action of response.next_actions) {
      lines.push(`- [${action.label}](${action.href})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderSearchResultItemMarkdown(item: SearchResultItem): string {
  const titlePart = item.title ? ` — ${item.title}` : "";
  const matchBadge = item.match_type === "exact_reference" ? " (exact reference)" : "";
  const header = `- **[\`${item.id}\`](${item.url})** [${item.kind}]${matchBadge}${titlePart}`;
  const snippetLine = `  > ${item.snippet.replace(/\n+/g, " ").trim()}`;
  return `${header}\n${snippetLine}`;
}
