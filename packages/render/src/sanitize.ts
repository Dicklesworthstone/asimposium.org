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
 * does not mangle prose that merely *discusses* the protocol. A forged comment
 * opener becomes the literal text `&lt;!--`: unlike a backslash prefix, that
 * cannot still be read as an HTML comment by a semantic consumer. The rest of
 * the author bytes remain legible as data. Neutralization is recorded, never
 * silent (Rule A4: the site never pretends).
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
 * Pack-envelope instruction keys a body is not allowed to forge in JSON shape.
 * These two keys are server-authored control furniture. Other ordinary quoted
 * JSON (including domain data such as `items`, `scope`, or `omitted`) stays
 * author prose and must not be rewritten here.
 */
export const RESERVED_ENVELOPE_KEYS: readonly string[] = ["next_actions", "why_included"];

const CONTROL_COMMENT_OPEN = "<!--";
const CONTROL_COMMENT_WHITESPACE = /^\p{White_Space}$/u;
const CANONICAL_MARK_OR_FORMAT = /[\p{M}\p{Cf}]/gu;
const CANONICAL_IGNORABLE = /^[\p{M}\p{Cf}]$/u;
const CONTROL_COMMENT_NAMESPACE = "asimp";

/** Exact lower-case reserved `"key"\s*:` envelope shapes, at any text prefix. */
const ENVELOPE_KEY = new RegExp(String.raw`"(${RESERVED_ENVELOPE_KEYS.join("|")})"(\s*):`, "g");

const ACTIVE_HTML_TAGS = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "style",
  "link",
  "meta",
  "base",
  "form",
]);
const ACTIVE_HTML_EVENT_NAME = /^on[a-z][a-z0-9:_-]*$/;
// Only these attributes are URL-valued HTML execution surfaces. Scanning a
// complete tag for `javascript:` also treats quoted descriptive data (title,
// alt, aria-*) as executable when it is not.
const URL_BEARING_HTML_ATTRIBUTES = new Set([
  "action",
  "cite",
  "data",
  "formaction",
  "href",
  "poster",
  "src",
  "xlink:href",
]);
const JAVASCRIPT_URL = "javascript:";
const HTML_ASCII_WHITESPACE = /^[\t\n\f\r ]$/;

