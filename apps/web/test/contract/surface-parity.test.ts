/**
 * Surface-Parity Matrix contract gate (Rule A1 / Diptych, Fable §13.2).
 *
 * Verifies every entry in `PUBLIC_RESOURCE_REGISTRY` against:
 * 1. `apps/web/next.config.ts` 308 redirects (every registered agent face suffix
 *    redirects to the configured Stoa origin).
 * 2. `apps/web/app/` (every registered human route key resolves to a real
 *    App Router `page.tsx` file, and no human HTML page is shadowed by a redirect).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { PUBLIC_RESOURCE_REGISTRY } from "@asimposium/contracts";
import nextConfig from "../../next.config";

const PACKAGE_DIR = dirname(dirname(import.meta.dir));
const APP_DIR = join(PACKAGE_DIR, "app");

/** Normalize parameterized route segments (`:id`, `:slug`, `[slug]`, `[...path]`) to a shared token. */
function normalizeRouteShape(route: string): string {
  const withoutQuery = route.split("?")[0] ?? route;
  return withoutQuery
    .replace(/@:[A-Za-z0-9_]+/g, "")
    .replace(/:\w+(?=\.|\/|$)/g, ":param")
    .replace(/\[\.\.\.[A-Za-z0-9_]+\]/g, ":catchall")
    .replace(/\[[A-Za-z0-9_]+\]/g, ":param");
}

function collectAppRoutes(dir: string, prefix = ""): string[] {
  const routes: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      routes.push(...collectAppRoutes(full, `${prefix}/${entry}`));
    } else if (entry === "page.tsx") {
      routes.push(prefix === "" ? "/" : prefix);
    }
  }
  return routes;
}

function appRouteExists(humanRouteKey: string, appRoutes: readonly string[]): boolean {
  const normalizedTarget = normalizeRouteShape(humanRouteKey);
  const targetSegments = normalizedTarget.split("/").filter(Boolean);
  return appRoutes.some((route) => {
    const routeSegments = normalizeRouteShape(route).split("/").filter(Boolean);
    for (let i = 0; i < routeSegments.length; i++) {
      if (routeSegments[i] === ":catchall") {
        return i <= targetSegments.length;
      }
      if (routeSegments[i] !== targetSegments[i]) {
        return false;
      }
    }
    return routeSegments.length === targetSegments.length;
  });
}

describe("Diptych Surface-Parity Matrix (PUBLIC_RESOURCE_REGISTRY x Agora x 308 redirects)", () => {
  test("every registered agent suffix face has a permanent 308 redirect to Stoa", async () => {
    const originalOrigin = process.env.STOA_ORIGIN;
    try {
      process.env.STOA_ORIGIN = "https://a-staging.asimposium.org";
      expect(typeof nextConfig.redirects).toBe("function");
      const redirects = await nextConfig.redirects!();
      const redirectMap = new Map(
        redirects.map((rule) => [normalizeRouteShape(rule.source), rule]),
      );

      for (const entry of PUBLIC_RESOURCE_REGISTRY) {
        const basePath = entry.agent_markdown_url
          .split("?")[0]!
          .replace(/\.md$/, "");
        for (const suffix of entry.allowed_suffixes) {
          // Bare human HTML routes without `.html` are served by Agora, not redirected.
          if (suffix === ".html" && entry.html_url && !entry.html_url.endsWith(".html")) {
            continue;
          }
          const candidatePath = `${basePath}${suffix}`;
          const normalized = normalizeRouteShape(candidatePath);
          const matched = redirectMap.get(normalized);
          expect(matched, `Missing apex 308 redirect for ${entry.kind} (${candidatePath})`).toBeDefined();
          expect(matched?.permanent).toBe(true);
          expect(matched?.destination.startsWith("https://a-staging.asimposium.org/")).toBe(true);
        }
      }
    } finally {
      if (originalOrigin === undefined) delete process.env.STOA_ORIGIN;
      else process.env.STOA_ORIGIN = originalOrigin;
    }
  });

  test("every registered human_route_key maps to a real Agora App Router page.tsx", () => {
    expect(existsSync(APP_DIR)).toBe(true);
    const appRoutes = collectAppRoutes(APP_DIR);

    for (const entry of PUBLIC_RESOURCE_REGISTRY) {
      // full-pack is an agent-only `.md` download surface (human_route_key === /p/:id/full.md).
      if (entry.human_route_key.endsWith(".md")) continue;
      expect(
        appRouteExists(entry.human_route_key, appRoutes),
        `Missing Agora page.tsx for ${entry.kind} (${entry.human_route_key})`,
      ).toBe(true);
    }
  });

  test("no bare human HTML App Router page is shadowed by a Stoa redirect", async () => {
    const appRoutes = collectAppRoutes(APP_DIR);
    const redirects = await nextConfig.redirects!();
    const redirectShapes = new Set(redirects.map((r) => normalizeRouteShape(r.source)));

    for (const route of appRoutes) {
      const normalized = normalizeRouteShape(route);
      expect(
        redirectShapes.has(normalized),
        `Agora human page ${route} is shadowed by a next.config.ts redirect`,
      ).toBe(false);
    }
  });
});
