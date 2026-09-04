/**
 * Structural contract for the Propylon configuration in `auth.ts`.
 *
 * Build/test-time only. Nothing under `app/` may import this module — it pulls
 * in the TypeScript compiler and has no business in a bundle.
 *
 * ## Why this file is an allowlist, not a scanner
 *
 * The first version of these checks was three regexes over source text. An
 * adversarial probe defeated all three in one pass. The second version parsed
 * the syntax tree but still reasoned by enumerating bad shapes, and a verifier
 * defeated it again: `globalThis["pro" + "cess"]["en" + "v"]` reaches the
 * environment without containing any pattern worth naming, and no finite list
 * of spellings ever closes that.
 *
 * So this is a **whitelist over one small file**. `auth.ts` has exactly one
 * job — configure Auth.js — and needs almost nothing to do it. Everything
 * outside that narrow surface is refused, including things that are probably
 * harmless, because "probably harmless" is how the last two versions failed.
 *
 * The contract, all from Fable §5.1 and §14.1:
 *
 *  1. **Imports are allowlisted.** Only `next-auth`, the Google provider, and
 *     the pure canonical sponsor-id and signed-authentication-time helpers.
 *     Otherwise `import { env } from "./secrets"` walks straight through every
 *     other rule in this file.
 *  2. **Exactly one Auth.js factory call**, resolved to the *imported* default
 *     binding under any alias. A locally-defined `NextAuth` is not Auth.js, and
 *     two calls make "which configuration is live" a question this checker
 *     cannot answer — so it refuses instead of guessing the first one.
 *  3. **Exactly one configured provider**, and it resolves to the imported
 *     Google module. The `providers` array NextAuth actually receives is the
 *     subject; an import scan is a proxy, and a proxy is what gets bypassed.
 *  4. **The session cookie is host-only.** `cookies.sessionToken.options` must
 *     be a literal object without `domain`.
 *  5. **One environment expression exists in the whole file**, spelled exactly
 *     `process.env.NODE_ENV`. Any other reference to `process`, `Bun` or
 *     `globalThis` anywhere in the file — aliased, bracketed, computed, inside
 *     a callback, inside an IIFE, inside a static initialiser — is refused.
 *     Auth.js resolves `AUTH_*` itself; this file never needs a secret.
 *  6. **Sponsor principals come only from Google's stable subject.** The JWT
 *     callback hashes `profile?.sub` with the reviewed helper while an OAuth
 *     account is present. The session callback exposes that value only after
 *     the canonical sponsor-id guard and deletes any stale id otherwise.
 *  7. **Recent authentication uses Google evidence.** The JWT callback copies
 *     only the validated ID-token `auth_time` claim while an OAuth account is
 *     present, and the session callback projects only that stable custom
 *     claim. Auth.js refreshes standard `iat` on session reads, so consulting
 *     it would turn page refresh into step-up.
 *
 * Anything unresolvable is a refusal. A checker that treats "I could not see
 * it" as "it is not there" reports a property it never established.
 *
 * ## What this does not do
 *
 * It analyses one file's syntax. It does not follow imports (which is why the
 * import allowlist carries so much weight), does not evaluate code, and proves
 * nothing about the `Set-Cookie` header a running server emits — that needs a
 * served response and belongs to the S-6 cross-plane spike.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

export type AuthViolationCode =
  | "AUTH_IMPORT_NOT_ALLOWED"
  | "AUTH_NEXTAUTH_CALL_UNRESOLVED"
  | "AUTH_NEXTAUTH_CALL_AMBIGUOUS"
  | "AUTH_EXPORT_NOT_WIRED"
  | "AUTH_DYNAMIC_CODE_FORBIDDEN"
  | "AUTH_PROVIDER_MISSING"
  | "AUTH_PROVIDER_NOT_GOOGLE"
  | "AUTH_PROVIDER_UNRESOLVED"
  | "AUTH_PROVIDERS_CONFIG_MISSING"
  | "AUTH_PROVIDERS_NOT_SINGLETON"
  | "AUTH_PROVIDERS_UNRESOLVABLE"
  | "AUTH_COOKIE_CONFIG_MISSING"
  | "AUTH_COOKIE_DOMAIN_SET"
  | "AUTH_COOKIE_UNRESOLVABLE"
  | "AUTH_ENV_ACCESS_FORBIDDEN"
  | "AUTH_CALL_NOT_ALLOWED"
  | "AUTH_PROVIDER_EVIDENCE_ESCAPE"
  | "AUTH_SPONSOR_PRINCIPAL_UNSAFE"
  | "AUTH_RECENT_AUTH_CONFIG_MISSING"
  | "AUTH_RECENT_AUTH_REFRESHABLE";

export interface AuthViolation {
  code: AuthViolationCode;
  /** Stable rule id, cited the way the Worker cites P1–P13. */
  rule: string;
  /** Path relative to the package root. Never absolute. */
  file: string;
  detail: string;
  fix_hint: string;
}

const RULES: Record<AuthViolationCode, { rule: string; fix_hint: string }> = {
  AUTH_IMPORT_NOT_ALLOWED: {
    rule: "ASI-PROPYLON-2",
    fix_hint:
      "auth.ts may import only next-auth, the Google provider, and the two reviewed pure identity helpers. Put anything else in a module the app imports directly, so it is reviewed on its own terms.",
  },
  AUTH_NEXTAUTH_CALL_UNRESOLVED: {
    rule: "ASI-PROPYLON-1",
    fix_hint:
      'Call the default export of "next-auth" with an object literal. A locally-defined function of the same name is not Auth.js and cannot be checked.',
  },
  AUTH_NEXTAUTH_CALL_AMBIGUOUS: {
    rule: "ASI-PROPYLON-1",
    fix_hint:
      "Configure Auth.js exactly once in this file. With two calls, which configuration is live is not decidable here.",
  },
  AUTH_EXPORT_NOT_WIRED: {
    rule: "ASI-PROPYLON-1",
    fix_hint:
      "Export the Propylon surface directly from the Auth.js call: `export const { handlers, auth, signIn, signOut } = NextAuth({...})`.",
  },
  AUTH_DYNAMIC_CODE_FORBIDDEN: {
    rule: "ASI-PROPYLON-2",
    fix_hint:
      "No dynamic import, require, eval or Function in auth.ts. Each one loads code the import allowlist cannot see, which is the whole basis of this check.",
  },
  AUTH_PROVIDER_MISSING: {
    rule: "ASI-PROPYLON-1",
    fix_hint:
      'Configure the Google provider: `import Google from "next-auth/providers/google"` and pass it in `providers`.',
  },
  AUTH_PROVIDER_NOT_GOOGLE: {
    rule: "ASI-PROPYLON-1",
    fix_hint:
      "Google is the only human identity provider (Fable §5.1). Remove the provider, or amend the plan first.",
  },
  AUTH_PROVIDER_UNRESOLVED: {
    rule: "ASI-PROPYLON-1",
    fix_hint:
      "Pass the imported Google binding directly. A locally-built or re-exported provider object cannot be checked here.",
  },
  AUTH_PROVIDERS_CONFIG_MISSING: {
    rule: "ASI-PROPYLON-1",
    fix_hint: "Pass a `providers` array to the Auth.js factory in this file.",
  },
  AUTH_PROVIDERS_NOT_SINGLETON: {
    rule: "ASI-PROPYLON-1",
    fix_hint:
      "Configure exactly one provider expression: the imported Google binding. Duplicates and extras both widen the identity surface.",
  },
  AUTH_PROVIDERS_UNRESOLVABLE: {
    rule: "ASI-PROPYLON-1",
    fix_hint:
      "Write `providers` as a literal array of imported bindings. A spread or a computed value hides what is configured.",
  },
  AUTH_COOKIE_CONFIG_MISSING: {
    rule: "ASI-HOST-ONLY",
    fix_hint:
      "Configure cookies.sessionToken.options explicitly so the host-only property is stated and checkable.",
  },
  AUTH_COOKIE_DOMAIN_SET: {
    rule: "ASI-HOST-ONLY",
    fix_hint:
      "Delete the `domain` key. A domain-scoped cookie reaches a.asimposium.org, which is the cross-plane confusion WRONG_PRINCIPAL exists for (Fable §14.1).",
  },
  AUTH_COOKIE_UNRESOLVABLE: {
    rule: "ASI-HOST-ONLY",
    fix_hint:
      "Write the cookie options as a literal object. A spread can inject `domain`, so absence stops being provable.",
  },
  AUTH_ENV_ACCESS_FORBIDDEN: {
    rule: "ASI-NO-BUILD-SECRETS",
    fix_hint:
      "`process.env.NODE_ENV` is the only environment expression allowed in auth.ts. Auth.js resolves AUTH_* itself; read anything else in a module of its own.",
  },
  AUTH_CALL_NOT_ALLOWED: {
    rule: "ASI-CALL-SURFACE",
    fix_hint:
      "auth.ts may execute only the imported next-auth factory, the Google provider, the reviewed sponsor-id and auth-time helpers, and the exact Reflect.deleteProperty cleanup. Ambient calls (fetch, console, timers, storage, beacons), new-expressions, tagged templates, decorators and local helpers all run code this file's review never sees; put such logic in a module the app imports and reviews on its own terms.",
  },
  AUTH_PROVIDER_EVIDENCE_ESCAPE: {
    rule: "ASI-PROVIDER-EVIDENCE",
    fix_hint:
      "Raw provider evidence has exactly three reviewed reads: the truthy `if (account)` guard, `profile?.sub` as the sole argument of sponsorIdFromGoogleSubject, and `account.id_token` as the sole argument of authTimeFromIdToken. The helper extracts the provider-signed ID-token issuance time. Every other read, alias, wrapper, computed access, closure capture or packaging of the profile/account bindings is refused.",
  },
  AUTH_SPONSOR_PRINCIPAL_UNSAFE: {
    rule: "ASI-SPONSOR-PRINCIPAL",
    fix_hint:
      "Inside the account guard, stamp token.sub only with await sponsorIdFromGoogleSubject(profile?.sub). In the session callback, project token.sub only through isCanonicalSponsorId(token.sub), and delete session.user.id on the invalid branch.",
  },
  AUTH_RECENT_AUTH_CONFIG_MISSING: {
    rule: "ASI-RECENT-AUTH",
    fix_hint:
      "Configure literal jwt and session callbacks. Stamp token.authTime from the provider-issued ID token only when an OAuth account is present, then project that stable claim to session.authIssuedAt.",
  },
  AUTH_RECENT_AUTH_REFRESHABLE: {
    rule: "ASI-RECENT-AUTH",
    fix_hint:
      "Never derive recent authentication from userinfo profile data, callback arrival, or Auth.js token.iat. Inside the account callback guard, call the reviewed authTimeFromIdToken helper with exactly account.id_token; that helper extracts the Google-signed ID-token iat, then the callback projects the stable token.authTime claim.",
  },
};

