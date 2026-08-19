/**
 * App Router + API contract validator for Agora.
 *
 * Build/test-time only. Nothing under `app/` may import this module — it pulls
 * in the TypeScript compiler and has no business in a client or server bundle.
 *
 * It enforces two families of rule against a package's route tree:
 *
 *  1. **Next.js App Router structural rules** — the ones Next.js itself turns
 *     into build failures or silent 404s. Catching them in `bun test` is
 *     cheaper than catching them in `next build`, and gives a cited rule id.
 *  2. **ASImposium doctrine rules** — Pages Router is forbidden by AGENTS.md,
 *     and Agora must expose no write path, because the Worker is the only
 *     process that touches D1 (Fable §14.1, AGENTS.md "One write path").
 *
 * Scope, stated honestly: this is static analysis of file layout and export
 * surface. It does not resolve re-exports across modules, does not evaluate
 * `export *`, and does not model route groups `(group)` or parallel routes
 * `@slot` beyond skipping them where they would produce false positives. It is
 * a floor, not a proof that a tree builds.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, sep } from "node:path";

import ts from "typescript";

export type ViolationCode =
  | "MISSING_APP_DIR"
  | "MISSING_ROOT_LAYOUT"
  | "ROUTE_PAGE_COLLISION"
  | "MISSING_DEFAULT_EXPORT"
  | "EMPTY_ROUTE_HANDLERS"
  | "INVALID_ROUTE_EXPORT"
  | "DUPLICATE_DYNAMIC_SEGMENT"
  | "PAGES_ROUTER_FORBIDDEN"
  | "WRITE_PATH_FORBIDDEN";

export interface Violation {
  code: ViolationCode;
  /** Stable rule id, cited in failures the way the Worker cites P1–P13. */
  rule: string;
  /** POSIX path relative to the scanned root. Never absolute — see §14.3. */
  file: string;
  detail: string;
  fix_hint: string;
}

const RULES: Record<ViolationCode, { rule: string; fix_hint: string }> = {
  MISSING_APP_DIR: {
    rule: "NEXT-APP-0",
    fix_hint:
      "Agora is an App Router application. Create `app/` with a root layout; do not add `pages/`.",
  },
  MISSING_ROOT_LAYOUT: {
    rule: "NEXT-APP-1",
    fix_hint: "Add `app/layout.tsx` exporting a default component that renders <html> and <body>.",
  },
  ROUTE_PAGE_COLLISION: {
    rule: "NEXT-APP-2",
    fix_hint:
      "A segment serves either a page or a route handler, not both. Move the handler under `app/api/...`.",
  },
  MISSING_DEFAULT_EXPORT: {
    rule: "NEXT-APP-3",
    fix_hint:
      "`page`, `layout`, `error`, `loading`, `not-found` and `template` files must have a default export.",
  },
  EMPTY_ROUTE_HANDLERS: {
    rule: "NEXT-APP-4",
    fix_hint:
      "Export at least one HTTP method (GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS) from a route file, or delete it.",
  },
  INVALID_ROUTE_EXPORT: {
    rule: "NEXT-APP-5",
    fix_hint:
      "Route files may export only HTTP methods and route segment config. Move helpers into a sibling module.",
  },
  DUPLICATE_DYNAMIC_SEGMENT: {
    rule: "NEXT-APP-6",
    fix_hint:
      "Sibling dynamic segments must use one slug name. Pick a single name for the level, e.g. `[slug]`.",
  },
  PAGES_ROUTER_FORBIDDEN: {
    rule: "ASI-STACK-1",
    fix_hint:
      "AGENTS.md forbids the Pages Router. Move the file into the App Router tree under `app/`.",
  },
  WRITE_PATH_FORBIDDEN: {
    rule: "ASI-ONE-WRITER",
    fix_hint:
      "Agora never mutates Krater. Send the write to the Worker at a.asimposium.org via a signed service envelope.",
  },
};

const HTTP_METHOD_EXPORTS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

/** Methods that mutate. Their presence in Agora is a doctrine violation. */
const WRITE_METHOD_EXPORTS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** https://nextjs.org/docs — route segment config, allowed alongside handlers. */
const ROUTE_SEGMENT_CONFIG_EXPORTS: ReadonlySet<string> = new Set([
  "dynamic",
  "dynamicParams",
  "revalidate",
  "fetchCache",
  "runtime",
  "preferredRegion",
  "maxDuration",
  "generateStaticParams",
]);

