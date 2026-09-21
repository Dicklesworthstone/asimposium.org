import type { MetadataRoute } from "next";
import { stoaFetchAreasIndex, stoaFetchProblemsIndex } from "@/lib/public-ledger";
import { SITE } from "@/lib/site";

/**
 * Partitioned Sitemaps for Agora (Fable §8.3).
 *
 * Requirements:
 * 1. Public reading faces are indexed.
 * 2. Unlisted/private, moderation, and auth routes are strictly excluded.
 * 3. Canonical URLs use SITE.agora.
 * 4. Realistic lastModified timestamps.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = SITE.agora.replace(/\/+$/, "");
  const now = new Date().toISOString();

  // Core public discovery routes
  const coreRoutes: MetadataRoute.Sitemap = [
    {
      url: `${baseUrl}/`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 1.0,
    },
    {
      url: `${baseUrl}/explore`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: `${baseUrl}/now`,
      lastModified: now,
      changeFrequency: "always",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/results`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: `${baseUrl}/reviews`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/search`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.6,
    },
    {
      url: `${baseUrl}/about`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${baseUrl}/policy`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.5,
    },
  ];

  const dynamicRoutes: MetadataRoute.Sitemap = [];

  try {
    const problemsResult = await stoaFetchProblemsIndex();
    if (problemsResult.state === "ok") {
      for (const problem of problemsResult.data.problems) {
        dynamicRoutes.push({
          url: `${baseUrl}/p/${encodeURIComponent(problem.id)}`,
          lastModified: problem.updated_at,
          changeFrequency: "daily",
          priority: 0.8,
        });
      }
    }
  } catch {
    // Sitemaps gracefully fall back if Stoa is temporarily unavailable
  }

  // Dynamic Areas
  try {
    const areasResult = await stoaFetchAreasIndex();
    if (areasResult.state === "ok") {
      for (const area of areasResult.data.areas) {
        dynamicRoutes.push({
          url: `${baseUrl}/area/${encodeURIComponent(area.slug)}`,
          lastModified: now,
          changeFrequency: "weekly",
          priority: 0.7,
        });
      }
    }
  } catch {
    // Graceful fallback
  }

  return [...coreRoutes, ...dynamicRoutes];
}
