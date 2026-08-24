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
 *     that came out of an untrusted body, including a JSON `\uXXXX` spelling
 *     that decodes to the same key. `next_actions` are server-authored (Fable
 *     §7.3), and a body may not look like it is authoring one.
 *  3. Markdown fences are always longer than the longest backtick run in the
 *     body they wrap, so a body cannot break out of its quarantine fence.
 *  4. Script-bearing HTML is recorded and never emitted live: the markdown face
 *     fences it, the HTML face escapes it. "Script-bearing" covers active tags,
 *     event-handler attributes, and any destination whose scheme a browser
 *     executes rather than fetches (`javascript:`, `data:`, `vbscript:`) —
 *     wherever that destination is a real URL surface.
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

const RESERVED_ENVELOPE_KEY_SET = new Set(RESERVED_ENVELOPE_KEYS);
const LONGEST_RESERVED_ENVELOPE_KEY = Math.max(...RESERVED_ENVELOPE_KEYS.map((key) => key.length));
const JSON_UNICODE_ESCAPE_SOURCE = String.raw`\\u[0-9A-Fa-f]{4}`;
const JSON_UNICODE_ESCAPE = /\\u([0-9A-Fa-f]{4})/g;
/**
 * A reserved key contains only ASCII identifier characters. Each decoded
 * character may instead use one exact JSON Unicode escape; the decoded-length
 * bound and disjoint alternatives keep the scan linear on hostile input.
 */
const ENVELOPE_KEY_CANDIDATE = new RegExp(
  String.raw`"((?:[A-Za-z0-9_]|${JSON_UNICODE_ESCAPE_SOURCE}){1,${LONGEST_RESERVED_ENVELOPE_KEY}})"(\s*):`,
  "g",
);

function decodeJsonUnicodeEscapes(value: string): string {
  return value.replace(JSON_UNICODE_ESCAPE, (_escape, digits: string) =>
    String.fromCharCode(Number.parseInt(digits, 16)),
  );
}

/** Encode only the two quotes, preserving the author's exact key escape bytes. */
function neutralizeReservedEnvelopeKeys(text: string): {
  readonly text: string;
  readonly count: number;
} {
  let count = 0;
  const neutralized = text.replace(
    ENVELOPE_KEY_CANDIDATE,
    (candidate, encodedKey: string, gap: string) => {
      if (!RESERVED_ENVELOPE_KEY_SET.has(decodeJsonUnicodeEscapes(encodedKey))) return candidate;
      count += 1;
      return `&quot;${encodedKey}&quot;${gap}:`;
    },
  );
  return { text: neutralized, count };
}

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
// complete tag for a dangerous scheme would also treat quoted descriptive data
// (title, alt, aria-*) as executable when it is not.
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
/**
 * URL schemes whose destination a browser executes rather than fetches.
 *
 * `javascript:` and `vbscript:` run script directly. `data:` is listed whole
 * rather than by media type: `data:text/html` and `data:image/svg+xml` execute,
 * and sorting the inert ones out would mean re-implementing media-type parsing
 * over attacker-controlled case, whitespace, `;`, base64 and percent escapes —
 * a second parser to get wrong. Recording an inert `data:image/png` is honest
 * over-reporting; missing an executable one is not (Rule A4).
 *
 * Matching is plain lower-case ASCII on purpose. Both interpretations that feed
 * the scanners (`rawBrowserTokenizerScanText`, `unicodeCanonicalTokenizerScanText`)
 * have already folded case and Unicode compatibility spellings, so `JaVaScRiPt:`,
 * a fullwidth `ｄata:` and format-character-stuffed spellings all arrive here
 * lower-cased and de-obfuscated.
 */
const DANGEROUS_URL_SCHEMES: readonly string[] = ["data:", "javascript:", "vbscript:"];

/** Longest dangerous scheme *name*, so scheme accumulation is bounded. */
const LONGEST_DANGEROUS_SCHEME_NAME = Math.max(
  ...DANGEROUS_URL_SCHEMES.map((scheme) => scheme.length - 1),
);
/** WHATWG URL scheme grammar after the first character, which must be alphabetic. */
const URL_SCHEME_CONTINUATION = /^[a-z0-9+.-]$/;

/**
 * The offset of the destination's scheme when a browser would parse it as one of
 * `DANGEROUS_URL_SCHEMES`, else `undefined`.
 *
 * This is the base matcher behind every destination surface. Markdown inline
 * and reference destinations pass through the small wrapper below because
 * CommonMark removes backslash escapes before handing a destination to a URL
 * parser; autolinks and HTML attributes do not.
 *
 * It is deliberately *anchored*: only the scheme the browser resolves counts. A
 * benign `https://example.test/?note=data:text/html` mentions a scheme in its
 * query and is data, not an execution surface; reporting it as neutralized would
 * be pretending (Rule A4).
 *
 * Two WHATWG basic-URL-parser preprocessing steps are mirrored, because both are
 * reachable inside an HTML attribute value and both change what executes:
 * leading C0-control-or-space is stripped, and ASCII tab, LF and CR are removed
 * from anywhere in the input — so `java<TAB>script:` is a `javascript:` URL.
 *
 * Case and Unicode compatibility spellings need no handling here: both scan
 * interpretations (`rawBrowserTokenizerScanText`, `unicodeCanonicalTokenizerScanText`)
 * have already folded them before this runs.
 *
 * Proven boundary: HTML character references inside an attribute value are *not*
 * decoded. A real HTML parser resolves `&#106;`, `&#x6a;`, `&Tab;` and `&colon;`
 * before the URL parser ever sees the value, so `href="&#106;avascript:steal()"`
 * is recorded as nothing here. Decoding them means owning a second parser — the
 * character-reference table, its unterminated-entity quirks and its context
 * rules — which is exactly the drift this module refuses elsewhere. This is a
 * detection limit only while no face emits live markup: the markdown face fences
 * the body and the HTML face escapes it, so neither renders the reference. It
 * must be closed together with the GFM pipeline (§14.3), whose HTML sanitizer
 * decodes references as part of parsing.
 */
