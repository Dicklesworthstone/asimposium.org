import type { ProblemNextResponse, TriageResponse } from "@asimposium/contracts";

/**
 * Renders the markdown face for GET /v1/p/:id/next with YAML frontmatter.
 * Frontmatter carries effective_permissions, role, degraded flags.
 */
export function renderProblemNextMarkdown(response: ProblemNextResponse): string {
  const lines: string[] = [
    "---",
    `problem_id: ${response.problem_id}`,
    `role: ${response.viewer.role}`,
    "effective_permissions:",
    `  read: ${response.viewer.effective_permissions.read ?? true}`,
    `  session_open: ${response.viewer.effective_permissions.session_open ?? false}`,
    `  workshop_push: ${response.viewer.effective_permissions.workshop_push ?? false}`,
    `  promote: ${response.viewer.effective_permissions.promote ?? false}`,
    `  review: ${response.viewer.effective_permissions.review ?? false}`,
    `degraded: ${response.degraded}`,
  ];

  if (response.degraded_reason !== undefined) {
    lines.push(`degraded_reason: ${response.degraded_reason}`);
  }
  if (response.selection_boundary !== undefined) {
    lines.push(`selection_boundary: ${response.selection_boundary}`);
  }
  lines.push("---", "");

  lines.push(`# Next Recommended Moves for ${response.problem_id}`, "");

  if (response.primary_move !== null) {
    lines.push(`## Primary Move: ${response.primary_move.move}`);
    lines.push(`- **Why**: ${response.primary_move.why}`);
    lines.push(`- **Refs**: ${response.primary_move.refs.join(", ") || "none"}`);
    lines.push("", "### Pre-filled Contract", "```json");
    lines.push(JSON.stringify(response.primary_move.contract, null, 2));
    lines.push("```", "");
  } else {
    lines.push(
      response.degraded
        ? "No moves generated (moves engine is inactive)."
        : "No eligible moves available for your role and current permissions.",
      "",
    );
  }

  if (response.alternatives.length > 0) {
    lines.push("## Alternatives", "");
    for (let i = 0; i < response.alternatives.length; i++) {
      const alt = response.alternatives[i];
      if (!alt) continue;
      lines.push(`### Alternative ${i + 1}: ${alt.move}`);
      lines.push(`- **Why**: ${alt.why}`);
      lines.push(`- **Refs**: ${alt.refs.join(", ") || "none"}`);
      lines.push("", "```json");
      lines.push(JSON.stringify(alt.contract, null, 2));
      lines.push("```", "");
    }
  }

  return lines.join("\n");
}

/**
 * Renders the markdown face for GET /v1/triage with YAML frontmatter.
 */
export function renderTriageMarkdown(response: TriageResponse): string {
  const lines: string[] = [
    "---",
    `fellow_id: ${response.hello.fellow.fellow_id}`,
    `degraded: ${response.degraded}`,
  ];

  if (response.degraded_reason !== undefined) {
    lines.push(`degraded_reason: ${response.degraded_reason}`);
  }
  if (response.selection_boundary !== undefined) {
    lines.push(`selection_boundary: ${response.selection_boundary}`);
  }
  lines.push("---", "");

  lines.push(`# Triage: Single Highest-EV Move for ${response.hello.fellow.name}`, "");

  if (response.move !== null) {
    lines.push(`## Recommended Move: ${response.move.move}`);
    lines.push(`- **Why**: ${response.move.why}`);
    lines.push(`- **Refs**: ${response.move.refs.join(", ") || "none"}`);
    lines.push("", "### Pre-filled Contract", "```json");
    lines.push(JSON.stringify(response.move.contract, null, 2));
    lines.push("```", "");
  } else {
    lines.push(
      response.degraded
        ? "No triage move selected (moves engine is inactive)."
        : "No eligible move found across your problem assignments.",
      "",
    );
  }

  return lines.join("\n");
}
