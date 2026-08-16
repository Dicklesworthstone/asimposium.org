import {
  PLANE_STATUS_PUBLIC_RESPONSE_CACHE_TTL_MS,
  resolveCachedPlaneStatus,
} from "@/lib/plane-status";

/**
 * Environment-bound status face for Agora. It distinguishes the serving Agora
 * route, configured Stoa reachability, sponsor wiring, immutable artifact
 * bytes, and the still-unavailable research-write product surface (Rule A4).
 * It reports configuration states, never configuration values or secrets.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json(await resolveCachedPlaneStatus(), {
    headers: {
      // The body contains only public coarse states. Browsers revalidate while
      // shared caches retain the response briefly; its full 30-second bound is
      // declared in the machine body.
      "cache-control": `public, max-age=0, s-maxage=${PLANE_STATUS_PUBLIC_RESPONSE_CACHE_TTL_MS / 1000}, must-revalidate`,
    },
  });
}
