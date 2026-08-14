import type { NextConfig } from "next";

/**
 * Agora build configuration.
 *
 * Deliberately thin at OPS.1. Security headers (strict CSP, §14.3), image
 * domains, and the apex `.md` 308-redirects to `a.asimposium.org` (§13.2) land
 * with W8/W10, not here.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // §14.3: do not advertise the framework.
  poweredByHeader: false,
};

export default nextConfig;
