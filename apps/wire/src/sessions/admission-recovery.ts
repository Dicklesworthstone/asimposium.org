import type { D1Database } from "@cloudflare/workers-types";
import {
  authenticatedFollowPrincipal,
  type FollowCredentialAuthority,
} from "../inbox/follow-principal.ts";
import { expireIdleSessions } from "./idle.ts";

/** Session admission must recover its own abandoned slots even if cron has
 * not run yet. The normal handler still owns request validation, replay and
 * admission. This only performs the same guarded maintenance as cron, scoped
 * to a freshly verified Fellow; headers/cookies can never choose another one.
 * It never consumes/clones the request body or extends an active session. */
export async function recoverIdleSessionSlots(
  request: Request,
  db: D1Database | undefined,
  authority: FollowCredentialAuthority,
): Promise<void> {
  if (
    request.method !== "POST" ||
    new URL(request.url).pathname !== "/v1/sessions" ||
    db === undefined ||
    !/^[A-Za-z0-9._-]{1,160}$/.test(request.headers.get("idempotency-key") ?? "")
  ) {
    return;
  }
  let fellowId: string | undefined;
  try {
    fellowId = await authenticatedFollowPrincipal(request, authority);
  } catch {
    return;
  }
  if (fellowId === undefined) return;
  await expireIdleSessions(db, { fellowId });
}
