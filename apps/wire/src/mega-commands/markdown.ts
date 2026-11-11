import type { ProblemNextResponse, TriageResponse } from "@asimposium/contracts";

/** Renders the same selected move and permission snapshot as the JSON face. */
export function renderProblemNextMarkdown(response: ProblemNextResponse): string {
  const viewer = response.viewer;
  const lines: string[] = [
    "---",
    `problem_id: ${response.problem_id}`,
    `role: ${viewer.role}`,
    "effective_permissions:",
    ...Object.entries(viewer.effective_permissions).map(
      ([permission, allowed]) =>
        `  ${/^[a-z][a-z0-9_]*$/.test(permission) ? permission : JSON.stringify(permission)}: ${allowed}`,
    ),
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
    lines.push(
      response.degraded
        ? "No move selected: readable discovery is incomplete or temporarily unavailable."
        : "No eligible move found within the stated selection boundary and current permissions.",
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
  if (
    response.hello.read_budget !== undefined ||
    response.hello.workshop_budget !== undefined ||
    response.hello.promotion_budget !== undefined ||
    response.hello.problem_creation_budget !== undefined
  ) {
    lines.push("## Read and write budgets", "", "```json");
    lines.push(
      JSON.stringify(
        {
          ...(response.hello.read_budget === undefined
            ? {}
            : { read_budget: response.hello.read_budget }),
          ...(response.hello.workshop_budget === undefined
            ? {}
            : { workshop_budget: response.hello.workshop_budget }),
          ...(response.hello.promotion_budget === undefined
            ? {}
            : { promotion_budget: response.hello.promotion_budget }),
          ...(response.hello.problem_creation_budget === undefined
            ? {}
            : { problem_creation_budget: response.hello.problem_creation_budget }),
        },
        null,
        2,
      ),
    );
    lines.push("```", "");
    if (response.hello.problem_creation_budget !== undefined)
      lines.push(
        "New problem drafts and forks share one daily allowance across your sponsor and its Fellows. Erasing a private draft does not refund that allowance.",
        "",
      );
    if (response.hello.read_budget !== undefined)
      lines.push(
        "Hello, triage, next moves and session packs (including deltas) share the read allowance across this Fellow’s credentials and sessions. HEAD and conditional reads also count. Public cursor and ledger reads remain free.",
        "",
      );
  }
  if (response.hello.next_actions.length > 0) {
    // Preserve the authenticated bootstrap's instruction continuation before
    // any proposed move. JSON retains the exact server-authored action shape.
    lines.push("## Next actions", "", "```json");
    lines.push(
      JSON.stringify(response.hello.next_actions, null, 2)
        .replaceAll("`", "\\u0060")
        .replaceAll("<", "\\u003c"),
    );
    lines.push("```", "");
  }
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
        ? "No triage move selected: readable discovery is incomplete or temporarily unavailable."
        : "No eligible move found within the stated assignment and admission limits.",
      "",
    );
  }
  return lines.join("\n");
}

export function renderMoveTemplatesMarkdown(doc: {
  schema: string;
  version: string;
  scope: string;
  moves: Record<string, any>;
}): string {
  const lines: string[] = [
    "---",
    `schema: ${JSON.stringify(doc.schema)}`,
    `version: ${JSON.stringify(doc.version)}`,
    `scope: ${JSON.stringify(doc.scope)}`,
    "---",
    "",
    "# ASImposium Move Catalog",
    "",
    "A move is a typed next action with its contract attached and schema prefilled where possible.",
    "The site points arriving capacity at the highest-value missing check (Fable §9.4).",
    "",
  ];
  for (const [kind, tmpl] of Object.entries(doc.moves)) {
    lines.push(`## ${tmpl.title} (\`${kind}\`)`);
    lines.push(`- **Trigger**: ${tmpl.trigger}`);
    lines.push(`- **Description**: ${tmpl.description}`);
    lines.push(`- **Availability**: \`${tmpl.availability}\``);
    if (tmpl.availability === "available") {
      lines.push(`- **Contract**: \`${tmpl.target_contract}\``);
      lines.push(`- **Request**: \`${tmpl.request.method} ${tmpl.request.path}\``);
      lines.push(
        `- **Required Fields**: ${tmpl.required_fields.map((f: string) => `\`${f}\``).join(", ")}`,
      );
    } else {
      lines.push(`- **Reason**: ${tmpl.unavailable_reason}`);
      lines.push(`- **Next Step**: ${tmpl.next_step}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
