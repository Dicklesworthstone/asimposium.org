import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  isTrustedStoaOrigin,
  MintEnrollmentResponseSchema,
  PRODUCTION_STOA_ORIGIN,
  parseStoaJoinUrl,
  STAGING_STOA_ORIGIN,
  STOA_HELLO_PATH,
  StoaHelloUrlSchema,
  StoaJoinUrlSchema,
  StoaOriginSchema,
  stoaHelloUrl,
  stoaJoinUrl,
} from "../../src/index.ts";

/**
 * The enrollment URL value domain.
 *
 * These URLs are credential-carrying: a join URL points a Fellow at whatever
 * origin it names, and `hello_url` is the first authenticated fetch an approved
 * agent makes. The domain is closed at the contract so no caller — Worker,
 * console, or harness — can widen it locally, and so a request-derived origin
 * can never satisfy it.
 */

const LOOPBACK = "http://127.0.0.1:8787";
const TRUSTED: string[] = [PRODUCTION_STOA_ORIGIN, STAGING_STOA_ORIGIN, LOOPBACK];

describe("trusted Stoa origins", () => {
  test.each(TRUSTED)("%s is trusted", (origin) => {
    expect(isTrustedStoaOrigin(origin)).toBe(true);
    expect(StoaOriginSchema.safeParse(origin).success).toBe(true);
  });

  test.each([
    ["a non-loopback host", "http://127.0.0.2:8787"],
    ["localhost by name", "http://localhost:8787"],
    ["loopback without a port", "http://127.0.0.1"],
    ["port zero", "http://127.0.0.1:0"],
    // `URL` drops a default port, so accepting this spelling would have put an
    // origin in the domain whose own builder output fails the URL schemas.
    ["the http default port", "http://127.0.0.1:80"],
    ["a leading-zero port", "http://127.0.0.1:08787"],
    ["a port above the range", "http://127.0.0.1:65536"],
    ["a trailing slash", "https://a.asimposium.org/"],
    ["a path", "https://a.asimposium.org/v1"],
    ["the apex", "https://asimposium.org"],
    ["a lookalike host", "https://a.asimposium.org.evil.test"],
    ["plaintext production", "http://a.asimposium.org"],
    ["an empty string", ""],
  ])("PLANTED: %s is refused", (_label, origin) => {
    expect(isTrustedStoaOrigin(origin)).toBe(false);
    expect(StoaOriginSchema.safeParse(origin).success).toBe(false);
  });

  test("PLANTED: a non-string is refused without throwing", () => {
    expect(isTrustedStoaOrigin(undefined)).toBe(false);
    expect(isTrustedStoaOrigin(8787)).toBe(false);
  });
});

describe("hello url builder", () => {
  test.each(TRUSTED)("%s builds exactly one hello path", (origin) => {
    const url = stoaHelloUrl(origin);
    expect(url).toBe(`${origin}${STOA_HELLO_PATH}`);
    expect(StoaHelloUrlSchema.safeParse(url).success).toBe(true);
  });

  test("PLANTED: an untrusted origin cannot build a hello url", () => {
    expect(() => stoaHelloUrl("https://evil.test")).toThrow(/trusted Stoa origin/);
    // A request-derived origin is the specific hazard: it must be refused at
    // the builder rather than validated after it has already been emitted.
    expect(() => stoaHelloUrl("https://a.asimposium.org.evil.test")).toThrow();
  });

  test.each([
    ["a query string", `${PRODUCTION_STOA_ORIGIN}/v1/hello?token=leak`],
    ["a fragment", `${PRODUCTION_STOA_ORIGIN}/v1/hello#v1.secret`],
    ["embedded credentials", "https://user:pass@a.asimposium.org/v1/hello"],
    ["a different path", `${PRODUCTION_STOA_ORIGIN}/v1/hello/extra`],
    ["a trailing slash", `${PRODUCTION_STOA_ORIGIN}/v1/hello/`],
    ["an untrusted origin", "https://evil.test/v1/hello"],
  ])("PLANTED: a hello url with %s is refused", (_label, candidate) => {
    expect(StoaHelloUrlSchema.safeParse(candidate).success).toBe(false);
  });

  // `new URL()` normalizes before it reports, so validating only `parsed.origin`
  // silently accepted each of these. They must be refused for the same reason
  // `StoaOriginSchema` refuses the bare spellings: the URL is compared as a
  // string, so one canonical form is the whole point.
  test.each([
    ["an uppercase host", "https://A.ASIMPOSIUM.ORG/v1/hello"],
    ["a mixed-case host", "https://a.Asimposium.org/v1/hello"],
    ["an explicit default port", "https://a.asimposium.org:443/v1/hello"],
    ["an explicit http default port", "http://127.0.0.1:80/v1/hello"],
    ["a leading-zero loopback port", "http://127.0.0.1:08787/v1/hello"],
    ["a percent-encoded path", "https://a.asimposium.org/v1/%68ello"],
  ])("PLANTED: a non-canonical hello url with %s is refused", (_label, candidate) => {
    expect(StoaHelloUrlSchema.safeParse(candidate).success).toBe(false);
  });
});

