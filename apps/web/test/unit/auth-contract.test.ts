import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  ALLOWED_ENV_EXPRESSION,
  ALLOWED_IMPORTS,
  type AuthViolation,
  type AuthViolationCode,
  formatAuthViolations,
  readAuthSurface,
  validateAuthConfig,
} from "../../scripts/auth-contract.ts";

/**
 * Every fixture here is a bypass that defeated an earlier version of this
 * check. Three defeated the original regexes, three more defeated the first
 * AST version, and five more came from the verifier round after that. They are
 * kept as a corpus because each one records a way the property can be true in
 * the file and false in the running application.
 */
const FIXTURES = join(dirname(import.meta.dir), "fixtures", "auth");

function scan(fixture: string): AuthViolation[] {
  return validateAuthConfig(readFileSync(join(FIXTURES, `${fixture}.ts`), "utf8"), `${fixture}.ts`);
}

function codesOf(violations: readonly AuthViolation[]): AuthViolationCode[] {
  return violations.map((v) => v.code);
}

/** A clean configuration with one field substituted, for focused cases. */
function config(overrides: { providers?: string; options?: string; extra?: string }): string {
  return `
    import NextAuth from "next-auth";
    import Google from "next-auth/providers/google";
    ${overrides.extra ?? ""}
    export const { handlers, auth, signIn, signOut } = NextAuth({
      providers: ${overrides.providers ?? "[Google]"},
      callbacks: {
        jwt({ token, account }) {
          if (account) token.authTime = Math.floor(Date.now() / 1_000);
          return token;
        },
        session({ session, token }) {
          if (typeof token.authTime === "number") session.authIssuedAt = token.authTime;
          return session;
        },
      },
      cookies: {
        sessionToken: {
          name: "asimp.session",
          options: ${overrides.options ?? '{ httpOnly: true, sameSite: "lax", path: "/" }'},
        },
      },
    });
  `;
}

describe("the baseline configuration is clean", () => {
  test("valid.ts produces no violations", () => {
    expect(formatAuthViolations(scan("valid"))).toBe("no violations");
  });

  test("an aliased Google import, invoked, is valid — the module resolves, not the name", () => {
    expect(formatAuthViolations(scan("aliased-google-import"))).toBe("no violations");
  });

  test("the allowlists stay minimal and are stated, not inferred", () => {
    expect([...ALLOWED_IMPORTS].sort()).toEqual(["next-auth", "next-auth/providers/google"]);
    expect(ALLOWED_ENV_EXPRESSION).toBe("process.env.NODE_ENV");
  });
});

