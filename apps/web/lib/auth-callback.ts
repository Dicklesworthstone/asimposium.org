/**
 * A Google OAuth callback always comes back carrying either `code` (consent
 * granted) or `error` (consent refused). A callback request with neither is a
 * reload, a back-button visit or a tab restored from history: there is nothing
 * to exchange. Auth.js would throw on it and report `Configuration`, which tells
 * the visitor the deployment is broken when it is not. Such a request is routed
 * to the honest "lost its one-time state" face instead.
 */
export const OAUTH_CALLBACK_PREFIX = "/api/auth/callback/";

export function isBareOAuthCallback(url: URL): boolean {
  if (!url.pathname.startsWith(OAUTH_CALLBACK_PREFIX)) return false;
  return !url.searchParams.has("code") && !url.searchParams.has("error");
}

/** Where a bare callback is sent: the existing Verification explanation. */
export const BARE_CALLBACK_REDIRECT = "/auth/error?error=Verification";
