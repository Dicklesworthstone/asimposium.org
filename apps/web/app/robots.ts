import type { MetadataRoute } from "next";

/**
 * §8.3 presentation commitments: robots rules exclude unlisted/private and
 * auth routes. The public reading faces stay crawlable; sponsor surfaces and
 * machine APIs never are. A partitioned sitemap lands with Agora's public
 * ledger pages in W8; the current Stoa-only digests do not create HTML URLs
 * for this hostname to advertise.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/console", "/approve", "/auth/", "/api/"],
      },
    ],
  };
}
