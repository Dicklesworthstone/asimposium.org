import { describe, expect, test } from "bun:test";

import { authTimeFromIdToken, validAuthTime } from "../../lib/auth-time";

/**
 * The step-up gate's evidence source: Google's `auth_time` is an ID-token-only
 * claim — the userinfo endpoint never carries it, so the jwt callback must
 * read it from the (already signature-verified) ID token. This is the bug
 * class that left the approve page's re-authenticate callout permanently on:
 * the claim was requested from Google but never actually captured.
 */

function idTokenWith(payload: Record<string, unknown>): string {
  const segment = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `header.${segment}.signature`;
}

describe("authTimeFromIdToken", () => {
  test("extracts a valid auth_time from the payload", () => {
    const now = Math.floor(Date.now() / 1_000);
    expect(authTimeFromIdToken(idTokenWith({ auth_time: now, sub: "g-1" }))).toBe(now);
  });

  test("returns undefined when the ID token is absent or malformed", () => {
    expect(authTimeFromIdToken(undefined)).toBeUndefined();
    expect(authTimeFromIdToken(null)).toBeUndefined();
    expect(authTimeFromIdToken(42)).toBeUndefined();
    expect(authTimeFromIdToken("")).toBeUndefined();
    expect(authTimeFromIdToken("no-segments")).toBeUndefined();
    expect(authTimeFromIdToken("a.!!!not-base64-json!!!.c")).toBeUndefined();
  });

  test("returns undefined when auth_time is missing or the wrong shape", () => {
    expect(authTimeFromIdToken(idTokenWith({ sub: "g-1" }))).toBeUndefined();
    expect(authTimeFromIdToken(idTokenWith({ auth_time: "1700000000" }))).toBeUndefined();
    expect(authTimeFromIdToken(idTokenWith({ auth_time: -1 }))).toBeUndefined();
    expect(authTimeFromIdToken(idTokenWith({ auth_time: 1.5 }))).toBeUndefined();
  });

  test("reads only the payload segment — a forged signature segment is irrelevant", () => {
    const now = Math.floor(Date.now() / 1_000);
    const token = idTokenWith({ auth_time: now });
    expect(authTimeFromIdToken(token.replace(/signature$/, "forged"))).toBe(now);
  });
});

describe("validAuthTime", () => {
  test("accepts only non-negative safe integers", () => {
    expect(validAuthTime(1_700_000_000)).toBe(1_700_000_000);
    expect(validAuthTime(0)).toBe(0);
    expect(validAuthTime(undefined)).toBeUndefined();
    expect(validAuthTime("1700000000")).toBeUndefined();
    expect(validAuthTime(-5)).toBeUndefined();
    expect(validAuthTime(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
    expect(validAuthTime(Number.NaN)).toBeUndefined();
  });
});
