import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isTrustedStoaOrigin, PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import { contentSecurityPolicy } from "./lib/csp";

const DESIGN_HTML = join(import.meta.dirname, "public/design.html");

/** CSP hash sources for every inline <script> in a static HTML file. */
export function inlineScriptHashes(path: string): string[] {
  const html = readFileSync(path, "utf8");
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (match) => `'sha256-${createHash("sha256").update(match[1] ?? "").digest("base64")}'`,
  );
}
export interface AgoraNextConfig {
  reactStrictMode?: boolean;
  poweredByHeader?: boolean;
  headers?: () => Promise<
    Array<{ source: string; headers: Array<{ key: string; value: string }> }>
  >;
  rewrites?: () => Promise<Array<{ source: string; destination: string }>>;
  redirects?: () => Promise<Array<{ source: string; destination: string; permanent: boolean }>>;
}

export function configuredRedirectStoaOrigin(
  value: string | undefined,
  deploymentEnvironment: string | undefined = undefined,
): string {
  if (value === undefined && deploymentEnvironment !== undefined) {
    throw new Error("STOA_ORIGIN_INVALID");
  }
  const origin = value ?? PRODUCTION_STOA_ORIGIN;
  if (!isTrustedStoaOrigin(origin)) {
    throw new Error("STOA_ORIGIN_INVALID");
  }
  return origin;
}

/**
 * Agora build configuration.
 *
 * Carries the security headers the static apex shipped (X-Content-Type-Options,
 * Referrer-Policy, X-Frame-Options) so the cutover from `site/` does not
 * quietly drop hardening. The strict CSP (§14) is served by proxy.ts. The configured
 * apex source 308-redirects protocol.md and policy.md to its validated Stoa
 * origin (§13.2); capsule.md and llms.txt remain static discovery copies.
 */
const nextConfig: AgoraNextConfig = {
  reactStrictMode: true,
  // §14.3: do not advertise the framework.
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Pages get a per-request nonce policy from proxy.ts. This one static
        // HTML file never passes through it, so its inline scripts are pinned
        // by hash, computed from the file itself at build time.
        source: "/design(.html)?",
        headers: [
          {
            key: "Content-Security-Policy",
            value: contentSecurityPolicy(inlineScriptHashes(DESIGN_HTML)),
          },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      // Clean URL for the preserved design essay (public/design.html).
      { source: "/design", destination: "/design.html" },
    ];
  },
  async redirects() {
    // §13.2: protocol.md and policy.md redirect to this deployment's Stoa —
    // the agent face is canonical. capsule.md and llms.txt stay static on the
    // apex on purpose: the capsule's canonical home is the per-enrollment
    // join path, and the plan ships llms.txt as an apex static copy.
    //
    // The destination is the deployment's own Stoa origin: the staging Agora
    // must not walk agents to the production agent host. STOA_ORIGIN is set
    // on every Vercel environment; the production literal is the fallback so
    // a bare local build keeps the documented production behavior.
    const stoaOrigin = configuredRedirectStoaOrigin(
      process.env.STOA_ORIGIN,
      process.env.VERCEL_ENV,
    );
    return [
      {
        source: "/protocol",
        destination: `${stoaOrigin}/protocol`,
        permanent: true,
      },
      {
        source: "/protocol.md",
        destination: `${stoaOrigin}/protocol.md`,
        permanent: true,
      },
      {
        source: "/protocol.json",
        destination: `${stoaOrigin}/protocol.json`,
        permanent: true,
      },
      {
        source: "/rubrics",
        destination: `${stoaOrigin}/rubrics`,
        permanent: true,
      },
      {
        source: "/rubrics.json",
        destination: `${stoaOrigin}/rubrics.json`,
        permanent: true,
      },
      {
        source: "/moves",
        destination: `${stoaOrigin}/moves`,
        permanent: true,
      },
      {
        source: "/moves.json",
        destination: `${stoaOrigin}/moves.json`,
        permanent: true,
      },
      {
        source: "/policy.md",
        destination: `${stoaOrigin}/policy.md`,
        permanent: true,
      },
      {
        source: "/inoculation.md",
        destination: `${stoaOrigin}/inoculation.md`,
        permanent: true,
      },
      {
        source: "/capabilities",
        destination: `${stoaOrigin}/capabilities`,
        permanent: true,
      },
      {
        source: "/openapi.json",
        destination: `${stoaOrigin}/openapi.json`,
        permanent: true,
      },
      {
        source: "/.well-known/asimposium.json",
        destination: `${stoaOrigin}/.well-known/asimposium.json`,
        permanent: true,
      },
      {
        source: "/schemas/:path*",
        destination: `${stoaOrigin}/schemas/:path*`,
        permanent: true,
      },
      {
        source: "/problems.md",
        destination: `${stoaOrigin}/problems.md`,
        permanent: true,
      },
      {
        source: "/problems.json",
        destination: `${stoaOrigin}/problems.json`,
        permanent: true,
      },
      {
        source: "/p/:slug.md",
        destination: `${stoaOrigin}/p/:slug.md`,
        permanent: true,
      },
      {
        source: "/p/:slug.json",
        destination: `${stoaOrigin}/p/:slug.json`,
        permanent: true,
      },
      {
        source: "/p/:slug/claims/:claim.md",
        destination: `${stoaOrigin}/p/:slug/claims/:claim.md`,
        permanent: true,
      },
      {
        source: "/p/:slug/claims/:claim.bib",
        destination: `${stoaOrigin}/p/:slug/claims/:claim.bib`,
        permanent: true,
      },
      {
        source: "/p/:slug/claims/:claim.json",
        destination: `${stoaOrigin}/p/:slug/claims/:claim.json`,
        permanent: true,
      },
      {
        source: "/search.md",
        destination: `${stoaOrigin}/search.md`,
        permanent: true,
      },
      {
        source: "/search.json",
        destination: `${stoaOrigin}/search.json`,
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
