/**
 * Canonicalization for the signed service envelope (Fable §14.1, ADR-1).
 *
 * Sponsor writes do not reach D1 from Vercel. A Next.js server action on the
 * apex signs an envelope naming the acting human, and the Worker — the single
 * writer and single validator — verifies it. The bytes that get signed are
 * defined here, and this file is the authoritative definition: `apps/web`
 * mirrors it, and a shared golden-vector corpus keeps the two honest.
 *
 * ## Why not JSON.stringify
 *
 * `JSON.stringify` is not a canonicalization. Key order is insertion order,
 * whitespace is a choice, and `-0`, `1e3` and non-BMP escapes all have more
 * than one faithful spelling. Two implementations that both "sign the JSON"
 * disagree on the first unusual input, and the failure looks like a bad key.
 *
 * ## The framing
 *
 * Fields are emitted in a fixed order, each as
 *
 *     <byteLen(name)> ":" <name> ":" <byteLen(value)> ":" <value> 0x1E
 *
 * with lengths counted in **UTF-8 bytes**, not UTF-16 code units. Explicit
 * length prefixes make the encoding injection-proof: no value containing a
 * separator, a newline, or a record terminator can be reframed as a different
 * field list. This is the classic defence against the `("a","bc") == ("ab","c")`
 * concatenation collision, and it is why a delimiter-only scheme is not enough.
 *
 * The payload appears only as a SHA-256 digest, and the signature is computed
 * over these bytes rather than included in them. That does not make the
 * canonical form loggable: it still carries attribution and the nonce.
 *
 * Canonicalization is deliberately **total** — it encodes any string, including
 * control characters and non-BMB code points, without ambiguity. Refusing
 * strange claims is a separate, stricter job done by the verifier's bounds
 * check (`envelope.ts`). Keeping the two apart means the framing stays correct
 * even for input the validator would reject, which is what defence in depth
 * means here.
 */

/** Envelope format version. A change here is a new signing domain. */
export const ENVELOPE_VERSION = "asimp-env-1";

/** Domain separation prefix, so these bytes cannot be replayed into another scheme. */
const DOMAIN_PREFIX = `${ENVELOPE_VERSION}\n`;

const FIELD_SEPARATOR = ":";
const RECORD_TERMINATOR = 0x1e;

/**
 * The signed field list, in canonical order.
 *
 * Order is fixed here rather than derived from the object, because "iterate the
 * keys" is exactly the ambiguity this file exists to remove. Adding a field is
 * a version bump: an old verifier would ignore it, which would let a signer
 * add unsigned meaning.
 */
export const CANONICAL_FIELDS = [
  "v",
  "kid",
  "alg",
  "iss",
  "aud",
  "iat",
  "exp",
  "nonce",
  "method",
  "route",
  "action",
  "principal_type",
  "principal_id",
  "payload_sha256",
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

/** The signed portion of a service envelope. The signature is carried beside it. */
export interface ServiceEnvelopeClaims {
  /** Envelope format version; must equal ENVELOPE_VERSION. */
  v: string;
  /** Non-secret key identifier, used to select a verification key. */
  kid: string;
  /** Signature algorithm; only Ed25519 is accepted. */
  alg: string;
  /** Issuing plane: the Agora server action. */
  iss: string;
  /** Audience plane: the Stoa Worker. */
  aud: string;
  /** Issued-at, integer seconds since the epoch. */
  iat: number;
  /** Expiry, integer seconds since the epoch. */
  exp: number;
  /** Single-use value; replay is refused on the second presentation. */
  nonce: string;
  /** HTTP method the envelope authorises. */
  method: string;
  /** Route *template*, never a filled path: `/v1/p/:id/directives`. */
  route: string;
  /** Typed action name, so an envelope for one write cannot authorise another. */
  action: string;
  /** Acting principal class. Sponsor writes are the only class at S-6. */
  principal_type: string;
  /** Opaque stable id for the acting human. Never an email address. */
  principal_id: string;
  /** Lowercase hex SHA-256 of the exact request body bytes. */
  payload_sha256: string;
}

const encoder = new TextEncoder();

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Field values are strings; numbers are rendered as base-10 integers. */
function fieldValue(claims: ServiceEnvelopeClaims, field: CanonicalField): string {
  const value = claims[field];
  if (typeof value === "number") {
    // Integer seconds only: a fractional or non-finite timestamp has more than
    // one spelling, so it is rejected before it reaches canonicalization.
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`field "${field}" must be a safe integer`);
    }
    return String(value);
  }
  return value;
}

/**
 * The exact bytes an Ed25519 signature covers.
 *
 * Deterministic: the same claims always produce the same bytes, regardless of
 * the order the object's keys happen to be in.
 */
export function canonicalBytes(claims: ServiceEnvelopeClaims): Uint8Array {
  const chunks: Uint8Array[] = [encoder.encode(DOMAIN_PREFIX)];
  for (const field of CANONICAL_FIELDS) {
    const nameBytes = encoder.encode(field);
    const valueBytes = encoder.encode(fieldValue(claims, field));
    chunks.push(
      encoder.encode(`${nameBytes.length}${FIELD_SEPARATOR}`),
      nameBytes,
      encoder.encode(`${FIELD_SEPARATOR}${valueBytes.length}${FIELD_SEPARATOR}`),
      valueBytes,
      new Uint8Array([RECORD_TERMINATOR]),
    );
  }
  return concatBytes(chunks);
}

/**
 * The canonical form as text. **Test and vector generation only.**
 *
 * Not safe to log. It excludes the payload bytes, but it carries the full
 * attribution — principal id, action, route, kid — and the nonce, which is a
 * single-use credential for the duration of the envelope. The never-log list
 * (§14.3) covers attribution and nonces as surely as it covers tokens; use
 * `buildAuthDiagnostic` for anything that reaches an operator.
 */
export function canonicalString(claims: ServiceEnvelopeClaims): string {
  return new TextDecoder().decode(canonicalBytes(claims));
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new TypeError("expected lowercase hex of even length");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/**
 * Lowercase hex SHA-256 of exactly the supplied byte view.
 *
 * A Node `Buffer` is a `Uint8Array`, but its `.slice()` is another view into
 * the same (often pooled) allocation. Passing that `.buffer` to WebCrypto can
 * therefore hash bytes before and after the caller's selected window. Copying
 * through the explicit view keeps the runtime behavior as narrow as the type.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const exact = new Uint8Array(bytes.byteLength);
  exact.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", exact.buffer);
  return toHex(new Uint8Array(digest));
}

/** Digest of a request body, from the exact bytes that will be transmitted. */
export async function payloadDigest(body: string | Uint8Array): Promise<string> {
  return sha256Hex(typeof body === "string" ? encoder.encode(body) : body);
}

/** Stable digest of the canonical form; used by the shared vector corpus. */
export async function canonicalDigest(claims: ServiceEnvelopeClaims): Promise<string> {
  return sha256Hex(canonicalBytes(claims));
}

/**
 * Length-independent comparison for digests and other attacker-influenced
 * strings. Both sides are hex of fixed width here, but the habit matters more
 * than this one call site.
 */
export function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  // Compare a fixed number of bytes so the loop count does not reveal the
  // length of the expected value.
  const width = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < width; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}
