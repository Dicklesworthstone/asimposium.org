import { roomName } from "../../../../packages/contracts/src/herald-room-model.ts";
import type { Env } from "../env.ts";
import { deliverHeraldRooms, type HeraldNamespace } from "./outbox.ts";
import { publicRoomRoute } from "./room-controller.ts";
import { roomRefusal } from "./room-http.ts";

/** Optional at the application boundary: legacy environments keep HTTP reads
 * and writes working while rollout applies 0078 and binds the exported room. */
export type HeraldRuntimeEnv = Env & { readonly HERALD_ROOMS?: HeraldNamespace };

/** Must run OUTSIDE response-rebuilding CORS middleware: a 101 carries the
 * provider's WebSocket capability, not an ordinary response body. Internal DO
 * nudge paths are never forwarded from the public Worker. */
export async function heraldRoomFetch(
  request: Request,
  env: HeraldRuntimeEnv,
  next: () => Response | Promise<Response>,
): Promise<Response> {
  const problem = publicRoomRoute(new URL(request.url).pathname);
  if (problem === undefined) return next();
  if (request.method !== "GET") return roomRefusal("upgrade", request.method);
  try {
    if (!env.HERALD_ROOMS) return roomRefusal("unavailable", request.method);
    return await env.HERALD_ROOMS.get(env.HERALD_ROOMS.idFromName(roomName(problem))).fetch(
      request,
    );
  } catch {
    return roomRefusal("unavailable", request.method);
  }
}

/** Normal writes promptly drain a bounded page; the durable queue plus the
 * existing scheduled sweep recovers a lost waitUntil or process interruption. */
export function scheduleHeraldDelivery(
  request: Request,
  response: Response,
  env: HeraldRuntimeEnv,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): void {
  if (
    !env.HERALD_ROOMS ||
    ["GET", "HEAD", "OPTIONS"].includes(request.method) ||
    response.status < 200 ||
    response.status >= 300
  )
    return;
  try {
    ctx.waitUntil(
      deliverHeraldRooms(env.DB, env.HERALD_ROOMS)
        .then((result) => {
          if (result.retry > 0)
            console.warn(JSON.stringify({ stage: "herald-room-delivery", ...result }));
        })
        .catch(() => {
          console.warn("HERALD_ROOM_DELIVERY_DEFERRED");
        }),
    );
  } catch {
    /* A committed write remains successful; the scheduled sweep retries. */
  }
}
