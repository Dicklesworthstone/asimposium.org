import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  assertSafeRunId,
  assertSafeS5Seed,
  assertSafeToolVersion,
  assertSecretSafe,
  buildDiagnostic,
  DiagnosticSafetyError,
  formatDiagnostic,
  type SuiteDiagnostic,
} from "../../scripts/diagnostics.ts";

function record(overrides: Partial<SuiteDiagnostic> = {}): SuiteDiagnostic {
  return {
    ...buildDiagnostic({
      package: "render",
      suite: "unit",
      target: "test/unit",
      duration_ms: 12,
      exit_code: 0,
      tool_version: "1.3.8",
      runtime: "bun-1.3.8",
    }),
    ...overrides,
  };
}

describe("buildDiagnostic", () => {
  test("answers tool, package, suite, version, duration, status and repro", () => {
    const built = record();
    expect(built.tool).toBe("bun test");
    expect(built.package).toBe("render");
    expect(built.suite).toBe("unit");
    expect(built.tool_version).toBe("1.3.8");
    expect(built.duration_ms).toBe(12);
    expect(built.status).toBe("pass");
    expect(built.repro).toBe("cd packages/render && bun run test:unit");
  });

  test("derives status from the real exit code rather than assuming success", () => {
    expect(
      buildDiagnostic({
        package: "render",
        suite: "unit",
        target: "test/unit",
        duration_ms: 1,
        exit_code: 1,
        tool_version: "1.3.8",
        runtime: "bun-1.3.8",
      }).status,
    ).toBe("fail");
  });
});

