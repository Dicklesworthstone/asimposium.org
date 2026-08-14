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
      /**
       * Ownership, not availability. Writes belong to the Worker and never to
       * Agora — that is architecture and is true today. Whether any write route
       * answers is a separate fact, and it is currently false: the Worker
       * serves only its own health face. Rule A4 forbids collapsing the two,
       * because "writes accepted at <url>" reads as a live endpoint.
       */
      writes_owned_by: SITE.stoa,
      writes_live: false,
      ledger_live: false,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
