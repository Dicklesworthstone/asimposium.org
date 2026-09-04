import { isTrustedStoaOrigin, PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import type { NextConfig } from "next";

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
 * quietly drop hardening. Strict CSP (§14.3) lands with W10. The configured
 * apex source 308-redirects protocol.md and policy.md to its validated Stoa
 * origin (§13.2); capsule.md and llms.txt remain static discovery copies.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // §14.3: do not advertise the framework.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
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
        source: "/protocol.md",
        destination: `${stoaOrigin}/protocol.md`,
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
