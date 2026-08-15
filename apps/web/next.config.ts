import type { NextConfig } from "next";

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
    return [
      {
        source: "/protocol.md",
        destination: "https://a.asimposium.org/protocol.md",
        permanent: true,
      },
      {
        source: "/policy.md",
        destination: "https://a.asimposium.org/policy.md",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