/**
 * The only write handlers Agora is permitted to expose, each with the reason it
 * is not a Krater write. Adding an entry here is a doctrine decision, not a
 * convenience: it belongs in a commit that a reviewer reads.
 */
export const WRITE_PATH_EXEMPTIONS: ReadonlyMap<string, string> = new Map([
  [
    "app/api/auth/[...nextauth]/route.ts",
    "Auth.js v5 OAuth callback and CSRF endpoint. Writes a host-only session cookie on the apex; never reaches D1 (Fable §14.1).",
  ],
]);

const FILE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"] as const;

/** Files that Next.js requires to have a default export. */
const DEFAULT_EXPORT_FILES = [
  "page",
  "layout",
  "template",
  "error",
  "loading",
  "not-found",
  "global-error",
] as const;

interface ExportSurface {
  names: ReadonlySet<string>;
  hasDefault: boolean;
}

function violation(code: ViolationCode, file: string, detail: string): Violation {
  const spec = RULES[code];
  return { code, rule: spec.rule, file, detail, fix_hint: spec.fix_hint };
}

function toPosix(relativePath: string): string {
  return relativePath.split(sep).join(posix.sep);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function findFile(dir: string, base: string): string | undefined {
  for (const ext of FILE_EXTENSIONS) {
    const candidate = join(dir, `${base}${ext}`);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not present; try the next extension.
    }
  }
  return undefined;
}

function collectBindingNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBindingNames(element.name, into);
  }
}

/**
 * Static export surface of a module. Resolves declarations, destructured
 * declarations (`export const { GET, POST } = handlers`) and export clauses.
 * Type-only exports are erased and therefore ignored.
 */
export function readExportSurface(source: string, fileName: string): ExportSurface {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    true,
    fileName.endsWith(".tsx") || fileName.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const names = new Set<string>();
  let hasDefault = false;

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      // `export default <expr>`; `export = <expr>` is CommonJS, not a default.
      if (statement.isExportEquals !== true) hasDefault = true;
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          if (element.isTypeOnly) continue;
          if (element.name.text === "default") hasDefault = true;
          else names.add(element.name.text);
        }
      }
      continue;
    }

    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    const exported = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;

    if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      hasDefault = true;
      continue;
    }

    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name) names.add(statement.name.text);
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names);
      }
      continue;
    }

    if (ts.isEnumDeclaration(statement)) {
      names.add(statement.name.text);
    }
    // Interfaces and type aliases are erased at runtime; not route exports.
  }

  return { names, hasDefault };
}

/** `[id]` → `id`, `[...slug]` → `slug`, `[[...slug]]` → `slug`. */
function dynamicSlugName(segment: string): string | undefined {
  const match = /^\[{1,2}(?:\.\.\.)?([^\]]+)\]{1,2}$/.exec(segment);
  return match?.[1];
}

function checkDefaultExport(
  filePath: string,
  relative: string,
  kind: string,
  out: Violation[],
): void {
  const surface = readExportSurface(readFileSync(filePath, "utf8"), filePath);
  if (!surface.hasDefault) {
    out.push(
      violation(
        "MISSING_DEFAULT_EXPORT",
        relative,
        `\`${kind}\` has no default export; Next.js cannot render this segment.`,
      ),
    );
  }
}

function checkRouteFile(filePath: string, relative: string, out: Violation[]): void {
  const surface = readExportSurface(readFileSync(filePath, "utf8"), filePath);

  const methods: string[] = [];
  for (const name of surface.names) {
    if (HTTP_METHOD_EXPORTS.has(name)) {
      methods.push(name);
      continue;
    }
    if (ROUTE_SEGMENT_CONFIG_EXPORTS.has(name)) continue;
    out.push(
      violation(
        "INVALID_ROUTE_EXPORT",
        relative,
        `Route file exports \`${name}\`, which is neither an HTTP method nor route segment config.`,
      ),
    );
  }

  if (methods.length === 0) {
    out.push(
      violation(
        "EMPTY_ROUTE_HANDLERS",
        relative,
        "Route file exports no HTTP method; every request to this segment 405s.",
      ),
    );
    return;
  }

  const writes = methods.filter((m) => WRITE_METHOD_EXPORTS.has(m)).sort();
  if (writes.length > 0 && !WRITE_PATH_EXEMPTIONS.has(relative)) {
    out.push(
      violation(
        "WRITE_PATH_FORBIDDEN",
        relative,
        `Agora exposes write handler(s) ${writes.join(", ")}; the Worker on a.asimposium.org is the only writer.`,
      ),
    );
  }
}

