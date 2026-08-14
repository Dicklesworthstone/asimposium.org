/**
 * Verification of the signed service envelope (Fable §14.1, ADR-1).
 *
 * The Worker is the single writer and the single validator. A sponsor write
 * arrives as an ordinary HTTP request carrying an envelope that names the
 * acting human; this module decides whether to believe it, and attributes the
 * write to that human when it does.
 *
 * ## Order of checks
 *
 * The order is deliberate and fails closed at every step:
 *
 *  1. shape and types — before any crypto touches attacker-controlled data;
 *  2. issuer / audience — an envelope minted for another plane is not ours;
 *  3. clock — expiry, and a bound on total lifetime so a signer cannot mint a
 *     decade-long envelope;
 *  4. key — resolved by `kid`, validity checked against `iat` (rotation);
 *  5. **signature** — everything after this point is authenticated data;
 *  6. payload digest — the body actually received, compared constant-time;
 *  7. **nonce** — claimed last, so an unauthenticated attacker cannot burn
 *     nonces by replaying garbage. Consuming state before verifying a signature
 *     is a denial-of-service primitive.
 *
 * ## What a refusal tells the caller
 *
 * Externally: `UNAUTHORIZED`, with no detail. Rule A5 splits transparency —
 * contract errors teach, but an auth refusal that explains *which* check failed
 * is an oracle for grinding out a forgery. The precise `reason` stays internal,
 * for metrics and operator diagnostics, and is enumerated rather than free text
 * so it can never carry a byte of the material it describes.
 */
import {
  CANONICAL_FIELDS,
  canonicalBytes,
  constantTimeEqual,
  ENVELOPE_VERSION,
  fromHex,
  payloadDigest,
  type ServiceEnvelopeClaims,
} from "./canonical";
import type { KeyLookupFailure, VerificationKeyring } from "./keyring";
import { NonceStoreFullError, type NonceStore } from "./nonce";

/** The wire shape: signed claims plus a detached signature. */
export interface ServiceEnvelope {
  claims: ServiceEnvelopeClaims;
  /** Ed25519 signature over `canonicalBytes(claims)`, lowercase hex. */
  signature: string;
}

export type EnvelopeRefusalReason =
  | "malformed"
  | "unsupported_version"
  | "unsupported_alg"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired"
  | "issued_in_future"
  | "lifetime_too_long"
  | KeyLookupFailure
  | "bad_signature"
  | "payload_mismatch"
  | "replayed"
  | "action_not_permitted"
  | "store_unavailable";

export interface AttributedPrincipal {
  type: string;
  /** Opaque stable id for the acting human. Never an email address. */
  id: string;
  /** The action the envelope authorised, for the event record. */
  action: string;
  /** The key that vouched for it, for the audit trail. Non-secret. */
  kid: string;
}

export type EnvelopeVerification =
  | { ok: true; principal: AttributedPrincipal; claims: ServiceEnvelopeClaims }
  | { ok: false; code: "UNAUTHORIZED"; reason: EnvelopeRefusalReason };

export interface VerifyOptions {
  keyring: VerificationKeyring;
  nonces: NonceStore;
  /** Epoch seconds. Injected rather than read, so clock tests are real tests. */
  now: number;
  /** Expected issuing plane. */
  issuer: string;
  /** Expected audience plane. */
  audience: string;
  /** The exact body bytes received with the request. */
  body: string | Uint8Array;
  /** Method and route template the request actually hit. */
  method: string;
  route: string;
  /** Tolerance for clock skew between the two planes, seconds. */
  clockSkewSeconds?: number;
  /** Hard ceiling on `exp - iat`, seconds. */
  maxLifetimeSeconds?: number;
  /** When present, the envelope's action must be a member. */
  permittedActions?: readonly string[];
}

const DEFAULT_CLOCK_SKEW_SECONDS = 60;
/** Two minutes. An envelope is created and consumed within one request. */
const DEFAULT_MAX_LIFETIME_SECONDS = 120;
const SIGNATURE_HEX_LENGTH = 128; // 64 bytes
const NONCE_MIN_LENGTH = 32;
const NONCE_MAX_LENGTH = 128;

/**
 * Hard bounds on every untrusted claim string, applied **before** the value
 * reaches canonicalization or any crypto call.
 *
 * Two reasons. First, unbounded attacker-controlled strings are a denial-of-
 * service surface: a megabyte `action` costs a megabyte of hashing per request,
 * for free, before any signature has been checked. Second, these values are
 * carried into event records and operator diagnostics, and a control character
 * or a newline in an id is how a log line becomes two log lines.
 *
 * Every class here is ASCII-only, so the pattern bounds the byte length too;
 * the byte length is still checked explicitly rather than inferred.
 */