describe("assertSecretSafe", () => {
  test("accepts a repo-relative record", () => {
    expect(() => assertSecretSafe(record(), {})).not.toThrow();
  });

  test("refuses a local absolute path in the reproduction command", () => {
    expect(() =>
      assertSecretSafe(record({ repro: "cd /Users/someone/projects/x && bun test" }), {}),
    ).toThrow(DiagnosticSafetyError);
  });

  test("refuses a Windows absolute path", () => {
    expect(() => assertSecretSafe(record({ repro: "cd C:\\work\\x && bun test" }), {})).toThrow(
      DiagnosticSafetyError,
    );
  });

  test("refuses a Fellow token prefix anywhere in the record", () => {
    expect(() => assertSecretSafe(record({ suite: "unit asimp_ag_abc123" }), {})).toThrow(
      DiagnosticSafetyError,
    );
  });

  test("refuses an enrollment fragment secret", () => {
    expect(() => assertSecretSafe(record({ suite: "join#v1.s3cr3t" }), {})).toThrow(
      DiagnosticSafetyError,
    );
  });

  for (const [name, value] of [
    ["Fellow bearer token", "asimp_ag_testcredential"],
    ["enrollment fragment", "#v1.testcredential"],
    ["Bearer authorization", "Bearer testcredential"],
    ["PEM private key", "-----BEGIN TEST PRIVATE KEY-----"],
    ["secret-key prefix", "sk-Aa1_Bb2-Cc3D"],
    ["secret-key live underscore prefix", "sk_live_Aa1_Bb2-Cc3D"],
    ["restricted-key prefix", "rk-Aa1_Bb2-Cc3D"],
    ["restricted-key live underscore prefix", "rk_live_Aa1_Bb2-Cc3D"],
    ["publishable-key prefix", "pk-Aa1_Bb2-Cc3D"],
    ["publishable-key live underscore prefix", "pk_live_Aa1_Bb2-Cc3D"],
    ["GitHub classic token", "ghp_Abcdefghijklmnop"],
    ["GitHub fine-grained token", "github_pat_Abcdefghijklmnopqrstuv"],
    ["Google API key", "AIzaAbcdefghijklmnopqrsT"],
    ["generic high-entropy token", "aB3dE5fG7_hI9jKlMnOpQrStUvWxYz01"],
  ] as const) {
    test(`recursively refuses a ${name} shape`, () => {
      expect(() => assertSecretSafe({ nested: { diagnostic: value } }, {})).toThrow(
        DiagnosticSafetyError,
      );
    });
  }

  test("permits exact public revision, digest, digest-list and ETag fields S-5 emits", () => {
    const sha256 = "a".repeat(64);
    expect(() =>
      assertSecretSafe(
        {
          revision: "fe7ca47",
          source_digest: `sha256:${sha256}`,
          served_digest: "fnv1a64:0123456789abcdef",
          local_digest: "fnv1a64:fedcba9876543210",
          canary_digest: "fnv1a64:0011223344556677",
          digests:
            "md=fnv1a64:0123456789abcdef json=fnv1a64:fedcba9876543210 html-fragment=fnv1a64:0011223344556677",
          etag: `"sha256:${sha256}"`,
          served_etag: `W/"sha256:${sha256}"`,
        },
        {},
      ),
    ).not.toThrow();
  });

  test("refuses a Cloudflare-style lowercase-hex key outside a named digest field", () => {
    expect(() =>
      assertSecretSafe({ nested: { detail: "0123456789abcdef0123456789abcdef01234" } }, {}),
    ).toThrow(DiagnosticSafetyError);
  });

  test("refuses a raw 64-hex private-key canary outside a named digest field", () => {
    expect(() => assertSecretSafe({ nested: { detail: "b".repeat(64) } }, {})).toThrow(
      DiagnosticSafetyError,
    );
  });

  test("refuses a digitless mixed-case separator-bearing secret recursively", () => {
    expect(() =>
      assertSecretSafe({ nested: { detail: "AbCdEfGhIjKlMnOpQrStUvWxYz-_AbCdEfGh" } }, {}),
    ).toThrow(DiagnosticSafetyError);
  });

  test("does not apply a digest exemption by content alone", () => {
    expect(() => assertSecretSafe({ detail: `sha256:${"c".repeat(64)}` }, {})).toThrow(
      DiagnosticSafetyError,
    );
  });

  test("accepts a long controlled assertion identifier rather than treating separators as entropy", () => {
    expect(() =>
      assertSecretSafe({ assertion: "served_md_etag_is_a_sha256_of_the_representation" }, {}),
    ).not.toThrow();
  });

  test("accepts a long legitimate S-5 seed and run identifier", () => {
    const seed = "s5-long-legitimate-seed-0123456789abcdefghijkl";
    const runId = `s5-${seed}-12345`;
    expect(seed.length).toBeGreaterThanOrEqual(32);
    expect(() => assertSecretSafe({ seed }, {})).not.toThrow();
    expect(() => assertSafeRunId(runId, {})).not.toThrow();
  });

  for (const field of ["seed", "run_id"] as const) {
    for (const [name, value] of [
      ["raw 64-hex private-key canary", "d".repeat(64)],
      ["37-character lowercase-hex key", "0123456789abcdef0123456789abcdef01234"],
      ["digitless mixed-case separator secret", "AbCdEfGhIjKlMnOpQrStUvWxYz-_AbCdEfGh"],
      ["known live credential prefix", "sk_live_Aa1_Bb2-Cc3D"],
    ] as const) {
      test(`applies ${name} refusal to caller-controlled ${field}`, () => {
        expect(() => assertSecretSafe({ [field]: value }, {})).toThrow(DiagnosticSafetyError);
      });
    }
  }

  test("refuses the value of a sensitive environment variable", () => {
    const env = { ASI_SERVICE_TOKEN: "supersecretvalue" };
    expect(() => assertSecretSafe(record({ runtime: "bun-1.3.8 supersecretvalue" }), env)).toThrow(
      DiagnosticSafetyError,
    );
  });

  test("recursively refuses a secret-shaped nested diagnostic field", () => {
    expect(() =>
      assertSecretSafe({ outer: { headers: ["safe", "asimp_ag_nestedcredential"] } }, {}),
    ).toThrow(DiagnosticSafetyError);
  });

  test("ignores short or non-sensitive environment values", () => {
    const env = { HOME_LABEL: "workstation", ASI_TOKEN: "abc" };
    expect(() =>
      assertSecretSafe(record({ runtime: "bun-1.3.8 workstation abc" }), env),
    ).not.toThrow();
  });
});