const NEXT_AUTH_MODULE = "next-auth";
const PROVIDER_PREFIX = "next-auth/providers/";
const GOOGLE_PROVIDER = `${PROVIDER_PREFIX}google`;
const AUTH_TIME_HELPER = "./lib/auth-time";
const SPONSOR_ID_HELPER = "./lib/sponsor-id";

/**
 * Modules `auth.ts` may import. Adding an entry is a deliberate decision about
 * what can influence identity, and belongs in a commit a reviewer reads.
 */
export const ALLOWED_IMPORTS: ReadonlySet<string> = new Set([
  NEXT_AUTH_MODULE,
  GOOGLE_PROVIDER,
  AUTH_TIME_HELPER,
  SPONSOR_ID_HELPER,
]);

/**
 * Global objects that can reach the process environment. Every syntactic route
 * to `env` passes through one of these names, which is what makes an allowlist
 * over them complete where a list of bad spellings never was.
 */
const ENV_ROOTS: ReadonlySet<string> = new Set(["process", "Bun", "globalThis", "global"]);

/**
 * Identifiers that can load or build code. Every *reference* is refused, not
 * only a direct call: `const f = Function; f("return process.env.X")()` reaches
 * the environment with the dangerous part living in a string, where no syntax
 * check can follow it.
 */
const DYNAMIC_CODE_NAMES: ReadonlySet<string> = new Set(["require", "eval", "Function"]);

/** The one environment expression `auth.ts` is allowed to contain. */
export const ALLOWED_ENV_EXPRESSION = "process.env.NODE_ENV";

export interface EnvAccess {
  /** The global root the expression starts from. */
  root: string;
  /** Source text of the whole expression, for the diagnostic. */
  text: string;
  /** True only for the exact allowed spelling. */
  allowed: boolean;
}

export interface SessionCookieOptions {
  present: boolean;
  keys: string[];
  unresolvable: boolean;
}

export interface ConfiguredProvider {
  text: string;
  /** Module the entry resolves to, when it resolves to an import binding. */
  module: string | undefined;
}

export interface ProviderSurface {
  /** Calls to the imported `next-auth` default binding found in the file. */
  factoryCalls: number;
  factoryResolved: boolean;
  configured: boolean;
  literalArray: boolean;
  unresolvable: boolean;
  entries: ConfiguredProvider[];
}

/**
 * The public Propylon surface. All four must come from the same Auth.js call:
 * checking one sentinel export lets the rest be served by something else, and
 * `auth()` is what every server component will actually consume.
 */
export const PROPYLON_EXPORTS = ["handlers", "auth", "signIn", "signOut"] as const;

export interface ExportWiring {
  /** Which of the public bindings the file exports at all. */
  exported: string[];
  /** Which of them are destructured from the single imported Auth.js call. */
  fromFactory: string[];
  /** Required bindings the file does not export. */
  missing: string[];
  /** Exported bindings that come from somewhere other than that call. */
  foreign: string[];
}

export interface AuthSurface {
  imports: string[];
  providers: ProviderSurface;
  cookies: SessionCookieOptions;
  envAccesses: EnvAccess[];
  wiring: ExportWiring;
  /** Source text of each dynamic-code escape hatch found in the file. */
  dynamicCode: string[];
  /** Source text of each executable call/new/tagged/decorator off the allowlist. */
  ambientCalls: string[];
  /** Source text of each raw provider-evidence read outside the reviewed shapes. */
  evidenceEscapes: string[];
  sponsorPrincipal: SponsorPrincipalSurface;
  recentAuth: RecentAuthSurface;
}

export interface SponsorPrincipalSurface {
  unresolvable: boolean;
  jwtStampCount: number;
  safeJwtStampCount: number;
  sessionProjectionCount: number;
  safeSessionProjectionCount: number;
  sessionCleanupCount: number;
  safeSessionCleanupCount: number;
}

export interface RecentAuthSurface {
  callbacksPresent: boolean;
  unresolvable: boolean;
  jwtPresent: boolean;
  sessionPresent: boolean;
  jwtStampCount: number;
  safeJwtStampCount: number;
  sessionProjectionCount: number;
  safeSessionProjectionCount: number;
  iatReads: string[];
}

function parse(source: string, fileName: string): ts.SourceFile {
  // setParentNodes: the env classifier needs to look upward from a node.
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
}

function violation(code: AuthViolationCode, file: string, detail: string): AuthViolation {
  const spec = RULES[code];
  return { code, rule: spec.rule, file, detail, fix_hint: spec.fix_hint };
}

/** Every module specifier the file imports or re-exports from. */
export function importedModules(sourceFile: ts.SourceFile): string[] {
  const found: string[] = [];
  for (const statement of sourceFile.statements) {
    const specifier =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;
    if (specifier !== undefined && ts.isStringLiteral(specifier)) found.push(specifier.text);
  }
  return found;
}

/** Local binding name → module specifier, for every value import in the file. */
function importBindings(sourceFile: ts.SourceFile): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    // `import Google from "..."` — the alias is irrelevant, the module is not.
    if (clause.name !== undefined) bindings.set(clause.name.text, specifier);
    const named = clause.namedBindings;
    if (named === undefined) continue;
    if (ts.isNamespaceImport(named)) bindings.set(named.name.text, specifier);
    else {
      for (const element of named.elements) {
        if (!element.isTypeOnly) bindings.set(element.name.text, specifier);
      }
    }
  }
  return bindings;
}

function literalPropertyName(element: ts.ObjectLiteralElementLike): string | undefined {
  const name = element.name;
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined; // computed key: not statically knowable
}

interface ObjectLookup {
  value: ts.Expression | undefined;
  unresolvable: boolean;
}

function propertyOf(object: ts.ObjectLiteralExpression, key: string): ObjectLookup {
  let value: ts.Expression | undefined;
  let unresolvable = false;
  for (const element of object.properties) {
    if (ts.isSpreadAssignment(element)) {
      unresolvable = true;
      continue;
    }
    if (literalPropertyName(element) !== key) continue;
    if (ts.isPropertyAssignment(element)) value = element.initializer;
    else unresolvable = true; // shorthand or method: the value lives elsewhere
  }
  return { value, unresolvable };
}

