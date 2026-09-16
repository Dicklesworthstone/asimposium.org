/** Read-side commitments shared by citation lists, history and backlinks. */
export interface CitationContentRow {
  readonly problem_id: string;
  readonly seq: number;
  readonly public_seq: number;
  readonly payload_json: string | null;
  readonly payload_sha256: string;
  readonly content_sha256: string | null;
  readonly redacted_at: string | null;
}

export const CITATION_EVENT_MAX_BYTES = 65_536;

/**
 * A surviving projection is not publication authority. Verify the currently
 * available content against its public event before inspecting any fields.
 * This verifies a payload commitment, not the entire event chain or its science.
 */
export async function verifiedCitationContent(
  problemId: string,
  row: CitationContentRow,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (
    row.problem_id !== problemId ||
    !Number.isSafeInteger(row.seq) ||
    row.seq < 1 ||
    !Number.isSafeInteger(row.public_seq) ||
    row.seq > row.public_seq ||
    row.redacted_at !== null ||
    typeof row.payload_json !== "string" ||
    row.payload_json.length > CITATION_EVENT_MAX_BYTES ||
    !/^[0-9a-f]{64}$/.test(row.payload_sha256) ||
    row.content_sha256 !== row.payload_sha256
  ) {
    return undefined;
  }
  const bytes = new TextEncoder().encode(row.payload_json);
  if (bytes.byteLength > CITATION_EVENT_MAX_BYTES) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actual = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (actual !== row.payload_sha256) return undefined;
  try {
    const value: unknown = JSON.parse(row.payload_json);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  } catch {
    return undefined;
  }
}

const ADJACENT_REFERENCE_CHARACTER = /[\p{L}\p{N}\p{M}_/@%+\-]/u;

/**
 * Backlinks are mentions, not proof of use. Match a complete local citation ID,
 * never L-1 inside L-10, a URL, a filename, or a different pinned version.
 * Bare mentions can be included only when the caller explicitly asks for them.
 */
export function mentionsCitation(
  text: string,
  citationId: string,
  version: number,
  includeUnversioned = false,
): boolean {
  if (
    !/^L-[0-9]+$/.test(citationId) ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    text.length > CITATION_EVENT_MAX_BYTES
  ) {
    return false;
  }
  for (const match of text.matchAll(/L-[0-9]+(?:@[1-9][0-9]*)?/g)) {
    const token = match[0];
    const start = match.index;
    const end = start + token.length;
    const before = text.slice(Math.max(0, start - 2), start).match(/.$/u)?.[0];
    const after = text.slice(end, end + 2).match(/^./u)?.[0];
    if (
      (before !== undefined && (ADJACENT_REFERENCE_CHARACTER.test(before) || before === ".")) ||
      (after !== undefined && ADJACENT_REFERENCE_CHARACTER.test(after)) ||
      (after === "." && /[\p{L}\p{N}_]/u.test(text.slice(end + 1, end + 3)))
    ) {
      continue;
    }
    const [id, pin] = token.split("@");
    if (id !== citationId) continue;
    if (pin === undefined ? includeUnversioned : pin === String(version)) return true;
  }
  return false;
}
