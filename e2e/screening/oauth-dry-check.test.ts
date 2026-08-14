import { describe, expect, test } from "bun:test";
import { assertProductionOAuthDryCheck, OAuthDryCheckFailure } from "./oauth-dry-check";

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

/**
 * The payload is exact and closed. An OAuth dry check describes a client
 * registration, so anything the endpoint volunteers beyond the four expected
 * fields is either contract drift or credential material — and a checker that
 * quietly ignores extra fields is how a client secret ends up in a log.
 */
describe("the dry-check payload is exact and closed", () => {
  const SECRET = "GOCSPX-do-not-log-this-value";

  function failureFor(payload: unknown): OAuthDryCheckFailure {
    try {
      assertProductionOAuthDryCheck(payload);
    } catch (error) {
      expect(error).toBeInstanceOf(OAuthDryCheckFailure);
      return error as OAuthDryCheckFailure;
    }
    throw new Error("expected a refusal");
  }

  /** Everything a diagnostic consumer could read off the failure. */
  function everythingVisible(failure: OAuthDryCheckFailure): string {
    return [
      failure.message,
      failure.code,
      JSON.stringify(failure),
      JSON.stringify(failure.unexpected_fields),
      String(failure.unexpected_field_count),
      String(failure.stack).split("\n")[0],
    ].join(" ");
  }

  test("PLANTED NEGATIVE: a secret-like extra field is refused, and its name is collapsed", () => {
    const failure = failureFor({ ...validResponse, client_secret: SECRET });
    expect(failure.code).toBe("OAUTH_DRY_CHECK_UNEXPECTED_FIELDS");
    // `client_secret` is a label a secret hides behind, so the name is collapsed
    // to the fixed category rather than echoed.
    expect(failure.unexpected_fields).toEqual(["<redacted-field-name>"]);
    expect(failure.unexpected_field_count).toBe(1);
    expect(everythingVisible(failure)).not.toContain(SECRET);
  });

  test("PLANTED NEGATIVE: neither the value nor the name of a credential field leaks", () => {
    const failure = failureFor({
      ...validResponse,
      client_secret: SECRET,
      refresh_token: "1//0eXampleRefreshToken",
      authorization: "Bearer abcdefghijklmnop",
    });
    const visible = everythingVisible(failure);
    for (const value of [SECRET, "1//0eXampleRefreshToken", "abcdefghijklmnop"]) {
      expect(visible).not.toContain(value);
    }
    for (const name of ["client_secret", "refresh_token", "authorization"]) {
      expect(visible).not.toContain(name);
    }
    expect(failure.unexpected_fields).toEqual(["<redacted-field-name>"]);
    expect(failure.unexpected_field_count).toBe(3);
  });

  test("PLANTED NEGATIVE: a credential-shaped KEY never reaches a diagnostic", () => {
    const keys = [
      "asimp_ag_01JQZX9Y2K4M7P8RSECRETVALUE",
      "sk-abcdefghijklmnopqrstuvwx",
      "ghp_abcdefghijklmnopqrstuvwxyz012345",
      "AIzaSyA0000000000000000000000000000000",
      "GOCSPX-abcdefghijklmnop",
      "v1.s3cr3tfragmentvalue0123",
      "bearer_abcdefghijklmnop",
    ];
    for (const key of keys) {
      const failure = failureFor({ ...validResponse, [key]: "x" });
      const visible = everythingVisible(failure);
      expect(failure.code).toBe("OAUTH_DRY_CHECK_UNEXPECTED_FIELDS");
      expect(failure.unexpected_fields).toEqual(["<redacted-field-name>"]);
      expect(visible).not.toContain(key);
      // Not even a fragment long enough to be useful.
      expect(visible).not.toContain(key.slice(0, 12));
    }
  });

  test("PLANTED NEGATIVE: newline, overlong and Unicode keys are collapsed, not echoed", () => {
    const hostileKeys = [
      `line-one\nclient_secret=${SECRET}`,
      `${"a".repeat(200)}`,
      "tökén",
      "🔑",
      `x=${SECRET}`,
      " leading-space",
      "Mixed_Case_Name",
    ];
    for (const key of hostileKeys) {
      const failure = failureFor({ ...validResponse, [key]: "x" });
      const visible = everythingVisible(failure);
      expect(failure.unexpected_fields).toEqual(["<redacted-field-name>"]);
      expect(visible).not.toContain(SECRET);
      expect(visible).not.toContain("\n" as string);
      expect(visible).not.toContain("tökén");
      expect(visible).not.toContain("🔑");
      expect(visible.length).toBeLessThan(600);
    }
  });

  test("no unexpected field name is ever printed, however boring it looks", () => {
    // Names are attacker-controlled, so the diagnostic keeps only what is fixed
    // and coarse: this category plus a true count.
    const failure = failureFor({ ...validResponse, project_number: 12, quota_tier: "free" });
    expect(failure.unexpected_fields).toEqual(["<redacted-field-name>"]);
    expect(failure.unexpected_field_count).toBe(2);
    expect(everythingVisible(failure)).not.toContain("project_number");
    expect(everythingVisible(failure)).not.toContain("quota_tier");
  });

  /**
   * The direct key probe. Each of these carries its whole secret inside the
   * property *name*, and each one is lowercase snake_case, so a pattern- or
   * label-based classifier waves them through. Nothing here may appear in any
   * field a diagnostic consumer can read.
   */
  test("PLANTED NEGATIVE: credential-bearing keys that defeat a heuristic still cannot leak", () => {
    const hostileKeys = [
      "sk_live_51h8xyzabcdefghijklmnop",
      "stripe_sk_live_abcdefghijklmnop",
      "xoxb_1234567890_abcdefghijklmnop",
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      "ya29_a0argrxeabcdefghijklmnop",
      "eyjhbgcioijsuzi1niisinr5cci6ikpxvcj9",
      "aws_akiaiosfodnn7example",
      "npm_abcdefghijklmnopqrstuvwxyz012345",
      "asimp_ag_01jqzx9y2k4m7p8rsecret",
    ];
    for (const key of hostileKeys) {
      const failure = failureFor({ ...validResponse, [key]: "x" });
      const visible = everythingVisible(failure);
      expect(failure.code).toBe("OAUTH_DRY_CHECK_UNEXPECTED_FIELDS");
      expect(failure.unexpected_fields).toEqual(["<redacted-field-name>"]);
      expect(failure.unexpected_field_count).toBe(1);
      expect(visible).not.toContain(key);
      // Not even a prefix long enough to identify the credential family.
      expect(visible).not.toContain(key.slice(0, 8));
    }
  });

  test("PLANTED NEGATIVE: many hostile keys report a count, never a padded list", () => {
    const noisy: Record<string, unknown> = { ...validResponse };
    for (let index = 0; index < 25; index += 1) noisy[`sk_live_${index}${SECRET}`] = index;
    const failure = failureFor(noisy);
    expect(failure.unexpected_fields).toEqual(["<redacted-field-name>"]);
    expect(failure.unexpected_field_count).toBe(25);
    const visible = everythingVisible(failure);
    expect(visible).not.toContain(SECRET);
    expect(visible).not.toContain("sk_live_");
    expect(visible.length).toBeLessThan(600);
  });

  test("an unexpected field is refused before any value-level check runs", () => {
    // Both a wrong provider *and* an extra field: the closure check wins, so a
    // payload carrying a secret never reaches the field readers.
    const failure = failureFor({ ...validResponse, provider: "github", client_secret: SECRET });
    expect(failure.code).toBe("OAUTH_DRY_CHECK_UNEXPECTED_FIELDS");
  });

  test("a key that smuggles a value through its own name is collapsed", () => {
    const failure = failureFor({ ...validResponse, [`token=${SECRET}`]: true });
    expect(failure.code).toBe("OAUTH_DRY_CHECK_UNEXPECTED_FIELDS");
    expect(failure.unexpected_fields).toEqual(["<redacted-field-name>"]);
    expect(JSON.stringify(failure.unexpected_fields)).not.toContain(SECRET);
  });

  test("the reported list is one fixed category regardless of payload size", () => {
    const noisy: Record<string, unknown> = { ...validResponse };
    for (let index = 0; index < 40; index += 1) noisy[`extra_${index}`] = index;
    const failure = failureFor(noisy);
    expect(failure.unexpected_fields).toEqual(["<redacted-field-name>"]);
    expect(failure.unexpected_field_count).toBe(40);
  });

  test("a missing expected field is refused with its own code", () => {
    const { scopes: _omitted, ...withoutScopes } = validResponse;
    const failure = failureFor(withoutScopes);
    expect(failure.code).toBe("OAUTH_DRY_CHECK_FIELDS_MISSING");
    expect(failure.unexpected_fields).toEqual(["scopes"]);
  });

  test("the exact four-field payload is still accepted", () => {
    expect(Object.keys(validResponse).sort()).toEqual([
      "environment",
      "provider",
      "redirect_uris",
      "scopes",
    ]);
    expect(() => assertProductionOAuthDryCheck(validResponse)).not.toThrow();
  });

  test("a non-object payload keeps its existing code", () => {
    expect(() => assertProductionOAuthDryCheck([validResponse])).toThrow(
      "OAUTH_DRY_CHECK_INVALID_RESPONSE",
    );
    expect(() => assertProductionOAuthDryCheck(null)).toThrow("OAUTH_DRY_CHECK_INVALID_RESPONSE");
  });

  test("no failure carries an unexpected_fields property when there is nothing to name", () => {
    const failure = failureFor({ ...validResponse, environment: "staging" });
    expect(failure.code).toBe("OAUTH_DRY_CHECK_ENVIRONMENT_MISMATCH");
    expect("unexpected_fields" in failure).toBe(false);
  });
});
