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
 * The body of one level-two section of a markdown document, from `## <heading>` up to the next
 * level-two heading. Level-three headings inside the section are kept, which is what makes the
 * word cap cover the rules and their subheadings but not the preamble around them.
 *
 * Returns `undefined` when the heading is absent, so a caller can refuse loudly rather than
 * silently measuring an empty string (which would make the cap vacuously green).
 */
export function extractSection(markdown: string, heading: string): string | undefined {
  const lines = markdown.split("\n");
  const wanted = heading.trim().toLowerCase();
  let start = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const match = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (match === null) continue;
    if ((match[1] ?? "").trim().toLowerCase() === wanted) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return undefined;

  const collected: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^##[ \t]+/.test(line)) break;
    collected.push(line);
  }
  return collected.join("\n").trim();
}
