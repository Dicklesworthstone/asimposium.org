import { describe, expect, test } from "bun:test";

import {
  byteLength,
  contentFingerprint,
  FINGERPRINT_ALGORITHM,
  stableStringify,
} from "../../src/canonical.ts";

describe("stableStringify", () => {
  test("is insensitive to key insertion order", () => {
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify(a)).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test("preserves array order, which is meaningful in a projection", () => {
    expect(stableStringify([{ b: 1 }, { a: 2 }])).toBe('[{"b":1},{"a":2}]');
  });

  test("drops undefined members, as JSON does", () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  test("indents when asked, for the JSON face", () => {
    expect(stableStringify({ b: 1, a: 2 }, 2)).toBe('{\n  "a": 2,\n  "b": 1\n}');
  });
});

describe("contentFingerprint", () => {
  test("names its algorithm, because it is not a cryptographic digest", () => {
    expect(contentFingerprint("x").startsWith(`${FINGERPRINT_ALGORITHM}:`)).toBe(true);
    expect(contentFingerprint("x")).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
  });

  test("is deterministic across calls", () => {
    expect(contentFingerprint("the same bytes")).toBe(contentFingerprint("the same bytes"));
  });

  test("changes when a single byte changes", () => {
    expect(contentFingerprint("S(k) < 2^k")).not.toBe(contentFingerprint("S(k) <= 2^k"));
  });

  test("matches the published FNV-1a 64-bit vector for the empty string", () => {
    // FNV-1a 64-bit offset basis, unchanged by zero input.
    expect(contentFingerprint("")).toBe("fnv1a64:cbf29ce484222325");
  });

  test("matches the published FNV-1a 64-bit vector for 'a'", () => {
    expect(contentFingerprint("a")).toBe("fnv1a64:af63dc4c8601ec8c");
  });
});

describe("byteLength", () => {
  test("counts UTF-8 bytes, not code units", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2);
    expect(byteLength("·")).toBe(2);
    expect(byteLength("𝕊")).toBe(4);
  });
});