describe("recent-auth is stable across ordinary session reads", () => {
  test("the account-guarded custom claim is the only accepted wiring", () => {
    const surface = readAuthSurface(readFileSync(join(FIXTURES, "valid.ts"), "utf8")).recentAuth;
    expect(surface).toMatchObject({
      callbacksPresent: true,
      unresolvable: false,
      jwtPresent: true,
      sessionPresent: true,
      jwtStampCount: 1,
      safeJwtStampCount: 1,
      sessionProjectionCount: 1,
      safeSessionProjectionCount: 1,
      iatReads: [],
    });
  });

  test("PLANTED: projecting refreshable JWT iat is refused", () => {
    const source = readFileSync(join(FIXTURES, "valid.ts"), "utf8").replaceAll(
      "token.authTime",
      "token.iat",
    );
    expect(codesOf(validateAuthConfig(source))).toContain("AUTH_RECENT_AUTH_REFRESHABLE");
  });

  test("PLANTED: stamping on every JWT callback is refused", () => {
    const source = readFileSync(join(FIXTURES, "valid.ts"), "utf8").replace(
      "if (account) token.authTime = Math.floor(Date.now() / 1_000);",
      "token.authTime = Math.floor(Date.now() / 1_000);",
    );
    expect(codesOf(validateAuthConfig(source))).toContain("AUTH_RECENT_AUTH_REFRESHABLE");
  });

  test("PLANTED: an unguarded session projection is refused", () => {
    const source = readFileSync(join(FIXTURES, "valid.ts"), "utf8").replace(
      'if (typeof token.authTime === "number") session.authIssuedAt = token.authTime;',
      "session.authIssuedAt = token.authTime;",
    );
    expect(codesOf(validateAuthConfig(source))).toContain("AUTH_RECENT_AUTH_REFRESHABLE");
  });

  test("PLANTED: aliases cannot hide an extra auth-time stamp or session overwrite", () => {
    const baseline = readFileSync(join(FIXTURES, "valid.ts"), "utf8");
    const aliasedStamp = baseline.replace(
      "return token;",
      "const tokenAlias = token; tokenAlias.authTime = Math.floor(Date.now() / 1_000); return token;",
    );
    const aliasedProjection = baseline.replace(
      "return session;",
      "const sessionAlias = session; sessionAlias.authIssuedAt = Math.floor(Date.now() / 1_000); return session;",
    );
    expect(codesOf(validateAuthConfig(aliasedStamp))).toContain("AUTH_RECENT_AUTH_REFRESHABLE");
    expect(codesOf(validateAuthConfig(aliasedProjection))).toContain(
      "AUTH_RECENT_AUTH_REFRESHABLE",
    );
  });

  test("PLANTED: a helper and computed properties cannot smuggle refreshable iat", () => {
    const baseline = readFileSync(join(FIXTURES, "valid.ts"), "utf8");
    const helper = baseline
      .replace(
        "export const { handlers",
        "function refreshAge(target: { authIssuedAt?: number }, source: { iat?: number }) { target.authIssuedAt = source.iat; }\nexport const { handlers",
      )
      .replace("return session;", "refreshAge(session, token); return session;");
    const computed = baseline.replace(
      "return session;",
      'session["authIssuedAt"] = token["authTime"]; return session;',
    );
    expect(codesOf(validateAuthConfig(helper))).toContain("AUTH_RECENT_AUTH_REFRESHABLE");
    expect(codesOf(validateAuthConfig(computed))).toContain("AUTH_RECENT_AUTH_REFRESHABLE");
  });
});

describe("round 1 — the mutations that defeated the regexes", () => {
  test("an inline `domain` on an existing line is caught", () => {
    const hit = scan("inline-cookie-domain").find((v) => v.code === "AUTH_COOKIE_DOMAIN_SET");
    expect(hit).toBeDefined();
    expect(hit?.rule).toBe("ASI-HOST-ONLY");
    expect(hit?.fix_hint).toContain("WRONG_PRINCIPAL");
  });

  test("a second provider with a hyphenated package name is caught", () => {
    const codes = codesOf(scan("second-provider-hyphenated"));
    expect(codes).toContain("AUTH_PROVIDER_NOT_GOOGLE");
    // The import allowlist catches it a second, independent way.
    expect(codes).toContain("AUTH_IMPORT_NOT_ALLOWED");
  });

  test("a credential read via destructuring is caught", () => {
    const hits = scan("destructured-secret").filter((v) => v.code === "AUTH_ENV_ACCESS_FORBIDDEN");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.rule).toBe("ASI-NO-BUILD-SECRETS");
  });
});

describe("round 2 — the guard is the configured set, not the import list", () => {
  test("a locally-defined second provider is caught though no import names it", () => {
    const hit = scan("inline-custom-provider").find((v) => v.code === "AUTH_PROVIDER_UNRESOLVED");
    expect(hit).toBeDefined();
    expect(hit?.detail).toContain("Rogue");
  });

  test("importing Google without configuring it is caught", () => {
    expect(codesOf(scan("unused-google-import"))).toContain("AUTH_PROVIDER_MISSING");
  });

  test("a spread provider array is unprovable, and unprovable is a refusal", () => {
    expect(codesOf(scan("spread-providers"))).toContain("AUTH_PROVIDERS_UNRESOLVABLE");
  });

  test("a non-array providers value is a refusal", () => {
    expect(codesOf(validateAuthConfig(config({ providers: "buildProviders(Google)" })))).toContain(
      "AUTH_PROVIDERS_UNRESOLVABLE",
    );
  });
});