function asObjectLiteral(node: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined {
  return node !== undefined && ts.isObjectLiteralExpression(node) ? node : undefined;
}

/**
 * Every call to the imported Auth.js factory, under whatever alias. Matching an
 * identifier merely *named* `NextAuth` would let a local function of that name
 * capture the guard and have it validate a configuration nobody runs.
 */
export function nextAuthCalls(sourceFile: ts.SourceFile): ts.CallExpression[] {
  const bindings = importBindings(sourceFile);
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      bindings.get(node.expression.text) === NEXT_AUTH_MODULE
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

/** The single Auth.js configuration object, or undefined when not decidable. */
export function nextAuthConfig(sourceFile: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  const calls = nextAuthCalls(sourceFile);
  if (calls.length !== 1) return undefined; // zero: none found; two: ambiguous
  return asObjectLiteral(calls[0]?.arguments[0]);
}

/**
 * Resolve the `providers` array actually handed to the Auth.js factory.
 *
 * Each element must be an imported binding, bare (`Google`) or invoked
 * (`Google({...})`). Anything else — a locally-defined object, a member call,
 * a spread — leaves the configured set unprovable and is reported as such.
 */
export function configuredProviders(sourceFile: ts.SourceFile): ProviderSurface {
  const calls = nextAuthCalls(sourceFile);
  const bindings = importBindings(sourceFile);
  const base: ProviderSurface = {
    factoryCalls: calls.length,
    factoryResolved: false,
    configured: false,
    literalArray: false,
    unresolvable: false,
    entries: [],
  };

  const config = nextAuthConfig(sourceFile);
  if (config === undefined) return base;
  const resolved = { ...base, factoryResolved: true };

  const lookup = propertyOf(config, "providers");
  if (lookup.value === undefined) return { ...resolved, unresolvable: lookup.unresolvable };
  if (!ts.isArrayLiteralExpression(lookup.value)) {
    return { ...resolved, configured: true, unresolvable: true };
  }

  const entries: ConfiguredProvider[] = [];
  let unresolvable = lookup.unresolvable;
  for (const element of lookup.value.elements) {
    if (ts.isSpreadElement(element)) {
      unresolvable = true;
      continue;
    }
    const referenced = ts.isCallExpression(element) ? element.expression : element;
    const text = element.getText(sourceFile);
    entries.push({
      text,
      module: ts.isIdentifier(referenced) ? bindings.get(referenced.text) : undefined,
    });
  }

  return { ...resolved, configured: true, literalArray: true, unresolvable, entries };
}

/** Resolve `cookies.sessionToken.options` structurally. */
export function sessionCookieOptions(sourceFile: ts.SourceFile): SessionCookieOptions {
  const empty: SessionCookieOptions = { present: false, keys: [], unresolvable: false };
  const config = nextAuthConfig(sourceFile);
  if (config === undefined) return empty;

  let unresolvable = false;
  let current: ts.ObjectLiteralExpression | undefined = config;
  for (const key of ["cookies", "sessionToken", "options"]) {
    if (current === undefined) break;
    const lookup: ObjectLookup = propertyOf(current, key);
    if (lookup.unresolvable) unresolvable = true;
    current = asObjectLiteral(lookup.value);
  }

  if (current === undefined) return { present: false, keys: [], unresolvable };

  const keys: string[] = [];
  for (const element of current.properties) {
    if (ts.isSpreadAssignment(element)) {
      unresolvable = true;
      continue;
    }
    const name = literalPropertyName(element);
    if (name === undefined) unresolvable = true;
    else keys.push(name);
  }
  return { present: true, keys, unresolvable };
}

type CallbackFunction = (ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression) & {
  readonly body: ts.ConciseBody;
};

function callbackFunction(
  callbacks: ts.ObjectLiteralExpression,
  key: string,
): { fn: CallbackFunction | undefined; unresolvable: boolean } {
  let fn: CallbackFunction | undefined;
  let unresolvable = false;
  for (const element of callbacks.properties) {
    if (ts.isSpreadAssignment(element)) {
      unresolvable = true;
      continue;
    }
    if (literalPropertyName(element) !== key) continue;
    if (ts.isMethodDeclaration(element) && element.body !== undefined) {
      fn = element as CallbackFunction;
    } else if (
      ts.isPropertyAssignment(element) &&
      (ts.isArrowFunction(element.initializer) || ts.isFunctionExpression(element.initializer))
    ) {
      fn = element.initializer;
    } else {
      unresolvable = true;
    }
  }
  return { fn, unresolvable };
}

function callbackBinding(fn: CallbackFunction, publicName: string): string | undefined {
  const parameter = fn.parameters[0];
  if (parameter === undefined || !ts.isObjectBindingPattern(parameter.name)) return undefined;
  for (const element of parameter.name.elements) {
    if (!ts.isIdentifier(element.name)) continue;
    const sourceName = element.propertyName;
    const name =
      sourceName !== undefined && (ts.isIdentifier(sourceName) || ts.isStringLiteral(sourceName))
        ? sourceName.text
        : element.name.text;
    if (name === publicName) return element.name.text;
  }
  return undefined;
}

function propertyAccess(
  node: ts.Node | undefined,
  objectName: string | undefined,
  propertyName: string,
): node is ts.PropertyAccessExpression {
  return (
    node !== undefined &&
    objectName !== undefined &&
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === objectName &&
    node.name.text === propertyName
  );
}

function staticPropertyName(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    const argument = node.argumentExpression;
    if (argument !== undefined && ts.isStringLiteralLike(argument)) return argument.text;
  }
  return undefined;
}

function isWithin(node: ts.Node, ancestor: ts.Node): boolean {
  for (let parent: ts.Node | undefined = node; parent !== undefined; parent = parent.parent) {
    if (parent === ancestor) return true;
  }
  return false;
}

function isSafeProviderAuthTimeExpression(
  node: ts.Expression,
  accountBinding: string | undefined,
  authTimeHelperBinding: string | undefined,
): boolean {
  return (
    authTimeHelperBinding !== undefined &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === authTimeHelperBinding &&
    node.arguments.length === 1 &&
    propertyAccess(node.arguments[0], accountBinding, "id_token")
  );
}

function exactNamedImportBinding(
  sourceFile: ts.SourceFile,
  moduleName: string,
  importedName: string,
): string | undefined {
  const matches: string[] = [];
  for (const statement of sourceFile.statements) {
    const namedBindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName ||
      statement.importClause?.isTypeOnly === true ||
      namedBindings === undefined ||
      !ts.isNamedImports(namedBindings)
    ) {
      continue;
    }
    for (const element of namedBindings.elements) {
      if (
        !element.isTypeOnly &&
        (element.propertyName?.text ?? element.name.text) === importedName
      ) {
        matches.push(element.name.text);
      }
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function hasValueDeclaration(root: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    const declared =
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.name.text === name;
    if (declared) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function unwrapTransparentExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function directIdentifierName(node: ts.Expression): string | undefined {
  const current = unwrapTransparentExpression(node);
  return ts.isIdentifier(current) ? current.text : undefined;
}

function assignmentRoot(node: ts.Expression): string | undefined {
  let current = unwrapTransparentExpression(node);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrapTransparentExpression(current.expression);
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}

function assignmentTargetContains(
  node: ts.Expression,
  matches: (target: ts.Expression) => boolean,
): boolean {
  const current = unwrapTransparentExpression(node);
  if (matches(current)) return true;
  if (ts.isSpreadElement(current)) {
    return assignmentTargetContains(current.expression, matches);
  }
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.some(
      (element) => !ts.isOmittedExpression(element) && assignmentTargetContains(element, matches),
    );
  }
  if (ts.isObjectLiteralExpression(current)) {
    return current.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return assignmentTargetContains(property.name, matches);
      }
      if (ts.isPropertyAssignment(property)) {
        return assignmentTargetContains(property.initializer, matches);
      }
      if (ts.isSpreadAssignment(property)) {
        return assignmentTargetContains(property.expression, matches);
      }
      return false;
    });
  }
  return false;
}