const ENROLLMENT_ID = "ASIMP-EN-01JXYZ4K6Q";
const SECRET = `v1.${"a".repeat(43)}`;

function mintResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enrollment_id: ENROLLMENT_ID,
    join_url: stoaJoinUrl(PRODUCTION_STOA_ORIGIN, ENROLLMENT_ID, SECRET),
    secret: SECRET,
    expires_at: 1_786_000_000,
    ...overrides,
  };
}

describe("join url domain", () => {
  test.each(TRUSTED)("%s builds and accepts an exact join url", (origin) => {
    const joinUrl = stoaJoinUrl(origin, ENROLLMENT_ID, SECRET);
    expect(joinUrl).toBe(`${origin}/join/${ENROLLMENT_ID}#${SECRET}`);
    expect(StoaJoinUrlSchema.safeParse(joinUrl).success).toBe(true);
    const parsed = parseStoaJoinUrl(joinUrl);
    expect(parsed?.origin).toBe(origin);
    expect(parsed?.enrollmentId).toBe(ENROLLMENT_ID);
    expect(parsed?.secret).toBe(SECRET);
  });

  test.each([
    ["a missing fragment", `${PRODUCTION_STOA_ORIGIN}/join/${ENROLLMENT_ID}`],
    ["an empty fragment", `${PRODUCTION_STOA_ORIGIN}/join/${ENROLLMENT_ID}#`],
    ["an invalid fragment", `${PRODUCTION_STOA_ORIGIN}/join/${ENROLLMENT_ID}#not-a-secret`],
    [
      "an unversioned fragment",
      `${PRODUCTION_STOA_ORIGIN}/join/${ENROLLMENT_ID}#${"a".repeat(43)}`,
    ],
    ["a malformed enrollment id", `${PRODUCTION_STOA_ORIGIN}/join/NOT-AN-ID#${SECRET}`],
    ["an extra path segment", `${PRODUCTION_STOA_ORIGIN}/join/${ENROLLMENT_ID}/extra#${SECRET}`],
    ["a missing id segment", `${PRODUCTION_STOA_ORIGIN}/join/#${SECRET}`],
    ["an untrusted origin", `https://evil.test/join/${ENROLLMENT_ID}#${SECRET}`],
    ["a query string", `${PRODUCTION_STOA_ORIGIN}/join/${ENROLLMENT_ID}?s=1#${SECRET}`],
    ["embedded credentials", `https://user:pass@a.asimposium.org/join/${ENROLLMENT_ID}#${SECRET}`],
    ["a non-join path", `${PRODUCTION_STOA_ORIGIN}/v1/hello#${SECRET}`],
    ["a bare string", "not-a-url"],
  ])("PLANTED: a join url with %s is refused", (_label, candidate) => {
    expect(StoaJoinUrlSchema.safeParse(candidate).success).toBe(false);
    expect(parseStoaJoinUrl(candidate)).toBeUndefined();
  });

  test.each([
    ["an uppercase host", `https://A.ASIMPOSIUM.ORG/join/${ENROLLMENT_ID}#${SECRET}`],
    ["an explicit default port", `https://a.asimposium.org:443/join/${ENROLLMENT_ID}#${SECRET}`],
    ["a leading-zero loopback port", `http://127.0.0.1:08787/join/${ENROLLMENT_ID}#${SECRET}`],
  ])("PLANTED: a non-canonical join url with %s is refused", (_label, candidate) => {
    expect(StoaJoinUrlSchema.safeParse(candidate).success).toBe(false);
    expect(parseStoaJoinUrl(candidate)).toBeUndefined();
  });

  test("PLANTED: the builder refuses every untrusted or malformed input", () => {
    expect(() => stoaJoinUrl("https://evil.test", ENROLLMENT_ID, SECRET)).toThrow(/trusted/);
    expect(() => stoaJoinUrl(PRODUCTION_STOA_ORIGIN, "NOT-AN-ID", SECRET)).toThrow(/enrollment id/);
    expect(() => stoaJoinUrl(PRODUCTION_STOA_ORIGIN, ENROLLMENT_ID, "nope")).toThrow(/secret/);
  });

  test("the fragment asymmetry is deliberate: hello refuses what join requires", () => {
    expect(
      StoaJoinUrlSchema.safeParse(stoaJoinUrl(PRODUCTION_STOA_ORIGIN, ENROLLMENT_ID, SECRET))
        .success,
    ).toBe(true);
    expect(
      StoaHelloUrlSchema.safeParse(`${PRODUCTION_STOA_ORIGIN}/v1/hello#${SECRET}`).success,
    ).toBe(false);
  });
});

