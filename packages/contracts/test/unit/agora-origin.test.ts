import { describe, expect, test } from "bun:test";

import {
  AGORA_APPROVE_PATH,
  AGORA_APPROVE_URL_PATTERN,
  AGORA_ORIGIN_PATTERN,
  AgoraApproveUrlSchema,
  AgoraOriginSchema,
  agoraApproveUrl,
  isTrustedAgoraOrigin,
  PRODUCTION_AGORA_ORIGIN,
  STAGING_AGORA_ORIGIN,
} from "../../src/index.ts";

/**
 * The Agora approval-URL value domain (bead asimposiumorg-0yt, first slice).
 *
 * The sponsor's approval URL is followed by a *human*, mid-enrollment. A staging
 * Stoa that hands out the production apex moves that person onto another plane
 * without telling them, and the mistake is invisible in production because there
 * it is correct. So the domain is closed at the contract, exactly as the Stoa
 * origin domain is, and asserted rather than described.
 *
 * Nothing consumes this vocabulary yet: `DeviceCodeStartResponseSchema` still
 * carries its literal and the generated artifacts are untouched. These tests
 * therefore prove the domain in isolation, before any deployment can emit from
 * it.
 */

const ORIGIN = new RegExp(AGORA_ORIGIN_PATTERN);
const APPROVE_URL = new RegExp(AGORA_APPROVE_URL_PATTERN);
const TRUSTED: string[] = [PRODUCTION_AGORA_ORIGIN, STAGING_AGORA_ORIGIN];

describe("the trusted Agora origin set", () => {
  test("is exactly the two designated per-environment origins, in canonical spelling", () => {
    expect(TRUSTED).toEqual(["https://asimposium.org", "https://staging.asimposium.org"]);
    for (const origin of TRUSTED) {
      expect(isTrustedAgoraOrigin(origin)).toBe(true);
      expect(AgoraOriginSchema.safeParse(origin).success).toBe(true);
      // Canonical means URL round-trips it unchanged; both constants must
      // already satisfy the predicate's own round trip.
      expect(new URL(origin).origin).toBe(origin);
    }
  });

  test("PLANTED: a non-string is refused without throwing", () => {
    for (const candidate of [undefined, null, 42, {}, [], new URL(PRODUCTION_AGORA_ORIGIN)]) {
      expect(isTrustedAgoraOrigin(candidate)).toBe(false);
    }
  });

  test("PLANTED: neighbouring and look-alike origins are refused", () => {
    const untrusted = [
      // The sibling planes are not the human plane.
      "https://a.asimposium.org",
      "https://a-staging.asimposium.org",
      "https://artifacts.asimposium.org",
      // Suffix and prefix confusables.
      "https://asimposium.org.evil.test",
      "https://staging.asimposium.org.evil.test",
      "https://evilasimposium.org",
      "https://www.asimposium.org",
      // Scheme, case, port, and trailing-slash spellings URL would rewrite.
      "http://asimposium.org",
      "https://ASIMPOSIUM.ORG",
      "https://Staging.Asimposium.Org",
      "https://asimposium.org:443",
      "https://staging.asimposium.org:443",
      "https://asimposium.org/",
      "https://asimposium.org/approve",
      // Loopback is deliberately absent from the Agora set.
      "http://127.0.0.1:3000",
      "http://localhost:3000",
      "",
    ];
    for (const candidate of untrusted) {
      expect({ candidate, trusted: isTrustedAgoraOrigin(candidate) }).toEqual({
        candidate,
        trusted: false,
      });
      expect(AgoraOriginSchema.safeParse(candidate).success).toBe(false);
    }
  });

  /**
   * The pattern is a second implementation of the same domain, so it can drift
   * from the predicate. Sweep the neighbourhood and require identical verdicts
   * rather than trusting the comment that says they agree.
   */
  test("the published origin pattern and the runtime predicate agree", () => {
    const corpus = [
      PRODUCTION_AGORA_ORIGIN,
      STAGING_AGORA_ORIGIN,
      "https://a.asimposium.org",
      "https://a-staging.asimposium.org",
      "https://artifacts.asimposium.org",
      "https://asimposium.org.evil.test",
      "https://staging.asimposium.org.evil.test",
      "https://evil.test",
      "http://asimposium.org",
      "http://staging.asimposium.org",
      "https://ASIMPOSIUM.ORG",
      "https://asimposium.org:443",
      "https://staging.asimposium.org:443",
      "https://asimposium.org/",
      "https://asimposium.org/approve",
      "https://asimposium.orgx",
      "https://xasimposium.org",
      "https://sub.staging.asimposium.org",
      "http://127.0.0.1:3000",
      "http://localhost:3000",
      "",
      " https://asimposium.org",
      "https://asimposium.org ",
    ];
    for (const candidate of corpus) {
      expect({ candidate, pattern: ORIGIN.test(candidate) }).toEqual({
        candidate,
        pattern: isTrustedAgoraOrigin(candidate),
      });
    }
  });
});

