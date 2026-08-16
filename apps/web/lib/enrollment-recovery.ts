export type EnrollmentRecoveryScope = "mint" | "decision";

const RECOVERY_KEY = /^[0-9a-f]{64}$/;

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
): "retain" | "clear" {
  if (reason === "unconfigured") return "clear";
  if (reason === "unreachable") return "retain";
  return status !== undefined && status >= 400 && status < 500 ? "clear" : "retain";
}

export function enrollmentRecoveryStateForOwner<T extends { readonly owner: string }>(
  owner: string | undefined,
  state: T | null,
): T | null {
  return owner !== undefined && state?.owner === owner ? state : null;
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