const CLAIM_BOUNDS: Record<string, { pattern: RegExp; maxBytes: number }> = {
  kid: { pattern: /^[A-Za-z0-9._-]+$/, maxBytes: 64 },
  iss: { pattern: /^[a-z0-9.-]+$/, maxBytes: 64 },
  aud: { pattern: /^[a-z0-9.-]+$/, maxBytes: 64 },
  method: { pattern: /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/, maxBytes: 7 },
  // A route *template*: segments, parameters, no query, no fragment.
  route: { pattern: /^\/[A-Za-z0-9/:._-]*$/, maxBytes: 256 },
  action: { pattern: /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, maxBytes: 64 },
  principal_type: { pattern: /^[a-z_]+$/, maxBytes: 32 },
  principal_id: { pattern: /^[A-Za-z0-9_-]+$/, maxBytes: 64 },
};

const utf8 = new TextEncoder();

function withinBounds(field: string, value: string): boolean {
  const bounds = CLAIM_BOUNDS[field];
  if (bounds === undefined) return true;
  if (utf8.encode(value).length > bounds.maxBytes) return false;
  return bounds.pattern.test(value);
}

const refuse = (reason: EnvelopeRefusalReason): EnvelopeVerification => ({
  ok: false,
  code: "UNAUTHORIZED",
  reason,
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural validation of an untrusted envelope.
 *
 * Every canonical field must be present with the right type, and no extra
 * fields are tolerated: an unsigned field on a signed object is meaning the
 * verifier did not authenticate, and tolerating it is how signature-stripping
 * bugs start.
 */
export function parseEnvelope(value: unknown): ServiceEnvelope | undefined {
  if (!isPlainRecord(value)) return undefined;
  const { claims, signature } = value;
  if (typeof signature !== "string" || !isPlainRecord(claims)) return undefined;
  if (Object.keys(value).length !== 2) return undefined;
  if (!/^[0-9a-f]+$/.test(signature) || signature.length !== SIGNATURE_HEX_LENGTH) {
    return undefined;
  }
  if (Object.keys(claims).length !== CANONICAL_FIELDS.length) return undefined;

  for (const field of CANONICAL_FIELDS) {
    const entry = claims[field];
    const expected = field === "iat" || field === "exp" ? "number" : "string";
    if (typeof entry !== expected) return undefined;
    if (expected === "number" && !Number.isSafeInteger(entry)) return undefined;
    if (expected === "string" && (entry as string).length === 0) return undefined;
  }

  const nonce = claims.nonce as string;
  if (nonce.length < NONCE_MIN_LENGTH || nonce.length > NONCE_MAX_LENGTH) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(nonce)) return undefined;
  if (!/^[0-9a-f]{64}$/.test(claims.payload_sha256 as string)) return undefined;

  // Hard bounds before anything expensive or attacker-influenced happens.
  for (const field of Object.keys(CLAIM_BOUNDS)) {
    if (!withinBounds(field, claims[field] as string)) return undefined;
  }

  return { claims: claims as unknown as ServiceEnvelopeClaims, signature };
}

export async function verifyServiceEnvelope(
  envelope: unknown,
  options: VerifyOptions,
): Promise<EnvelopeVerification> {
  const parsed = parseEnvelope(envelope);
  if (parsed === undefined) return refuse("malformed");

  const { claims, signature } = parsed;
  if (claims.v !== ENVELOPE_VERSION) return refuse("unsupported_version");
  if (claims.alg !== "Ed25519") return refuse("unsupported_alg");
  if (claims.iss !== options.issuer) return refuse("wrong_issuer");
  if (claims.aud !== options.audience) return refuse("wrong_audience");

  // The envelope authorises one method and one route template. A signature for
  // a workshop read must not move a directive write.
  if (claims.method !== options.method || claims.route !== options.route) {
    return refuse("action_not_permitted");
  }
  if (options.permittedActions !== undefined && !options.permittedActions.includes(claims.action)) {
    return refuse("action_not_permitted");
  }

  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  const maxLifetime = options.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS;
  if (claims.exp <= claims.iat) return refuse("malformed");
  if (claims.exp - claims.iat > maxLifetime) return refuse("lifetime_too_long");
  if (options.now > claims.exp + skew) return refuse("expired");
  if (claims.iat > options.now + skew) return refuse("issued_in_future");

  const lookup = await options.keyring.lookup(claims.kid, claims.iat);
  if (!lookup.ok) return refuse(lookup.reason);

  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify(
      { name: "Ed25519" },
      lookup.key,
      fromHex(signature) as BufferSource,
      canonicalBytes(claims) as BufferSource,
    );
  } catch {
    // A malformed signature must be a refusal, never a 500 that leaks a stack.
    return refuse("bad_signature");
  }
  if (!signatureValid) return refuse("bad_signature");

  // Authenticated from here down.
  const actualDigest = await payloadDigest(options.body);
  if (!constantTimeEqual(actualDigest, claims.payload_sha256)) {
    return refuse("payload_mismatch");
  }

  let claimed: boolean;
  try {
    claimed = await options.nonces.claim(claims.nonce, claims.exp, options.now);
  } catch (error) {
    // Fail closed. A replay window that cannot answer is not a reason to write.
    if (error instanceof NonceStoreFullError) return refuse("store_unavailable");
    return refuse("store_unavailable");
  }
  if (!claimed) return refuse("replayed");

  return {
    ok: true,
    claims,
    principal: {
      type: claims.principal_type,
      id: claims.principal_id,
      action: claims.action,
      kid: claims.kid,
    },
  };
}