function dangerousSchemeOffsetAt(
  text: string,
  startOffset: number,
  endOffset: number,
): number | undefined {
  let cursor = startOffset;
  // Leading C0 control or space is stripped before parsing.
  while (cursor < endOffset && text.charCodeAt(cursor) <= 0x20) cursor += 1;

  const schemeStart = cursor;
  let scheme = "";

  while (cursor < endOffset) {
    const code = text.charCodeAt(cursor);
    // ASCII tab, LF and CR are removed from anywhere in the input.
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      cursor += 1;
      continue;
    }
    const character = text[cursor] as string;
    if (character === ":") {
      return DANGEROUS_URL_SCHEMES.includes(`${scheme}:`) ? schemeStart : undefined;
    }
    if (scheme.length >= LONGEST_DANGEROUS_SCHEME_NAME) return undefined;
    if (
      scheme.length === 0 ? !isAsciiLowerAlpha(character) : !URL_SCHEME_CONTINUATION.test(character)
    ) {
      return undefined;
    }
    scheme += character;
    cursor += 1;
  }

  return undefined;
}

function isMarkdownEscapablePunctuation(character: string | undefined): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

/** Dangerous-scheme matching after CommonMark backslash-unescapes punctuation. */
function markdownDangerousSchemeOffsetAt(
  text: string,
  startOffset: number,
  endOffset: number,
): number | undefined {
  let cursor = startOffset;
  while (cursor < endOffset && text.charCodeAt(cursor) <= 0x20) cursor += 1;

  const schemeStart = cursor;
  let scheme = "";
  while (cursor < endOffset) {
    const code = text.charCodeAt(cursor);
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      cursor += 1;
      continue;
    }

    let character = text[cursor] as string;
    let sourceWidth = 1;
    if (character === "\\" && isMarkdownEscapablePunctuation(text[cursor + 1])) {
      character = text[cursor + 1] as string;
      sourceWidth = 2;
    }
    if (character === ":") {
      return DANGEROUS_URL_SCHEMES.includes(`${scheme}:`) ? schemeStart : undefined;
    }
    if (scheme.length >= LONGEST_DANGEROUS_SCHEME_NAME) return undefined;
    if (
      scheme.length === 0 ? !isAsciiLowerAlpha(character) : !URL_SCHEME_CONTINUATION.test(character)
    ) {
      return undefined;
    }
    scheme += character;
    cursor += sourceWidth;
  }

  return undefined;
}

const HTML_ASCII_WHITESPACE = /^[\t\n\f\r ]$/;
const COMMONMARK_HTML_START_TAG_NAME = /^[a-z][a-z0-9-]*$/;

