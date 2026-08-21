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

  test("preserves prototype-sensitive own keys from parsed JSON", () => {
    const input = JSON.parse(
      '{"prototype":"p","__proto__":{"polluted":true},"constructor":"c","nested":{"z":1,"__proto__":"n"}}',
    ) as unknown;

    expect(stableStringify(input)).toBe(
      '{"__proto__":{"polluted":true},"constructor":"c","nested":{"__proto__":"n","z":1},"prototype":"p"}',
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("snapshots each enumerable own value exactly once", () => {
    let reads = 0;
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "value", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? { b: 2, a: 1 } : "changed-on-reread";
      },
    });

    expect(stableStringify(input)).toBe('{"value":{"a":1,"b":2}}');
    expect(reads).toBe(1);
  });

  test("does not let an enumerable toJSON function replace canonical data", () => {
    const input = {
      retained: { b: 2, a: 1 },
      toJSON: () => ({ forged: true }),
    };

    expect(stableStringify(input)).toBe('{"retained":{"a":1,"b":2}}');
    expect(stableStringify({ nested: input })).toBe('{"nested":{"retained":{"a":1,"b":2}}}');
  });

  test("preserves JSON array handling for functions and symbols", () => {
    expect(stableStringify([() => "forged", Symbol("forged"), 1])).toBe("[null,null,1]");
  });

  test("returns canonical JSON text for supported scalar roots", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(false)).toBe("false");
    expect(stableStringify(0)).toBe("0");
    expect(stableStringify("text")).toBe('"text"');
  });

  test("refuses roots with no JSON representation without reflecting them", () => {
    const unsupported: readonly unknown[] = [
      undefined,
      () => "caller-controlled-function-result",
      Symbol("caller-controlled-symbol-description"),
    ];

    for (const value of unsupported) {
      expect(() => stableStringify(value)).toThrow(TypeError);
      expect(() => stableStringify(value)).toThrow(
        "stableStringify root has no JSON representation",
      );
    }
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
