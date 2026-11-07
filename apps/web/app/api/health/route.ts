import {
  planeStatusAtTime,
  planeStatusCacheControl,
  resolveCachedPlaneStatus,
} from "@/lib/plane-status";

/**
 * Environment-bound status face for Agora. It distinguishes the serving Agora
 * route, configured Stoa reachability, sponsor wiring, immutable artifact
 * bytes, and revision-bound research-write qualification evidence (Rule A4).
 * It reports configuration states, never configuration values or secrets.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const status = planeStatusAtTime(await resolveCachedPlaneStatus());
  return Response.json(status, {
    headers: {
      // The body contains only public coarse states. Browsers revalidate while
      // shared caches retain the response briefly; its full 30-second bound is
      // declared in the machine body. Readiness evidence can shorten that bound.
      "cache-control": planeStatusCacheControl(status),
    },
  });
}