describe("round 3 — the verifier's bypasses", () => {
  test("the same provider twice is not a singleton", () => {
    const hit = scan("duplicate-google-provider").find(
      (v) => v.code === "AUTH_PROVIDERS_NOT_SINGLETON",
    );
    expect(hit).toBeDefined();
    expect(hit?.detail).toContain("2 entries");
    // Every entry resolves to Google, so the per-entry rules are all satisfied.
    expect(codesOf(scan("duplicate-google-provider"))).not.toContain("AUTH_PROVIDER_NOT_GOOGLE");
  });

  test("a clean first call cannot mask a second, exported one", () => {
    const codes = codesOf(scan("multiple-nextauth-calls"));
    expect(codes).toContain("AUTH_NEXTAUTH_CALL_AMBIGUOUS");
    // It refuses rather than reporting on whichever call it happened to find.
    expect(codes).not.toContain("AUTH_PROVIDER_MISSING");
  });

  test("a locally-defined function named NextAuth does not capture the guard", () => {
    expect(codesOf(scan("local-fake-nextauth"))).toContain("AUTH_NEXTAUTH_CALL_UNRESOLVED");
  });

  test("an IIFE runs at import and its secret read is caught", () => {
    const hit = scan("iife-env-read").find((v) => v.code === "AUTH_ENV_ACCESS_FORBIDDEN");
    expect(hit).toBeDefined();
    expect(hit?.detail).toContain("process");
  });

  test("static field initialisers and static blocks are caught", () => {
    expect(
      scan("static-class-env-read").filter((v) => v.code === "AUTH_ENV_ACCESS_FORBIDDEN"),
    ).toHaveLength(2);
  });

  test("a globalThis root assembled from string fragments is caught", () => {
    const hit = scan("computed-global-root").find((v) => v.code === "AUTH_ENV_ACCESS_FORBIDDEN");
    expect(hit).toBeDefined();
    expect(hit?.detail).toContain("globalThis");
  });

  test("the Bun global aliased before `.env` is caught", () => {
    expect(codesOf(scan("bun-alias"))).toContain("AUTH_ENV_ACCESS_FORBIDDEN");
  });

  test("an environment arriving from another module is caught by the import allowlist", () => {
    const hit = scan("disallowed-import").find((v) => v.code === "AUTH_IMPORT_NOT_ALLOWED");
    expect(hit).toBeDefined();
    expect(hit?.detail).toContain("./secrets");
  });
});