function hasBindingWrite(root: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      assignmentTargetContains(node.left, (target) => assignmentRoot(target) === name)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function hasDirectBindingWrite(root: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      assignmentTargetContains(node.left, (target) => directIdentifierName(target) === name)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function hasWholeBindingEscape(root: ts.Node, name: string): boolean {
  const aliases = new Set([name]);
  let aliasAdded = true;
  while (aliasAdded) {
    aliasAdded = false;
    const collectAliases = (node: ts.Node): void => {
      let target: ts.Identifier | undefined;
      let source: ts.Expression | undefined;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        target = node.name;
        source = node.initializer;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        target = node.left;
        source = node.right;
      }
      const sourceName = source === undefined ? undefined : directIdentifierName(source);
      if (
        target !== undefined &&
        sourceName !== undefined &&
        aliases.has(sourceName) &&
        !aliases.has(target.text)
      ) {
        aliases.add(target.text);
        aliasAdded = true;
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(root);
  }

  const containsWholeBinding = (node: ts.Expression): boolean => {
    const current = unwrapTransparentExpression(node);
    if (ts.isIdentifier(current)) return aliases.has(current.text);
    if (ts.isConditionalExpression(current)) {
      return containsWholeBinding(current.whenTrue) || containsWholeBinding(current.whenFalse);
    }
    if (
      ts.isBinaryExpression(current) &&
      [
        ts.SyntaxKind.CommaToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(current.operatorToken.kind)
    ) {
      return containsWholeBinding(current.left) || containsWholeBinding(current.right);
    }
    if (ts.isAwaitExpression(current)) return containsWholeBinding(current.expression);
    if (ts.isSpreadElement(current)) return containsWholeBinding(current.expression);
    if (ts.isArrayLiteralExpression(current)) {
      return current.elements.some(
        (element) => !ts.isOmittedExpression(element) && containsWholeBinding(element),
      );
    }
    if (ts.isObjectLiteralExpression(current)) {
      return current.properties.some((property) => {
        if (ts.isShorthandPropertyAssignment(property)) {
          return aliases.has(property.name.text);
        }
        if (ts.isPropertyAssignment(property)) return containsWholeBinding(property.initializer);
        if (ts.isSpreadAssignment(property)) return containsWholeBinding(property.expression);
        return false;
      });
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      if (!ts.isBlock(current.body)) return containsWholeBinding(current.body);
      let returnsBinding = false;
      const visitReturn = (child: ts.Node): void => {
        if (returnsBinding || (child !== current && ts.isFunctionLike(child))) return;
        if (
          ts.isReturnStatement(child) &&
          child.expression !== undefined &&
          containsWholeBinding(child.expression)
        ) {
          returnsBinding = true;
          return;
        }
        ts.forEachChild(child, visitReturn);
      };
      visitReturn(current.body);
      return returnsBinding;
    }
    return false;
  };

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // A protected callback object stored for later use has already escaped
    // this local proof, even if the eventual mutating call is written through
    // a wrapper path the simple alias relation cannot reconstruct. Refuse the
    // storage edge itself: direct aliases, array/object wrappers, default
    // values, and expression-bodied closures all arrive as an initializer or
    // assignment RHS containing the whole binding.
    const storedExpression =
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isBindingElement(node)
        ? node.initializer
        : ts.isBinaryExpression(node) &&
            node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
          ? node.right
          : undefined;
    if (storedExpression !== undefined && containsWholeBinding(storedExpression)) {
      found = true;
      return;
    }
    if (
      (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) &&
      containsWholeBinding(node)
    ) {
      found = true;
      return;
    }
    // A declaration-style nested function has no initializer. Its return or
    // yield is nevertheless an escape once somebody later calls the function.
    // The callback's own required trailing `return token/session` is outside
    // `root`, so its enclosing function deliberately does not satisfy this.
    if (
      ((ts.isReturnStatement(node) && node.expression !== undefined) ||
        (ts.isYieldExpression(node) && node.expression !== undefined)) &&
      containsWholeBinding(node.expression)
    ) {
      let enclosing: ts.Node | undefined = node.parent;
      while (enclosing !== undefined && !ts.isFunctionLike(enclosing)) enclosing = enclosing.parent;
      if (enclosing !== undefined && isWithin(enclosing, root)) {
        found = true;
        return;
      }
    }
    // Throwing the protected object is also an escape: framework error
    // handlers, adapters, or loggers may observe the thrown value even though
    // the callback retains its reviewed trailing return on the ordinary path.
    if (
      ts.isThrowStatement(node) &&
      node.expression !== undefined &&
      containsWholeBinding(node.expression)
    ) {
      found = true;
      return;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const receiver =
        ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression)
          ? node.expression.expression
          : undefined;
      if (
        containsWholeBinding(node.expression) ||
        (receiver !== undefined && containsWholeBinding(receiver)) ||
        node.arguments?.some(containsWholeBinding)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function hasFieldMutationOtherThan(
  root: ts.Node,
  objectName: string,
  propertyName: string,
  allowed: ts.Node,
): boolean {
  const aliases = new Set([objectName]);
  let aliasAdded = true;
  while (aliasAdded) {
    aliasAdded = false;
    const collectAliases = (node: ts.Node): void => {
      let target: ts.Identifier | undefined;
      let source: ts.Expression | undefined;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        target = node.name;
        source = node.initializer;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        target = node.left;
        source = node.right;
      }
      const sourceBinding = source === undefined ? undefined : directIdentifierName(source);
      if (
        target !== undefined &&
        sourceBinding !== undefined &&
        aliases.has(sourceBinding) &&
        !aliases.has(target.text)
      ) {
        aliases.add(target.text);
        aliasAdded = true;
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(root);
  }

  let found = false;
  const targetsField = (target: ts.Expression): boolean => {
    const current = unwrapTransparentExpression(target);
    const rootName = assignmentRoot(current);
    if (rootName === undefined || !aliases.has(rootName)) return false;
    const name = staticPropertyName(current);
    // A computed property that cannot be resolved statically may be the
    // protected evidence field. Refuse it rather than blessing a dynamic
    // post-evidence overwrite the checker cannot distinguish from a harmless
    // property write.
    return name === undefined || name === propertyName;
  };
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      node !== allowed &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      assignmentTargetContains(node.left, targetsField)
    ) {
      found = true;
      return;
    }
    if (
      ((ts.isPrefixUnaryExpression(node) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) ||
        ts.isPostfixUnaryExpression(node)) &&
      targetsField(node.operand)
    ) {
      found = true;
      return;
    }
    if (ts.isDeleteExpression(node) && targetsField(node.expression)) {
      found = true;
      return;
    }
    if (ts.isCallExpression(node)) {
      const target = node.arguments[0];
      const namedProperty = node.arguments[1];
      const directTarget = target !== undefined && aliases.has(directIdentifierName(target) ?? "");
      if (directTarget && propertyAccess(node.expression, "Object", "assign")) {
        found = true;
        return;
      }
      if (directTarget && propertyAccess(node.expression, "Object", "defineProperties")) {
        found = true;
        return;
      }
      const namedPropertyIsProtectedOrUnknown =
        namedProperty === undefined ||
        !ts.isStringLiteralLike(namedProperty) ||
        namedProperty.text === propertyName;
      if (
        directTarget &&
        namedPropertyIsProtectedOrUnknown &&
        (propertyAccess(node.expression, "Object", "defineProperty") ||
          propertyAccess(node.expression, "Reflect", "defineProperty") ||
          propertyAccess(node.expression, "Reflect", "deleteProperty") ||
          propertyAccess(node.expression, "Reflect", "set"))
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

interface StaticAccessPath {
  readonly root: string;
  /** Undefined means at least one computed segment could not be resolved. */
  readonly path: readonly string[] | undefined;
}

function staticAccessPath(node: ts.Expression): StaticAccessPath | undefined {
  let current = unwrapTransparentExpression(node);
  const reversed: string[] = [];
  let unresolvable = false;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (ts.isPropertyAccessExpression(current)) {
      reversed.push(current.name.text);
    } else {
      const argument = current.argumentExpression;
      if (argument !== undefined && ts.isStringLiteralLike(argument)) reversed.push(argument.text);
      else unresolvable = true;
    }
    current = unwrapTransparentExpression(current.expression);
  }
  if (!ts.isIdentifier(current)) return undefined;
  return {
    root: current.text,
    path: unresolvable ? undefined : reversed.reverse(),
  };
}

function propertyPathAccess(
  node: ts.Expression | undefined,
  root: string | undefined,
  path: readonly string[],
): boolean {
  if (node === undefined || root === undefined) return false;
  const access = staticAccessPath(node);
  return (
    access !== undefined &&
    access.root === root &&
    access.path !== undefined &&
    access.path.length === path.length &&
    access.path.every((part, index) => part === path[index])
  );
}

/**
 * Refuse any mutation that can replace `session.user.id`, including through a
 * direct alias of `session` or `session.user`. Unknown computed paths rooted at
 * either binding fail closed rather than being assumed unrelated.
 */
function hasSponsorSessionMutationOtherThan(
  root: ts.Node,
  sessionBinding: string,
  allowed: ReadonlySet<ts.Node>,
): boolean {
  const sessionAliases = new Set([sessionBinding]);
  const userAliases = new Set<string>();
  let aliasAdded = true;
  while (aliasAdded) {
    aliasAdded = false;
    const collectAliases = (node: ts.Node): void => {
      let target: ts.Identifier | undefined;
      let source: ts.Expression | undefined;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        target = node.name;
        source = node.initializer;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        target = node.left;
        source = node.right;
      }
      const access = source === undefined ? undefined : staticAccessPath(source);
      if (target !== undefined && access !== undefined) {
        if (
          ((sessionAliases.has(access.root) && access.path?.length === 0) ||
            (userAliases.has(access.root) && access.path?.length === 0)) &&
          !sessionAliases.has(target.text) &&
          !userAliases.has(target.text)
        ) {
          if (sessionAliases.has(access.root)) sessionAliases.add(target.text);
          else userAliases.add(target.text);
          aliasAdded = true;
        } else if (
          sessionAliases.has(access.root) &&
          access.path?.length === 1 &&
          access.path[0] === "user" &&
          !userAliases.has(target.text)
        ) {
          userAliases.add(target.text);
          aliasAdded = true;
        }
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(root);
  }

  const mutationTargetsPrincipal = (target: ts.Expression): boolean => {
    const access = staticAccessPath(target);
    if (access === undefined) return false;
    if (sessionAliases.has(access.root)) {
      if (access.path === undefined) return true;
      return access.path[0] === "user" && (access.path.length === 1 || access.path[1] === "id");
    }
    if (userAliases.has(access.root)) {
      if (access.path === undefined) return true;
      return access.path.length > 0 && access.path[0] === "id";
    }
    return false;
  };

  const objectCanContainPrincipal = (target: ts.Expression): boolean => {
    const access = staticAccessPath(target);
    if (access === undefined) return false;
    if (sessionAliases.has(access.root)) {
      if (access.path === undefined || access.path.length === 0) return true;
      return access.path[0] === "user" && (access.path.length === 1 || access.path[1] === "id");
    }
    if (userAliases.has(access.root)) {
      return access.path === undefined || access.path.length === 0 || access.path[0] === "id";
    }
    return false;
  };

  const expressionContainsPrincipalObject = (node: ts.Expression): boolean => {
    const current = unwrapTransparentExpression(node);
    const bodyExposesPrincipal = (body: ts.ConciseBody): boolean => {
      if (!ts.isBlock(body)) return expressionContainsPrincipalObject(body);
      let exposesPrincipal = false;
      const visitExposure = (child: ts.Node): void => {
        if (exposesPrincipal || (child !== body && ts.isFunctionLike(child))) return;
        const exposedExpression =
          ts.isReturnStatement(child) || ts.isYieldExpression(child) ? child.expression : undefined;
        if (
          exposedExpression !== undefined &&
          expressionContainsPrincipalObject(exposedExpression)
        ) {
          exposesPrincipal = true;
          return;
        }
        ts.forEachChild(child, visitExposure);
      };
      visitExposure(body);
      return exposesPrincipal;
    };
    if (objectCanContainPrincipal(current)) return true;
    if (ts.isConditionalExpression(current)) {
      return (
        expressionContainsPrincipalObject(current.whenTrue) ||
        expressionContainsPrincipalObject(current.whenFalse)
      );
    }
    if (
      ts.isBinaryExpression(current) &&
      [
        ts.SyntaxKind.CommaToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(current.operatorToken.kind)
    ) {
      return (
        expressionContainsPrincipalObject(current.left) ||
        expressionContainsPrincipalObject(current.right)
      );
    }
    if (ts.isAwaitExpression(current)) {
      return expressionContainsPrincipalObject(current.expression);
    }
    if (ts.isSpreadElement(current)) return expressionContainsPrincipalObject(current.expression);
    if (ts.isArrayLiteralExpression(current)) {
      return current.elements.some(
        (element) => !ts.isOmittedExpression(element) && expressionContainsPrincipalObject(element),
      );
    }
    if (ts.isObjectLiteralExpression(current)) {
      return current.properties.some((property) => {
        if (ts.isShorthandPropertyAssignment(property)) {
          return objectCanContainPrincipal(property.name);
        }
        if (ts.isPropertyAssignment(property)) {
          return expressionContainsPrincipalObject(property.initializer);
        }
        if (ts.isSpreadAssignment(property)) {
          return expressionContainsPrincipalObject(property.expression);
        }
        if (
          (ts.isMethodDeclaration(property) ||
            ts.isGetAccessorDeclaration(property) ||
            ts.isSetAccessorDeclaration(property)) &&
          property.body !== undefined
        ) {
          return bodyExposesPrincipal(property.body);
        }
        return false;
      });
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      return bodyExposesPrincipal(current.body);
    }
    if (ts.isClassExpression(current)) {
      return current.members.some(
        (member) =>
          (ts.isMethodDeclaration(member) ||
            ts.isGetAccessorDeclaration(member) ||
            ts.isSetAccessorDeclaration(member)) &&
          member.body !== undefined &&
          bodyExposesPrincipal(member.body),
      );
    }
    return false;
  };

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    const storedExpression =
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isBindingElement(node)
        ? node.initializer
        : ts.isBinaryExpression(node) &&
            node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
          ? node.right
          : undefined;
    if (storedExpression !== undefined && expressionContainsPrincipalObject(storedExpression)) {
      found = true;
      return;
    }
    if (
      (ts.isArrayLiteralExpression(node) ||
        ts.isObjectLiteralExpression(node) ||
        ts.isClassExpression(node)) &&
      expressionContainsPrincipalObject(node)
    ) {
      found = true;
      return;
    }
    if (
      ((ts.isReturnStatement(node) && node.expression !== undefined) ||
        (ts.isYieldExpression(node) && node.expression !== undefined)) &&
      expressionContainsPrincipalObject(node.expression)
    ) {
      let enclosing: ts.Node | undefined = node.parent;
      while (enclosing !== undefined && !ts.isFunctionLike(enclosing)) {
        enclosing = enclosing.parent;
      }
      if (enclosing !== undefined && isWithin(enclosing, root)) {
        found = true;
        return;
      }
    }
    if (
      ts.isThrowStatement(node) &&
      node.expression !== undefined &&
      expressionContainsPrincipalObject(node.expression)
    ) {
      found = true;
      return;
    }
    if (
      ts.isTaggedTemplateExpression(node) &&
      (expressionContainsPrincipalObject(node.tag) ||
        (ts.isTemplateExpression(node.template) &&
          node.template.templateSpans.some((span) =>
            expressionContainsPrincipalObject(span.expression),
          )))
    ) {
      found = true;
      return;
    }
    if (
      ts.isNewExpression(node) &&
      (expressionContainsPrincipalObject(node.expression) ||
        node.arguments?.some(expressionContainsPrincipalObject))
    ) {
      found = true;
      return;
    }
    if (
      !allowed.has(node) &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      assignmentTargetContains(node.left, mutationTargetsPrincipal)
    ) {
      found = true;
      return;
    }
    if (
      !allowed.has(node) &&
      ((ts.isPrefixUnaryExpression(node) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) ||
        ts.isPostfixUnaryExpression(node)) &&
      mutationTargetsPrincipal(node.operand)
    ) {
      found = true;
      return;
    }
    if (
      !allowed.has(node) &&
      ts.isDeleteExpression(node) &&
      mutationTargetsPrincipal(node.expression)
    ) {
      found = true;
      return;
    }
    if (!allowed.has(node) && ts.isCallExpression(node)) {
      const target = node.arguments[0];
      const directTarget = target !== undefined && objectCanContainPrincipal(target);
      if (
        directTarget &&
        (propertyAccess(node.expression, "Object", "assign") ||
          propertyAccess(node.expression, "Object", "defineProperties"))
      ) {
        found = true;
        return;
      }
      const receiver =
        ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression)
          ? node.expression.expression
          : undefined;
      if (
        expressionContainsPrincipalObject(node.expression) ||
        node.arguments.some(expressionContainsPrincipalObject) ||
        (receiver !== undefined && objectCanContainPrincipal(receiver))
      ) {
        found = true;
        return;
      }
      const namedProperty = node.arguments[1];
      if (
        directTarget &&
        (namedProperty === undefined ||
          !ts.isStringLiteralLike(namedProperty) ||
          namedProperty.text === "id" ||
          namedProperty.text === "user") &&
        (propertyAccess(node.expression, "Object", "defineProperty") ||
          propertyAccess(node.expression, "Reflect", "defineProperty") ||
          propertyAccess(node.expression, "Reflect", "deleteProperty") ||
          propertyAccess(node.expression, "Reflect", "set"))
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function isDirectStatementInTruthyIf(
  node: ts.Node,
  binding: string | undefined,
  callback: CallbackFunction,
): boolean {
  const statement = node.parent;
  const block = statement?.parent;
  const guarded = block?.parent;
  return (
    binding !== undefined &&
    statement !== undefined &&
    ts.isExpressionStatement(statement) &&
    block !== undefined &&
    ts.isBlock(block) &&
    guarded !== undefined &&
    ts.isIfStatement(guarded) &&
    ts.isBlock(callback.body) &&
    guarded.parent === callback.body &&
    guarded.thenStatement === block &&
    ts.isIdentifier(guarded.expression) &&
    guarded.expression.text === binding
  );
}

function isDirectStatementInNumberGuard(
  node: ts.Node,
  tokenBinding: string | undefined,
  callback: CallbackFunction,
): boolean {
  const statement = node.parent;
  if (statement === undefined || !ts.isExpressionStatement(statement)) return false;
  const parent = statement.parent;
  const guarded = ts.isIfStatement(parent)
    ? parent.thenStatement === statement
      ? parent
      : undefined
    : ts.isBlock(parent) &&
        ts.isIfStatement(parent.parent) &&
        parent.parent.thenStatement === parent
      ? parent.parent
      : undefined;
  if (guarded === undefined) return false;
  const condition = guarded.expression;
  return (
    ts.isBlock(callback.body) &&
    guarded.parent === callback.body &&
    ts.isBinaryExpression(condition) &&
    [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(
      condition.operatorToken.kind,
    ) &&
    ts.isTypeOfExpression(condition.left) &&
    propertyAccess(condition.left.expression, tokenBinding, "authTime") &&
    ts.isStringLiteral(condition.right) &&
    condition.right.text === "number"
  );
}

function hasExactTrailingBindingReturn(
  callback: CallbackFunction,
  binding: string | undefined,
  evidence: ts.Node,
): boolean {
  if (binding === undefined || !ts.isBlock(callback.body)) return false;
  const trailing = callback.body.statements.at(-1);
  if (
    trailing === undefined ||
    !ts.isReturnStatement(trailing) ||
    trailing.expression === undefined ||
    !ts.isIdentifier(trailing.expression) ||
    trailing.expression.text !== binding ||
    evidence.end >= trailing.getStart()
  ) {
    return false;
  }

  let returns = 0;
  const visit = (node: ts.Node): void => {
    if (node !== callback && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) returns += 1;
    ts.forEachChild(node, visit);
  };
  visit(callback.body);
  return returns === 1;
}

function directGuardingIf(node: ts.Node, callback: CallbackFunction): ts.IfStatement | undefined {
  const statement = node.parent;
  if (statement === undefined || !ts.isExpressionStatement(statement)) return undefined;
  const parent = statement.parent;
  const guarded = ts.isIfStatement(parent)
    ? parent.thenStatement === statement
      ? parent
      : undefined
    : ts.isBlock(parent) &&
        ts.isIfStatement(parent.parent) &&
        parent.parent.thenStatement === parent
      ? parent.parent
      : undefined;
  return guarded !== undefined && ts.isBlock(callback.body) && guarded.parent === callback.body
    ? guarded
    : undefined;
}

function isSafeSponsorSubjectExpression(
  node: ts.Expression,
  profileBinding: string | undefined,
  helperBinding: string | undefined,
): boolean {
  if (!ts.isAwaitExpression(node) || helperBinding === undefined) return false;
  const call = node.expression;
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== helperBinding ||
    call.arguments.length !== 1
  ) {
    return false;
  }
  const subject = call.arguments[0];
  return (
    subject !== undefined &&
    propertyAccess(subject, profileBinding, "sub") &&
    subject.questionDotToken !== undefined
  );
}

function exactSponsorCleanup(
  node: ts.Node | undefined,
  sessionBinding: string | undefined,
): node is ts.CallExpression {
  const property = node !== undefined && ts.isCallExpression(node) ? node.arguments[1] : undefined;
  return (
    node !== undefined &&
    ts.isCallExpression(node) &&
    propertyAccess(node.expression, "Reflect", "deleteProperty") &&
    node.arguments.length === 2 &&
    propertyPathAccess(node.arguments[0], sessionBinding, ["user"]) &&
    property !== undefined &&
    ts.isStringLiteralLike(property) &&
    property.text === "id"
  );
}

function branchExpression(branch: ts.Statement | undefined): ts.Expression | undefined {
  if (branch === undefined) return undefined;
  if (ts.isExpressionStatement(branch)) return branch.expression;
  if (ts.isBlock(branch) && branch.statements.length === 1) {
    const only = branch.statements[0];
    if (only !== undefined && ts.isExpressionStatement(only)) return only.expression;
  }
  return undefined;
}

function sponsorPrincipalSurface(sourceFile: ts.SourceFile): SponsorPrincipalSurface {
  const empty: SponsorPrincipalSurface = {
    unresolvable: false,
    jwtStampCount: 0,
    safeJwtStampCount: 0,
    sessionProjectionCount: 0,
    safeSessionProjectionCount: 0,
    sessionCleanupCount: 0,
    safeSessionCleanupCount: 0,
  };
  const config = nextAuthConfig(sourceFile);
  if (config === undefined) return empty;
  const callbacksLookup = propertyOf(config, "callbacks");
  const callbacks = asObjectLiteral(callbacksLookup.value);
  if (callbacks === undefined) {
    return { ...empty, unresolvable: callbacksLookup.unresolvable };
  }
  const jwtLookup = callbackFunction(callbacks, "jwt");
  const sessionLookup = callbackFunction(callbacks, "session");
  const surface = {
    ...empty,
    unresolvable:
      callbacksLookup.unresolvable || jwtLookup.unresolvable || sessionLookup.unresolvable,
  };
  const jwt = jwtLookup.fn;
  const session = sessionLookup.fn;
  if (jwt === undefined || session === undefined) return surface;

  const jwtToken = callbackBinding(jwt, "token");
  const account = callbackBinding(jwt, "account");
  const profile = callbackBinding(jwt, "profile");
  const sessionBinding = callbackBinding(session, "session");
  const sessionToken = callbackBinding(session, "token");
  const importedSponsorHelper = exactNamedImportBinding(
    sourceFile,
    SPONSOR_ID_HELPER,
    "sponsorIdFromGoogleSubject",
  );
  const sponsorHelper =
    importedSponsorHelper !== undefined &&
    !hasValueDeclaration(sourceFile, importedSponsorHelper) &&
    !hasBindingWrite(sourceFile, importedSponsorHelper)
      ? importedSponsorHelper
      : undefined;
  const importedCanonicalHelper = exactNamedImportBinding(
    sourceFile,
    SPONSOR_ID_HELPER,
    "isCanonicalSponsorId",
  );
  const canonicalHelper =
    importedCanonicalHelper !== undefined &&
    !hasValueDeclaration(sourceFile, importedCanonicalHelper) &&
    !hasBindingWrite(sourceFile, importedCanonicalHelper)
      ? importedCanonicalHelper
      : undefined;

  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      propertyAccess(node.left, jwtToken, "sub")
    ) {
      surface.jwtStampCount += 1;
      if (
        jwtToken !== undefined &&
        account !== undefined &&
        profile !== undefined &&
        isWithin(node, jwt) &&
        isSafeSponsorSubjectExpression(node.right, profile, sponsorHelper) &&
        isDirectStatementInTruthyIf(node, account, jwt) &&
        hasExactTrailingBindingReturn(jwt, jwtToken, node) &&
        !hasValueDeclaration(jwt.body, jwtToken) &&
        !hasValueDeclaration(jwt.body, account) &&
        !hasValueDeclaration(jwt.body, profile) &&
        !hasFieldMutationOtherThan(jwt.body, jwtToken, "sub", node) &&
        !hasFieldMutationOtherThan(jwt.body, profile, "sub", jwt) &&
        !hasWholeBindingEscape(jwt.body, jwtToken) &&
        !hasWholeBindingEscape(jwt.body, profile) &&
        !hasBindingWrite(jwt.body, account) &&
        !hasBindingWrite(jwt.body, profile)
      ) {
        surface.safeJwtStampCount += 1;
      }
    }

    if (
      ts.isCallExpression(node) &&
      exactSponsorCleanup(node, sessionBinding) &&
      isWithin(node, session)
    ) {
      surface.sessionCleanupCount += 1;
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      propertyPathAccess(node.left, sessionBinding, ["user", "id"])
    ) {
      surface.sessionProjectionCount += 1;
      const guarded = directGuardingIf(node, session);
      const condition = guarded?.expression;
      const cleanup = branchExpression(guarded?.elseStatement);
      const conditionIsCanonical =
        canonicalHelper !== undefined &&
        condition !== undefined &&
        ts.isCallExpression(condition) &&
        ts.isIdentifier(condition.expression) &&
        condition.expression.text === canonicalHelper &&
        condition.arguments.length === 1 &&
        propertyAccess(condition.arguments[0], sessionToken, "sub");
      const cleanupCall = exactSponsorCleanup(cleanup, sessionBinding) ? cleanup : undefined;
      if (
        sessionBinding !== undefined &&
        sessionToken !== undefined &&
        isWithin(node, session) &&
        propertyAccess(node.right, sessionToken, "sub") &&
        conditionIsCanonical &&
        cleanupCall !== undefined &&
        hasExactTrailingBindingReturn(session, sessionBinding, node) &&
        !hasValueDeclaration(session.body, sessionBinding) &&
        !hasValueDeclaration(session.body, sessionToken) &&
        !hasDirectBindingWrite(session.body, sessionBinding) &&
        !hasBindingWrite(session.body, sessionToken) &&
        !hasFieldMutationOtherThan(session.body, sessionToken, "sub", session) &&
        !hasWholeBindingEscape(session.body, sessionBinding) &&
        !hasWholeBindingEscape(session.body, sessionToken) &&
        !hasSponsorSessionMutationOtherThan(
          session.body,
          sessionBinding,
          new Set<ts.Node>([node, cleanupCall]),
        )
      ) {
        surface.safeSessionProjectionCount += 1;
        surface.safeSessionCleanupCount += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return surface;
}

/** Prove that only validated provider evidence can set decision step-up time. */
export function recentAuthSurface(sourceFile: ts.SourceFile): RecentAuthSurface {
  const empty: RecentAuthSurface = {
    callbacksPresent: false,
    unresolvable: false,
    jwtPresent: false,
    sessionPresent: false,
    jwtStampCount: 0,
    safeJwtStampCount: 0,
    sessionProjectionCount: 0,
    safeSessionProjectionCount: 0,
    iatReads: [],
  };
  const config = nextAuthConfig(sourceFile);
  if (config === undefined) return empty;
  const lookup = propertyOf(config, "callbacks");
  const callbacks = asObjectLiteral(lookup.value);
  if (callbacks === undefined) return { ...empty, unresolvable: lookup.unresolvable };

  const jwt = callbackFunction(callbacks, "jwt");
  const session = callbackFunction(callbacks, "session");
  const surface = {
    ...empty,
    callbacksPresent: true,
    unresolvable: lookup.unresolvable || jwt.unresolvable || session.unresolvable,
    jwtPresent: jwt.fn !== undefined,
    sessionPresent: session.fn !== undefined,
  };

  // Bindings are resolved while walking the complete source. That matters: a
  // helper or alias outside the callback must not be able to add a second
  // refreshable write that a callback-local walk never sees.
  const jwtToken = jwt.fn === undefined ? undefined : callbackBinding(jwt.fn, "token");
  const account = jwt.fn === undefined ? undefined : callbackBinding(jwt.fn, "account");
  const importedAuthTimeHelper = exactNamedImportBinding(
    sourceFile,
    AUTH_TIME_HELPER,
    "authTimeFromIdToken",
  );
  const authTimeHelper =
    importedAuthTimeHelper !== undefined &&
    !hasValueDeclaration(sourceFile, importedAuthTimeHelper) &&
    !hasBindingWrite(sourceFile, importedAuthTimeHelper)
      ? importedAuthTimeHelper
      : undefined;
  const sessionToken = session.fn === undefined ? undefined : callbackBinding(session.fn, "token");
  const sessionBinding =
    session.fn === undefined ? undefined : callbackBinding(session.fn, "session");
  const visit = (node: ts.Node): void => {
    // Auth.js's JWT `iat` is forbidden anywhere in executable auth
    // configuration, including through aliases or helpers. The separately
    // reviewed ID-token decoder is the only place the provider's signed `iat`
    // may be read.
    if (ts.isIdentifier(node) && node.text === "iat") {
      surface.iatReads.push(node.getText(sourceFile));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const assignedProperty = staticPropertyName(node.left);
      if (assignedProperty === "authTime") {
        surface.jwtStampCount += 1;
        if (
          jwt.fn !== undefined &&
          isWithin(node, jwt.fn) &&
          propertyAccess(node.left, jwtToken, "authTime") &&
          isSafeProviderAuthTimeExpression(node.right, account, authTimeHelper) &&
          isDirectStatementInTruthyIf(node, account, jwt.fn) &&
          hasExactTrailingBindingReturn(jwt.fn, jwtToken, node) &&
          jwtToken !== undefined &&
          account !== undefined &&
          !hasValueDeclaration(jwt.fn.body, jwtToken) &&
          !hasValueDeclaration(jwt.fn.body, account) &&
          !hasFieldMutationOtherThan(jwt.fn.body, jwtToken, "authTime", node) &&
          !hasWholeBindingEscape(jwt.fn.body, jwtToken) &&
          !hasWholeBindingEscape(jwt.fn.body, account) &&
          !hasBindingWrite(jwt.fn.body, account)
        ) {
          surface.safeJwtStampCount += 1;
        }
      }
      if (assignedProperty === "authIssuedAt") {
        surface.sessionProjectionCount += 1;
        if (
          session.fn !== undefined &&
          isWithin(node, session.fn) &&
          propertyAccess(node.left, sessionBinding, "authIssuedAt") &&
          propertyAccess(node.right, sessionToken, "authTime") &&
          isDirectStatementInNumberGuard(node, sessionToken, session.fn) &&
          hasExactTrailingBindingReturn(session.fn, sessionBinding, node) &&
          sessionToken !== undefined &&
          sessionBinding !== undefined &&
          !hasValueDeclaration(session.fn.body, sessionToken) &&
          !hasValueDeclaration(session.fn.body, sessionBinding) &&
          !hasFieldMutationOtherThan(session.fn.body, sessionBinding, "authIssuedAt", node) &&
          !hasWholeBindingEscape(session.fn.body, sessionBinding) &&
          !hasWholeBindingEscape(session.fn.body, sessionToken) &&
          !hasBindingWrite(session.fn.body, sessionToken)
        ) {
          surface.safeSessionProjectionCount += 1;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return surface;
}

/** True when this identifier is a real value reference, not a name position. */
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (parent === undefined) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isPropertySignature(parent) || ts.isMethodSignature(parent)) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  // A type annotation is not a value reference.
  if (ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent)) return false;
  return true;
}

/**
 * True when this `process` identifier is the root of exactly
 * `process.env.NODE_ENV`, written with plain property access.
 */
function isAllowedEnvExpression(node: ts.Identifier): boolean {
  if (node.text !== "process") return false;
  const env = node.parent;
  if (!ts.isPropertyAccessExpression(env) || env.expression !== node) return false;
  if (env.name.text !== "env") return false;
  const named = env.parent;
  if (!ts.isPropertyAccessExpression(named) || named.expression !== env) return false;
  return named.name.text === "NODE_ENV";
}

/**
 * Every reference to a global root that can reach the environment, anywhere in
 * the file, at any scope.
 *
 * The whole file rather than module scope: `auth.ts` has no legitimate reason
 * to read a secret at *any* time — Auth.js resolves `AUTH_*` itself — so the
 * narrow rule is both simpler and stronger than deciding which callbacks run
 * at import. Bracket access, computed keys, aliasing and IIFEs all need one of
 * these three names somewhere, which is what makes this complete for syntactic
 * access in a way that enumerating bad shapes was not.
 */
export function envAccesses(sourceFile: ts.SourceFile): EnvAccess[] {
  const found: EnvAccess[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && ENV_ROOTS.has(node.text) && isValueReference(node)) {
      const allowed = isAllowedEnvExpression(node);
      found.push({
        root: node.text,
        text: (allowed ? node.parent.parent : node.parent).getText(sourceFile),
        allowed,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function objectBindingNames(name: ts.BindingName, into: string[]): void {
  if (ts.isIdentifier(name)) {
    into.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) objectBindingNames(element.name, into);
  }
}

/**
 * Prove the shipped export wiring, not merely that a safe call exists.
 *
 * A file can contain an impeccable Auth.js call whose result is thrown away
 * while `handlers` is exported from something else entirely. Finding one good
 * call somewhere establishes nothing about what the application imports, so
 * the exported `handlers` binding must be initialised by *that* call.
 */
export function propylonExportWiring(sourceFile: ts.SourceFile): ExportWiring {
  const calls = new Set<ts.Node>(nextAuthCalls(sourceFile));
  const exported = new Set<string>();
  const fromFactory = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      const isExported = (ts.getModifiers(statement) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
      for (const declaration of statement.declarationList.declarations) {
        const names: string[] = [];
        objectBindingNames(declaration.name, names);
        const wired = declaration.initializer !== undefined && calls.has(declaration.initializer);
        for (const name of names) {
          if (isExported) exported.add(name);
          // Bindings destructured from the factory call, exported here or via
          // a later `export { ... }` clause.
          if (wired) fromFactory.add(name);
        }
      }
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
      if (statement.isTypeOnly) continue;
      if (!ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        // The exported *name* is what consumers import; its local origin is
        // what `fromFactory` decides.
        exported.add(element.name.text);
        if (!fromFactory.has((element.propertyName ?? element.name).text)) {
          fromFactory.delete(element.name.text);
        } else {
          fromFactory.add(element.name.text);
        }
      }
    }
  }

  const required = [...PROPYLON_EXPORTS];
  return {
    exported: required.filter((name) => exported.has(name)),
    fromFactory: required.filter((name) => fromFactory.has(name)),
    missing: required.filter((name) => !exported.has(name)),
    foreign: required.filter((name) => exported.has(name) && !fromFactory.has(name)),
  };
}

/**
 * Escape hatches that load or build code the import allowlist cannot see.
 * Without this the allowlist is decorative: `await import("./secrets")` names
 * no module in any import statement.
 */
export function dynamicCode(sourceFile: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      found.push(node.getText(sourceFile));
    }
    // Every reference, not only `require(...)` / `eval(...)` / `new Function`:
    // an alias defers the danger into a string the analyzer cannot follow.
    if (ts.isIdentifier(node) && DYNAMIC_CODE_NAMES.has(node.text) && isValueReference(node)) {
      // `isValueReference` already excludes the declaration name, so
      // `declare const require: …` is a declaration and `const f = Function`
      // is a reference — which is the case that matters.
      found.push(node.parent.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * The exact executable-call surface `auth.ts` needs, as an allowlist.
 *
 * The shipped file performs six calls: the imported Auth.js factory, the
 * imported Google provider, the two reviewed identity helpers, the canonical
 * guard, and the exact `Reflect.deleteProperty` cleanup. Everything else that
 * *executes* — ambient `fetch`/`console`/timer/storage/beacon calls, local
 * helper functions, aliased or wrapped callees, `new` expressions, tagged
 * templates, decorators — is refused by construction rather than enumerated:
 * a call is allowed only when its callee resolves to a binding imported from
 * an allowlisted module (and never shadowed or reassigned), or is the literal
 * `Reflect.deleteProperty` member spelling on the intact global. A callee this
 * function cannot resolve is a refusal, not a pass.
 *
 * Dynamic `import(...)` is deliberately skipped here: `dynamicCode` already
 * reports it, and reporting it twice would blur which rule refused it.
 */
export function executableCallSurface(sourceFile: ts.SourceFile): string[] {
  const bindings = importBindings(sourceFile);
  const callableImport = (name: string): boolean => {
    const moduleSpecifier = bindings.get(name);
    return (
      moduleSpecifier !== undefined &&
      ALLOWED_IMPORTS.has(moduleSpecifier) &&
      !hasValueDeclaration(sourceFile, name) &&
      !hasBindingWrite(sourceFile, name)
    );
  };
  const intactGlobal = (name: string): boolean =>
    !bindings.has(name) &&
    !hasValueDeclaration(sourceFile, name) &&
    !hasBindingWrite(sourceFile, name);

  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node) || ts.isDecorator(node)) {
      found.push(node.getText(sourceFile));
    } else if (ts.isCallExpression(node) && node.expression.kind !== ts.SyntaxKind.ImportKeyword) {
      const callee = unwrapTransparentExpression(node.expression);
      const allowed =
        (ts.isIdentifier(callee) && callableImport(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === "Reflect" &&
          callee.name.text === "deleteProperty" &&
          intactGlobal("Reflect"));
      if (!allowed) found.push(node.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * Every read of the raw provider-evidence bindings in the jwt callback that is
 * not one of the three reviewed shapes.
 *
 * The call allowlist refuses the ambient sinks; this refuses the *values*
 * moving toward any sink at all, including a plain `const leaked =
 * profile?.email` with no call in sight. The completeness argument is the same
 * one the environment rule relies on: every syntactic route to the evidence —
 * alias, wrapper, computed access, closure capture, destructure, object or
 * array packaging, template span — must reference the `profile` or `account`
 * binding by its identifier somewhere, so allowlisting the identifier's three
 * legitimate positions closes all of them at once. A shadowed or renamed
 * binding fails closed: its uses stop matching the allowed shapes and are
 * reported.
 */
export function providerEvidenceEscapes(sourceFile: ts.SourceFile): string[] {
  const config = nextAuthConfig(sourceFile);
  if (config === undefined) return [];
  const callbacks = asObjectLiteral(propertyOf(config, "callbacks").value);
  if (callbacks === undefined) return [];
  const jwt = callbackFunction(callbacks, "jwt").fn;
  if (jwt === undefined) return [];
  const profile = callbackBinding(jwt, "profile");
  const account = callbackBinding(jwt, "account");

  const unshadowedNamedImport = (module: string, importedName: string): string | undefined => {
    const binding = exactNamedImportBinding(sourceFile, module, importedName);
    return binding !== undefined &&
      !hasValueDeclaration(sourceFile, binding) &&
      !hasBindingWrite(sourceFile, binding)
      ? binding
      : undefined;
  };
  const sponsorHelper = unshadowedNamedImport(SPONSOR_ID_HELPER, "sponsorIdFromGoogleSubject");
  const authTimeHelper = unshadowedNamedImport(AUTH_TIME_HELPER, "authTimeFromIdToken");

  const soleArgumentOfHelperCall = (
    argument: ts.Expression,
    helper: string | undefined,
  ): boolean => {
    const call = argument.parent;
    return (
      helper !== undefined &&
      call !== undefined &&
      ts.isCallExpression(call) &&
      ts.isIdentifier(call.expression) &&
      call.expression.text === helper &&
      call.arguments.length === 1 &&
      call.arguments[0] === argument
    );
  };

  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isValueReference(node)) {
      if (profile !== undefined && node.text === profile) {
        const access = node.parent;
        const allowed =
          access !== undefined &&
          ts.isPropertyAccessExpression(access) &&
          access.expression === node &&
          access.name.text === "sub" &&
          access.questionDotToken !== undefined &&
          soleArgumentOfHelperCall(access, sponsorHelper);
        if (!allowed) {
          found.push(
            (access !== undefined && !ts.isSourceFile(access) ? access : node).getText(sourceFile),
          );
        }
      }
      if (account !== undefined && node.text === account) {
        const parent = node.parent;
        const truthyGuard =
          parent !== undefined && ts.isIfStatement(parent) && parent.expression === node;
        const idTokenRead =
          parent !== undefined &&
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node &&
          parent.name.text === "id_token" &&
          soleArgumentOfHelperCall(parent, authTimeHelper);
        if (!truthyGuard && !idTokenRead) {
          found.push(
            (parent !== undefined && !ts.isSourceFile(parent) ? parent : node).getText(sourceFile),
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(jwt.body);
  return found;
}

export function readAuthSurface(source: string, fileName = "auth.ts"): AuthSurface {
  const sourceFile = parse(source, fileName);
  return {
    imports: importedModules(sourceFile),
    providers: configuredProviders(sourceFile),
    cookies: sessionCookieOptions(sourceFile),
    envAccesses: envAccesses(sourceFile),
    wiring: propylonExportWiring(sourceFile),
    dynamicCode: dynamicCode(sourceFile),
    ambientCalls: executableCallSurface(sourceFile),
    evidenceEscapes: providerEvidenceEscapes(sourceFile),
    sponsorPrincipal: sponsorPrincipalSurface(sourceFile),
    recentAuth: recentAuthSurface(sourceFile),
  };
}

function envViolations(surface: AuthSurface, file: string): AuthViolation[] {
  return surface.envAccesses
    .filter((access) => !access.allowed)
    .map((access) =>
      violation(
        "AUTH_ENV_ACCESS_FORBIDDEN",
        file,
        `\`${access.text}\` reaches the environment through \`${access.root}\`; only ${ALLOWED_ENV_EXPRESSION} is permitted in this file.`,
      ),
    );
}

function importViolations(surface: AuthSurface, file: string): AuthViolation[] {
  return surface.imports
    .filter((specifier) => !ALLOWED_IMPORTS.has(specifier))
    .map((specifier) =>
      violation(
        "AUTH_IMPORT_NOT_ALLOWED",
        file,
        `auth.ts imports "${specifier}", which is not on the allowlist.`,
      ),
    );
}

/** Validate one Propylon configuration source. */
export function validateAuthConfig(source: string, file = "auth.ts"): AuthViolation[] {
  const surface = readAuthSurface(source, file);
  const providers = surface.providers;
  const recentAuth = surface.recentAuth;
  const sponsorPrincipal = surface.sponsorPrincipal;
  const out: AuthViolation[] = [
    ...importViolations(surface, file),
    ...envViolations(surface, file),
    ...surface.dynamicCode.map((text) =>
      violation(
        "AUTH_DYNAMIC_CODE_FORBIDDEN",
        file,
        `\`${text}\` loads or builds code that the import allowlist cannot see.`,
      ),
    ),
    ...surface.ambientCalls.map((text) =>
      violation(
        "AUTH_CALL_NOT_ALLOWED",
        file,
        `\`${text}\` is not on the executable-call allowlist for auth.ts.`,
      ),
    ),
    ...surface.evidenceEscapes.map((text) =>
      violation(
        "AUTH_PROVIDER_EVIDENCE_ESCAPE",
        file,
        `\`${text}\` reads or repackages raw provider evidence outside the reviewed helper arguments.`,
      ),
    ),
  ];

  if (providers.factoryCalls > 1) {
    out.push(
      violation(
        "AUTH_NEXTAUTH_CALL_AMBIGUOUS",
        file,
        `${providers.factoryCalls} calls to the Auth.js factory; which configuration is live is not decidable here.`,
      ),
    );
    return out;
  }
  if (!providers.factoryResolved) {
    out.push(
      violation(
        "AUTH_NEXTAUTH_CALL_UNRESOLVED",
        file,
        'No call to the default export of "next-auth" with an object literal was found in this file.',
      ),
    );
    return out;
  }

  if (
    !recentAuth.callbacksPresent ||
    !recentAuth.jwtPresent ||
    !recentAuth.sessionPresent ||
    recentAuth.unresolvable
  ) {
    out.push(
      violation(
        "AUTH_RECENT_AUTH_CONFIG_MISSING",
        file,
        "The jwt/session callback pair is absent or not a literal, statically resolvable configuration.",
      ),
    );
  } else if (
    recentAuth.jwtStampCount !== 1 ||
    recentAuth.safeJwtStampCount !== 1 ||
    recentAuth.sessionProjectionCount !== 1 ||
    recentAuth.safeSessionProjectionCount !== 1 ||
    recentAuth.iatReads.length > 0
  ) {
    out.push(
      violation(
        "AUTH_RECENT_AUTH_REFRESHABLE",
        file,
        `Recent-auth wiring is unsafe: ${recentAuth.jwtStampCount} authTime stamp(s), ${recentAuth.safeJwtStampCount} account-guarded ID-token helper stamp(s), ${recentAuth.sessionProjectionCount} session projection(s), ${recentAuth.safeSessionProjectionCount} guarded stable projection(s), ${recentAuth.iatReads.length} iat read(s).`,
      ),
    );
  }

  if (
    sponsorPrincipal.unresolvable ||
    sponsorPrincipal.jwtStampCount !== 1 ||
    sponsorPrincipal.safeJwtStampCount !== 1 ||
    sponsorPrincipal.sessionProjectionCount !== 1 ||
    sponsorPrincipal.safeSessionProjectionCount !== 1 ||
    sponsorPrincipal.sessionCleanupCount !== 1 ||
    sponsorPrincipal.safeSessionCleanupCount !== 1
  ) {
    out.push(
      violation(
        "AUTH_SPONSOR_PRINCIPAL_UNSAFE",
        file,
        `Sponsor-principal wiring is unsafe: ${sponsorPrincipal.jwtStampCount} subject-derived stamp(s), ${sponsorPrincipal.safeJwtStampCount} safe stamp(s), ${sponsorPrincipal.sessionProjectionCount} session projection(s), ${sponsorPrincipal.safeSessionProjectionCount} canonical projection(s), ${sponsorPrincipal.sessionCleanupCount} invalid-id cleanup(s), ${sponsorPrincipal.safeSessionCleanupCount} guarded cleanup(s).`,
      ),
    );
  }

  if (surface.wiring.missing.length > 0) {
    out.push(
      violation(
        "AUTH_EXPORT_NOT_WIRED",
        file,
        `The Propylon surface is incomplete: ${surface.wiring.missing.join(", ")} not exported.`,
      ),
    );
  }
  if (surface.wiring.foreign.length > 0) {
    out.push(
      violation(
        "AUTH_EXPORT_NOT_WIRED",
        file,
        `Exported ${surface.wiring.foreign.join(", ")} did not come from the imported Auth.js call; the checked configuration is not the shipped one.`,
      ),
    );
  }

  if (!providers.configured) {
    out.push(
      violation(
        "AUTH_PROVIDERS_CONFIG_MISSING",
        file,
        "The Auth.js factory receives no `providers` property in this file.",
      ),
    );
  } else if (!providers.literalArray || providers.unresolvable) {
    out.push(
      violation(
        "AUTH_PROVIDERS_UNRESOLVABLE",
        file,
        "`providers` is not a literal array of imported bindings, so the configured set cannot be established.",
      ),
    );
  }

  for (const entry of providers.entries) {
    if (entry.module === undefined) {
      out.push(
        violation(
          "AUTH_PROVIDER_UNRESOLVED",
          file,
          `Configured provider \`${entry.text}\` does not resolve to an imported provider module.`,
        ),
      );
      continue;
    }
    if (entry.module !== GOOGLE_PROVIDER) {
      out.push(
        violation(
          "AUTH_PROVIDER_NOT_GOOGLE",
          file,
          `Configured provider \`${entry.text}\` resolves to "${entry.module}"; Google is the only human identity provider.`,
        ),
      );
    }
  }

  if (providers.literalArray) {
    if (!providers.entries.some((entry) => entry.module === GOOGLE_PROVIDER)) {
      out.push(
        violation(
          "AUTH_PROVIDER_MISSING",
          file,
          "No configured provider resolves to the Google provider module.",
        ),
      );
    }
    if (providers.entries.length !== 1) {
      out.push(
        violation(
          "AUTH_PROVIDERS_NOT_SINGLETON",
          file,
          `\`providers\` configures ${providers.entries.length} entries; exactly one is allowed.`,
        ),
      );
    }
  }

  if (!surface.cookies.present) {
    out.push(
      violation(
        "AUTH_COOKIE_CONFIG_MISSING",
        file,
        "cookies.sessionToken.options does not resolve to an object literal, so host-only cannot be verified.",
      ),
    );
  } else if (surface.cookies.keys.includes("domain")) {
    out.push(
      violation(
        "AUTH_COOKIE_DOMAIN_SET",
        file,
        "cookies.sessionToken.options sets `domain`; the sponsor cookie would leave the apex.",
      ),
    );
  }
  if (surface.cookies.unresolvable) {
    out.push(
      violation(
        "AUTH_COOKIE_UNRESOLVABLE",
        file,
        "A spread or computed key on the cookie path means `domain` cannot be proven absent.",
      ),
    );
  }

  return out;
}

/** Validate the `auth.ts` of a package directory. */
export function validateAuthFile(packageDir: string, relativePath = "auth.ts"): AuthViolation[] {
  return validateAuthConfig(readFileSync(join(packageDir, relativePath), "utf8"), relativePath);
}

export function formatAuthViolations(violations: readonly AuthViolation[]): string {
  if (violations.length === 0) return "no violations";
  return violations
    .map((v) => `${v.code} [${v.rule}] ${v.file}: ${v.detail} — fix: ${v.fix_hint}`)
    .join("\n");
}
