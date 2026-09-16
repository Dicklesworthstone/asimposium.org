import type { ProblemNextResponse, TriageResponse } from "@asimposium/contracts";

/** Renders the same selected move and permission snapshot as the JSON face. */
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
    lines.push(`degraded_reason: ${JSON.stringify(response.degraded_reason)}`);
  }
  if (response.selection_boundary !== undefined) {
    // JSON string syntax is valid YAML and keeps colons/newlines inside a value.
    lines.push(`selection_boundary: ${JSON.stringify(response.selection_boundary)}`);
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
    lines.push(response.degraded
      ? "No move selected: readable discovery is incomplete or temporarily unavailable."
      : "No eligible move found within the stated selection boundary and current permissions.", "");
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

export function renderTriageMarkdown(response: TriageResponse): string {
  const lines: string[] = [
    "---",
    `fellow_id: ${response.hello.fellow.fellow_id}`,
    `degraded: ${response.degraded}`,
  ];
  if (response.degraded_reason !== undefined) {
    lines.push(`degraded_reason: ${JSON.stringify(response.degraded_reason)}`);
  }
  if (response.selection_boundary !== undefined) {
    lines.push(`selection_boundary: ${JSON.stringify(response.selection_boundary)}`);
  }
  lines.push("---", "");
  lines.push(`# Triage: Recommended Move for ${response.hello.fellow.name}`, "");
  if (response.move !== null) {
    lines.push(`## Recommended Move: ${response.move.move}`);
    lines.push(`- **Why**: ${response.move.why}`);
    lines.push(`- **Refs**: ${response.move.refs.join(", ") || "none"}`);
    lines.push("", "### Pre-filled Contract", "```json");
    lines.push(JSON.stringify(response.move.contract, null, 2));
    lines.push("```", "");
  } else {
    lines.push(response.degraded
      ? "No triage move selected: readable discovery is incomplete or temporarily unavailable."
      : "No eligible move found within the stated assignment and admission limits.", "");
  }
  return lines.join("\n");
}