describe("round 4 — the contract must prove the shipped wiring", () => {
  test("a safe unused call cannot vouch for a fake exported factory", () => {
    const violations = scan("fake-exported-factory");
    const hit = violations.find((v) => v.code === "AUTH_EXPORT_NOT_WIRED");
    expect(hit).toBeDefined();
    expect(hit?.detail).toContain("did not come from the imported Auth.js call");
    expect(hit?.detail).toContain("handlers");
    // The impeccable unused call is present and must not launder the file.
    expect(formatAuthViolations(violations)).not.toBe("no violations");
  });

  test("a file that exports no handlers at all is refused", () => {
    const source = `
      import NextAuth from "next-auth";
      import Google from "next-auth/providers/google";
      const instance = NextAuth({
        providers: [Google],
        cookies: { sessionToken: { name: "s", options: { httpOnly: true } } },
      });
      export const auth = instance.auth;
    `;
    expect(codesOf(validateAuthConfig(source))).toContain("AUTH_EXPORT_NOT_WIRED");
  });

  test("a safe `handlers` cannot vouch for a fake `auth`, `signIn` or `signOut`", () => {
    const violations = scan("partial-fake-surface");
    const hit = violations.find((v) => v.code === "AUTH_EXPORT_NOT_WIRED");
    expect(hit).toBeDefined();
    expect(hit?.detail).toContain("auth");
    expect(hit?.detail).toContain("signIn");
    expect(hit?.detail).toContain("signOut");
    // handlers really is wired, and the checker says so rather than blaming it.
    expect(hit?.detail).not.toContain("handlers");

    const wiring = readAuthSurface(
      readFileSync(join(FIXTURES, "partial-fake-surface.ts"), "utf8"),
    ).wiring;
    expect(wiring.fromFactory).toEqual(["handlers"]);
    expect(wiring.foreign).toEqual(["auth", "signIn", "signOut"]);
  });

  test("re-exporting a fake through an export clause is still foreign", () => {
    const source = `
      import NextAuth from "next-auth";
      import Google from "next-auth/providers/google";
      const fake = { auth: () => undefined, signIn: () => undefined, signOut: () => undefined };
      export const { handlers } = NextAuth({
        providers: [Google],
        cookies: { sessionToken: { name: "s", options: { httpOnly: true } } },
      });
      const { auth, signIn, signOut } = fake;
      export { auth, signIn, signOut };
    `;
    expect(codesOf(validateAuthConfig(source))).toContain("AUTH_EXPORT_NOT_WIRED");
  });

  test("dynamic import is refused: the allowlist cannot see what it loads", () => {
    const hit = scan("dynamic-import-secrets").find(
      (v) => v.code === "AUTH_DYNAMIC_CODE_FORBIDDEN",
    );
    expect(hit).toBeDefined();
    expect(hit?.detail).toContain("./secrets");
  });

  test("require, eval and Function are all refused", () => {
    const hits = scan("require-and-eval").filter((v) => v.code === "AUTH_DYNAMIC_CODE_FORBIDDEN");
    const text = hits.map((v) => v.detail).join(" ");
    expect(text).toContain("require(");
    expect(text).toContain("eval(");
    expect(text).toContain("Function(");
  });

  test("Node's `global` is a fourth route to the environment and is refused", () => {
    const hit = scan("node-global-root").find((v) => v.code === "AUTH_ENV_ACCESS_FORBIDDEN");
    expect(hit).toBeDefined();
    expect(hit?.detail).toContain("global");
  });

  test("aliasing Function or eval before calling does not evade the check", () => {
    const hits = scan("aliased-dynamic-code").filter(
      (v) => v.code === "AUTH_DYNAMIC_CODE_FORBIDDEN",
    );
    const text = hits.map((v) => v.detail).join(" ");
    // The reference is the violation; the call site is `f(...)` and carries
    // nothing a syntax check could recognise.
    expect(text).toContain("Function");
    expect(text).toContain("eval");
  });

  test("a declaration named `require` is not itself a reference to require", () => {
    // `declare const require: …` names a binding; it does not invoke anything.
    const source = config({ extra: "declare const require: (id: string) => unknown;" });
    expect(codesOf(validateAuthConfig(source))).not.toContain("AUTH_DYNAMIC_CODE_FORBIDDEN");
  });

  test("the baseline exports the whole surface from the one factory call", () => {
    const wiring = readAuthSurface(readFileSync(join(FIXTURES, "valid.ts"), "utf8")).wiring;
    expect(wiring).toEqual({
      exported: ["handlers", "auth", "signIn", "signOut"],
      fromFactory: ["handlers", "auth", "signIn", "signOut"],
      missing: [],
      foreign: [],
    });
  });
});

describe("the environment rule is an allowlist over the whole file", () => {
  test.each([
    ["direct member", "const s = process.env.AUTH_SECRET;"],
    ["bracket on process", 'const s = process["env"].AUTH_SECRET;'],
    ["bracket on the key", 'const s = process.env["AUTH_SECRET"];'],
    ["Bun bracket", 'const s = Bun["env"]["AUTH_SECRET"];'],
    ["globalThis chain", "const s = globalThis.process.env.AUTH_SECRET;"],
    ["globalThis brackets", 'const s = globalThis["process"]["env"].AUTH_SECRET;'],
    ["alias of process", "const p = process;"],
    ["alias of Bun", "const b = Bun;"],
    ["alias of globalThis", "const g = globalThis;"],
    ["alias of the env object", "const e = process.env;"],
    ["computed key", "const s = process.env[k];"],
    ["destructure", "const { AUTH_SECRET } = process.env;"],
    ["renamed destructure", "const { AUTH_SECRET: s } = process.env;"],
    ["inside a callback", "const f = { cb: () => process.env.AUTH_SECRET };"],
    ["inside a nested function", "function outer() { function inner() { return Bun.env.X; } }"],
    ["passed as an argument", "register(process.env);"],
    [
      "NODE_ENV by bracket, which is not the allowed spelling",
      'const s = process.env["NODE_ENV"];',
    ],
  ])("%s is refused", (_label, extra) => {
    expect(codesOf(validateAuthConfig(config({ extra })))).toContain("AUTH_ENV_ACCESS_FORBIDDEN");
  });

  test("the one allowed spelling is accepted, and only in that exact shape", () => {
    const clean = config({
      options: '{ httpOnly: true, secure: process.env.NODE_ENV === "production" }',
    });
    expect(formatAuthViolations(validateAuthConfig(clean))).toBe("no violations");

    const accesses = readAuthSurface(clean).envAccesses;
    expect(accesses).toHaveLength(1);
    expect(accesses[0]?.allowed).toBe(true);
    expect(accesses[0]?.text).toBe("process.env.NODE_ENV");
  });

  test("a property merely named `process` is not an environment access", () => {
    expect(readAuthSurface("const o = { process: 1 }; const x = o.process;").envAccesses).toEqual(
      [],
    );
  });
});

