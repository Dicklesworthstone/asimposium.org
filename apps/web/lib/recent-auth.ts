/** Decision step-up window from W3.4, in whole epoch seconds. */
export const RECENT_DECISION_WINDOW_SECONDS = 15 * 60;

/**
 * Fail-closed freshness check for the server-stamped interactive sign-in time.
 * Future, fractional, non-finite, and unsafe integers are not authentication
 * evidence; accepting any of them would turn clock/data corruption into access.
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
  return age >= 0 && age <= RECENT_DECISION_WINDOW_SECONDS;
}
