/**
 * Optional standards-based Ed25519 Proof-of-Possession verification using
 * RFC 9421 HTTP Message Signatures (`alg="ed25519"`, `tag="asimposium-pop-v1"`)
 * and RFC 9530 `Content-Digest` (`sha-256=:...:`).
 *
 * Implements Fable §5.5 / ADR-11 (`asimposiumorg-rc-cli-pop-encrypted-store-gates-sn5p`):
 * - Plain `bearer` Fellow credentials (`curl` / default) remain 100% first-class.
 * - Fellow credentials recorded with `credential_profile = "http-message-signature"`
 *   MUST present a valid RFC 9421 Ed25519 signature over `(@method, @authority,
 *   @target-uri, authorization[, content-digest])` bound to their registered
 *   Ed25519 public key and a non-replayed nonce.
 *
 * Verification order matches `envelope.ts` (anti-DoS & non-oracle Rule A5):
 *   1. Header syntax & bounds
 *   2. Tag, algorithm, keyid match, clock skew & lifetime bounds
 *   3. Content-Digest exact body hash check (when body is non-empty or required)
 *   4. Reconstruct exact RFC 9421 §2.5 signature base from actual HTTP request
 *   5. Ed25519 WebCrypto signature verification
 *   6. Nonce replay claim LAST (so unauthenticated callers cannot burn nonces)
 *
 * Externally every failure returns uniform `401 UNAUTHORIZED` with zero oracle leakage.
 */

import { constantTimeEqual } from "./canonical";
import { type NonceStore, NonceStoreFullError } from "./nonce";

export const POP_CREDENTIAL_PROFILE = "http-message-signature" as const;
export const POP_SIGNATURE_TAG = "asimposium-pop-v1" as const;
export const POP_SIGNATURE_ALG = "ed25519" as const;
export const POP_CLOCK_SKEW_SECONDS = 60;
export const POP_MAX_LIFETIME_SECONDS = 300;

export type PopRefusalReason =
  | "missing_headers"
  | "malformed_signature_input"
  | "malformed_signature"
  | "unsupported_components"
  | "unsupported_alg"
  | "wrong_tag"
  | "wrong_keyid"
  | "invalid_nonce"
  | "expired"
  | "issued_in_future"
  | "lifetime_too_long"
  | "missing_content_digest"
  | "content_digest_mismatch"
  | "bad_signature"
  | "replayed"
  | "store_unavailable";

export type PopVerificationResult =
  | {
      readonly ok: true;
      readonly keyId: string;
      readonly nonce: string;
      readonly created: number;
      readonly expires: number;
    }
  | {
      readonly ok: false;
      readonly code: "UNAUTHORIZED";
      readonly reason: PopRefusalReason;
    };

export interface VerifyFellowPopOptions {
  /** Exact HTTP method received by the Worker (e.g. GET, POST). */
  readonly method: string;
  /** Exact full target URI received by the Worker (scheme + authority + path + query). */
  readonly targetUri: string;
  /** Exact `Authorization` header sent on the request. */
  readonly authorization: string;
  /** Exact `Signature-Input` header. */
  readonly signatureInput: string | null;
  /** Exact `Signature` header. */
  readonly signature: string | null;
  /** Exact `Content-Digest` header (required when body bytes are non-empty). */
  readonly contentDigest: string | null;
  /** Exact raw request body bytes received by the Worker (empty for GET/HEAD/DELETE). */
  readonly bodyBytes: Uint8Array;
  /** Registered 32-byte Ed25519 public key bound to this Fellow credential. */
  readonly expectedPublicKeyBytes: Uint8Array;
  /** Current Unix epoch seconds (injected for deterministic clock tests). */
  readonly nowSeconds: number;
  /** Replay-protection nonce store scoped to PoP nonces. */
  readonly nonces: NonceStore;
  /** Optional clock skew override (default 60s). */
  readonly clockSkewSeconds?: number;
}

const utf8 = new TextEncoder();

function refuse(reason: PopRefusalReason): PopVerificationResult {
  return { ok: false, code: "UNAUTHORIZED", reason };
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) return null;
  try {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

export function base64UrlToBytes(b64url: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(b64url)) return null;
  const padded = b64url
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(b64url.length / 4) * 4, "=");
  return base64ToBytes(padded);
}

/**
 * Deterministic key fingerprint matching Rust `cli/src/pop.rs::ed25519_key_fingerprint`.
 */
export async function ed25519KeyFingerprint(rawPublicKey: Uint8Array): Promise<string> {
  if (rawPublicKey.byteLength !== 32) {
    throw new TypeError("Ed25519 public key must be exactly 32 bytes.");
  }
  const digest = await crypto.subtle.digest("SHA-256", rawPublicKey.slice().buffer);
  return `ed25519:${bytesToHex(new Uint8Array(digest))}`;
}

