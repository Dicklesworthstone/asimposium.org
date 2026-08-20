/**
 * Verification keyring for the service envelope.
 *
 * The Worker holds **public** keys only. Signing lives on the Agora side, so a
 * Worker compromise cannot forge a sponsor write — which matters because the
 * Worker is the single writer and therefore the most attractive target in the
 * system (Fable §14.1). This is why the envelope is Ed25519 rather than an
 * HMAC: a shared secret would put a signing capability on both planes.
 *
 * ## Rotation overlap
 *
 * A key has a validity window. During a rotation both the outgoing and incoming
 * keys are valid, so envelopes signed moments before the cutover still verify
 * while envelopes signed after it verify too. The window is checked against the
 * envelope's `iat` rather than against "now": an envelope signed while a key
 * was live stays verifiable for its short lifetime even if the key retires in
 * between, and — the direction that actually matters — a key that was *not yet*
 * live at `iat` cannot be used to backdate an envelope.
 */
import { fromHex } from "./canonical";

export interface VerificationKeyRecord {
  /** Non-secret key identifier carried in the envelope. */
  kid: string;
  /** Raw 32-byte Ed25519 public key, lowercase hex. */
  publicKeyHex: string;
  /** Inclusive start of validity, epoch seconds. */
  notBefore: number;
  /** Exclusive end of validity, epoch seconds. Omit only for the current key. */
  notAfter?: number;
}

export type KeyLookupFailure = "unknown_kid" | "key_not_yet_valid" | "key_retired" | "key_unusable";

/** Key ids are non-secret identifiers, not free text. */
const KID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** Raw Ed25519 public keys are exactly 32 bytes, lowercase hex. */
const PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/;

export class KeyringConfigError extends Error {
  readonly code = "KEYRING_CONFIG_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "KeyringConfigError";
  }
}

/**
 * Validate one configured key at construction time.
 *
 * Configuration errors belong at startup, where a deploy fails loudly, rather
 * than at request time, where they would surface as an exception escaping the
 * verifier and becoming a 500 that leaks a stack trace.
 */
function validateRecord(record: VerificationKeyRecord): void {
  if (typeof record !== "object" || record === null) {
    throw new KeyringConfigError("key record must be an object");
  }
  if (!KID_PATTERN.test(record.kid)) {
    throw new KeyringConfigError("key record has an invalid key identifier");
  }
  if (!PUBLIC_KEY_PATTERN.test(record.publicKeyHex)) {
    // The key itself is public, but echoing it into an error adds nothing.
    throw new KeyringConfigError("key record public key must be 32 bytes of lowercase hex");
  }
  if (!Number.isSafeInteger(record.notBefore) || record.notBefore < 0) {
    throw new KeyringConfigError("key record notBefore must be a non-negative integer");
  }
  if (record.notAfter !== undefined) {
    if (!Number.isSafeInteger(record.notAfter)) {
      throw new KeyringConfigError("key record notAfter must be an integer");
    }
    if (record.notAfter <= record.notBefore) {
      // An empty validity window silently refuses every envelope it should have
      // accepted, and looks exactly like a signature bug.
      throw new KeyringConfigError("key record notAfter must be after notBefore");
    }
  }
}

export type KeyLookup =
  | { ok: true; key: CryptoKey; record: VerificationKeyRecord }
  | { ok: false; reason: KeyLookupFailure };

const ED25519: EdKeyAlgorithm = { name: "Ed25519" };

interface EdKeyAlgorithm {
  name: "Ed25519";
}

export class VerificationKeyring {
  readonly #records: Map<string, VerificationKeyRecord>;
  readonly #imported = new Map<string, CryptoKey>();

  constructor(records: readonly VerificationKeyRecord[]) {
    if (records.length === 0) {
      throw new KeyringConfigError("keyring must contain a current verification key");
    }
    this.#records = new Map();
    for (const record of records) {
      validateRecord(record);
      if (this.#records.has(record.kid)) {
        // Two keys under one id makes "which key signed this" undecidable.
        throw new KeyringConfigError("keyring contains a duplicate key identifier");
      }
      this.#records.set(record.kid, record);
    }

    const newestNotBefore = Math.max(...records.map((record) => record.notBefore));
    const openEnded = records.filter((record) => record.notAfter === undefined);
    if (openEnded.length !== 1 || openEnded[0]?.notBefore !== newestNotBefore) {
      throw new KeyringConfigError(
        "exactly the newest current key must have an open-ended validity window",
      );
    }
  }

  /** Key ids known to this keyring. Non-secret; safe to log. */
  get kids(): string[] {
    return [...this.#records.keys()].sort();
  }

  /**
   * Resolve a key id to an imported public key, if the key was valid when the
   * envelope claims to have been issued.
   */
  async lookup(kid: string, issuedAt: number): Promise<KeyLookup> {
    const record = this.#records.get(kid);
    if (record === undefined) return { ok: false, reason: "unknown_kid" };
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
      return { ok: false, reason: "key_unusable" };
    }
    if (issuedAt < record.notBefore) return { ok: false, reason: "key_not_yet_valid" };
    if (record.notAfter !== undefined && issuedAt >= record.notAfter) {
      return { ok: false, reason: "key_retired" };
    }

    const cached = this.#imported.get(kid);
    if (cached !== undefined) return { ok: true, key: cached, record };

    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey(
        "raw",
        fromHex(record.publicKeyHex).slice().buffer,
        ED25519,
        false,
        ["verify"],
      );
    } catch {
      // Construction validates the shape, so reaching here means the runtime
      // rejected an otherwise well-formed key (not a valid curve point, or no
      // Ed25519 support). Fail closed: never throw past the verifier.
      return { ok: false, reason: "key_unusable" };
    }
    this.#imported.set(kid, key);
    return { ok: true, key, record };
  }
}