describe("the approve-url builder", () => {
  test("emits exactly one path on each trusted origin", () => {
    expect(AGORA_APPROVE_PATH).toBe("/approve");
    expect(agoraApproveUrl(PRODUCTION_AGORA_ORIGIN)).toBe("https://asimposium.org/approve");
    expect(agoraApproveUrl(STAGING_AGORA_ORIGIN)).toBe("https://staging.asimposium.org/approve");
  });

  test("its output is exactly what the published url schema accepts", () => {
    for (const origin of TRUSTED) {
      const built = agoraApproveUrl(origin);
      expect(AgoraApproveUrlSchema.safeParse(built).success).toBe(true);
      expect(APPROVE_URL.test(built)).toBe(true);
      // Closed domain: the builder can emit nothing its own schema rejects.
      const parsed = new URL(built);
      expect(parsed.href).toBe(built);
      expect(parsed.pathname).toBe(AGORA_APPROVE_PATH);
      expect(parsed.search).toBe("");
      expect(parsed.hash).toBe("");
      expect(parsed.username).toBe("");
      expect(parsed.password).toBe("");
    }
  });

  test("PLANTED: the builder refuses every untrusted or malformed origin", () => {
    const refused: unknown[] = [
      "https://a.asimposium.org",
      "https://evil.test",
      "http://asimposium.org",
      "https://asimposium.org/",
      "https://asimposium.org:443",
      "https://ASIMPOSIUM.ORG",
      "http://127.0.0.1:3000",
      "",
      undefined,
      null,
      42,
    ];
    for (const candidate of refused) {
      expect(() => agoraApproveUrl(candidate as string)).toThrow(TypeError);
    }
  });

  test("PLANTED: credential, query, fragment, and path variants are refused", () => {
    const refused = [
      "https://asimposium.org/approve?user_code=ABCD1234",
      "https://asimposium.org/approve#ABCD1234",
      "https://user:pass@asimposium.org/approve",
      "https://asimposium.org/approve/",
      "https://asimposium.org/approve/extra",
      "https://asimposium.org/Approve",
      "https://asimposium.org/api/auth/callback/google",
      "https://a.asimposium.org/approve",
      "http://asimposium.org/approve",
      "https://asimposium.org:443/approve",
      "https://ASIMPOSIUM.ORG/approve",
      "https://asimposium.org.evil.test/approve",
      "/approve",
      "",
    ];
    for (const candidate of refused) {
      expect({ candidate, ok: AgoraApproveUrlSchema.safeParse(candidate).success }).toEqual({
        candidate,
        ok: false,
      });
    }
  });

  test("the published approve-url pattern and the schema agree", () => {
    const corpus = [
      ...TRUSTED.map((origin) => `${origin}${AGORA_APPROVE_PATH}`),
      "https://asimposium.org/approve?user_code=ABCD1234",
      "https://asimposium.org/approve#ABCD1234",
      "https://asimposium.org/approve/",
      "https://asimposium.org/approve/extra",
      "https://asimposium.org/Approve",
      "https://a.asimposium.org/approve",
      "http://asimposium.org/approve",
      "https://asimposium.org:443/approve",
      "https://asimposium.org.evil.test/approve",
      "https://asimposium.org",
      "/approve",
      "",
    ];
    for (const candidate of corpus) {
      expect({ candidate, pattern: APPROVE_URL.test(candidate) }).toEqual({
        candidate,
        pattern: AgoraApproveUrlSchema.safeParse(candidate).success,
      });
    }
  });
});

describe("this slice changes nothing a deployment emits", () => {
  test("the production approve url is byte-identical to today's device-flow literal", () => {
    // `DeviceCodeStartResponseSchema.verification_url` is still that literal and
    // is deliberately untouched here. This asserts the replacement, when it
    // lands, is the same bytes in production — so the swap is provably a no-op
    // there and a real change only on staging.
    expect(agoraApproveUrl(PRODUCTION_AGORA_ORIGIN)).toBe("https://asimposium.org/approve");
  });

  test("the staging approve url never names the production apex", () => {
    const staging = agoraApproveUrl(STAGING_AGORA_ORIGIN);
    expect(staging.startsWith(STAGING_AGORA_ORIGIN)).toBe(true);
    expect(staging).not.toContain("//asimposium.org");
    expect(staging).not.toBe(agoraApproveUrl(PRODUCTION_AGORA_ORIGIN));
  });
});