/**
 * RFC 9530 `Content-Digest` value: `sha-256=:<base64>:`
 */
export async function computeContentDigest(bodyBytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bodyBytes.slice().buffer);
  return `sha-256=:${bytesToBase64(new Uint8Array(digest))}:`;
}

/**
 * Extracts RFC 9421 `@authority` (`host` or `host:port` when non-default).
 */
export function authorityFromUri(targetUri: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(targetUri);
  } catch {
    return null;
  }
  if (!parsed.hostname) return null;
  const host = parsed.hostname.toLowerCase();
  return parsed.port ? `${host}:${parsed.port}` : host;
}

const COMPONENTS_WITHOUT_BODY = '("@method" "@authority" "@target-uri" "authorization")';
const COMPONENTS_WITH_BODY =
  '("@method" "@authority" "@target-uri" "authorization" "content-digest")';

const SIGNATURE_INPUT_RE =
  /^sig1=(\("[^"]+"(?: "[^"]+")*\));created=(\d{1,12});expires=(\d{1,12});nonce="([A-Za-z0-9._-]{16,128})";keyid="(ed25519:[0-9a-f]{64})";alg="([a-z0-9-]+)";tag="([a-z0-9-]+)"$/;

interface ParsedSignatureInput {
  readonly signatureParams: string;
  readonly components: string;
  readonly hasContentDigest: boolean;
  readonly created: number;
  readonly expires: number;
  readonly nonce: string;
  readonly keyId: string;
  readonly alg: string;
  readonly tag: string;
}

function parseSignatureInputHeader(header: string): ParsedSignatureInput | null {
  if (header.length > 1024 || /[\r\n]/.test(header)) return null;
  const match = SIGNATURE_INPUT_RE.exec(header.trim());
  if (!match) return null;
  const components = match[1] ?? "";
  const created = Number(match[2]);
  const expires = Number(match[3]);
  const nonce = match[4] ?? "";
  const keyId = match[5] ?? "";
  const alg = match[6] ?? "";
  const tag = match[7] ?? "";
  if (!Number.isSafeInteger(created) || !Number.isSafeInteger(expires)) return null;
  if (components !== COMPONENTS_WITHOUT_BODY && components !== COMPONENTS_WITH_BODY) {
    return null;
  }
  return {
    signatureParams: header.trim().slice("sig1=".length),
    components,
    hasContentDigest: components === COMPONENTS_WITH_BODY,
    created,
    expires,
    nonce,
    keyId,
    alg,
    tag,
  };
}

/**
 * Builds the exact RFC 9421 §2.5 signature base string.
 */
export function buildRfc9421SignatureBase(input: {
  readonly method: string;
  readonly targetUri: string;
  readonly authorization: string;
  readonly contentDigest?: string;
  readonly signatureParams: string;
}): string | null {
  const upperMethod = input.method.toUpperCase();
  if (!/^[A-Z]{3,16}$/.test(upperMethod)) return null;
  if (/[\r\n\t]/.test(input.targetUri)) return null;
  const authority = authorityFromUri(input.targetUri);
  if (authority === null) return null;
  if (/[\r\n]/.test(input.authorization)) return null;
  const lines = [
    `"@method": ${upperMethod}`,
    `"@authority": ${authority}`,
    `"@target-uri": ${input.targetUri}`,
    `"authorization": ${input.authorization}`,
  ];
  if (input.contentDigest !== undefined) {
    if (/[\r\n]/.test(input.contentDigest)) return null;
    lines.push(`"content-digest": ${input.contentDigest}`);
  }
  lines.push(`"@signature-params": ${input.signatureParams}`);
  return lines.join("\n");
}

/**
 * Verifies an RFC 9421 Ed25519 PoP request against the credential's bound
 * public key and replay-protection nonce store.
 */
