/**
 * Propylon step-up evidence (Fable §5.1): Google's `auth_time` is an
 * ID-token-only claim — the userinfo endpoint never carries it, so the jwt
 * callback reads it from the (already signature-verified) ID token. These
 * helpers live outside `auth.ts` so the module keeps its exact contract-pinned
 * export surface (`auth`, `handlers`, `signIn`, `signOut`) while the
 * extraction stays unit-testable.
 */

/**
 * A claim is authentication evidence only as a non-negative safe integer
 * (the same bar the step-up check applies downstream).
 */
export function validAuthTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Read `auth_time` out of an OIDC ID token Auth.js has already verified. The
 * token is a compact JWS; only the payload segment is decoded, never trusted
 * beyond the one claim, and any malformed shape yields undefined (fail-closed
 * at the step-up check, not a crash).
 */
export function authTimeFromIdToken(idToken: unknown): number | undefined {
  if (typeof idToken !== "string") return undefined;
  const segment = idToken.split(".")[1];
  if (segment === undefined) return undefined;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(segment, "base64url").toString("utf8"),
    );
    if (typeof payload !== "object" || payload === null) return undefined;
    return validAuthTime((payload as Record<string, unknown>).auth_time);
  } catch {
    return undefined;
  }
}
