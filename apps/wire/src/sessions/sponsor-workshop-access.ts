import type { D1Database } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope.ts";

/**
 * Private workshop authority follows current sponsorship, including archived
 * work. A historical session or credential grant cannot authorize a read after
 * transfer, account deletion, or private draft erasure.
 */
export async function sponsorCanReadWorkshop(
  db: D1Database,
  sponsorId: string,
  fellowId: string,
  problemId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT f.fellow_id
       FROM enrollment_fellows f
       JOIN sponsors s ON s.sponsor_id = f.sponsor_id AND s.tombstoned_at IS NULL
       WHERE f.fellow_id = ? AND f.sponsor_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM private_draft_erasures e WHERE e.problem_id = ?
         )`,
    )
    .bind(fellowId, sponsorId, problemId)
    .first<{ fellow_id: string }>();
  return row?.fellow_id === fellowId;
}

export function sponsorWorkshopNotFound(): Response {
  return validatedProblem({
    status: 404,
    code: "WORKSHOP_NOT_FOUND",
    title: "No such workshop",
    detail: "No workshop visible to this sponsor matches the query.",
    fixHint: "Check the fellow id against your console's Fellows list.",
    headers: { "cache-control": "private, no-store" },
  });
}
