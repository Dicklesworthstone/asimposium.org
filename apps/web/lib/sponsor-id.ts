/**
 * The canonical sponsor id: `usr_` plus the Google `sub`. Minted by the
 * Auth.js session callback in `auth.ts`, gated here, and carried as the
 * service envelope's principal_id. This module is import-safe everywhere —
 * no server-only boundary, no secrets — so both the console UI and the Stoa
 * client share exactly one definition.
 */
export const CANONICAL_SPONSOR_ID = /^usr_[A-Za-z0-9_-]{1,60}$/;

export function isCanonicalSponsorId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_SPONSOR_ID.test(value);
}