/**
 * The origin domain must be closed under both builders.
 *
 * `isTrustedStoaOrigin` and the URL schemas are independent gates and nothing
 * forces them to agree. `http://127.0.0.1:80` satisfied every origin check, but
 * `URL` drops a default port, so `stoaHelloUrl` and `stoaJoinUrl` emitted
 * strings their own schemas rejected. That is worse than a refusal: a mint
 * durably issues an enrollment and only then fails to validate the response it
 * has already committed, leaving a live secret nobody can return. This table
 * proves closure over the whole accepted domain rather than sampling it.
 */
describe("builder closure over the accepted origin domain", () => {
  const ACCEPTED: string[] = [
    PRODUCTION_STOA_ORIGIN,
    STAGING_STOA_ORIGIN,
    "http://127.0.0.1:1",
    "http://127.0.0.1:443",
    "http://127.0.0.1:8787",
    "http://127.0.0.1:65535",
  ];

  test.each(ACCEPTED)("%s builds hello and join urls its own schemas accept", (origin) => {
    expect(isTrustedStoaOrigin(origin)).toBe(true);
    expect(StoaHelloUrlSchema.safeParse(stoaHelloUrl(origin)).success).toBe(true);
    const joinUrl = stoaJoinUrl(origin, ENROLLMENT_ID, SECRET);
    expect(StoaJoinUrlSchema.safeParse(joinUrl).success).toBe(true);
    // The mint response is the durable artifact, so it must validate too:
    // this is the assertion that would have caught the issue-then-fail path.
    expect(
      MintEnrollmentResponseSchema.safeParse(mintResponse({ join_url: joinUrl })).success,
    ).toBe(true);
  });

  test("PLANTED: the http default port is refused rather than left to fail downstream", () => {
    const defaultPort = "http://127.0.0.1:80";
    expect(isTrustedStoaOrigin(defaultPort)).toBe(false);
    expect(StoaOriginSchema.safeParse(defaultPort).success).toBe(false);
    // The builders refuse at the source, so no caller can reach the state
    // where an emitted URL fails the schema that is supposed to describe it.
    expect(() => stoaHelloUrl(defaultPort)).toThrow();
    expect(() => stoaJoinUrl(defaultPort, ENROLLMENT_ID, SECRET)).toThrow();
    // Causal: this is the string the builders would have produced, and it does
    // not survive the schemas — which is why the origin must be refused.
    expect(StoaHelloUrlSchema.safeParse(`${defaultPort}${STOA_HELLO_PATH}`).success).toBe(false);
    expect(
      StoaJoinUrlSchema.safeParse(`${defaultPort}/join/${ENROLLMENT_ID}#${SECRET}`).success,
    ).toBe(false);
  });
});

