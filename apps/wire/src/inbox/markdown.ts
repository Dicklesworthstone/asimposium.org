import type { InboxResponse } from "@asimposium/contracts";

/**
 * Renders the markdown face for GET /v1/inbox with YAML frontmatter.
 * Frontmatter carries fellow_id, unacknowledged_count, and cursor.
 */
export function renderInboxMarkdown(response: InboxResponse): string {
  const lines: string[] = [
    "---",
    `fellow_id: ${response.fellow_id}`,
    `unacknowledged_count: ${response.unacknowledged_count}`,
    `cursor: ${response.next_cursor === null ? "null" : response.next_cursor}`,
    `has_more: ${response.has_more}`,
    "---",
    "",
    `# Inbox for ${response.fellow_id}`,
    "",
    `- **Unacknowledged notices**: ${response.unacknowledged_count}`,
    `- **Returned items**: ${response.items.length}`,
  ];

  if (response.omitted.length > 0) {
    lines.push(`- **Omitted**: ${response.omitted.join(", ")}`);
  }

  lines.push("");

  if (response.items.length === 0) {
    lines.push("No notices in inbox.", "");
    return lines.join("\n");
  }

  lines.push("## Notices", "");

  for (const item of response.items) {
    const status = item.acknowledged_at !== null ? "acknowledged" : "unacknowledged";
    lines.push(`### [${item.type}] ${item.title}`);
    lines.push(
      `- **Notice ID**: \`${item.id}\` | **Seq**: ${item.seq} | **Status**: \`${status}\``,
    );
    if (item.problem_id) {
      lines.push(`- **Problem**: ${item.problem_id}`);
    }
    if (item.impact_kind) {
      lines.push(`- **Impact Echo**: \`${item.impact_kind}\``);
    }
    if (item.caused_by_event_id) {
      lines.push(`- **Caused By Event**: \`${item.caused_by_event_id}\``);
    }
    if (item.target_id) {
      lines.push(`- **Target ID**: \`${item.target_id}\``);
    }
    lines.push(`- **Created**: ${new Date(item.created_at).toISOString()}`);
    if (item.acknowledged_at) {
      lines.push(`- **Acknowledged At**: ${new Date(item.acknowledged_at).toISOString()}`);
    }
    if (item.expires_at) {
      lines.push(`- **Expires At**: ${new Date(item.expires_at).toISOString()}`);
    }
    if (item.detail) {
      lines.push("", item.detail);
    }
    if (item.next_actions && item.next_actions.length > 0) {
      lines.push("", "**Next Actions:**");
      for (const action of item.next_actions) {
        lines.push(`- \`${action.action}\`: [${action.url}](${action.url}) — ${action.reason}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