const BACKTICK_RUN = /`+/g;

function countMatches(text: string, pattern: RegExp): number {
  const scan = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  let count = 0;
  while (scan.exec(text) !== null) count += 1;
  return count;
}

function isHtmlAsciiWhitespace(character: string | undefined): boolean {
  return character !== undefined && HTML_ASCII_WHITESPACE.test(character);
}

function isAsciiLowerAlpha(character: string | undefined): boolean {
  return character !== undefined && character >= "a" && character <= "z";
}

function isTagNameBoundary(character: string | undefined): boolean {
  return character === "/" || character === ">" || isHtmlAsciiWhitespace(character);
}

function isAttributeNameBoundary(character: string | undefined): boolean {
  return character === "=" || isTagNameBoundary(character);
}

/**
 * The raw pass is deliberately browser-shaped: only ASCII case folding is
 * applied to markup names. In particular it cannot create a delimiter, quote,
 * or closer which changes how a real raw handler is tokenized.
 */
function rawBrowserTokenizerScanText(value: string): string {
  // ASCII folding is length-preserving, so raw tokenizer positions are original
  // UTF-16 source offsets and require no recovery map.
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/**
 * The compatibility pass may reveal an obfuscated token, but is a second
 * interpretation rather than an input rewrite for the raw pass. Its source map
 * makes any finding deduplicate against the original source occurrence.
 */
function canonicalSourcePiece(character: string): string {
  return character
    .normalize("NFKD")
    .replace(CANONICAL_MARK_OR_FORMAT, "")
    .normalize("NFKC")
    .toLowerCase();
}

function unicodeCanonicalTokenizerScanText(value: string): string {
  // Keep the interpretation itself as a compact whole string. Mapping every
  // source point before knowing whether there is a finding turns benign NFKD
  // expansion into an attacker-controlled allocation; recovery below runs only
  // for the few offsets the scanner actually reports.
  return value
    .normalize("NFKD")
    .replace(CANONICAL_MARK_OR_FORMAT, "")
    .normalize("NFKC")
    .toLowerCase();
}

interface ActiveHtmlFinding {
  readonly kind: "tag" | "javascript";
  /** Offset in the tokenizer interpretation that produced this finding. */
  readonly offset: number;
}

function sourceFindingKey(finding: ActiveHtmlFinding): string {
  return `${finding.kind}:${finding.offset}`;
}

/**
 * Canonical findings are emitted in transformed-text order. Recover their raw
 * source offsets only when they exist, walking the source once with the exact
 * per-code-point transform used to build the interpretation. Benign NFKD
 * expansion therefore retains no source metadata at all.
 */
function canonicalFindingsAtSourceOffsets(
  value: string,
  canonicalFindings: readonly ActiveHtmlFinding[],
): ActiveHtmlFinding[] {
  if (canonicalFindings.length === 0) return [];

  const sourceFindings: ActiveHtmlFinding[] = [];
  let sourceOffset = 0;
  let transformedOffset = 0;
  let findingIndex = 0;

  while (sourceOffset < value.length && findingIndex < canonicalFindings.length) {
    const character = codePointAt(value, sourceOffset);
    const transformedLength = canonicalSourcePiece(character).length;
    const transformedEndOffset = transformedOffset + transformedLength;

    while (findingIndex < canonicalFindings.length) {
      const finding = canonicalFindings[findingIndex];
      if (finding === undefined || finding.offset >= transformedEndOffset) break;
      sourceFindings.push({ kind: finding.kind, offset: sourceOffset });
      findingIndex += 1;
    }

    transformedOffset = transformedEndOffset;
    sourceOffset += character.length;
  }

  return sourceFindings;
}

export interface ActiveHtmlScanDiagnostics {
  readonly raw: {
    readonly transformed_utf16_units: number;
    readonly finding_offsets: number;
    readonly source_mapping_entries: number;
  };
  readonly canonical: {
    readonly transformed_utf16_units: number;
    readonly finding_offsets: number;
    readonly source_mapping_entries: number;
  };
}

/**
 * Structural storage diagnostic for the two active-markup interpretations.
 * The raw interpretation is an identity offset map. Canonical recovery stores
 * one entry only for an actual scanner finding, never for transformed text.
 */
export function activeHtmlScanDiagnostics(body: string): ActiveHtmlScanDiagnostics {
  const rawText = rawBrowserTokenizerScanText(body);
  const rawFindings = collectActiveHtml(rawText);
  const canonicalText = unicodeCanonicalTokenizerScanText(body);
  const canonicalFindings = collectActiveHtml(canonicalText);
  return {
    raw: {
      transformed_utf16_units: rawText.length,
      finding_offsets: rawFindings.length,
      source_mapping_entries: 0,
    },
    canonical: {
      transformed_utf16_units: canonicalText.length,
      finding_offsets: canonicalFindings.length,
      source_mapping_entries: canonicalFindings.length,
    },
  };
}

function htmlCommentEndOffset(value: string, openOffset: number): number {
  let cursor = openOffset + CONTROL_COMMENT_OPEN.length;

  // The tokenizer also closes these two parse-error forms immediately.
  if (value[cursor] === ">") return cursor + 1;
  if (value.startsWith("->", cursor)) return cursor + 2;

  while (cursor < value.length) {
    if (value.startsWith("-->", cursor)) return cursor + 3;
    if (value.startsWith("--!>", cursor)) return cursor + 4;
    cursor += 1;
  }

  // An unclosed comment consumes the remainder as comment data.
  return value.length;
}

interface ActiveStartTagScan {
  readonly endOffset: number;
  readonly active: boolean;
  readonly javascriptUrlOffsets: readonly number[];
}

function findJavascriptUrlOffsets(value: string, startOffset: number, endOffset: number): number[] {
  const offsets: number[] = [];
  let searchFrom = startOffset;

  while (searchFrom < endOffset) {
    const found = value.indexOf(JAVASCRIPT_URL, searchFrom);
    if (found === -1 || found + JAVASCRIPT_URL.length > endOffset) break;
    offsets.push(found);
    searchFrom = found + JAVASCRIPT_URL.length;
  }

  return offsets;
}

function finishActiveStartTag(
  endOffset: number,
  active: boolean,
  javascriptUrlOffsets: readonly number[],
): ActiveStartTagScan {
  return {
    endOffset,
    active,
    javascriptUrlOffsets,
  };
}

/**
 * Scan one canonical start-tag candidate using the tokenizer boundaries that
 * matter to event attributes. In before-attribute and self-closing states both
 * ASCII whitespace and `/` are separators. Inside an unquoted value, `/` is
 * data; inside a quoted value, every byte through the matching quote is data.
 */
function scanActiveStartTag(value: string, openOffset: number): ActiveStartTagScan | undefined {
  if (!isAsciiLowerAlpha(value[openOffset + 1])) return undefined;

  let cursor = openOffset + 1;
  while (cursor < value.length && !isTagNameBoundary(value[cursor])) cursor += 1;

  const tagName = value.slice(openOffset + 1, cursor);
  let active = ACTIVE_HTML_TAGS.has(tagName);
  const javascriptUrlOffsets: number[] = [];

  while (cursor < value.length) {
    while (isHtmlAsciiWhitespace(value[cursor]) || value[cursor] === "/") cursor += 1;

    if (cursor >= value.length) {
      return finishActiveStartTag(value.length, active, javascriptUrlOffsets);
    }
    if (value[cursor] === ">") {
      return finishActiveStartTag(cursor + 1, active, javascriptUrlOffsets);
    }

    const attributeNameStart = cursor;
    if (value[cursor] === "=") cursor += 1;
    while (cursor < value.length && !isAttributeNameBoundary(value[cursor])) cursor += 1;
    const attributeName = value.slice(attributeNameStart, cursor);

    let hasValue = false;
    if (value[cursor] === "=") {
      hasValue = true;
      cursor += 1;
    } else if (isHtmlAsciiWhitespace(value[cursor])) {
      while (isHtmlAsciiWhitespace(value[cursor])) cursor += 1;
      if (value[cursor] === "=") {
        hasValue = true;
        cursor += 1;
      }
    }

    if (!hasValue) continue;
    if (ACTIVE_HTML_EVENT_NAME.test(attributeName)) active = true;
    const urlBearingAttribute = URL_BEARING_HTML_ATTRIBUTES.has(attributeName);

    while (isHtmlAsciiWhitespace(value[cursor])) cursor += 1;
    const quote = value[cursor];
    if (quote === '"' || quote === "'") {
      cursor += 1;
      const valueStart = cursor;
      while (cursor < value.length && value[cursor] !== quote) cursor += 1;
      if (urlBearingAttribute) {
        javascriptUrlOffsets.push(...findJavascriptUrlOffsets(value, valueStart, cursor));
      }
      if (value[cursor] === quote) cursor += 1;
      continue;
    }

    // HTML's unquoted-value state ends only at ASCII whitespace or `>`.
    // A solidus here is part of the value, not an attribute separator.
    const valueStart = cursor;
    while (
      cursor < value.length &&
      !isHtmlAsciiWhitespace(value[cursor]) &&
      value[cursor] !== ">"
    ) {
      cursor += 1;
    }
    if (urlBearingAttribute) {
      javascriptUrlOffsets.push(...findJavascriptUrlOffsets(value, valueStart, cursor));
    }
  }

  return finishActiveStartTag(value.length, active, javascriptUrlOffsets);
}

/**
 * Collect active markup under one tokenizer interpretation. Findings keep
 * tokenizer offsets temporarily; canonical offsets are recovered only when
 * there is something to report.
 */
function collectActiveHtml(text: string): ActiveHtmlFinding[] {
  const findings: ActiveHtmlFinding[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    // Numeric inspection avoids allocating a one-character substring for every
    // transformed UTF-16 unit in a benign large canonical interpretation.
    const characterCode = text.charCodeAt(cursor);
    if (characterCode === 60) {
      if (
        text.charCodeAt(cursor + 1) === 33 &&
        text.charCodeAt(cursor + 2) === 45 &&
        text.charCodeAt(cursor + 3) === 45
      ) {
        cursor = htmlCommentEndOffset(text, cursor);
        continue;
      }
      const tag = scanActiveStartTag(text, cursor);
      if (tag !== undefined) {
        if (tag.active) findings.push({ kind: "tag", offset: cursor });
        for (const javascriptOffset of tag.javascriptUrlOffsets) {
          findings.push({ kind: "javascript", offset: javascriptOffset });
        }
        cursor = tag.endOffset;
        continue;
      }
    }

    if (characterCode === 106 && text.startsWith(JAVASCRIPT_URL, cursor)) {
      findings.push({ kind: "javascript", offset: cursor });
      cursor += JAVASCRIPT_URL.length;
      continue;
    }
    cursor += 1;
  }

  return findings;
}

/**
 * Script-bearing HTML detection only: every face still renders the original
 * body inert. Raw-tokenizer and Unicode-canonical interpretations are scanned
 * separately, so normalization can reveal a mutation but can never manufacture
 * a quote, comment, or tag boundary that suppresses raw active markup.
 */
function countActiveHtml(body: string): number {
  const findings = new Set<string>();
  // Never feed canonical text back into this raw browser-tokenizer pass. A
  // compatibility character can normalize into `<!--`, a quote, or `>`; that
  // derived syntax is allowed to affect only the canonical interpretation, so
  // it cannot hide a real handler from the raw one.
  for (const finding of collectActiveHtml(rawBrowserTokenizerScanText(body))) {
    findings.add(sourceFindingKey(finding));
  }

  const canonicalFindings = collectActiveHtml(unicodeCanonicalTokenizerScanText(body));
  for (const finding of canonicalFindingsAtSourceOffsets(body, canonicalFindings)) {
    findings.add(sourceFindingKey(finding));
  }

  return findings.size;
}

function codePointAt(text: string, offset: number): string {
  return String.fromCodePoint(text.codePointAt(offset) as number);
}

function isControlCommentWhitespace(character: string): boolean {
  return CONTROL_COMMENT_WHITESPACE.test(character);
}

/**
 * Decide whether the raw comment at `openOffset` names our control namespace.
 * This deliberately scans every literal opener: a preceding backslash is text,
 * not a property of an HTML comment, and therefore cannot exempt attacker
 * input from neutralization. It retains only the five semantic characters in
 * `asimp`: each source code point is NFKD-expanded incrementally, then marks
 * and format characters are ignored before its remaining semantic characters
 * are folded and compared to the next expected prefix character. A mismatch or
 * sixth semantic character is a final rejection, so one malformed unclosed
 * comment cannot make later opener candidates rescan its suffix.
 */
function isAsimpControlComment(body: string, openOffset: number): boolean {
  let cursor = openOffset + CONTROL_COMMENT_OPEN.length;
  let semanticLength = 0;

  while (cursor < body.length) {
    // A fieldless control header is still a control header. The tokenizer
    // accepts both ordinary and parse-error comment closers; either bounds the
    // namespace before the closer's punctuation can
    // be mistaken for a sixth semantic character (`asimp--!>`).
    if (body.startsWith("-->", cursor) || body.startsWith("--!>", cursor)) {
      return semanticLength === CONTROL_COMMENT_NAMESPACE.length;
    }
    const character = codePointAt(body, cursor);
    if (character.normalize("NFKC") === ":") {
      return semanticLength === CONTROL_COMMENT_NAMESPACE.length;
    }
    if (isControlCommentWhitespace(character)) {
      // Leading whitespace (including after only ignorable Cf/M noise) is not
      // part of the namespace. Once it has semantic content, whitespace ends it.
      if (semanticLength !== 0) return semanticLength === CONTROL_COMMENT_NAMESPACE.length;
      cursor += character.length;
      continue;
    }

    for (const decomposed of character.normalize("NFKD")) {
      if (CANONICAL_IGNORABLE.test(decomposed)) continue;

      // NFKD can expand one code point into several semantic characters. Fold
      // those incrementally too, rather than collecting a namespace string.
      for (const folded of decomposed.normalize("NFKC").toLowerCase()) {
        if (CANONICAL_IGNORABLE.test(folded)) continue;
        if (
          semanticLength === CONTROL_COMMENT_NAMESPACE.length ||
          folded !== CONTROL_COMMENT_NAMESPACE[semanticLength]
        ) {
          return false;
        }
        semanticLength += 1;
      }
    }
    cursor += character.length;
  }

  return semanticLength === CONTROL_COMMENT_NAMESPACE.length;
}

/**
 * Make control-comment openers inert without relying on Markdown escaping.
 * Replacing `<` with `&lt;` preserves the remaining hostile text for disclosure,
 * works after any number of attacker-controlled backslashes, and cannot match
 * this scanner on a later pass.
 */
function neutralizeControlComments(body: string): {
  readonly text: string;
  readonly count: number;
} {
  const pieces: string[] = [];
  let copiedThrough = 0;
  let searchFrom = 0;
  let count = 0;

  while (true) {
    const openOffset = body.indexOf(CONTROL_COMMENT_OPEN, searchFrom);
    if (openOffset === -1) break;

    if (isAsimpControlComment(body, openOffset)) {
      pieces.push(body.slice(copiedThrough, openOffset), "&lt;!--");
      copiedThrough = openOffset + CONTROL_COMMENT_OPEN.length;
      count += 1;
    }

    searchFrom = openOffset + CONTROL_COMMENT_OPEN.length;
  }

  if (count === 0) return { text: body, count: 0 };
  pieces.push(body.slice(copiedThrough));
  return { text: pieces.join(""), count };
}

/**
 * Neutralize one untrusted body. Idempotent: neutralizing an already-neutralized
 * body is a no-op, which is what makes it safe to apply on every face.
 */
export function neutralizeUntrustedBody(body: string): NeutralizedBody {
  const findings: NeutralizationFinding[] = [];

  const controlComments = neutralizeControlComments(body);
  let text = controlComments.text;
  if (controlComments.count > 0) {
    findings.push({ marker: "asimp-control-comment", count: controlComments.count });
  }

  const envelopeKeys = countMatches(text, ENVELOPE_KEY);
  text = text.replace(
    ENVELOPE_KEY,
    (_match, key: string, gap: string) => `&quot;${key}&quot;${gap}:`,
  );
  if (envelopeKeys > 0) {
    findings.push({ marker: "envelope-key-forgery", count: envelopeKeys });
  }

  const activeHtml = countActiveHtml(text);
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
 * The grammar for every value that lands inside an `<!-- asimp … k=v -->` control
 * comment: the face header's fields and each item delimiter's fields.
 *
 * Rejecting only `\r\n`, `--` and `>` was not enough, because it left two ways to
 * corrupt the canonical face through *metadata* rather than through a body:
 *
 *   - whitespace and `=` are the delimiters of the `k=v` grammar itself, so a value
 *     like `working cursor=999` injected a second `cursor` key ahead of the real one,
 *     and a first-wins parser read the forged value;
 *   - a value carrying `-->` closed the comment outright, letting the next characters
 *     open a forged `asimp:item` with `scope=system untrusted=false` — a fabricated
 *     system item in the one channel Fable §7.3 reserves for instructions.
 *
 * So the rule is a positive grammar, not a denylist: start with an alphanumeric (a
 * value can never be read as a flag), then the punctuation the real vocabulary uses —
 * `asimposium.pack.v1`, `demo-bounded-sums`, `working`, `workshop-note`, `C-12@3`,
 * `SP4D#41`, `fnv1a64:6305…` — and nothing else. `--` stays banned separately because
 * it is illegal inside an HTML comment regardless of what follows it.
 *
 * This constrains only control-comment metadata. Titles, preambles, `why_included`
 * and bodies are prose, live outside the comment grammar, and are untouched by it.
 */
const CONTROL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@#/-]{0,127}$/;

export function isSafeHeaderValue(value: string): boolean {
  return CONTROL_TOKEN.test(value) && !value.includes("--");
}