/**
 * The published artifact must not overstate what the contract accepts.
 *
 * `refine()` is invisible to `toJSONSchema`, so `origin`, `join_url` and
 * `hello_url` were emitted as bare strings: anyone validating against our own
 * published schema would have accepted `https://evil.test/join/…`. A schema
 * that silently accepts a foreign origin is worse than no schema, because it
 * launders the value as checked. These tests run the real generated files, not
 * the Zod objects, so they fail if generation regresses or is skipped.
 */
describe("generated artifacts carry the origin semantics", () => {
  const enrollment = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../../generated/enrollment.schema.json"), "utf8"),
  );
  const capsule = JSON.parse(
    readFileSync(
      resolve(import.meta.dir, "../../generated/enrollment-capsule.schema.json"),
      "utf8",
    ),
  );

  const patternOf = (node: Record<string, unknown>): RegExp => {
    const pattern = node.pattern;
    expect(typeof pattern).toBe("string");
    return new RegExp(pattern as string);
  };

  const ORIGIN = patternOf(capsule.properties.origin);
  const JOIN = patternOf(enrollment.properties.mint_response.properties.join_url);
  const HELLO = patternOf(enrollment.properties.approved_response.properties.hello_url);

  test.each(TRUSTED)("%s and its built URLs satisfy the published patterns", (origin) => {
    expect(ORIGIN.test(origin)).toBe(true);
    expect(HELLO.test(stoaHelloUrl(origin))).toBe(true);
    expect(JOIN.test(stoaJoinUrl(origin, ENROLLMENT_ID, SECRET))).toBe(true);
  });

  test.each([
    ["a foreign origin", "https://evil.test"],
    ["a lookalike host", "https://a.asimposium.org.evil.test"],
    ["a subdomain of the real host", "https://x.a.asimposium.org"],
    ["plaintext production", "http://a.asimposium.org"],
    ["the apex", "https://asimposium.org"],
    ["loopback by name", "http://localhost:8787"],
    ["an uppercase host", "https://A.ASIMPOSIUM.ORG"],
    ["an explicit default port", "https://a.asimposium.org:443"],
    ["the http default port", "http://127.0.0.1:80"],
    ["a leading-zero port", "http://127.0.0.1:08787"],
    ["port zero", "http://127.0.0.1:0"],
    ["a port above the range", "http://127.0.0.1:65536"],
    ["a trailing slash", "https://a.asimposium.org/"],
  ])("PLANTED: the published origin pattern rejects %s", (_label, candidate) => {
    expect(ORIGIN.test(candidate)).toBe(false);
  });

  test.each([
    ["a foreign origin", "https://evil.test/v1/hello"],
    ["a lookalike host", "https://a.asimposium.org.evil.test/v1/hello"],
    ["embedded credentials", "https://user:pass@a.asimposium.org/v1/hello"],
    ["a query string", "https://a.asimposium.org/v1/hello?token=leak"],
    ["a fragment", `https://a.asimposium.org/v1/hello#${SECRET}`],
    ["a deeper path", "https://a.asimposium.org/v1/hello/extra"],
    ["a trailing slash", "https://a.asimposium.org/v1/hello/"],
    ["the default port spelled out", "https://a.asimposium.org:443/v1/hello"],
    ["a different path entirely", "https://a.asimposium.org/v1/fellows"],
  ])("PLANTED: the published hello pattern rejects %s", (_label, candidate) => {
    expect(HELLO.test(candidate)).toBe(false);
  });

  test.each([
    ["a foreign origin", `https://evil.test/join/${ENROLLMENT_ID}#${SECRET}`],
    ["a missing fragment", `${PRODUCTION_STOA_ORIGIN}/join/${ENROLLMENT_ID}`],
    ["an empty fragment", `${PRODUCTION_STOA_ORIGIN}/join/${ENROLLMENT_ID}#`],
    ["an invalid fragment", `${PRODUCTION_STOA_ORIGIN}/join/${ENROLLMENT_ID}#not-a-secret`],
    [
      "an unversioned fragment",
      `${PRODUCTION_STOA_ORIGIN}/join/${ENROLLMENT_ID}#${"a".repeat(43)}`,
    ],
    ["a malformed enrollment id", `${PRODUCTION_STOA_ORIGIN}/join/NOT-AN-ID#${SECRET}`],
    ["an extra path segment", `${PRODUCTION_STOA_ORIGIN}/join/${ENROLLMENT_ID}/extra#${SECRET}`],
    ["a missing id segment", `${PRODUCTION_STOA_ORIGIN}/join/#${SECRET}`],
    ["a query string", `${PRODUCTION_STOA_ORIGIN}/join/${ENROLLMENT_ID}?s=1#${SECRET}`],
    ["embedded credentials", `https://user:pass@a.asimposium.org/join/${ENROLLMENT_ID}#${SECRET}`],
    ["the hello path", `${PRODUCTION_STOA_ORIGIN}/v1/hello#${SECRET}`],
    ["a bare string", "not-a-url"],
  ])("PLANTED: the published join pattern rejects %s", (_label, candidate) => {
    expect(JOIN.test(candidate)).toBe(false);
  });

  /**
   * The pattern is a second implementation of the same domain, so it can drift
   * from the predicate. Rather than trust the comment that says they agree,
   * sweep the interesting neighbourhood and require identical verdicts.
   */
  test("the published origin pattern and the runtime predicate agree", () => {
    const corpus = [
      PRODUCTION_STOA_ORIGIN,
      STAGING_STOA_ORIGIN,
      "https://evil.test",
      "https://a.asimposium.org.evil.test",
      "http://a.asimposium.org",
      "https://asimposium.org",
      "http://localhost:8787",
      "http://127.0.0.2:8787",
      "https://A.ASIMPOSIUM.ORG",
      "https://a.asimposium.org:443",
      "https://a.asimposium.org/",
      "",
      ...[0, 1, 9, 10, 79, 80, 81, 99, 100, 443, 999, 1_000, 8_787, 9_999, 10_000].map(
        (port) => `http://127.0.0.1:${port}`,
      ),
      ...[59_999, 60_000, 64_999, 65_000, 65_499, 65_500, 65_529, 65_530, 65_535, 65_536].map(
        (port) => `http://127.0.0.1:${port}`,
      ),
      "http://127.0.0.1:080",
      "http://127.0.0.1:08787",
      "http://127.0.0.1:",
      "http://127.0.0.1",
    ];
    for (const candidate of corpus) {
      expect({ candidate, pattern: ORIGIN.test(candidate) }).toEqual({
        candidate,
        pattern: isTrustedStoaOrigin(candidate),
      });
    }
  });

  test("the mint artifact states the cross-field check it cannot express", () => {
    // JSON Schema has no keyword for "join_url embeds these sibling fields", so
    // the artifact must say so rather than imply it validated it.
    const description = enrollment.properties.mint_response.description;
    expect(typeof description).toBe("string");
    expect(description).toContain("cannot express");
    expect(description).toContain("enforced at runtime");
    // The structural half is still published, so the claim is scoped, not a
    // blanket disclaimer that would excuse the patterns above from existing.
    expect(JOIN.test(stoaJoinUrl(PRODUCTION_STOA_ORIGIN, ENROLLMENT_ID, SECRET))).toBe(true);
  });

  test("PLANTED: the artifact cannot catch a coherent-shaped but incoherent mint response", () => {
    // Both URLs below satisfy the published pattern; only the runtime contract
    // rejects the second. This is the exact boundary the description names.
    const foreign = stoaJoinUrl(PRODUCTION_STOA_ORIGIN, "ASIMP-EN-02KKKK4K6Q", SECRET);
    expect(JOIN.test(foreign)).toBe(true);
    expect(
      MintEnrollmentResponseSchema.safeParse(mintResponse({ join_url: foreign })).success,
    ).toBe(false);
  });
});

describe("mint response coherence", () => {
  test("a coherent mint response validates", () => {
    expect(MintEnrollmentResponseSchema.safeParse(mintResponse()).success).toBe(true);
  });

  test("PLANTED: join_url naming a different enrollment is refused", () => {
    const result = MintEnrollmentResponseSchema.safeParse(
      mintResponse({ enrollment_id: "ASIMP-EN-02KKKK4K6Q" }),
    );
    expect(result.success).toBe(false);
  });

  test("PLANTED: join_url carrying a different secret is refused", () => {
    const result = MintEnrollmentResponseSchema.safeParse(
      mintResponse({ secret: `v1.${"b".repeat(43)}` }),
    );
    expect(result.success).toBe(false);
  });
});
