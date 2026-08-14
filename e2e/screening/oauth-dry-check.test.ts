import { describe, expect, test } from "bun:test";
import { assertProductionOAuthDryCheck } from "./oauth-dry-check";

const validResponse = {
  environment: "production",
  provider: "google",
  scopes: ["profile", "email", "openid"],
  redirect_uris: ["https://asimposium.org/api/auth/callback/google"],
};

describe("S-4 OAuth production-configuration dry check", () => {
  test("accepts only production Google configuration over the staging transport", () => {
    expect(() => assertProductionOAuthDryCheck(validResponse)).not.toThrow();
  });

  test("PLANTED NEGATIVE: staging configuration cannot be misreported as production proof", () => {
    expect(() =>
      assertProductionOAuthDryCheck({ ...validResponse, environment: "staging" }),
    ).toThrow("OAUTH_DRY_CHECK_ENVIRONMENT_MISMATCH");
  });

  test("PLANTED NEGATIVE: wrong provider, scopes, and unsafe redirect are rejected", () => {
    expect(() => assertProductionOAuthDryCheck({ ...validResponse, provider: "other" })).toThrow(
      "OAUTH_DRY_CHECK_PROVIDER_MISMATCH",
    );
    expect(() => assertProductionOAuthDryCheck({ ...validResponse, scopes: ["openid"] })).toThrow(
      "OAUTH_DRY_CHECK_SCOPE_MISMATCH",
    );
    expect(() =>
      assertProductionOAuthDryCheck({
        ...validResponse,
        redirect_uris: ["http://example.invalid/callback"],
      }),
    ).toThrow("OAUTH_DRY_CHECK_REDIRECT_INVALID");
  });
});