/**
 * The shared scanner is a dependency, not a copy (OPS.2a, asimposiumorg-233).
 *
 * Every value below is chosen so that the *only* rule that can refuse it lives in
 * `@asimposium/contracts/diagnostic-safety`. None contains a 32-character run, so
 * `hasGenericSecretToken` cannot fire; none contains a 32-character hex run, so
 * `hasLongHexToken` cannot; none is an absolute path, and the env map is empty so
 * no environment secret can. Delete the import and these go green-to-red — which
 * is the point. A family the deleted local array already matched would still be
 * refused by a stale copy and would prove nothing about delegation.
 */
describe("shared scanner delegation", () => {
  for (const [name, value] of [
    // Basic auth: the local array carried Bearer and no Basic at all.
    ["HTTP Basic credential", "Basic dGVzdDpzZWNyZXQ="],
    // Clipped forms: the local array had length floors (16 / 22 / 20) that a
    // capture ceiling cutting the token in half slipped straight under.
    ["truncated GitHub classic token", "ghp_short"],
    ["truncated GitHub fine-grained token", "github_pat_trunc"],
    ["truncated Google API key", "AIzaShort"],
    // Labelled never-log fields: refused for what the label declares, not shape.
    ["labelled password field", "password: hunter2"],
    ["multi-attribute cookie header", "cookie: sid=abc; other=secret"],
    ["non-Bearer authorization scheme", "authorization: Token abc"],
    ["private directive body", "directive_body: prove lemma, then reveal witness"],
    // Query credential.
    ["query token parameter", "callback?token=abcd1234"],
  ] as const) {
    test(`refuses a ${name} only the shared scanner knows`, () => {
      // Causality, asserted rather than claimed: every local guard is provably
      // inert on this value, so the refusal below can only come from the shared
      // scanner. `hasGenericSecretToken` and `hasLongHexToken` both need a
      // 32-character run, `ABSOLUTE_PATH` needs a rooted path, and the env map is
      // empty. If someone drops the import, nothing else is left to throw.
      expect(value).not.toMatch(/[A-Za-z0-9_-]{32,}/);
      expect(value).not.toMatch(/[0-9a-f]{32,}/i);
      expect(value).not.toMatch(/(^|[\s"'=(:])(\/[A-Za-z0-9._~-]+\/|[A-Za-z]:\\)/);

      expect(() => assertSecretSafe({ nested: { detail: value } }, {})).toThrow(
        DiagnosticSafetyError,
      );
    });
  }

  // Families the local array also matched. These do not prove delegation; they
  // prove the union did not *lose* anything when the copy went away.
  for (const [name, value] of [
    ["live Stripe secret key", "sk_live_51HxAbCdEfGhIjKlMnOp"],
    ["full GitHub fine-grained token", "github_pat_11ABCDEFG0abcdefghijklmnop"],
    ["truncated PEM block", "-----BEGIN RSA PRIVATE KEY-----\nMIIEpQIBAAKCAQ"],
    ["truncated Bearer credential", "Bearer abc"],
    ["Fellow token", "asimp_ag_abcd"],
  ] as const) {
    test(`still refuses a ${name} after consolidation`, () => {
      expect(() => assertSecretSafe({ nested: { detail: value } }, {})).toThrow(
        DiagnosticSafetyError,
      );
    });
  }

  // The union widened the vocabulary; it must not have widened it onto prose.
  // `Bearer tokens…` and `pk-3` are the exact strings a lookahead-based clipped
  // rule used to eat, which is why the shared clipped patterns are terminal-only.
  for (const [name, value] of [
    ["prose naming a credential family", "Bearer tokens are hashed before storage"],
    ["short version string sharing a key prefix", "renderer pk-3 emitted the fragment"],
    ["prose naming a header", "authorization header omitted from the record"],
    ["ordinary failure detail", "expected 3 fragments, received 2"],
  ] as const) {
    test(`accepts ${name}`, () => {
      expect(() => assertSecretSafe({ nested: { detail: value } }, {})).not.toThrow();
    });
  }

  test("resolves the shared subpath from this package's own module graph", async () => {
    const shared = await import("@asimposium/contracts/diagnostic-safety");
    expect(typeof shared.containsCredentialShape).toBe("function");
    expect(shared.containsCredentialShape("Basic dGVzdDpzZWNyZXQ=")).toBe(true);
    expect(shared.containsCredentialShape("expected 3 fragments, received 2")).toBe(false);
  });

  test("declares the shared scanner as a dependency rather than relying on hoisting", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const declared = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(declared["@asimposium/contracts"]).toBe("workspace:*");
  });

  test("keeps no local copy of a known credential family", () => {
    const source = readFileSync(new URL("../../scripts/diagnostics.ts", import.meta.url), "utf8");
    expect(source).toContain('from "@asimposium/contracts/diagnostic-safety"');
    expect(source).toContain("containsCredentialShape(value)");

    // Scan executable code only. Naming a credential family in a comment is
    // documentation and must stay legal — the thing being forbidden is a second
    // *implementation* of the vocabulary, which can only live in code. Scanning
    // raw source would make an honest explanatory comment fail the gate, so the
    // module's comments come off first. This slicer assumes `//` and `/* */`
    // never appear inside a string or regex literal in this one file, which the
    // executable-line assertions below would catch if it ever stopped holding.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|\s)\/\/.*$/gm, "$1")
      .trim();
    expect(code).toContain("containsCredentialShape(value)");
    expect(code).not.toContain("CREDENTIAL_SHAPES");
    for (const fragment of [
      "asimp_ag_",
      "#v1",
      "Bearer",
      "gh[pousr]",
      "github_pat_",
      "AIza",
      "PRIVATE KEY",
    ]) {
      expect(code).not.toContain(fragment);
    }
    // The stricter contextual guards stay local; consolidation must not take them.
    for (const guard of ["ABSOLUTE_PATH", "GENERIC_HIGH_ENTROPY_TOKEN", "LONG_HEX_TOKEN"]) {
      expect(source).toContain(guard);
    }
  });
});

describe("assertSafeRunId", () => {
  test("accepts a compact shared S-5 run identifier", () => {
    expect(() => assertSafeRunId("s5-fixed-seed-v1-12345", {})).not.toThrow();
  });

  test("refuses an unsafe run identifier before it can enter a record", () => {
    expect(() => assertSafeRunId("bad run id", {})).toThrow(DiagnosticSafetyError);
  });
});

describe("assertSafeS5Seed", () => {
  test("accepts the long ordinary lowercase/digit/hyphen seed used by S-5", () => {
    expect(() =>
      assertSafeS5Seed("s5-long-legitimate-seed-0123456789abcdefghijkl", {}),
    ).not.toThrow();
  });

  for (const [name, seed] of [
    ["quote", 'x","status":"pass'],
    ["newline", "line1\nline2"],
    ["overlong", "a".repeat(65)],
  ] as const) {
    test(`refuses a ${name} seed at the shared boundary`, () => {
      expect(() => assertSafeS5Seed(seed, {})).toThrow(DiagnosticSafetyError);
    });
  }
});

describe("assertSafeToolVersion", () => {
  test("accepts exact pinned Bun and Wrangler releases", () => {
    expect(() => assertSafeToolVersion("bun_version", "1.3.8", {})).not.toThrow();
    expect(() => assertSafeToolVersion("wrangler_version", "4.123.0", {})).not.toThrow();
  });

  for (const [field, value] of [
    ["bun_version", "^1.3.8"],
    ["wrangler_version", "latest"],
    ["bun_version", "1.3.8; echo leaked"],
    ["wrangler_version", "sk_live_Aa1_Bb2-Cc3D"],
  ] as const) {
    test(`refuses a non-exact ${field} declaration`, () => {
      expect(() => assertSafeToolVersion(field, value, {})).toThrow(DiagnosticSafetyError);
    });
  }
});

describe("formatDiagnostic", () => {
  test("emits one key-sorted NDJSON line", () => {
    const line = formatDiagnostic(record());
    expect(line.includes("\n")).toBe(false);
    const parsed = JSON.parse(line) as SuiteDiagnostic;
    expect(parsed.repro).toBe("cd packages/render && bun run test:unit");
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
  });
});
