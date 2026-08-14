/**
 * The agent face (Fable Rule A1: `.md` always, and it is canonical).
 *
 * Layout is fixed and machine-parseable: an `<!-- asimp … -->` header carries
 * envelope metadata (§7.7), each item is delimited by its own control comment,
 * and untrusted bodies live inside a fence that they cannot close. Because the
 * delimiters are exactly the control comments the sanitizer neutralizes inside
 * bodies, an untrusted body cannot forge an item boundary.
 */

import type { PreparedItem, PreparedProjection } from "../prepare.ts";
import { fenceFor } from "../sanitize.ts";

type Field = readonly [string, string | number];

/** `<!-- asimp[:tag] k=v … -->`, the only control grammar the faces use. */
function controlComment(tag: string, fields: readonly Field[]): string {
  const name = tag === "" ? "asimp" : `asimp:${tag}`;
  const pairs = fields.map(([key, value]) => `${key}=${value}`).join(" ");
  return pairs === "" ? `<!-- ${name} -->` : `<!-- ${name} ${pairs} -->`;
}

function renderItem(item: PreparedItem): string[] {
  const lines: string[] = [];
  lines.push(
    controlComment("item", [
      ["id", item.id],
      ["kind", item.kind],
      ["scope", item.scope],
      ["untrusted", String(item.untrusted)],
    ]),
  );
  const trust = item.untrusted ? "untrusted data" : "server-authored";
  lines.push(`### ${item.id} · ${item.kind} · ${item.scope} · ${trust}`);
  lines.push("");
  lines.push(`_why included:_ ${item.why_included}`);
  lines.push("");

  if (item.untrusted) {
    const fence = fenceFor(item.body);
    lines.push(`${fence.delimiter}text`);
    lines.push(item.body);
    lines.push(fence.delimiter);
    if (item.neutralized.length > 0) {
      const summary = item.neutralized
        .map((finding) => `${finding.marker}×${finding.count}`)
        .join(", ");
      lines.push("");
      lines.push(`_neutralized in this body:_ ${summary}`);
    }
  } else {
    // System items are the instruction channel and are server-authored, so they
    // render as markdown rather than as quarantined text.
    lines.push(item.body);
  }
  lines.push("");
  lines.push(controlComment("item-end", [["id", item.id]]));
  lines.push("");
  return lines;
}

export function renderMarkdownFace(prepared: PreparedProjection): string {
  const lines: string[] = [];

  lines.push(
    controlComment("", [
      ["face", "md"],
      ["schema", prepared.schema],
      ["kind", prepared.kind],
      ["problem", prepared.problem],
      ["profile", prepared.profile],
      ["cursor", prepared.cursor],
      ["items", prepared.items.length],
      ["omitted", prepared.omitted.length],
      ["fingerprint", prepared.fingerprint],
    ]),
  );
  lines.push("");
  lines.push(`# ${prepared.title}`);
  lines.push("");
  lines.push(prepared.preamble);
  lines.push("");

  lines.push("## Items");
  lines.push("");
  if (prepared.items.length === 0) {
    lines.push("_none_");
    lines.push("");
  } else {
    for (const item of prepared.items) lines.push(...renderItem(item));
  }

  lines.push("## Omitted");
  lines.push("");
  if (prepared.omitted.length === 0) {
    lines.push("_none_");
  } else {
    for (const entry of prepared.omitted) {
      lines.push(
        entry.detail === undefined ? `- ${entry.reason}` : `- ${entry.reason} — ${entry.detail}`,
      );
    }
  }
  lines.push("");

  lines.push("## Next actions (server-authored)");
  lines.push("");
  if (prepared.next_actions.length === 0) {
    lines.push("_none_");
  } else {
    for (const action of prepared.next_actions) {
      lines.push(`- \`${action.method} ${action.url}\` — ${action.why}`);
    }
  }
  lines.push("");

  if (prepared.degraded.length > 0) {
    lines.push("## Degraded");
    lines.push("");
    for (const note of prepared.degraded) lines.push(`- ${note}`);
    lines.push("");
  }

  lines.push(controlComment("face-end", [["fingerprint", prepared.fingerprint]]));
  return `${lines.join("\n")}\n`;
}
