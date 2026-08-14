/**
 * Text measurements the served-text gates are built on (bead asimposiumorg-8xn, OPS.1).
 *
 * The word cap of Rule A8 / R-12 is only a real fence if "a word" means one thing everywhere, so
 * the counter lives here and both the runtime assertion and the tests call it.
 */

/** Normalize to LF and guarantee exactly one trailing newline, so digests survive a checkout. */
export function normalizeServedText(raw: string): string {
  const lf = raw.replace(/\r\n?/g, "\n");
  return `${lf.replace(/\n+$/, "")}\n`;
}

/**
 * Words, counted the way a human editor would: whitespace-separated runs that contain at least one
 * letter or digit. Bare punctuation and list bullets do not inflate the count toward the cap.
 */
export function countWords(text: string): number {
  let count = 0;
  for (const token of text.split(/\s+/)) {
    if (/[\p{L}\p{N}]/u.test(token)) count += 1;
  }
  return count;
}

/**
 * Conservative token estimate: UTF-8 bytes over four. This is a budget heuristic, not a tokenizer,
 * and it is labelled that way wherever it is displayed. It over-counts English prose slightly,
 * which is the safe direction for a budget (Fable §5.2's 2,500-token capsule ceiling).
 */
export function estimateTokens(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x80) bytes += 1;
    else if (codePoint < 0x800) bytes += 2;
    else if (codePoint < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return Math.ceil(bytes / 4);
}

/**
 * An open fenced code block: which marker opened it and how long the opening run was. CommonMark
 * closes a fence only with a run of the *same* marker that is at least as long as the opener, so
 * both facts have to be carried, not just "we are inside a fence".
 */
interface OpenFence {
  readonly marker: "`" | "~";
  readonly length: number;
}

/** Fence delimiters: up to three spaces of indent, then a run of at least three markers. */
const FENCE_DELIMITER = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** A closing fence carries nothing but the run itself (CommonMark 4.5). */
const FENCE_CLOSER = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * A level-two ATX heading: up to three spaces of indent, exactly two `#`, then a space, a tab, or
 * end of line. `###` is level three and never matches; `##Rules` is not a heading at all.
 */
const ATX_LEVEL_TWO = /^ {0,3}##(?!#)(?:[ \t]+(.*?))?[ \t]*$/;

/** ATX headings may close with a run of `#` preceded by whitespace: `## Rules ##` is "Rules". */
const ATX_CLOSING_SEQUENCE = /[ \t]+#+$/;

/**
 * The fence this line opens, if any. A backtick fence's info string may not itself contain a
 * backtick (CommonMark 4.5), which is what keeps `` `inline code` `` from reading as a fence.
 */
function opensFence(line: string): OpenFence | undefined {
  const match = FENCE_DELIMITER.exec(line);
  if (match === null) return undefined;
  const run = match[1] ?? "";
  const marker = run[0] === "~" ? "~" : "`";
  const info = match[2] ?? "";
  if (marker === "`" && info.includes("`")) return undefined;
  return { marker, length: run.length };
}

/** True when this line closes `open`: same marker, at least as long, nothing else on the line. */
function closesFence(line: string, open: OpenFence): boolean {
  const match = FENCE_CLOSER.exec(line);
  if (match === null) return false;
  const run = match[1] ?? "";
  return run[0] === open.marker && run.length >= open.length;
}

/** The heading text of a level-two ATX heading, or `undefined` when the line is not one. */
function levelTwoHeading(line: string): string | undefined {
  const match = ATX_LEVEL_TWO.exec(line);
  if (match === null) return undefined;
  return (match[1] ?? "").replace(ATX_CLOSING_SEQUENCE, "").trim();
}

/**
 * The body of one level-two section of a markdown document, from `## <heading>` up to the next
 * level-two heading. Level-three headings inside the section are kept, which is what makes the
 * word cap cover the rules and their subheadings but not the preamble around them.
 *
 * The scan is fence-aware, and that is load-bearing rather than cosmetic. A heading-shaped line
 * inside a fenced example is *content*: a renderer shows it as code, so treating it as a section
 * boundary would let a bloated rules section hide its tail behind a fenced `## Anything` and
 * report itself inside the Rule A8 cap. Under-counting is the direction that fails silently, so
 * the scan errs the other way: an unclosed fence runs to the end of the document (as CommonMark
 * says it does), which over-counts and trips the cap loudly.
 *
 * Deliberately not supported: setext headings (`Rules` over `---`). Their absence can only extend
 * a section, never truncate it, so it can only make the cap stricter — and the served documents
 * use ATX throughout, checked by the gate tests.
 *
 * Returns `undefined` when the heading is absent, so a caller can refuse loudly rather than
 * silently measuring an empty string (which would make the cap vacuously green).
 */
export function extractSection(markdown: string, heading: string): string | undefined {
  const lines = markdown.split("\n");
  const wanted = heading.trim().toLowerCase();
  let open: OpenFence | undefined;
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    if (open !== undefined) {
      if (closesFence(line, open)) open = undefined;
      continue;
    }

    const fence = opensFence(line);
    if (fence !== undefined) {
      open = fence;
      continue;
    }

    const found = levelTwoHeading(line);
    if (found === undefined) continue;

    if (start === -1) {
      if (found.toLowerCase() === wanted) start = i + 1;
      continue;
    }

    end = i;
    break;
  }

  if (start === -1) return undefined;
  return lines.slice(start, end).join("\n").trim();
}