describe("cookie spellings", () => {
  test.each([
    ["inline", '{ httpOnly: true, domain: ".asimposium.org" }'],
    ["own line", '{\n  httpOnly: true,\n  domain: ".asimposium.org",\n}'],
    ["quoted key", '{ httpOnly: true, "domain": ".asimposium.org" }'],
    ["trailing comment", '{ httpOnly: true, domain: ".x.org" /* temporary */ }'],
    ["odd whitespace", '{ httpOnly: true,   domain   :   ".x.org" }'],
  ])("`domain` written %s is caught", (_label, options) => {
    expect(codesOf(validateAuthConfig(config({ options })))).toContain("AUTH_COOKIE_DOMAIN_SET");
  });

  test("a spread on the cookie options is a refusal", () => {
    expect(codesOf(scan("spread-cookie-options"))).toContain("AUTH_COOKIE_UNRESOLVABLE");
  });

  test("omitting the cookie configuration is a refusal, not a silent default", () => {
    expect(codesOf(scan("no-cookie-config"))).toContain("AUTH_COOKIE_CONFIG_MISSING");
  });

  test("the word `domain` in a comment or a cookie name is not a violation", () => {
    const source = config({
      options: '{ httpOnly: true /* no domain here */, path: "/" }',
    }).replace('"asimp.session"', '"asimp.session.domain"');
    expect(codesOf(validateAuthConfig(source))).not.toContain("AUTH_COOKIE_DOMAIN_SET");
  });
});

describe("diagnostics", () => {
  test("no violation carries an absolute path", () => {
    for (const fixture of [
      "inline-cookie-domain",
      "second-provider-hyphenated",
      "destructured-secret",
      "inline-custom-provider",
      "duplicate-google-provider",
      "multiple-nextauth-calls",
      "local-fake-nextauth",
      "iife-env-read",
      "static-class-env-read",
      "computed-global-root",
      "bun-alias",
      "disallowed-import",
    ]) {
      const violations = scan(fixture);
      expect(violations.length).toBeGreaterThan(0);
      for (const v of violations) {
        expect(v.file.startsWith("/")).toBe(false);
        expect(v.file).not.toContain(FIXTURES);
      }
    }
  });

  test("a detail quotes the offending expression, never a resolved value", () => {
    // The analyzer reads source text only; there is no environment lookup in
    // it, so a planted value cannot reach a diagnostic even when the variable
    // it names is set in this very process. The quoted text is also kept to
    // the accessor rather than the whole statement, so it echoes as little of
    // the source as the message can carry and still be actionable.
    process.env.ASIMP_AUDIT_CANARY = "canary-secret-value";
    const violations = validateAuthConfig(
      config({ extra: "const { ASIMP_AUDIT_CANARY } = process.env;" }),
    );
    const detail = violations.map((v) => v.detail).join(" ");
    expect(codesOf(violations)).toContain("AUTH_ENV_ACCESS_FORBIDDEN");
    expect(detail).toContain("process.env");
    expect(detail).not.toContain("canary-secret-value");
  });
});
