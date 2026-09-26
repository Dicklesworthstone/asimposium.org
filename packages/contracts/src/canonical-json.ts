/**
 * The one canonical JSON codec for integrity digests (bead asimposiumorg-phg).
 *
 * Rules, pinned by golden vectors in fixtures/canonical-json.vectors.json:
 * - object keys sorted by UTF-16 code unit (JavaScript's default sort), not by
 *   code point, so a key with a surrogate pair sorts before U+E000..U+FFFF;
 * - strings, booleans, null and numbers serialized exactly as JSON.stringify
 *   (so -0 is "0", 1.0 is "1", 1e21 is "1e+21");
 * - no whitespace;
 * - non-finite numbers, undefined, functions, symbols and bigints are refused,
 *   including as object members and array holes (never silently dropped).
 *
 * Callers may supply their own error factory so a refusal keeps the caller's
 * error class (Krater's input error, the split service's TypeError).
 */

export class CanonicalJsonError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

export type CanonicalJsonRefusal = (message: string) => never;

const refuseDefault: CanonicalJsonRefusal = (message) => {
  throw new CanonicalJsonError(message);
};

export function canonicalJson(
  value: unknown,
  refuse: CanonicalJsonRefusal = refuseDefault,
): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) refuse("canonical JSON numbers must be finite.");
    return JSON.stringify(value);
  }
  // Array.from visits holes as undefined, so a sparse array is refused rather
  // than serialized as invalid JSON ("[1,,3]").
  if (Array.isArray(value))
    return `[${Array.from(value, (item) => canonicalJson(item, refuse)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], refuse)}`)
      .join(",")}}`;
  }
  return refuse("canonical JSON values must be JSON values.");
}
