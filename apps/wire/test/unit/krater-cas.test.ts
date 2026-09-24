import { describe, expect, test } from "bun:test";

import {
  archiveMemberPathIsSafe,
  bodyLooksSecretShaped,
  CAS_EXTRACT_CHARS,
  CAS_KEY_PREFIX,
  CAS_SPILL_THRESHOLD_BYTES,
  casExtractFor,
  casKeyForHash,
  scanBodyForSecrets,
  shouldSpillToCas,
} from "../../src/krater/cas.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("CAS keying and dedupe (W2.7)", () => {
  test("the key is the digest: identical bytes dedupe to one object site-wide", () => {
    expect(casKeyForHash(HASH_A)).toBe(`${CAS_KEY_PREFIX}${HASH_A}`);
    expect(casKeyForHash(HASH_A)).toBe(casKeyForHash(HASH_A));
    expect(casKeyForHash(HASH_A)).not.toBe(casKeyForHash(HASH_B));
  });

  test("a non-sha256-hex digest is refused, never silently keyed", () => {
    for (const bad of ["", "xyz", HASH_A.toUpperCase(), `${HASH_A}ff`, HASH_A.slice(0, 63)]) {
      expect(() => casKeyForHash(bad)).toThrow();
    }
  });

  test("PLANTED: a runtime digest cannot validate one coercion and key another", () => {
    for (const derive of [casKeyForHash]) {
      let coercions = 0;
      const digestLike = {
        [Symbol.toPrimitive](): string {
          coercions += 1;
          return coercions === 1 ? HASH_A : "../private-object";
        },
      };

      expect(() => derive(digestLike as unknown as string)).toThrow("ARTIFACT_DIGEST_INVALID");
      expect(coercions).toBe(0);
    }
  });
});

describe("the spill threshold and extract", () => {
  test("bodies over 1 KB spill; at-or-under stays in the row", () => {
    expect(shouldSpillToCas(CAS_SPILL_THRESHOLD_BYTES)).toBe(false);
    expect(shouldSpillToCas(CAS_SPILL_THRESHOLD_BYTES + 1)).toBe(true);
    for (const invalid of [
      -1,
      1.5,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => shouldSpillToCas(invalid)).toThrow("ARTIFACT_SIZE_INVALID");
    }
  });

  test("the extract is exactly 280 scalar-safe code points and never splits a surrogate pair", () => {
    const long = "x".repeat(1000);
    const extract = casExtractFor(long);
    expect(extract.length).toBe(CAS_EXTRACT_CHARS);
    expect(casExtractFor("short")).toBe("short");
    const unicode = `${"λ".repeat(CAS_EXTRACT_CHARS - 1)}😀tail`;
    const unicodeExtract = casExtractFor(unicode);
    expect([...unicodeExtract]).toHaveLength(CAS_EXTRACT_CHARS);
    expect(unicodeExtract.endsWith("😀")).toBe(true);
    expect(unicodeExtract).not.toContain("\uFFFD");
  });

  test("PLANTED: lone surrogates before and at the extract boundary normalize without splitting pairs", () => {
    for (const loneSurrogate of ["\uD800", "\uDFFF"]) {
      expect(casExtractFor(loneSurrogate)).toBe("\uFFFD");

      const beforeBoundary = casExtractFor(
        `${"x".repeat(CAS_EXTRACT_CHARS - 2)}${loneSurrogate}😀tail`,
      );
      expect(beforeBoundary).toBe(`${"x".repeat(CAS_EXTRACT_CHARS - 2)}\uFFFD😀`);
      expect([...beforeBoundary]).toHaveLength(CAS_EXTRACT_CHARS);
      // In Unicode mode the valid astral pair is one code point outside this
      // range, while a lone surrogate remains a matching invalid code point.
      expect(beforeBoundary).not.toMatch(/[\uD800-\uDFFF]/u);

      const atBoundary = casExtractFor(`${"x".repeat(CAS_EXTRACT_CHARS - 1)}${loneSurrogate}tail`);
      expect(atBoundary).toBe(`${"x".repeat(CAS_EXTRACT_CHARS - 1)}\uFFFD`);
      expect([...atBoundary]).toHaveLength(CAS_EXTRACT_CHARS);
      expect(atBoundary).not.toMatch(/[\uD800-\uDFFF]/u);
    }
  });
});

