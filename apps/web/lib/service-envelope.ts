/**
 * Signed service envelope — the Agora (apex) signing side.
 *
 * Sponsor writes are Next.js server actions. They do not touch D1: the Worker
 * is the single writer and the single validator (ADR-1, Fable §14.1). A server
 * action mints an envelope naming the acting human, signs it with the apex's
 * Ed25519 private key, and sends it to `a.asimposium.org`, which verifies and
 * attributes the write.
 *
 * ## Two properties this file exists to hold
 *
 * **The session cookie never leaves the apex.** It is host-only by construction
 * (`auth.ts`), and nothing here forwards it. The envelope carries an opaque
 * principal id derived from the session — never the cookie, never the Google
 * token, never the email address. A Fellow must never be able to obtain a
 * human's session material, and the way to guarantee that is for it never to
 * cross the seam in the first place.
 *
 * **The canonical bytes match the Worker's.** This is an independent
 * implementation of the canonicalization in `apps/wire/src/auth/canonical.ts`,
 * and the two are pinned to a shared golden-vector corpus
 * (`apps/wire/src/auth/service-envelope-vectors.json`). Two implementations
 * that both "sign the JSON" agree until the first unusual input; a shared
 * corpus turns that eventual production failure into a test failure now.
 *
 * The private key lives in the Vercel environment and is read at call time,
 * never at module scope — `auth.ts` is under a static contract that forbids
 * module-scope secret reads, and the same discipline applies here.
 */

/** Envelope format version. Must match the Worker's ENVELOPE_VERSION. */
export const ENVELOPE_VERSION = "asimp-env-1";

const DOMAIN_PREFIX = `${ENVELOPE_VERSION}\n`;
const FIELD_SEPARATOR = ":";
const RECORD_TERMINATOR = 0x1e;

/** Signed field list, in canonical order. Must match the Worker's, exactly. */
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

export interface ServiceEnvelopeClaims {
  v: string;
  kid: string;
  alg: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  nonce: string;
  method: string;
  route: string;
  action: string;
  principal_type: string;
  principal_id: string;
  payload_sha256: string;
}

export interface ServiceEnvelope {
  claims: ServiceEnvelopeClaims;
  signature: string;
}

const encoder = new TextEncoder();

// RFC 8410 OneAsymmetricKey prefix for an Ed25519 private key whose payload is
// the 32-byte seed. WebCrypto imports Ed25519 private keys as PKCS#8; `raw` is
// the public-key format and therefore cannot portably import a signing seed.
const ED25519_PKCS8_SEED_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

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

/**
 * The exact bytes the signature covers.
 *
 * Length-prefixed framing, lengths in UTF-8 bytes. See the Worker's
 * `canonical.ts` for why `JSON.stringify` is not a canonicalization.
 */
