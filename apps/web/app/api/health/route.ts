import { LAUNCH_STAGE, PLANE, SITE } from "@/lib/site";

/**
 * Liveness face for the Agora plane. Read-only by construction: it answers a
 * fixed, environment-independent description of which plane responded, and it
 * points writers at the Worker (Fable §14.1, "one writer").
 *
 * It reports no environment values, no build identifiers, and no dependency
 * health — an honest "this process is up", nothing more (Rule A4).
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(
    {
      plane: PLANE,
      stage: LAUNCH_STAGE,
      /** Every write in the system belongs to the Worker, not to Agora. */
      writes_accepted_at: SITE.stoa,
      ledger_live: false,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
