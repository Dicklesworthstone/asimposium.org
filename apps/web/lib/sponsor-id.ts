/**
 * The canonical sponsor id: `usr_` plus a fixed-width digest of the validated
 * Google `sub`. Minted by the Auth.js JWT callback in `auth.ts`, gated here,
 * and carried as the service envelope's principal_id. Hashing keeps Google's
 * documented 255-character subject range inside the durable D1 identifier
 * bound without storing an email or a raw provider identifier.
 *
 * This module is import-safe everywhere — no server-only boundary, no secrets
 * — so the Auth.js callback, console UI, and Stoa client share one definition.
 */
export const CANONICAL_SPONSOR_ID = /^usr_[A-Za-z0-9_-]{1,60}$/;

const GOOGLE_SUBJECT = /^[\x21-\x7e]{1,255}$/;

export function isCanonicalSponsorId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_SPONSOR_ID.test(value);
}

export async function sponsorIdFromGoogleSubject(value: unknown): Promise<string | undefined> {
  if (typeof value !== "string" || !GOOGLE_SUBJECT.test(value)) return undefined;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  const suffix = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `usr_${suffix}`;
}