export function canonicalBytes(claims: ServiceEnvelopeClaims): Uint8Array {
  const chunks: Uint8Array[] = [encoder.encode(DOMAIN_PREFIX)];
  for (const field of CANONICAL_FIELDS) {
    const raw = claims[field];
    if (typeof raw === "number" && !Number.isSafeInteger(raw)) {
      throw new TypeError(`field "${field}" must be a safe integer`);
    }
    const nameBytes = encoder.encode(field);
    const valueBytes = encoder.encode(typeof raw === "number" ? String(raw) : raw);
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

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * A detached copy of exactly this byte view.
 *
 * `Buffer.prototype.slice()` is a view, unlike `Uint8Array.prototype.slice()`.
 * Passing its `.buffer` to WebCrypto can therefore hash a Node pool rather
 * than the selected bytes.  Copying from the view reads only
 * `byteOffset..byteOffset + byteLength`, works for both Buffer and ordinary
 * Uint8Array inputs, and never mutates caller-owned storage.
 */
function exactBytesBuffer(bytes: Uint8Array): ArrayBuffer {
  const exact = new Uint8Array(bytes.byteLength);
  exact.set(bytes);
  return exact.buffer;
}

/** Import a lowercase 32-byte Ed25519 seed as a non-extractable signing key. */
export async function importEd25519PrivateSeedHex(seedHex: string): Promise<CryptoKey> {
  if (!/^[0-9a-f]{64}$/.test(seedHex)) {
    throw new TypeError("Ed25519 private seed must be exactly 64 lowercase hex characters");
  }

  const pkcs8 = new Uint8Array(ED25519_PKCS8_SEED_PREFIX.length + 32);
  pkcs8.set(ED25519_PKCS8_SEED_PREFIX);
  for (let index = 0; index < 32; index += 1) {
    pkcs8[ED25519_PKCS8_SEED_PREFIX.length + index] = Number.parseInt(
      seedHex.slice(index * 2, index * 2 + 2),
      16,
    );
  }
  return crypto.subtle.importKey("pkcs8", exactBytesBuffer(pkcs8), { name: "Ed25519" }, false, [
    "sign",
  ]);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", exactBytesBuffer(bytes));
  return toHex(new Uint8Array(digest));
}

/** Digest of the exact body bytes that will be transmitted. */
export async function payloadDigest(body: string | Uint8Array): Promise<string> {
  return sha256Hex(typeof body === "string" ? encoder.encode(body) : body);
}

/** 256-bit single-use nonce, base64url, from the platform CSPRNG. */
export function mintNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export interface MintOptions {
  /** Ed25519 private key. Supplied by the caller; never read at module scope. */
  privateKey: CryptoKey;
  /** Non-secret key id the Worker will resolve to a public key. */
  kid: string;
  /** Epoch seconds. Injected so lifetime is testable rather than incidental. */
  now: number;
  /** Envelope lifetime in seconds. Kept short: minted and consumed in one request. */
  lifetimeSeconds?: number;
  issuer?: string;
  audience?: string;
  method: string;
  /** Route *template*, never a filled path. */
  route: string;
  action: string;
  /** Opaque stable id for the acting human. Never an email, never a cookie. */
  principalId: string;
  principalType?: string;
  /** The exact body bytes that will be sent with the request. */
  body: string | Uint8Array;
  /** Override for tests that need a fixed nonce. Production mints its own. */
  nonce?: string;
}

const DEFAULT_LIFETIME_SECONDS = 60;

/**
 * Mint and sign an envelope for one write.
 *
 * The envelope binds method, route template, action and payload digest
 * together, so a signature obtained for one write cannot be lifted onto
 * another.
 */
export async function mintServiceEnvelope(options: MintOptions): Promise<ServiceEnvelope> {
  const lifetime = options.lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS;
  if (!Number.isSafeInteger(options.now)) {
    throw new TypeError("now must be integer epoch seconds");
  }
  if (lifetime <= 0) throw new TypeError("lifetimeSeconds must be positive");

  const claims: ServiceEnvelopeClaims = {
    v: ENVELOPE_VERSION,
    kid: options.kid,
    alg: "Ed25519",
    iss: options.issuer ?? "agora",
    aud: options.audience ?? "stoa",
    iat: options.now,
    exp: options.now + lifetime,
    nonce: options.nonce ?? mintNonce(),
    method: options.method,
    route: options.route,
    action: options.action,
    principal_type: options.principalType ?? "sponsor",
    principal_id: options.principalId,
    payload_sha256: await payloadDigest(options.body),
  };

  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    options.privateKey,
    canonicalBytes(claims).slice().buffer,
  );

  return { claims, signature: toHex(new Uint8Array(signature)) };
}

/** Header the envelope travels in. Never a cookie, never an Authorization header. */
export const SERVICE_ENVELOPE_HEADER = "asimp-service-envelope";

/**
 * Request headers for a sponsor write.
 *
 * Deliberately returns only what the Worker needs. There is no parameter here
 * through which a cookie or a Google token could be forwarded, which is the
 * structural version of "the session never crosses the seam".
 */
export function serviceEnvelopeHeaders(envelope: ServiceEnvelope): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    [SERVICE_ENVELOPE_HEADER]: JSON.stringify(envelope),
  };
}
