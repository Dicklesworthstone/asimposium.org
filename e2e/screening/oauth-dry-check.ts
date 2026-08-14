export class OAuthDryCheckFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OAuthDryCheckFailure";
  }
}

interface OAuthDryCheckResponse {
  readonly environment?: unknown;
  readonly provider?: unknown;
  readonly scopes?: unknown;
  readonly redirect_uris?: unknown;
}

/**
 * The transport is staging, but this response attests production OAuth client
 * configuration only. It does not contact or mutate a cloud console.
 */
export function assertProductionOAuthDryCheck(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OAuthDryCheckFailure("OAUTH_DRY_CHECK_INVALID_RESPONSE");
  }
  const response = value as OAuthDryCheckResponse;
  if (response.environment !== "production") {
    throw new OAuthDryCheckFailure("OAUTH_DRY_CHECK_ENVIRONMENT_MISMATCH");
  }
  if (response.provider !== "google") {
    throw new OAuthDryCheckFailure("OAUTH_DRY_CHECK_PROVIDER_MISMATCH");
  }
  if (
    !Array.isArray(response.scopes) ||
    [...response.scopes].sort().join(",") !== "email,openid,profile"
  ) {
    throw new OAuthDryCheckFailure("OAUTH_DRY_CHECK_SCOPE_MISMATCH");
  }
  if (!Array.isArray(response.redirect_uris) || response.redirect_uris.length === 0) {
    throw new OAuthDryCheckFailure("OAUTH_DRY_CHECK_REDIRECT_MISSING");
  }
  for (const redirect of response.redirect_uris) {
    if (typeof redirect !== "string") {
      throw new OAuthDryCheckFailure("OAUTH_DRY_CHECK_REDIRECT_INVALID");
    }
    try {
      const parsed = new URL(redirect);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
        throw new OAuthDryCheckFailure("OAUTH_DRY_CHECK_REDIRECT_INVALID");
      }
    } catch (error) {
      if (error instanceof OAuthDryCheckFailure) throw error;
      throw new OAuthDryCheckFailure("OAUTH_DRY_CHECK_REDIRECT_INVALID");
    }
  }
}
