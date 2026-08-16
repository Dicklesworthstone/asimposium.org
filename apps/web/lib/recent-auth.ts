/** Decision step-up window from W3.4, in whole epoch seconds. */
export const RECENT_DECISION_WINDOW_SECONDS = 15 * 60;
/** Match the signed Agora-to-Stoa envelope's bounded inter-plane clock skew. */
export const RECENT_AUTH_CLOCK_SKEW_SECONDS = 60;

/**
 * Fail-closed freshness check for Google's signed authentication time.
 * Fractional, non-finite, unsafe, and beyond-skew future values are not
 * authentication evidence; accepting them would turn clock/data corruption
 * into access.
 */
export function recentAuthOk(
  authIssuedAt: number | undefined,
  nowSeconds = Math.floor(Date.now() / 1_000),
): boolean {
  if (
    typeof authIssuedAt !== "number" ||
    !Number.isSafeInteger(authIssuedAt) ||
    !Number.isSafeInteger(nowSeconds) ||
    authIssuedAt < 0 ||
    nowSeconds < 0
  ) {
    return false;
  }
  const age = nowSeconds - authIssuedAt;
  return (
    age >= -RECENT_AUTH_CLOCK_SKEW_SECONDS &&
    age <= RECENT_DECISION_WINDOW_SECONDS + RECENT_AUTH_CLOCK_SKEW_SECONDS
  );
}
