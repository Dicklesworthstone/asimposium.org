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
 *  1. **Imports are allowlisted.** Only `next-auth` and the Google provider.
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
  | "AUTH_ENV_ACCESS_FORBIDDEN";

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
      "auth.ts may import only next-auth and the Google provider. Put anything else in a module the app imports directly, so it is reviewed on its own terms.",
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
};

const NEXT_AUTH_MODULE = "next-auth";
const PROVIDER_PREFIX = "next-auth/providers/";
const GOOGLE_PROVIDER = `${PROVIDER_PREFIX}google`;

/**
 * Modules `auth.ts` may import. Adding an entry is a deliberate decision about
 * what can influence identity, and belongs in a commit a reviewer reads.
 */
export const ALLOWED_IMPORTS: ReadonlySet<string> = new Set([
  NEXT_AUTH_MODULE,
  GOOGLE_PROVIDER,
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
        const wired =
          declaration.initializer !== undefined && calls.has(declaration.initializer);
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

export function readAuthSurface(source: string, fileName = "auth.ts"): AuthSurface {
  const sourceFile = parse(source, fileName);
  return {
    imports: importedModules(sourceFile),
    providers: configuredProviders(sourceFile),
    cookies: sessionCookieOptions(sourceFile),
    envAccesses: envAccesses(sourceFile),
    wiring: propylonExportWiring(sourceFile),
    dynamicCode: dynamicCode(sourceFile),
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