const BACKTICK_RUN = /`+/g;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WORKER_URL_ORIGIN = "https://a.asimposium.org";

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

const NON_ASCII = /[^\x00-\x7f]/;

/**
 * The compatibility pass may reveal an obfuscated token, but is a second
 * interpretation rather than an input rewrite for the raw pass. Its source map
 * makes any finding deduplicate against the original source occurrence.
 */
function canonicalizeSourceCodePoint(sourceCodePoint: string): string {
  const code = sourceCodePoint.charCodeAt(0);
  if (sourceCodePoint.length === 1 && code <= 0x7f) {
    return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : sourceCodePoint;
  }
  return sourceCodePoint.normalize("NFKD").replace(CANONICAL_MARK_OR_FORMAT, "").toLowerCase();
}

function unicodeCanonicalTokenizerScanText(value: string): string {
  // Keep the historical whole-string interpretation for the exported
  // structural diagnostic. NFKC can compose adjacent non-ASCII source code
  // points (notably Hangul Jamo), and that transformed length is observable.
  return value
    .normalize("NFKD")
    .replace(CANONICAL_MARK_OR_FORMAT, "")
    .normalize("NFKC")
    .toLowerCase();
}

function unicodeCanonicalSourceMappedScanText(value: string): string {
  if (!NON_ASCII.test(value)) {
    return rawBrowserTokenizerScanText(value);
  }
  // NFKD already exposes every compatibility spelling the ASCII-shaped
  // tokenizer recognizes. After marks and format controls are removed, a
  // whole-string NFKC pass can only recompose non-ASCII sequences (not create
  // a tag name, attribute name, or URL scheme). Omitting only that recomposition
  // gives the classifier the same findings while letting source recovery replay
  // this exact interpretation once, code point by code point.
  const parts: string[] = [];
  for (const sourceCodePoint of value) {
    const canonical = canonicalizeSourceCodePoint(sourceCodePoint);
    if (canonical !== "") parts.push(canonical);
  }
  return parts.join("");
}

interface ActiveHtmlFinding {
  readonly kind: "tag" | "url";
  /** Offset in the tokenizer interpretation that produced this finding. */
  readonly offset: number;
}

function sourceFindingKey(finding: ActiveHtmlFinding): string {
  return `${finding.kind}:${finding.offset}`;
}

/**
 * Canonical findings are emitted in transformed-text order. Recover all of
 * their source offsets in one forward replay of the exact per-code-point
 * interpretation above. Only the findings and their sorted indexes are
 * retained: a benign compatibility-expansion corpus still allocates no source
 * map, while thousands of findings do not re-normalize thousands of prefixes.
 */
function canonicalFindingsAtSourceOffsets(
  value: string,
  canonicalFindings: readonly ActiveHtmlFinding[],
): ActiveHtmlFinding[] {
  if (canonicalFindings.length === 0) return [];
  if (!NON_ASCII.test(value)) {
    return canonicalFindings as ActiveHtmlFinding[];
  }

  const pending = canonicalFindings
    .map((finding, index) => ({ canonicalOffset: finding.offset, index }))
    .sort((left, right) => left.canonicalOffset - right.canonicalOffset);
  const sourceOffsets = new Array<number>(canonicalFindings.length);
  let canonicalStart = 0;
  let pendingIndex = 0;
  let sourceOffset = 0;

  for (const sourceCodePoint of value) {
    const canonicalLength = canonicalizeSourceCodePoint(sourceCodePoint).length;
    const canonicalEnd = canonicalStart + canonicalLength;
    while (
      pendingIndex < pending.length &&
      (pending[pendingIndex]?.canonicalOffset ?? canonicalEnd) < canonicalEnd
    ) {
      const target = pending[pendingIndex];
      if (target !== undefined && target.canonicalOffset >= canonicalStart) {
        sourceOffsets[target.index] = sourceOffset;
      }
      pendingIndex += 1;
    }
    canonicalStart = canonicalEnd;
    sourceOffset += sourceCodePoint.length;
  }

  // A scanner finding is always inside the canonical text. Keep this fallback
  // fail-safe (an extra, non-deduplicated finding) if that invariant regresses.
  for (; pendingIndex < pending.length; pendingIndex += 1) {
    const target = pending[pendingIndex];
    if (target !== undefined) sourceOffsets[target.index] = value.length;
  }

  return canonicalFindings.map((finding, index) => ({
    kind: finding.kind,
    offset: sourceOffsets[index] ?? value.length,
  }));
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
  const rawFindings = collectActiveMarkup(rawText);
  const canonicalText = unicodeCanonicalTokenizerScanText(body);
  const canonicalFindings = collectActiveMarkup(canonicalText);
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
  /** Whether the candidate ended in `>` rather than reaching end-of-input. */
  readonly complete: boolean;
  readonly tagName: string;
  readonly active: boolean;
  readonly dangerousUrlOffsets: readonly number[];
}

/**
 * The dangerous destination scheme of one URL-bearing attribute value, if any.
 *
 * Returns at most one offset per attribute: the value's own scheme. A scheme
 * spelled later in the path or query is ordinary data and is not reported.
 */
function findDangerousUrlOffsets(value: string, startOffset: number, endOffset: number): number[] {
  const offset = dangerousSchemeOffsetAt(value, startOffset, endOffset);
  return offset === undefined ? [] : [offset];
}

function finishActiveStartTag(
  endOffset: number,
  complete: boolean,
  tagName: string,
  active: boolean,
  dangerousUrlOffsets: readonly number[],
): ActiveStartTagScan {
  return {
    endOffset,
    complete,
    tagName,
    active,
    dangerousUrlOffsets,
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
  const dangerousUrlOffsets: number[] = [];

  while (cursor < value.length) {
    while (isHtmlAsciiWhitespace(value[cursor]) || value[cursor] === "/") cursor += 1;

    if (cursor >= value.length) {
      return finishActiveStartTag(value.length, false, tagName, active, dangerousUrlOffsets);
    }
    if (value[cursor] === ">") {
      return finishActiveStartTag(cursor + 1, true, tagName, active, dangerousUrlOffsets);
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
        dangerousUrlOffsets.push(...findDangerousUrlOffsets(value, valueStart, cursor));
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
      dangerousUrlOffsets.push(...findDangerousUrlOffsets(value, valueStart, cursor));
    }
  }

  return finishActiveStartTag(value.length, false, tagName, active, dangerousUrlOffsets);
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
      if (isMarkdownEscaped(text, cursor)) {
        cursor += 1;
        continue;
      }
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
        for (const dangerousOffset of tag.dangerousUrlOffsets) {
          findings.push({ kind: "url", offset: dangerousOffset });
        }
        cursor = tag.endOffset;
        continue;
      }
    }

    cursor += 1;
  }

  return findings;
}

function isMarkdownEscaped(text: string, offset: number): boolean {
  let backslashes = 0;
  let cursor = offset;
  while (cursor > 0 && text[cursor - 1] === "\\") {
    backslashes += 1;
    cursor -= 1;
  }
  return backslashes % 2 === 1;
}

function markdownCodeSpanEnd(text: string, openOffset: number): number | undefined {
  let runLength = 1;
  while (text[openOffset + runLength] === "`") runLength += 1;
  const openingEnd = openOffset + runLength;
  let cursor = openingEnd;
  while (cursor < text.length) {
    const candidate = text.indexOf("`", cursor);
    if (candidate === -1) return openingEnd;
    let closingLength = 1;
    while (text[candidate + closingLength] === "`") closingLength += 1;
    // CommonMark matches a code-span opener only with a run of exactly the
    // same length. A two-backtick slice inside a three-backtick run is not a
    // closer for a two-backtick opener.
    if (closingLength === runLength) return candidate + closingLength;
    cursor = candidate + closingLength;
  }
  // The maximal opener run is literal text when no exact closer exists. Skip
  // only those delimiter bytes; the following body still needs active-markup
  // scanning. This also prevents quadratic rescans of one long unmatched run.
  return openingEnd;
}

function markdownLineStart(text: string, offset: number): number {
  return Math.max(text.lastIndexOf("\n", offset - 1), text.lastIndexOf("\r", offset - 1)) + 1;
}

function markdownLineEnd(text: string, offset: number): number {
  const lineFeed = text.indexOf("\n", offset);
  const carriageReturn = text.indexOf("\r", offset);
  if (lineFeed === -1) return carriageReturn === -1 ? text.length : carriageReturn;
  return carriageReturn === -1 ? lineFeed : Math.min(lineFeed, carriageReturn);
}

function markdownNextLineStart(text: string, lineEnd: number): number {
  if (lineEnd >= text.length) return text.length;
  return text[lineEnd] === "\r" && text[lineEnd + 1] === "\n" ? lineEnd + 2 : lineEnd + 1;
}

/**
 * Return the end of a CommonMark fenced code block beginning at `openOffset`.
 * An unclosed opener keeps the rest of the document inert, as CommonMark does.
 */