export async function verifyFellowPopRequest(
  options: VerifyFellowPopOptions,
): Promise<PopVerificationResult> {
  if (!options.signatureInput || !options.signature) {
    return refuse("missing_headers");
  }
  if (options.expectedPublicKeyBytes.byteLength !== 32) {
    return refuse("wrong_keyid");
  }

  const parsed = parseSignatureInputHeader(options.signatureInput);
  if (!parsed) {
    return refuse("malformed_signature_input");
  }
  if (parsed.alg !== POP_SIGNATURE_ALG) {
    return refuse("unsupported_alg");
  }
  if (parsed.tag !== POP_SIGNATURE_TAG) {
    return refuse("wrong_tag");
  }

  const expectedKeyId = await ed25519KeyFingerprint(options.expectedPublicKeyBytes);
  if (!constantTimeEqual(parsed.keyId, expectedKeyId)) {
    return refuse("wrong_keyid");
  }

  const skew = options.clockSkewSeconds ?? POP_CLOCK_SKEW_SECONDS;
  if (
    !Number.isFinite(options.nowSeconds) ||
    !Number.isFinite(skew) ||
    skew < 0 ||
    skew > POP_MAX_LIFETIME_SECONDS
  ) {
    return refuse("malformed_signature_input");
  }
  if (
    parsed.expires <= parsed.created ||
    parsed.expires - parsed.created > POP_MAX_LIFETIME_SECONDS
  ) {
    return refuse("lifetime_too_long");
  }
  if (parsed.created > options.nowSeconds + skew) {
    return refuse("issued_in_future");
  }
  if (parsed.expires < options.nowSeconds - skew) {
    return refuse("expired");
  }

  // Whenever body bytes are present, Content-Digest MUST be signed and match the exact body.
  const hasBody = options.bodyBytes.byteLength > 0;
  if (hasBody && !parsed.hasContentDigest) {
    return refuse("missing_content_digest");
  }
  let verifiedContentDigest: string | undefined;
  if (parsed.hasContentDigest) {
    if (!options.contentDigest) {
      return refuse("missing_content_digest");
    }
    const expectedDigest = await computeContentDigest(options.bodyBytes);
    if (!constantTimeEqual(options.contentDigest.trim(), expectedDigest)) {
      return refuse("content_digest_mismatch");
    }
    verifiedContentDigest = expectedDigest;
  }

  const sigTrimmed = options.signature.trim();
  if (!sigTrimmed.startsWith("sig1=:") || !sigTrimmed.endsWith(":")) {
    return refuse("malformed_signature");
  }
  const sigBytes = base64ToBytes(sigTrimmed.slice("sig1=:".length, -1));
  if (sigBytes === null || sigBytes.byteLength !== 64) {
    return refuse("malformed_signature");
  }

  const signatureBase = buildRfc9421SignatureBase({
    method: options.method,
    targetUri: options.targetUri,
    authorization: options.authorization,
    contentDigest: verifiedContentDigest,
    signatureParams: parsed.signatureParams,
  });
  if (signatureBase === null) {
    return refuse("malformed_signature_input");
  }

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      "raw",
      options.expectedPublicKeyBytes.slice().buffer,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    return refuse("bad_signature");
  }

  const validSig = await crypto.subtle.verify(
    "Ed25519",
    cryptoKey,
    sigBytes.slice().buffer,
    utf8.encode(signatureBase).slice().buffer,
  );
  if (!validSig) {
    return refuse("bad_signature");
  }

  // Claim replay nonce LAST (only after cryptographic verification succeeds).
  const nonceKey = `pop:${parsed.keyId}:${parsed.nonce}`;
  try {
    const claimed = await options.nonces.claim(nonceKey, parsed.expires + skew, options.nowSeconds);
    if (!claimed) {
      return refuse("replayed");
    }
  } catch (err) {
    if (err instanceof NonceStoreFullError) {
      return refuse("store_unavailable");
    }
    return refuse("store_unavailable");
  }

  return {
    ok: true,
    keyId: parsed.keyId,
    nonce: parsed.nonce,
    created: parsed.created,
    expires: parsed.expires,
  };
}

/**
 * Enforces credential_profile policy for an authenticated Fellow token:
 * - `"bearer"`: plain bearer tokens (curl & default `asimp`) pass immediately.
 * - `"http-message-signature"`: requires valid RFC 9421 Ed25519 PoP verification.
 */
export async function enforceFellowCredentialProfile(input: {
  readonly credentialProfile: "bearer" | "dpop" | "http-message-signature";
  readonly popPublicKeyBytes?: Uint8Array;
  readonly request: {
    readonly method: string;
    readonly targetUri: string;
    readonly authorization: string;
    readonly signatureInput: string | null;
    readonly signature: string | null;
    readonly contentDigest: string | null;
    readonly bodyBytes: Uint8Array;
  };
  readonly nowSeconds: number;
  readonly nonces: NonceStore;
}): Promise<
  | { readonly ok: true; readonly profile: "bearer" | "http-message-signature" }
  | {
      readonly ok: false;
      readonly code: "UNAUTHORIZED";
      readonly reason: PopRefusalReason | "unsupported_profile";
    }
> {
  if (input.credentialProfile === "bearer") {
    return { ok: true, profile: "bearer" };
  }
  if (input.credentialProfile !== "http-message-signature") {
    return { ok: false, code: "UNAUTHORIZED", reason: "unsupported_profile" };
  }
  if (!input.popPublicKeyBytes) {
    return { ok: false, code: "UNAUTHORIZED", reason: "wrong_keyid" };
  }
  const verified = await verifyFellowPopRequest({
    ...input.request,
    expectedPublicKeyBytes: input.popPublicKeyBytes,
    nowSeconds: input.nowSeconds,
    nonces: input.nonces,
  });
  if (!verified.ok) {
    return verified;
  }
  return { ok: true, profile: "http-message-signature" };
}
