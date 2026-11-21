/**
 * W12.7 DNS Cutover, Apex Static-Copy Drift, /install.sh Exemption & 308
 * Redirect Matrix CI Gate (`asimposiumorg-mmo`, ADR-2 & R-9).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import nextConfig, { configuredRedirectStoaOrigin } from "../apps/web/next.config.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

describe("W12.7 DNS Cutover, Apex Static Copies & 308 Redirect Matrix (asimposiumorg-mmo)", () => {
  test("apex static protocol copies exist and remain byte-identical to packages/protocol/assets/*", () => {
    const pairs: readonly [string, string][] = [
      ["apps/web/public/AGENTS.md", "packages/protocol/assets/handbook.md"],
      ["apps/web/public/llms.txt", "packages/protocol/assets/llms.txt"],
      ["apps/web/public/skill.md", "packages/protocol/assets/skill.md"],
      ["apps/web/public/capsule.md", "packages/protocol/assets/capsule.md"],
      ["apps/web/public/protocol.md", "packages/protocol/assets/protocol.md"],
      ["apps/web/public/policy.md", "packages/protocol/assets/policy.md"],
      ["apps/web/public/inoculation.md", "packages/protocol/assets/inoculation.md"],
    ];

    for (const [apexRel, protoRel] of pairs) {
      const apexPath = join(REPO_ROOT, apexRel);
      const protoPath = join(REPO_ROOT, protoRel);
      expect(existsSync(apexPath), `Missing apex static copy: ${apexRel}`).toBe(true);
      expect(existsSync(protoPath), `Missing canonical asset: ${protoRel}`).toBe(true);
      const apexBytes = readFileSync(apexPath, "utf8");
      const protoBytes = readFileSync(protoPath, "utf8");
      expect(apexBytes, `Static drift between ${apexRel} and ${protoRel}`).toBe(protoBytes);
    }

    // W11.5 canonical /install.sh lives on apex and is executable
    const installPath = join(REPO_ROOT, "apps/web/public/install.sh");
    expect(existsSync(installPath)).toBe(true);
    const mode = statSync(installPath).mode & 0o777;
    expect(mode & 0o111).toBeGreaterThan(0);
  });

  test("308 redirect matrix routes all documented content paths to the deployment Stoa origin and NEVER captures /install.sh, /AGENTS.md, /llms.txt, or /skill.md", async () => {
    const origStoa = process.env.STOA_ORIGIN;
    const origVercelEnv = process.env.VERCEL_ENV;
    try {
      // Production origin redirect check
      process.env.STOA_ORIGIN = "https://a.asimposium.org";
      process.env.VERCEL_ENV = "production";
      const prodRedirects = (await nextConfig.redirects?.()) ?? [];
      expect(prodRedirects.length).toBeGreaterThan(30);

      const bySource = new Map(prodRedirects.map((r) => [r.source, r]));
      const mustRedirectPaths = [
        "/protocol.md",
        "/protocol.json",
        "/policy.md",
        "/inoculation.md",
        "/capabilities",
        "/openapi.json",
        "/.well-known/asimposium.json",
        "/schemas/:path*",
        "/problems.md",
        "/problems.json",
        "/problems.toon",
        "/areas.md",
        "/areas.json",
        "/stats.md",
        "/stats.json",
        "/p/:slug.md",
        "/p/:slug.json",
        "/p/:slug/full.md",
        "/p/:slug/claims/:claim.md",
        "/search.md",
        "/search.json",
      ];
      for (const path of mustRedirectPaths) {
        const entry = bySource.get(path);
        expect(entry, `Missing 308 redirect for ${path}`).toBeDefined();
        expect(entry?.permanent).toBe(true);
        expect(entry?.destination).toBe(`https://a.asimposium.org${path}`);
      }

      // Apex-pinned static files MUST NOT be redirected
      for (const apexOnly of [
        "/install.sh",
        "/AGENTS.md",
        "/llms.txt",
        "/skill.md",
        "/capsule.md",
      ]) {
        expect(bySource.has(apexOnly), `Apex file ${apexOnly} must not be redirected`).toBe(false);
      }

      // Staging isolation: staging Agora redirects to a-staging.asimposium.org, NEVER production
      process.env.STOA_ORIGIN = "https://a-staging.asimposium.org";
      process.env.VERCEL_ENV = "preview";
      const stagingRedirects = (await nextConfig.redirects?.()) ?? [];
      for (const rule of stagingRedirects) {
        expect(rule.destination.startsWith("https://a-staging.asimposium.org/")).toBe(true);
        expect(rule.destination.includes("https://a.asimposium.org/")).toBe(false);
      }

      // Fail-closed: missing STOA_ORIGIN on Vercel deployment refuses build/start
      expect(() => configuredRedirectStoaOrigin(undefined, "production")).toThrow(
        "STOA_ORIGIN_INVALID",
      );
      expect(() => configuredRedirectStoaOrigin("https://evil.example.com", "production")).toThrow(
        "STOA_ORIGIN_INVALID",
      );
    } finally {
      if (origStoa === undefined) delete process.env.STOA_ORIGIN;
      else process.env.STOA_ORIGIN = origStoa;
      if (origVercelEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = origVercelEnv;
    }
  });

  test("security headers, environments.toml ADR-2 topology, and W12.7 cutover ADR doc align", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    const headers = (await nextConfig.headers?.()) ?? [];
    const globalRule = headers.find((h) => h.source === "/(.*)");
    expect(globalRule).toBeDefined();
    const headerNames = new Set((globalRule?.headers ?? []).map((h) => h.key));
    expect(headerNames.has("X-Content-Type-Options")).toBe(true);
    expect(headerNames.has("X-Frame-Options")).toBe(true);
    expect(headerNames.has("Referrer-Policy")).toBe(true);

    const envToml = readFileSync(join(REPO_ROOT, "infra/environments.toml"), "utf8");
    expect(envToml).toContain('production_artifact_hostname = "artifacts.asimposium.org"');
    expect(envToml).toContain('production = "https://a.asimposium.org"');
    expect(envToml).toContain('production = "https://asimposium.org"');
    expect(envToml).toContain('preview_environment = "staging"');

    const adrDoc = readFileSync(
      join(REPO_ROOT, "docs/ops/w12-7-dns-cutover-and-vercel-plan.md"),
      "utf8",
    );
    expect(adrDoc).toContain("DNS-only (grey cloud)");
    expect(adrDoc).toContain("Vercel Hobby");
    expect(adrDoc).toContain("Vercel Pro ($20/month)");
    expect(adrDoc).toContain("NEVER** enable Managed Challenge");
  });
});
