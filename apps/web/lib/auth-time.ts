/**
 * Propylon step-up evidence (Fable §5.1): Google's `auth_time` is an
 * ID-token-only claim — the userinfo endpoint never carries it, so the jwt
 * callback reads it from the (already signature-verified) ID token. These
 * helpers live outside `auth.ts` so the module keeps its exact contract-pinned
 * export surface (`auth`, `handlers`, `signIn`, `signOut`) while the
 * extraction stays unit-testable.
 */

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * A claim is authentication evidence only as a non-negative safe integer
 * (the same bar the step-up check applies downstream).
 */
export function validAuthTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Read `auth_time` out of an OIDC ID token Auth.js has already verified. The
 * token is a compact JWS; only the payload segment is decoded, never trusted
 * beyond the one claim, and any malformed shape yields undefined (fail-closed
 * at the step-up check, not a crash).
 */
export function authTimeFromIdToken(idToken: unknown): number | undefined {
  if (typeof idToken !== "string") return undefined;
  const segments = idToken.split(".");
  const segment = segments[1];
  if (
    segments.length !== 3 ||
    segment === undefined ||
    !segments.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
  ) {
    return undefined;
  }
  try {
    const payloadBytes = Buffer.from(segment, "base64url");
    if (payloadBytes.toString("base64url") !== segment) return undefined;
    const payload: unknown = JSON.parse(fatalUtf8.decode(payloadBytes));
    if (typeof payload !== "object" || payload === null) return undefined;
    return validAuthTime((payload as Record<string, unknown>).auth_time);
  } catch {
    return undefined;
  }
}
