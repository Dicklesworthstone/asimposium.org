import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

/**
 * §8.3 presentation commitments: robots rules exclude unlisted/private and
 * auth routes. The public reading faces stay crawlable; sponsor surfaces and
 * machine APIs never are.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/console",
          "/approve",
          "/auth/",
          "/api/",
          "/admin/",
          "/moderation/",
        ],
      },
    ],
    sitemap: `${SITE.agora.replace(/\/+$/, "")}/sitemap.xml`,
  };
}
