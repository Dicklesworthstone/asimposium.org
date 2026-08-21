import type { MetadataRoute } from "next";

/**
 * §8.3 presentation commitments: robots rules exclude unlisted/private and
 * auth routes. The public reading faces stay crawlable; sponsor surfaces and
 * machine APIs never are. A partitioned sitemap lands with the public ledger
 * faces (W5+); until then there is deliberately none to advertise.
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
