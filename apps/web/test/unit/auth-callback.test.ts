import { describe, expect, test } from "bun:test";
import { BARE_CALLBACK_REDIRECT, isBareOAuthCallback } from "../../lib/auth-callback";

const at = (path: string): URL => new URL(path, "https://asimposium.org");

describe("bare OAuth callbacks (a reload or restored tab)", () => {
  test("a callback with neither code nor error is bare", () => {
    expect(isBareOAuthCallback(at("/api/auth/callback/google"))).toBe(true);
    expect(isBareOAuthCallback(at("/api/auth/callback/google?state=x"))).toBe(true);
  });

  test("a callback carrying code or error goes to Auth.js unchanged", () => {
    expect(isBareOAuthCallback(at("/api/auth/callback/google?code=c&state=s"))).toBe(false);
    expect(isBareOAuthCallback(at("/api/auth/callback/google?error=access_denied"))).toBe(false);
  });

  test("other Auth.js routes are never intercepted", () => {
    expect(isBareOAuthCallback(at("/api/auth/session"))).toBe(false);
    expect(isBareOAuthCallback(at("/api/auth/signin/google"))).toBe(false);
    expect(isBareOAuthCallback(at("/api/auth/csrf"))).toBe(false);
  });

  test("the redirect lands on the stale-state explanation, not Configuration", () => {
    expect(BARE_CALLBACK_REDIRECT).toBe("/auth/error?error=Verification");
  });
});