function markdownFencedCodeBlockEnd(text: string, openOffset: number): number | undefined {
  const delimiter = text[openOffset];
  if ((delimiter !== "`" && delimiter !== "~") || isMarkdownEscaped(text, openOffset)) {
    return undefined;
  }
  const preceding = text[openOffset - 1];
  if (openOffset > 0 && preceding !== " " && preceding !== "\n" && preceding !== "\r") {
    return undefined;
  }

  const lineStart = markdownLineStart(text, openOffset);
  const indentation = text.slice(lineStart, openOffset);
  if (indentation.length > 3 || ![...indentation].every((character) => character === " ")) {
    return undefined;
  }

  let openingLength = 1;
  while (text[openOffset + openingLength] === delimiter) openingLength += 1;
  if (openingLength < 3) return undefined;

  const openingLineEnd = markdownLineEnd(text, openOffset + openingLength);
  // Backtick-fence info strings may not themselves contain a backtick.
  if (delimiter === "`" && text.slice(openOffset + openingLength, openingLineEnd).includes("`")) {
    return undefined;
  }

  let line = markdownNextLineStart(text, openingLineEnd);
  while (line < text.length) {
    let cursor = line;
    let closingIndentation = 0;
    while (text[cursor] === " " && closingIndentation < 4) {
      cursor += 1;
      closingIndentation += 1;
    }
    if (closingIndentation <= 3) {
      let closingLength = 0;
      while (text[cursor + closingLength] === delimiter) closingLength += 1;
      if (closingLength >= openingLength) {
        let tail = cursor + closingLength;
        while (text[tail] === " " || text[tail] === "\t") {
          tail += 1;
        }
        if (tail === text.length || text[tail] === "\n" || text[tail] === "\r") {
          return markdownNextLineStart(text, tail);
        }
      }
    }
    const lineEnd = markdownLineEnd(text, line);
    if (lineEnd === text.length) break;
    line = markdownNextLineStart(text, lineEnd);
  }

  return text.length;
}

/** Markdown code spans and fenced blocks are text, never live HTML surfaces. */
function markdownInertEnd(text: string, openOffset: number): number | undefined {
  const fencedEnd = markdownFencedCodeBlockEnd(text, openOffset);
  if (fencedEnd !== undefined) return fencedEnd;
  return text[openOffset] === "`" && !isMarkdownEscaped(text, openOffset)
    ? markdownCodeSpanEnd(text, openOffset)
    : undefined;
}