describe("the P7 secret-shaped refusal", () => {
  test("a Fellow bearer token in the body is refused before it binds", () => {
    const token = `asimp_ag_${"A".repeat(26)}_${"x".repeat(43)}`;
    expect(bodyLooksSecretShaped(`here is my token: ${token}`)).toBe(true);
    expect(bodyLooksSecretShaped(`leaked: ${token}`)).toBe(true);
  });

  test("a private key block is refused", () => {
    expect(bodyLooksSecretShaped("-----BEGIN PRIVATE KEY-----\nabc")).toBe(true);
  });

  test("ordinary research prose is not secret-shaped", () => {
    expect(
      bodyLooksSecretShaped("Every toggle-invariant labeling factors through the quotient."),
    ).toBe(false);
  });

  test("the scan reports the redacted location, never the value", () => {
    const token = `asimp_ag_${"A".repeat(26)}_${"x".repeat(43)}`;
    const body = `line one is clean\nleaked: ${token} here\nline three is clean`;
    const findings = scanBodyForSecrets(body);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const first = findings[0];
    if (first === undefined) throw new Error("expected a finding");
    expect(first.kind).toBe("fellow-token");
    expect(first.line).toBe(2);
    expect(first.column).toBe(9);
    // The finding carries no bytes of the secret.
    expect(JSON.stringify(findings)).not.toContain(token);
  });

  test("the scan reports every finding in deterministic location-and-kind order", () => {
    const first = `asimp_ag_${"A".repeat(26)}_${"x".repeat(43)}`;
    const second = `asimp_ag_${"B".repeat(26)}_${"y".repeat(43)}`;
    const findings = scanBodyForSecrets(`first ${first}; second ${second}`);
    expect(findings).toEqual([
      { kind: "fellow-token", line: 1, column: 7 },
      { kind: "prefixed-grant", line: 1, column: 7 },
      { kind: "fellow-token", line: 1, column: 95 },
      { kind: "prefixed-grant", line: 1, column: 95 },
    ]);
  });

  test("a finding column counts code points, so an astral character shifts it by one", () => {
    const token = `asimp_ag_${"A".repeat(26)}_${"x".repeat(43)}`;
    // `😀` is one code point but two UTF-16 units, so the token begins at
    // UTF-16 offset 3 and code point 2. The reported column is the code-point
    // one — 3, not the 4 a UTF-16 count would give — matching the unit
    // `casExtractFor` slices on, so a location a reader is asked to inspect
    // agrees with what they count.
    const findings = scanBodyForSecrets(`😀 ${token}`);
    expect(findings.filter((finding) => finding.kind === "fellow-token")).toEqual([
      { kind: "fellow-token", line: 1, column: 3 },
    ]);
  });

  test("personal email addresses are PII and refused", () => {
    const findings = scanBodyForSecrets("reach me at researcher@example.org for the data");
    expect(findings.some((f) => f.kind === "personal-address")).toBe(true);
    expect(bodyLooksSecretShaped("contact: someone@somewhere.com")).toBe(true);
  });

  test("the CAS URL shape does not trip the address detector", () => {
    // An artifacts URL has no @, so it must not false-positive as an address.
    expect(
      scanBodyForSecrets(`see https://artifacts.asimposium.org/sha256/${HASH_A}`),
    ).toHaveLength(0);
  });

  test("the early-exit wall stays equivalent to exhaustive diagnostics across calls", () => {
    const token = `asimp_ag_${"A".repeat(26)}_${"x".repeat(43)}`;
    for (const body of [
      "ordinary research prose",
      `first call ${token}`,
      "clean first line\ncontact: researcher@example.org",
    ]) {
      const expected = scanBodyForSecrets(body).length > 0;
      expect(bodyLooksSecretShaped(body)).toBe(expected);
      // The repeat is load-bearing: a future global/sticky regex would mutate
      // lastIndex and make the second observation disagree.
      expect(bodyLooksSecretShaped(body)).toBe(expected);
    }
  });
});

describe("archive safety bounds", () => {
  test("traversal members are refused; ordinary members pass", () => {
    expect(archiveMemberPathIsSafe("src/main.leans")).toBe(true);
    expect(archiveMemberPathIsSafe("a/b/c.txt")).toBe(true);
    expect(archiveMemberPathIsSafe("../escape")).toBe(false);
    expect(archiveMemberPathIsSafe("/absolute")).toBe(false);
    expect(archiveMemberPathIsSafe("C:\\\\windows")).toBe(false);
    expect(archiveMemberPathIsSafe("a/../../up")).toBe(false);
    expect(archiveMemberPathIsSafe("")).toBe(false);
  });
});
