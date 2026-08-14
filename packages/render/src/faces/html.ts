/**
 * The human face, as an embeddable fragment (Fable Rule A1).
 *
 * Deliberately narrow at this stage: the fragment is *structure plus escaped
 * text*. It runs no markdown-to-HTML conversion, so there is no path by which
 * author bytes become markup, no author-supplied URL becomes an `href`, and no
 * `<script>` survives. The GFM + math pipeline (KaTeX trust mode off, raw HTML
 * disabled, Fable §14.3) lands with S-5/W8 and must call `escapeHtml` and
 * `neutralizeUntrustedBody` from this same module rather than growing a second
 * sanitizer.
 *
 * The fragment carries no `<html>`, `<head>` or `<body>`: Agora embeds it.
 */

import type { PreparedItem, PreparedProjection } from "../prepare.ts";
import { escapeHtml } from "../sanitize.ts";

function attribute(name: string, value: string | number): string {
  return `${name}="${escapeHtml(String(value))}"`;
}

function renderItem(item: PreparedItem): string[] {
  const lines: string[] = [];
  lines.push(
    `    <li class="asimp-item" ${attribute("data-id", item.id)} ${attribute("data-kind", item.kind)} ` +
      `${attribute("data-scope", item.scope)} ${attribute("data-untrusted", String(item.untrusted))}>`,
  );
  const trust = item.untrusted ? "untrusted data" : "server-authored";
  lines.push(
    `      <header class="asimp-item__provenance">${escapeHtml(item.id)} · ${escapeHtml(item.kind)} · ` +
      `${escapeHtml(item.scope)} · ${escapeHtml(trust)}</header>`,
  );
  lines.push(`      <p class="asimp-item__why">${escapeHtml(item.why_included)}</p>`);
  lines.push(`      <pre class="asimp-item__body"><code>${escapeHtml(item.body)}</code></pre>`);
  if (item.neutralized.length > 0) {
    const summary = item.neutralized
      .map((finding) => `${finding.marker}×${finding.count}`)
      .join(", ");
    lines.push(`      <p class="asimp-item__neutralized">neutralized: ${escapeHtml(summary)}</p>`);
  }
  lines.push("    </li>");
  return lines;
}

export function renderHtmlFragmentFace(prepared: PreparedProjection): string {
  const lines: string[] = [];
  lines.push(
    `<section class="asimp-face" ${attribute("data-schema", prepared.schema)} ` +
      `${attribute("data-kind", prepared.kind)} ${attribute("data-problem", prepared.problem)} ` +
      `${attribute("data-profile", prepared.profile)} ${attribute("data-cursor", prepared.cursor)} ` +
      `${attribute("data-fingerprint", prepared.fingerprint)}>`,
  );
  lines.push(`  <h2 class="asimp-face__title">${escapeHtml(prepared.title)}</h2>`);
  lines.push(`  <p class="asimp-face__preamble">${escapeHtml(prepared.preamble)}</p>`);

  lines.push(`  <ol class="asimp-face__items">`);
  for (const item of prepared.items) lines.push(...renderItem(item));
  lines.push("  </ol>");

  lines.push(`  <section class="asimp-face__omitted">`);
  lines.push("    <h3>Omitted</h3>");
  lines.push("    <ul>");
  if (prepared.omitted.length === 0) {
    lines.push("      <li>none</li>");
  } else {
    for (const entry of prepared.omitted) {
      const text = entry.detail === undefined ? entry.reason : `${entry.reason} — ${entry.detail}`;
      lines.push(`      <li>${escapeHtml(text)}</li>`);
    }
  }
  lines.push("    </ul>");
  lines.push("  </section>");

  lines.push(`  <section class="asimp-face__next-actions">`);
  lines.push("    <h3>Next actions (server-authored)</h3>");
  lines.push("    <ul>");
  if (prepared.next_actions.length === 0) {
    lines.push("      <li>none</li>");
  } else {
    for (const action of prepared.next_actions) {
      lines.push(
        `      <li><code>${escapeHtml(action.method)} ${escapeHtml(action.url)}</code> — ${escapeHtml(action.why)}</li>`,
      );
    }
  }
  lines.push("    </ul>");
  lines.push("  </section>");

  if (prepared.degraded.length > 0) {
    lines.push(`  <section class="asimp-face__degraded">`);
    lines.push("    <h3>Degraded</h3>");
    lines.push("    <ul>");
    for (const note of prepared.degraded) lines.push(`      <li>${escapeHtml(note)}</li>`);
    lines.push("    </ul>");
    lines.push("  </section>");
  }

  lines.push("</section>");
  return `${lines.join("\n")}\n`;
}
