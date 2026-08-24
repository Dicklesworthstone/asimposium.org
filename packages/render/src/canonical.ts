/**
 * Canonical serialization and the shared face fingerprint.
 *
 * Fable §7.1 axiom 7: "public packs are deterministic (same cursor + profile +
 * budget → byte-identical)". Determinism has to survive object key order, so
 * every structure this package hashes or emits goes through `stableStringify`.
 */

/** Recursively key-sorted JSON. `undefined` members are dropped, as in JSON. */
export function stableStringify(value: unknown, indent = 0): string {
  const serialized = JSON.stringify(sortValue(value), null, indent);
  if (serialized === undefined) {
    // JSON.stringify has a deliberately wider runtime return type than this
    // canonical face boundary: unsupported root values produce `undefined`,
    // even though the same values are omitted from objects or become null in
    // arrays. Refuse with a fixed message instead of violating our `string`
    // contract or reflecting a caller-controlled value into diagnostics.
    throw new TypeError("stableStringify root has no JSON representation");
  }
  return serialized;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sorted = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(source).sort()) {
    const member = source[key];
    if (member !== undefined && typeof member !== "function" && typeof member !== "symbol") {
      sorted[key] = sortValue(member);
    }
  }
  return sorted;
}

/**
 * Fingerprint algorithm identifier. FNV-1a is a *non-cryptographic* checksum:
 * it detects drift between faces, and it is not an integrity control. ETags and
 * the per-item digests of Fable §7.3 use the Worker's SHA-256, not this.
 * Naming it in the output is Rule A4 applied to ourselves.
 */
export const FINGERPRINT_ALGORITHM = "fnv1a64";

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a over the UTF-8 bytes of `text`, as `fnv1a64:<16 hex digits>`. */
export function contentFingerprint(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hash = FNV_OFFSET_BASIS;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return `${FINGERPRINT_ALGORITHM}:${hash.toString(16).padStart(16, "0")}`;
}

/** Byte length of a face body, for the `bytes` field of Fable §7.3. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Newline count of a pretty-printed fragment, for indent-adjusted byte math. */
export function countNewlines(text: string): number {
  let count = 0;
  for (const character of text) if (character === "\n") count += 1;
  return count;
}
