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
 * quietly drop hardening. Strict CSP (§14.3) lands with W10; the apex `.md`
 * 308-redirects to `a.asimposium.org` (§13.2) land when the agent host
 * deploys — until then the texts are served from `public/`.
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
    // §13.2: once the agent host serves a text, the apex redirects there —
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
    ];
  },
};

export default nextConfig;