function markdownLabelEnds(text: string): Int32Array {
  const ends = new Int32Array(text.length);
  ends.fill(-1);
  const opens: number[] = [];

  for (let cursor = 0; cursor < text.length; cursor += 1) {
    if (text[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (text[cursor] === "[") {
      opens.push(cursor);
      continue;
    }
    if (text[cursor] === "]") {
      const open = opens.pop();
      if (open !== undefined) ends[open] = cursor;
    }
  }

  return ends;
}

function markdownLinkCloseAfterDestination(text: string, cursor: number): boolean {
  while (isHtmlAsciiWhitespace(text[cursor])) cursor += 1;
  if (text[cursor] === ")") return true;

  const opening = text[cursor];
  if (opening !== '"' && opening !== "'" && opening !== "(") return false;
  const closing = opening === "(" ? ")" : opening;
  cursor += 1;

  while (cursor < text.length) {
    if (text[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (text[cursor] === closing) {
      cursor += 1;
      break;
    }
    cursor += 1;
  }
  if (text[cursor - 1] !== closing) return false;

  while (isHtmlAsciiWhitespace(text[cursor])) cursor += 1;
  return text[cursor] === ")";
}

/**
 * Return the start of a dangerous-scheme Markdown destination only when it is
 * part of a syntactically active inline link or image. A bare scheme spelling,
 * a prose label followed by a parenthesized aside, and code-span examples are
 * data, not execution surfaces.
 *
 * The scheme must begin the destination. `[x](https://example.test/?u=data:…)`
 * is an ordinary link whose *query* mentions a scheme, so it is not a finding;
 * only the destination the browser would actually resolve is scanned.
 */
function markdownDangerousDestinationOffset(
  text: string,
  openParenOffset: number,
): number | undefined {
  let cursor = openParenOffset + 1;
  while (isHtmlAsciiWhitespace(text[cursor])) cursor += 1;
  if (cursor >= text.length) return undefined;

  if (text[cursor] === "<") {
    const destinationStart = cursor + 1;
    const destinationEnd = text.indexOf(">", destinationStart);
    if (destinationEnd === -1) return undefined;
    return markdownLinkCloseAfterDestination(text, destinationEnd + 1) &&
      markdownDangerousSchemeOffsetAt(text, destinationStart, text.length) !== undefined
      ? destinationStart
      : undefined;
  }

  const destinationStart = cursor;
  let nestedParens = 0;
  while (cursor < text.length) {
    const character = text[cursor];
    if (isHtmlAsciiWhitespace(character) && nestedParens === 0) {
      return markdownLinkCloseAfterDestination(text, cursor) &&
        markdownDangerousSchemeOffsetAt(text, destinationStart, text.length) !== undefined
        ? destinationStart
        : undefined;
    }
    if (character === "(") {
      nestedParens += 1;
    } else if (character === ")") {
      if (nestedParens === 0) {
        return markdownDangerousSchemeOffsetAt(text, destinationStart, text.length) !== undefined
          ? destinationStart
          : undefined;
      }
      nestedParens -= 1;
    }
    cursor += 1;
  }

  return undefined;
}

function normalizedMarkdownReferenceLabel(
  text: string,
  openOffset: number,
  closeOffset: number,
): string | undefined {
  const source = text.slice(openOffset + 1, closeOffset);
  if (source.length === 0) return undefined;
  let sourceCharacters = 0;
  for (const _character of source) {
    sourceCharacters += 1;
    if (sourceCharacters > 999) return undefined;
  }

  let unescaped = "";
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source[cursor] as string;
    if (
      character === "\\" &&
      cursor + 1 < source.length &&
      isMarkdownEscapablePunctuation(source[cursor + 1])
    ) {
      cursor += 1;
      unescaped += source[cursor] as string;
      continue;
    }
    // CommonMark link labels cannot contain an unescaped bracket.
    if (character === "[" || character === "]") return undefined;
    unescaped += character;
  }

  const normalized = unescaped
    .trim()
    .replace(/[\t\n\r ]+/g, " ")
    .toLowerCase()
    // JavaScript lowercasing does not perform the full folds CommonMark's
    // normative example requires: capital sharp-S lowers to sharp-S, while
    // both sharp-S forms must match "ss"; final sigma likewise folds to sigma.
    .replaceAll("ß", "ss")
    .replaceAll("ς", "σ");
  return normalized === "" ? undefined : normalized;
}

function markdownReferenceTitleTailIsValid(text: string, cursor: number, lineEnd: number): boolean {
  while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
  if (cursor === lineEnd) return true;

  const opening = text[cursor];
  if (opening !== '"' && opening !== "'" && opening !== "(") return false;
  const closing = opening === "(" ? ")" : opening;
  cursor += 1;
  while (cursor < lineEnd) {
    if (text[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (text[cursor] === closing) {
      cursor += 1;
      while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
      return cursor === lineEnd;
    }
    cursor += 1;
  }
  return false;
}

function markdownReferenceDefinitionEnd(
  text: string,
  destinationEnd: number,
  destinationLineEnd: number,
  containerMarkers: readonly MarkdownContainerMarker[],
): number | undefined {
  let cursor = destinationEnd;
  while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
  if (cursor < destinationLineEnd) {
    return markdownReferenceTitleTailIsValid(text, destinationEnd, destinationLineEnd)
      ? destinationLineEnd
      : undefined;
  }
  if (destinationLineEnd === text.length) return destinationLineEnd;

  const nextLineStart = markdownNextLineStart(text, destinationLineEnd);
  const nextLineEnd = markdownLineEnd(text, nextLineStart);
  const nextContentStart = markdownContainerContinuationStart(
    text,
    nextLineStart,
    nextLineEnd,
    containerMarkers,
  );
  if (nextContentStart !== undefined) {
    cursor = nextContentStart;
    if (
      (text[cursor] === '"' || text[cursor] === "'" || text[cursor] === "(") &&
      markdownReferenceTitleTailIsValid(text, cursor, nextLineEnd)
    ) {
      return nextLineEnd;
    }
  }

  // A non-title next line is ordinary content; the destination-only
  // definition still ends on its own line.
  return destinationLineEnd;
}

interface MarkdownReferenceDefinition {
  readonly label: string;
  readonly dangerousOffset: number | null;
  readonly endOffset: number;
}

type MarkdownContainerMarker =
  | { readonly kind: "quote" }
  | { readonly kind: "list"; readonly continuationWidth: number };

interface MarkdownContainerPrefix {
  readonly contentStart: number;
  readonly markers: readonly MarkdownContainerMarker[];
}

function markdownListMarkerEnd(
  text: string,
  markerStart: number,
  contentOffset: number,
): number | undefined {
  const marker = text[markerStart];
  if (marker === "-" || marker === "+" || marker === "*") return markerStart + 1;

  let cursor = markerStart;
  let digits = 0;
  while (
    cursor < contentOffset &&
    digits < 10 &&
    (text[cursor] as string) >= "0" &&
    (text[cursor] as string) <= "9"
  ) {
    cursor += 1;
    digits += 1;
  }
  return digits >= 1 && digits <= 9 && (text[cursor] === "." || text[cursor] === ")")
    ? cursor + 1
    : undefined;
}

/**
 * Validate the physical prefix before block content. CommonMark removes block
 * quote and list-item markers before applying the ordinary three-space rule to
 * a link-reference definition, so `> [a]: …` and `- [a]: …` are definitions
 * even though `[` is more than three source columns from the line start.
 */
function markdownContainerPrefixAt(
  text: string,
  lineStart: number,
  contentOffset: number,
): MarkdownContainerPrefix | undefined {
  let cursor = lineStart;
  const markers: MarkdownContainerMarker[] = [];
  while (cursor < contentOffset) {
    const indentationStart = cursor;
    let indentation = 0;
    while (cursor < contentOffset && text[cursor] === " " && indentation < 4) {
      cursor += 1;
      indentation += 1;
    }
    if (indentation > 3) return undefined;
    if (cursor === contentOffset) return { contentStart: cursor, markers };

    if (text[cursor] === ">") {
      markers.push({ kind: "quote" });
      cursor += 1;
      if (cursor < contentOffset && (text[cursor] === " " || text[cursor] === "\t")) cursor += 1;
      continue;
    }

    const markerEnd = markdownListMarkerEnd(text, cursor, contentOffset);
    if (markerEnd === undefined || markerEnd >= contentOffset) return undefined;
    cursor = markerEnd;
    let padding = 0;
    while (
      cursor < contentOffset &&
      padding < 4 &&
      (text[cursor] === " " || text[cursor] === "\t")
    ) {
      cursor += 1;
      padding += 1;
    }
    if (
      padding === 0 ||
      (cursor < contentOffset && (text[cursor] === " " || text[cursor] === "\t"))
    ) {
      return undefined;
    }
    markers.push({
      kind: "list",
      continuationWidth: cursor - indentationStart,
    });
  }
  return { contentStart: cursor, markers };
}

/**
 * Locate reference-definition continuation content after repeated block-quote
 * markers and the ordinary 0..3-space definition indentation. A list marker
 * is not a continuation prefix: it starts a new block. List-item continuation
 * is represented by its indentation after the marker from the preceding line.
 */
function markdownContainerContinuationStart(
  text: string,
  lineStart: number,
  lineEnd: number,
  markers: readonly MarkdownContainerMarker[],
): number | undefined {
  let cursor = lineStart;
  for (const marker of markers) {
    if (marker.kind === "quote") {
      let indentation = 0;
      while (cursor < lineEnd && text[cursor] === " " && indentation < 4) {
        cursor += 1;
        indentation += 1;
      }
      if (indentation > 3 || text[cursor] !== ">") return undefined;
      cursor += 1;
      if (cursor < lineEnd && (text[cursor] === " " || text[cursor] === "\t")) cursor += 1;
      continue;
    }

    for (let width = 0; width < marker.continuationWidth; width += 1) {
      if (text[cursor] !== " " && text[cursor] !== "\t") return undefined;
      cursor += 1;
    }
  }

  let indentation = 0;
  while (cursor < lineEnd && text[cursor] === " " && indentation < 4) {
    cursor += 1;
    indentation += 1;
  }
  if (indentation > 3) return undefined;
  return cursor;
}

function markdownReferenceDefinitionAt(
  text: string,
  openOffset: number,
  labelEnd: number,
): MarkdownReferenceDefinition | undefined {
  const lineStart = markdownLineStart(text, openOffset);
  const containerPrefix = markdownContainerPrefixAt(text, lineStart, openOffset);
  if (containerPrefix === undefined) return undefined;
  if (text[labelEnd + 1] !== ":") return undefined;
  const label = normalizedMarkdownReferenceLabel(text, openOffset, labelEnd);
  if (label === undefined) return undefined;

  let cursor = labelEnd + 2;
  let lineEnd = markdownLineEnd(text, cursor);
  while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
  if (cursor === lineEnd && lineEnd < text.length) {
    const nextLineStart = markdownNextLineStart(text, lineEnd);
    const nextLineEnd = markdownLineEnd(text, nextLineStart);
    const nextContentStart = markdownContainerContinuationStart(
      text,
      nextLineStart,
      nextLineEnd,
      containerPrefix.markers,
    );
    if (nextContentStart === undefined) return undefined;
    cursor = nextContentStart;
    lineEnd = nextLineEnd;
  }
  if (cursor >= lineEnd) return undefined;

  let destinationStart = cursor;
  let destinationEnd: number;
  if (text[cursor] === "<") {
    destinationStart = cursor + 1;
    destinationEnd = text.indexOf(">", destinationStart);
    if (destinationEnd === -1 || destinationEnd > lineEnd) return undefined;
    for (let offset = destinationStart; offset < destinationEnd; offset += 1) {
      if (text[offset] === "<" || text[offset] === "\n" || text[offset] === "\r") return undefined;
    }
    cursor = destinationEnd + 1;
  } else {
    let nestedParens = 0;
    while (cursor < lineEnd) {
      const character = text[cursor] as string;
      if (character === "\\") {
        cursor += 2;
        continue;
      }
      if ((character === " " || character === "\t") && nestedParens === 0) break;
      if (character === "<" || character === ">") return undefined;
      if (character === "(") {
        nestedParens += 1;
        if (nestedParens > 32) return undefined;
      } else if (character === ")") {
        if (nestedParens === 0) return undefined;
        nestedParens -= 1;
      }
      cursor += 1;
    }
    if (cursor === destinationStart || nestedParens !== 0) return undefined;
    destinationEnd = cursor;
  }

  const endOffset = markdownReferenceDefinitionEnd(text, cursor, lineEnd, containerPrefix.markers);
  if (endOffset === undefined) return undefined;
  return {
    label,
    dangerousOffset:
      markdownDangerousSchemeOffsetAt(text, destinationStart, destinationEnd) ?? null,
    endOffset,
  };
}

function markdownPreviousLineIsBlank(text: string, lineStart: number): boolean {
  if (lineStart === 0) return true;
  let previousLineEnd = lineStart - 1;
  if (text[previousLineEnd] === "\n" && text[previousLineEnd - 1] === "\r") previousLineEnd -= 1;
  const previousLineStart = markdownLineStart(text, previousLineEnd);
  const contentStart =
    markdownContainerPrefixAt(text, previousLineStart, previousLineEnd)?.contentStart ??
    previousLineStart;
  for (let cursor = contentStart; cursor < previousLineEnd; cursor += 1) {
    if (text[cursor] !== " " && text[cursor] !== "\t") return false;
  }
  return true;
}

interface MarkdownReferenceCatalog {
  readonly destinations: ReadonlyMap<string, number | null>;
  readonly definitionEnds: ReadonlyMap<number, number>;
}

function collectMarkdownReferenceDefinitions(
  text: string,
  labelEnds: Int32Array,
): MarkdownReferenceCatalog {
  const definitions = new Map<string, number | null>();
  const definitionEnds = new Map<number, number>();
  let consecutiveDefinitionLineStart = -1;
  let cursor = 0;
  while (cursor < text.length) {
    const inertEnd = markdownInertEnd(text, cursor);
    if (inertEnd !== undefined) {
      cursor = inertEnd;
      continue;
    }
    if (text.startsWith(CONTROL_COMMENT_OPEN, cursor)) {
      cursor = htmlCommentEndOffset(text, cursor);
      continue;
    }
    if (text[cursor] !== "[" || isMarkdownEscaped(text, cursor)) {
      cursor += 1;
      continue;
    }
    const labelEnd = labelEnds[cursor] ?? -1;
    if (labelEnd < 0) {
      cursor += 1;
      continue;
    }
    const lineStart = markdownLineStart(text, cursor);
    if (
      lineStart !== 0 &&
      lineStart !== consecutiveDefinitionLineStart &&
      !markdownPreviousLineIsBlank(text, lineStart)
    ) {
      cursor = labelEnd + 1;
      continue;
    }
    const definition = markdownReferenceDefinitionAt(text, cursor, labelEnd);
    if (definition !== undefined) {
      if (!definitions.has(definition.label)) {
        definitions.set(definition.label, definition.dangerousOffset);
      }
      definitionEnds.set(cursor, definition.endOffset);
      consecutiveDefinitionLineStart = markdownNextLineStart(text, definition.endOffset);
    }
    cursor = labelEnd + 1;
  }
  return { destinations: definitions, definitionEnds };
}

/**
 * CommonMark also makes a URI-shaped `<scheme:…>` an autolink. It is a real
 * Markdown URL surface, unlike a bare scheme spelling in prose. Keep the scan
 * intentionally narrow: the character after `<` must begin one of the dangerous
 * schemes, the URL cannot contain ASCII whitespace or another angle bracket, and
 * a backslash-escaped opener remains ordinary text.
 */
function markdownDangerousAutolinkOffset(text: string, openOffset: number): number | undefined {
  if (isMarkdownEscaped(text, openOffset)) return undefined;

  const destinationStart = openOffset + 1;
  if (dangerousSchemeOffsetAt(text, destinationStart, text.length) === undefined) return undefined;

  for (let cursor = destinationStart; cursor < text.length; cursor += 1) {
    const character = text[cursor] as string;
    if (character === ">") return destinationStart;
    if (character === "<" || isHtmlAsciiWhitespace(character)) return undefined;
  }

  return undefined;
}

/**
 * Markdown autolinks are not recognized inside a complete CommonMark HTML
 * start tag. `scanActiveStartTag` supplies the matching-quote-aware end offset;
 * retain the CommonMark tag-name grammar here so `<javascript:...>` remains a
 * standalone autolink rather than being mistaken for a custom HTML element.
 */
function completeMarkdownHtmlStartTagEnd(text: string, openOffset: number): number | undefined {
  const tag = scanActiveStartTag(text, openOffset);
  if (tag === undefined || !tag.complete || !COMMONMARK_HTML_START_TAG_NAME.test(tag.tagName)) {
    return undefined;
  }
  return tag.endOffset;
}

function collectActiveMarkdownUrls(text: string): ActiveHtmlFinding[] {
  const findings: ActiveHtmlFinding[] = [];
  const labelEnds = markdownLabelEnds(text);
  const referenceCatalog = collectMarkdownReferenceDefinitions(text, labelEnds);
  let cursor = 0;

  while (cursor < text.length) {
    const inertEnd = markdownInertEnd(text, cursor);
    if (inertEnd !== undefined) {
      cursor = inertEnd;
      continue;
    }
    if (text.startsWith(CONTROL_COMMENT_OPEN, cursor)) {
      cursor = htmlCommentEndOffset(text, cursor);
      continue;
    }
    if (text[cursor] === "<") {
      const startTagEnd = completeMarkdownHtmlStartTagEnd(text, cursor);
      if (startTagEnd !== undefined) {
        cursor = startTagEnd;
        continue;
      }
      const autolinkOffset = markdownDangerousAutolinkOffset(text, cursor);
      if (autolinkOffset !== undefined) {
        findings.push({ kind: "url", offset: autolinkOffset });
      }
      cursor += 1;
      continue;
    }
    if (text[cursor] !== "[" || isMarkdownEscaped(text, cursor)) {
      cursor += 1;
      continue;
    }

    const labelEnd = labelEnds[cursor] ?? -1;
    if (labelEnd < 0) {
      cursor += 1;
      continue;
    }

    const nextCharacter = text[labelEnd + 1];
    if (nextCharacter === "(") {
      const destinationOffset = markdownDangerousDestinationOffset(text, labelEnd + 1);
      if (destinationOffset !== undefined) {
        findings.push({ kind: "url", offset: destinationOffset });
      }
      cursor = labelEnd + 1;
      continue;
    }
    // A definition is metadata, not a rendered URL surface by itself.
    if (nextCharacter === ":") {
      cursor = referenceCatalog.definitionEnds.get(cursor) ?? labelEnd + 1;
      continue;
    }

    const ownLabel = normalizedMarkdownReferenceLabel(text, cursor, labelEnd);
    let referenceLabel = ownLabel;
    let referenceEnd = labelEnd;
    if (nextCharacter === "[") {
      const explicitLabelEnd = labelEnds[labelEnd + 1] ?? -1;
      if (explicitLabelEnd < 0) {
        cursor = labelEnd + 1;
        continue;
      }
      referenceLabel =
        explicitLabelEnd === labelEnd + 2
          ? ownLabel
          : normalizedMarkdownReferenceLabel(text, labelEnd + 1, explicitLabelEnd);
      referenceEnd = explicitLabelEnd;
    }
    if (
      referenceLabel !== undefined &&
      referenceCatalog.destinations.get(referenceLabel) !== undefined &&
      referenceCatalog.destinations.get(referenceLabel) !== null
    ) {
      findings.push({ kind: "url", offset: cursor });
    }
    cursor = referenceEnd + 1;
  }

  return findings;
}

function collectActiveMarkup(text: string): ActiveHtmlFinding[] {
  return [...collectActiveHtml(text), ...collectActiveMarkdownUrls(text)];
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
  for (const finding of collectActiveMarkup(rawBrowserTokenizerScanText(body))) {
    findings.add(sourceFindingKey(finding));
  }

  const canonicalFindings = collectActiveMarkup(unicodeCanonicalSourceMappedScanText(body));
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
 * Trusted system-item Markdown may be expressive prose, but the renderer is
 * the sole author of its structural control comments. Reject a trusted body
 * that tries to embed one rather than allowing it to close or forge a face
 * delimiter around otherwise legitimate Markdown.
 */
export function hasAsimpControlComment(body: string): boolean {
  let searchFrom = 0;

  while (true) {
    const openOffset = body.indexOf(CONTROL_COMMENT_OPEN, searchFrom);
    if (openOffset === -1) return false;
    if (isAsimpControlComment(body, openOffset)) return true;
    searchFrom = openOffset + CONTROL_COMMENT_OPEN.length;
  }
}

/**
 * Return the first malformed UTF-16 code-unit offset, if any. JavaScript
 * strings can carry lone surrogate halves, but Unicode normalization and
 * `TextEncoder` do not preserve them: the latter serializes a replacement
 * character. Callers that fingerprint or render a projection must reject them
 * before either operation so every face and its fingerprint describe the same
 * scalar-value input.
 */
export function firstUnpairedUtf16SurrogateOffset(value: string): number | undefined {
  for (let offset = 0; offset < value.length; offset += 1) {
    const codeUnit = value.charCodeAt(offset);
    const highSurrogate = codeUnit >= 0xd800 && codeUnit <= 0xdbff;
    const lowSurrogate = codeUnit >= 0xdc00 && codeUnit <= 0xdfff;

    if (highSurrogate) {
      const next = value.charCodeAt(offset + 1);
      const nextIsLowSurrogate = next >= 0xdc00 && next <= 0xdfff;
      if (!nextIsLowSurrogate) return offset;
      offset += 1;
      continue;
    }
    if (lowSurrogate) return offset;
  }

  return undefined;
}

function hasAsciiUrlControlOrSpace(value: string): boolean {
  for (let offset = 0; offset < value.length; offset += 1) {
    const codeUnit = value.charCodeAt(offset);
    if (codeUnit <= 0x20 || codeUnit === 0x7f) return true;
  }
  return false;
}

/** Split raw navigation text before `?`; query data is not part of route matching. */
function workerPathname(value: string): string {
  const queryOffset = value.indexOf("?");
  return queryOffset === -1 ? value : value.slice(0, queryOffset);
}

/**
 * Worker routes are declared without encoded pathname segments. Reject every
 * literal percent in the pathname, including malformed escapes, before URL
 * parsing can preserve, normalize, or a router can decode one or more layers.
 * The query is intentionally excluded: percent-encoded query values are data.
 */
function hasEncodedWorkerPathSegment(pathname: string): boolean {
  return pathname.includes("%");
}

/** Reject dot segments before URL construction silently normalizes them. */
function hasUnsafeWorkerPathTraversal(pathname: string): boolean {
  return pathname.split("/").some((segment) => segment === "." || segment === "..");
}

/**
 * `next_actions` are executable navigation instructions, not general links.
 * Keep them on the Worker origin. They may address both public faces and API
 * routes, while still permitting a normal query string such as
 * `/v1/sessions/SES-1/pack?profile=working`.
 */
export function isSafeWorkerPath(value: string): boolean {
  const pathname = workerPathname(value);

  if (
    value.startsWith("//") ||
    URL_SCHEME.test(value) ||
    value.includes("\\") ||
    value.includes("#") ||
    value.includes("`") ||
    hasAsciiUrlControlOrSpace(value) ||
    hasEncodedWorkerPathSegment(pathname) ||
    hasUnsafeWorkerPathTraversal(pathname) ||
    !value.startsWith("/")
  ) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(value, WORKER_URL_ORIGIN);
  } catch {
    return false;
  }

  return (
    url.origin === WORKER_URL_ORIGIN &&
    url.username === "" &&
    url.password === "" &&
    url.hash === ""
  );
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

  const envelopeKeys = neutralizeReservedEnvelopeKeys(text);
  text = envelopeKeys.text;
  if (envelopeKeys.count > 0) {
    findings.push({ marker: "envelope-key-forgery", count: envelopeKeys.count });
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

export interface TrustedBodyFenceAudit {
  /**
   * Offset of a line-start fence opener that no later line of `text` closes —
   * one whose fenced block would swallow every byte that follows it.
   * `undefined` when the body's top-level fence state ends closed.
   */
  readonly unclosedFenceOffset: number | undefined;
}

/**
 * Audit one trusted body against the one fence invariant that survives
 * prepare.ts's backtick ban: tilde fences. The markdown face renders trusted
 * bodies unmodified between renderer-authored blank lines, so a body whose
 * fenced block is still open at its end would swallow every following byte —
 * the item-end delimiter, the trailer, and face-end. Using the same
 * CommonMark interpretation as `markdownFencedCodeBlockEnd`: openers are
 * 0-3-space-indented runs of three or more backticks or tildes at a line
 * start, backtick info strings may not contain a backtick, closers are
 * same-character runs at least as long as their opener with only whitespace
 * after, and everything inside an open block is inert until such a closer
 * arrives. Walking the body's lines from closed state therefore reproduces
 * exactly the document-level fence state the face inherits after the body.
 */
export function auditTrustedBodyFences(text: string): TrustedBodyFenceAudit {
  let openDelimiter = "";
  let openLength = 0;
  let openOffset = -1;

  let cursor = 0;
  while (cursor < text.length) {
    const lineEnd = markdownLineEnd(text, cursor);
    if (openDelimiter === "") {
      let position = cursor;
      let indentation = 0;
      while (text[position] === " " && indentation < 4) {
        position += 1;
        indentation += 1;
      }
      const delimiter = text[position];
      if (
        indentation <= 3 &&
        (delimiter === "`" || delimiter === "~") &&
        !isMarkdownEscaped(text, position)
      ) {
        let runLength = 0;
        while (text[position + runLength] === delimiter) runLength += 1;
        const infoString = text.slice(position + runLength, lineEnd).trim();
        if (runLength >= 3 && !(delimiter === "`" && infoString.includes("`"))) {
          openDelimiter = delimiter;
          openLength = runLength;
          openOffset = position;
        }
      }
    } else {
      let position = cursor;
      let closingIndentation = 0;
      while (text[position] === " " && closingIndentation < 4) {
        position += 1;
        closingIndentation += 1;
      }
      if (closingIndentation <= 3) {
        let closingLength = 0;
        while (text[position + closingLength] === openDelimiter) closingLength += 1;
        if (closingLength >= openLength) {
          let tail = position + closingLength;
          while (text[tail] === " " || text[tail] === "\t") tail += 1;
          if (tail === lineEnd) {
            openDelimiter = "";
            openLength = 0;
          }
        }
      }
    }
    cursor = markdownNextLineStart(text, lineEnd);
  }

  return {
    unclosedFenceOffset: openDelimiter === "" ? undefined : openOffset,
  };
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
