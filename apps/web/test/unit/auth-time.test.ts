import { describe, expect, test } from "bun:test";

import { authTimeFromIdToken, validAuthTime } from "../../lib/auth-time";

/**
 * The step-up gate's evidence source: the Google ID token issued for the OAuth
 * callback, not Auth.js's refreshable session JWT and not Google's optional
 * `auth_time`. Preferring an old `auth_time` was the bug that left the approve
 * page's step-up callout permanently on.
 */

function idTokenWith(payload: Record<string, unknown>): string {
  const segment = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `header.${segment}.signature`;
}

describe("authTimeFromIdToken", () => {
  test("extracts a valid provider-issued iat from the payload", () => {
    const now = Math.floor(Date.now() / 1_000);
    expect(authTimeFromIdToken(idTokenWith({ iat: now, sub: "g-1" }))).toBe(now);
  });

  test("returns undefined when the ID token is absent or malformed", () => {
    expect(authTimeFromIdToken(undefined)).toBeUndefined();
    expect(authTimeFromIdToken(null)).toBeUndefined();
    expect(authTimeFromIdToken(42)).toBeUndefined();
    expect(authTimeFromIdToken("")).toBeUndefined();
    expect(authTimeFromIdToken("no-segments")).toBeUndefined();
    expect(authTimeFromIdToken("a.!!!not-base64-json!!!.c")).toBeUndefined();
    const valid = idTokenWith({ iat: 1_700_000_000 });
    const [header, payload, signature] = valid.split(".");
    expect(header).toBeDefined();
    expect(payload).toBeDefined();
    expect(signature).toBeDefined();
    expect(authTimeFromIdToken(`${header}.${payload}`)).toBeUndefined();
    expect(authTimeFromIdToken(`${header}.${payload}.${signature}.extra`)).toBeUndefined();
    expect(authTimeFromIdToken(`.${payload}.${signature}`)).toBeUndefined();
    expect(authTimeFromIdToken(`${header}.${payload}.`)).toBeUndefined();
    expect(authTimeFromIdToken(`${header}.${payload}!.${signature}`)).toBeUndefined();

    const invalidUtf8Payload = Buffer.concat([
      Buffer.from('{"iat":1700000000,"invalid":"', "utf8"),
      Buffer.from([0xff]),
      Buffer.from('"}', "utf8"),
    ]).toString("base64url");
    expect(authTimeFromIdToken(`${header}.${invalidUtf8Payload}.${signature}`)).toBeUndefined();

    let payloadBytes = Buffer.from('{"iat":1700000000}', "utf8");
    while (payloadBytes.length % 3 === 0) {
      payloadBytes = Buffer.concat([payloadBytes, Buffer.from(" ")]);
    }
    const canonicalPayload = payloadBytes.toString("base64url");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const noncanonicalPayload = [...alphabet]
      .map((last) => `${canonicalPayload.slice(0, -1)}${last}`)
      .find(
        (candidate) =>
          candidate !== canonicalPayload &&
          Buffer.from(candidate, "base64url").equals(payloadBytes),
      );
    if (noncanonicalPayload === undefined) throw new Error("fixture needs unused base64url bits");
    expect(authTimeFromIdToken(`${header}.${noncanonicalPayload}.${signature}`)).toBeUndefined();
  });

  test("returns undefined when iat is missing or the wrong shape", () => {
    expect(authTimeFromIdToken(idTokenWith({ sub: "g-1" }))).toBeUndefined();
    expect(authTimeFromIdToken(idTokenWith({ iat: "1700000000" }))).toBeUndefined();
    expect(authTimeFromIdToken(idTokenWith({ iat: -1 }))).toBeUndefined();
    expect(authTimeFromIdToken(idTokenWith({ iat: 1.5 }))).toBeUndefined();
  });

  test("does not preserve a stale optional auth_time over the callback's signed iat", () => {
    const issuedNow = 1_800_000_000;
    expect(authTimeFromIdToken(idTokenWith({ iat: issuedNow, auth_time: 1_700_000_000 }))).toBe(
      issuedNow,
    );
    expect(authTimeFromIdToken(idTokenWith({ auth_time: issuedNow }))).toBeUndefined();
  });

  test("reads only the payload segment — a forged signature segment is irrelevant", () => {
    const now = Math.floor(Date.now() / 1_000);
    const token = idTokenWith({ iat: now });
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
