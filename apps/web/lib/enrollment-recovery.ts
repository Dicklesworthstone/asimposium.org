export type EnrollmentRecoveryScope = "mint" | "decision";

const RECOVERY_KEY = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY = /^console-[A-Za-z0-9._-]{1,152}$/;
const RECOVERY_PAYLOAD = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,20000}$/;
const RECOVERY_PAYLOAD_AAD = new TextEncoder().encode(
  "asimposium-console-enrollment-recovery-payload-v1",
);
const RECOVERY_PAYLOAD_INFO = new TextEncoder().encode(
  "asimposium-console-enrollment-recovery-payload-aes-gcm-v1",
);

export interface EnrollmentRecoveryPayloadData {
  readonly sponsorId: string;
  readonly scope: EnrollmentRecoveryScope;
  readonly fingerprint: string;
  readonly idempotencyKey: string;
  readonly expiresAt: number;
  readonly request: unknown;
}

export function enrollmentRecoveryConfigurationIsValid(
  recoveryKeyHex: string | undefined,
  serviceEnvelopeKeyHex: string | undefined,
): recoveryKeyHex is string {
  return (
    recoveryKeyHex !== undefined &&
    RECOVERY_KEY.test(recoveryKeyHex) &&
    recoveryKeyHex !== serviceEnvelopeKeyHex
  );
}

export function enrollmentRecoveryDisposition(
  reason: "unconfigured" | "unreachable" | "refused",
  status?: number,
  problemCode?: string,
): "retain" | "clear" {
  if (reason === "unconfigured") return "clear";
  if (reason === "unreachable") return "retain";
  const operationalCodes = new Set([
    "AUTH_REPLAY_STORE_UNAVAILABLE",
    "ENROLLMENT_UNAVAILABLE",
    "INTERNAL_ERROR",
    "SPONSOR_AUTH_UNAVAILABLE",
  ]);
  return status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 425 &&
    status !== 429 &&
    problemCode !== undefined &&
    !operationalCodes.has(problemCode)
    ? "clear"
    : "retain";
}

/** A committed Worker result must never be hidden by ancillary UI cache work. */
export function bestEffortEnrollmentCacheInvalidation(
  invalidate: () => void,
): void {
  try {
    invalidate();
  } catch {
    // The caller already holds the authoritative one-time result. The client
    // refresh is sufficient; cache invalidation is never allowed to suppress it.
  }
}

function decodeHexKey(hex: string): ArrayBuffer {
  if (!RECOVERY_KEY.test(hex)) {
    throw new Error("enrollment recovery key must be 32 lowercase-hex bytes");
  }
  const buffer = new ArrayBuffer(32);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return buffer;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("invalid recovery payload encoding");
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (standard.length % 4)) % 4);
  const binary = atob(`${standard}${padding}`);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (encodeBase64Url(bytes) !== value)
    throw new Error("invalid recovery payload encoding");
  return bytes;
}

async function recoveryPayloadKey(keyHex: string): Promise<CryptoKey> {
  const root = await crypto.subtle.importKey(
    "raw",
    decodeHexKey(keyHex),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: RECOVERY_PAYLOAD_INFO,
    },
    root,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function enrollmentRecoveryPayloadIsValid(
  value: unknown,
): value is string {
  return typeof value === "string" && RECOVERY_PAYLOAD.test(value);
}

/** Seal the exact normalized request for browser-local crash recovery. */
export async function sealEnrollmentRecoveryPayload(
  keyHex: string,
  payload: EnrollmentRecoveryPayloadData,
): Promise<string> {
  if (
    payload.sponsorId.length === 0 ||
    (payload.scope !== "mint" && payload.scope !== "decision") ||
    !RECOVERY_KEY.test(payload.fingerprint) ||
    !IDEMPOTENCY_KEY.test(payload.idempotencyKey) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= 0
  ) {
    throw new Error("invalid enrollment recovery payload");
  }
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ version: 1, ...payload }),
  );
  if (plaintext.length > 12_000)
    throw new Error("enrollment recovery payload is too large");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: RECOVERY_PAYLOAD_AAD },
      await recoveryPayloadKey(keyHex),
      plaintext,
    ),
  );
  const envelope = `v1.${encodeBase64Url(iv)}.${encodeBase64Url(ciphertext)}`;
  if (!enrollmentRecoveryPayloadIsValid(envelope)) {
    throw new Error("invalid enrollment recovery payload");
  }
  return envelope;
}

/** Open an authenticated payload and bind it to the current sponsor and time. */
export async function openEnrollmentRecoveryPayload(
  keyHex: string,
  envelope: string,
  expectedSponsorId: string,
  expectedScope: EnrollmentRecoveryScope,
  now: number,
): Promise<EnrollmentRecoveryPayloadData> {
  if (
    !enrollmentRecoveryPayloadIsValid(envelope) ||
    !Number.isSafeInteger(now) ||
    now <= 0
  ) {
    throw new Error("invalid enrollment recovery payload");
  }
  const [, ivPart, ciphertextPart] = envelope.split(".");
  if (ivPart === undefined || ciphertextPart === undefined) {
    throw new Error("invalid enrollment recovery payload");
  }
  let decoded: unknown;
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decodeBase64Url(ivPart),
        additionalData: RECOVERY_PAYLOAD_AAD,
      },
      await recoveryPayloadKey(keyHex),
      decodeBase64Url(ciphertextPart),
    );
    decoded = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error("invalid enrollment recovery payload");
  }
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("invalid enrollment recovery payload");
  }
  const candidate = decoded as Partial<EnrollmentRecoveryPayloadData> & {
    readonly version?: unknown;
  };
  if (
    candidate.version !== 1 ||
    candidate.sponsorId !== expectedSponsorId ||
    candidate.scope !== expectedScope ||
    !RECOVERY_KEY.test(candidate.fingerprint ?? "") ||
    !IDEMPOTENCY_KEY.test(candidate.idempotencyKey ?? "") ||
    !Number.isSafeInteger(candidate.expiresAt) ||
    (candidate.expiresAt ?? 0) <= now ||
    !("request" in candidate)
  ) {
    throw new Error("invalid enrollment recovery payload");
  }
  return {
    sponsorId: candidate.sponsorId,
    scope: candidate.scope,
    fingerprint: candidate.fingerprint,
    idempotencyKey: candidate.idempotencyKey,
    expiresAt: candidate.expiresAt,
    request: candidate.request,
  } as EnrollmentRecoveryPayloadData;
}

/**
 * Produce the opaque identity stored beside a browser-local idempotency key.
 * The caller must pass schema-normalized data so property order is canonical.
 * The dedicated root is intentionally independent of rotatable envelope keys
 * and must remain stable for at least the Worker's 24-hour replay horizon.
 */
export async function enrollmentRecoveryFingerprint(
  keyHex: string,
  sponsorId: string,
  scope: EnrollmentRecoveryScope,
  normalizedRequest: unknown,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    decodeHexKey(keyHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const body = JSON.stringify(normalizedRequest);
  const input = encoder.encode(
    `asimposium-console-enrollment-recovery-v1\u0000${sponsorId}\u0000${scope}\u0000${body}`,
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, input));
  return [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Derive the opaque browser namespace for one sponsor. Server Actions compare
 * this value again immediately before dispatch so a same-origin session change
 * cannot move a prepared write to another principal.
 */
export function enrollmentRecoveryOwner(
  keyHex: string,
  sponsorId: string,
): Promise<string> {
  return enrollmentRecoveryFingerprint(keyHex, sponsorId, "mint", {
    purpose: "client-memory-owner-v1",
  });
}