function walkSegment(dir: string, relativeDir: string, out: Violation[]): void {
  const entries = readdirSync(dir, { withFileTypes: true });

  const pageFile = findFile(dir, "page");
  const routeFile = findFile(dir, "route");

  if (pageFile && routeFile) {
    out.push(
      violation(
        "ROUTE_PAGE_COLLISION",
        toPosix(join("app", relativeDir, "route.ts")),
        "This segment defines both a page and a route handler; Next.js cannot resolve it.",
      ),
    );
  }

  for (const base of DEFAULT_EXPORT_FILES) {
    const file = findFile(dir, base);
    if (file) {
      checkDefaultExport(file, toPosix(relativeToRoot(file, dir, relativeDir)), base, out);
    }
  }

  if (routeFile) {
    checkRouteFile(routeFile, toPosix(relativeToRoot(routeFile, dir, relativeDir)), out);
  }

  const dynamicNames = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name === "node_modules" || name.startsWith(".")) continue;
    // `_private` folders are excluded from routing; `@slot` parallel routes
    // form their own level and do not collide with sibling dynamic segments.
    if (!name.startsWith("_") && !name.startsWith("@")) {
      const slug = dynamicSlugName(name);
      if (slug) dynamicNames.add(slug);
    }
    if (name.startsWith("_")) continue;
    walkSegment(join(dir, name), join(relativeDir, name), out);
  }

  if (dynamicNames.size > 1) {
    out.push(
      violation(
        "DUPLICATE_DYNAMIC_SEGMENT",
        toPosix(relativeDir === "" ? "app" : join("app", relativeDir)),
        `Sibling dynamic segments use different slug names: ${[...dynamicNames].sort().join(", ")}.`,
      ),
    );
  }
}

function relativeToRoot(filePath: string, dir: string, relativeDir: string): string {
  const fileName = filePath.slice(dir.length + 1);
  return join("app", relativeDir, fileName);
}

/**
 * Validate an App Router tree. `appDir` is the absolute path to `app/`; every
 * returned `file` is relative to the package root and starts with `app/`.
 */
export function validateAppRouterTree(appDir: string): Violation[] {
  const out: Violation[] = [];

  if (!isDirectory(appDir)) {
    out.push(violation("MISSING_APP_DIR", "app", "No `app/` directory in this package."));
    return out;
  }

  if (!findFile(appDir, "layout")) {
    out.push(
      violation(
        "MISSING_ROOT_LAYOUT",
        "app/layout.tsx",
        "The App Router requires a root layout; without it every route 404s at build time.",
      ),
    );
  }

  walkSegment(appDir, "", out);
  return out;
}

/**
 * Validate a whole Agora package: stack doctrine plus the App Router tree.
 */
export function validateAgoraPackage(packageDir: string): Violation[] {
  const out: Violation[] = [];

  for (const pagesDir of ["pages", join("src", "pages")]) {
    if (isDirectory(join(packageDir, pagesDir))) {
      out.push(
        violation(
          "PAGES_ROUTER_FORBIDDEN",
          toPosix(pagesDir),
          "Pages Router directory present; AGENTS.md fixes Agora on the App Router.",
        ),
      );
    }
  }

  out.push(...validateAppRouterTree(join(packageDir, "app")));
  return out;
}

/** Human-readable failure text. Contains no absolute paths by construction. */
export function formatViolations(violations: readonly Violation[]): string {
  if (violations.length === 0) return "no violations";
  return violations
    .map((v) => `${v.code} [${v.rule}] ${v.file}: ${v.detail} — fix: ${v.fix_hint}`)
    .join("\n");
}
