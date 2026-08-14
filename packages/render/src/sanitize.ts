/**
 * The one sanitization story (Fable §14.3: "one markdown pipeline in
 * `packages/render`"; §14.4 layer 3: the forged-control-surface defense).
 *
 * Every face routes untrusted bodies through `neutralizeUntrustedBody` before
 * any format-specific work. Nothing else in this package may rewrite a body.
 *
 * What the neutralizer guarantees, precisely:
 *
 *  1. No rendered face carries an *active* `<!-- asimp … -->` control header
 *     that came out of an untrusted body. Our machine-readable delimiters are
 *     exactly those comments, so a body cannot forge one.
 *  2. No rendered face carries a JSON-shaped pack-envelope key (`"next_actions":`)
 *     that came out of an untrusted body. `next_actions` are server-authored
 *     (Fable §7.3), and a body may not look like it is authoring one.
 *  3. Markdown fences are always longer than the longest backtick run in the
 *     body they wrap, so a body cannot break out of its quarantine fence.
 *  4. Script-bearing HTML is recorded and never emitted live: the markdown face
 *     fences it, the HTML face escapes it.
 *
 * What it deliberately does *not* do: it does not delete author content, and it
 * does not mangle prose that merely *discusses* the protocol. Escapes are
 * backslash escapes, which GFM renders as the original character, so a human
 * reading the rendered page sees what the author wrote while a raw-text scan
 * for a control token fails. Neutralization is recorded, never silent
 * (Rule A4: the site never pretends).
 */

import type { NeutralizationMarker } from "./types.ts";

export interface NeutralizationFinding {
  readonly marker: NeutralizationMarker;
  readonly count: number;
}

export interface NeutralizedBody {
  readonly text: string;
  readonly findings: readonly NeutralizationFinding[];
}

/**
 * Pack-envelope keys a body is not allowed to forge in JSON shape.
 * Kept narrow on purpose: these are site-invented structural keys, so the
 * quoted-key-colon form is never legitimate scientific prose.
 */
export const RESERVED_ENVELOPE_KEYS: readonly string[] = [
  "next_actions",
  "why_included",
  "untrusted",
  "scope",
  "items",
  "omitted",
  "degraded",
  "preamble",
];

/** `<!--` (not already escaped) introducing a control comment addressed to us. */
const CONTROL_COMMENT = /(?<!\\)<!--(\s*)asimp/gi;

/** `"key":` in JSON shape, where the opening quote is not already escaped. */
const ENVELOPE_KEY = new RegExp(
  String.raw`(?<!\\)"(${RESERVED_ENVELOPE_KEYS.join("|")})"(\s*):`,
  "g",
);

/**
 * Script-bearing HTML. Detection only: both faces render untrusted bodies inert
 * (fenced in markdown, escaped in HTML), so this drives the report, not the
 * output. Kept narrow so ordinary `<` in mathematics is not flagged.
 */
const ACTIVE_HTML =
  /<\s*(script|iframe|object|embed|style|link|meta|base|form)\b|\bon[a-z]+\s*=|javascript:/gi;

const BACKTICK_RUN = /`+/g;

function countMatches(text: string, pattern: RegExp): number {
  const scan = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let count = 0;
  while (scan.exec(text) !== null) count += 1;
  return count;
}

/**
 * Neutralize one untrusted body. Idempotent: neutralizing an already-neutralized
 * body is a no-op, which is what makes it safe to apply on every face.
 */
export function neutralizeUntrustedBody(body: string): NeutralizedBody {
  const findings: NeutralizationFinding[] = [];

  const controlComments = countMatches(body, CONTROL_COMMENT);
  let text = body.replace(CONTROL_COMMENT, (_match, gap: string) => `\\<!--${gap}asimp`);
  if (controlComments > 0) {
    findings.push({ marker: "asimp-control-comment", count: controlComments });
  }

  const envelopeKeys = countMatches(text, ENVELOPE_KEY);
  text = text.replace(ENVELOPE_KEY, (_match, key: string, gap: string) => `\\"${key}\\"${gap}:`);
  if (envelopeKeys > 0) {
    findings.push({ marker: "envelope-key-forgery", count: envelopeKeys });
  }

  const activeHtml = countMatches(text, ACTIVE_HTML);
  if (activeHtml > 0) {
    findings.push({ marker: "active-html", count: activeHtml });
  }

  return { text, findings };
}

/** Longest run of backticks in `text`, 0 when there is none. */
export function longestBacktickRun(text: string): number {
  let longest = 0;
  BACKTICK_RUN.lastIndex = 0;
  for (const match of text.matchAll(BACKTICK_RUN)) {
    longest = Math.max(longest, match[0].length);
  }
  return longest;
}

export interface Fence {
  readonly delimiter: string;
  /** True when the body forced a longer fence than the three-backtick default. */
  readonly extended: boolean;
}

/**
 * Choose a fence that `text` cannot close. CommonMark closes a fenced block
 * only on a run at least as long as the opener, so opener = longest run + 1
 * (minimum 3) is breakout-proof.
 */
export function fenceFor(text: string): Fence {
  const longest = longestBacktickRun(text);
  const length = Math.max(3, longest + 1);
  return { delimiter: "`".repeat(length), extended: length > 3 };
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escape text for an HTML text node *or* a double-quoted attribute value.
 * The HTML face never emits author bytes any other way: no markdown-to-HTML
 * conversion, no raw HTML pass-through, no author-supplied URLs.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] as string);
}

/**
 * Reject values that would break out of our own `<!-- asimp … -->` header
 * grammar. Header values are server-authored, so this is a defensive assertion
 * about our own composer, not a filter on user content.
 */
export function isSafeHeaderValue(value: string): boolean {
  return !/[\r\n]/.test(value) && !value.includes("--") && !value.includes(">");
}
