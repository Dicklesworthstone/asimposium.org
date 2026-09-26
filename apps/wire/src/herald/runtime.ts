import { roomName } from "../../../../packages/contracts/src/herald-room-model.ts";
import type { Env } from "../env.ts";
import { deliverHeraldRooms, type HeraldNamespace } from "./outbox.ts";
import { publicRoomRoute } from "./room-controller.ts";
import { roomRefusal } from "./room-http.ts";

/** Optional at the application boundary: legacy environments keep HTTP reads
 * and writes working while rollout applies 0078 and binds the exported room. */
export type HeraldRuntimeEnv = Env & { readonly HERALD_ROOMS?: HeraldNamespace };

/** Every schema object migration 0078 creates. Without them a room would
 * accept connections that no write ever wakes (Rule A4: no fake liveness), so
 * the upgrade fails closed until the migration is applied. */
export const HERALD_ROOM_SCHEMA_OBJECTS = [
  ["table", "herald_room_outbox"],
  ["index", "herald_room_outbox_pending"],
  ["trigger", "herald_room_problem_insert"],
  ["trigger", "herald_room_problem_change"],
  ["trigger", "herald_room_content_insert"],
  ["trigger", "herald_room_content_redaction"],
  ["trigger", "herald_room_content_delete"],
] as const;

// Positive results only: a database that gains 0078 is picked up on the next
// upgrade, and a schema never loses it outside a restore (which restarts).
const heraldSchemaReady = new WeakSet<object>();

export async function heraldRoomSchemaReady(db: Env["DB"]): Promise<boolean> {
  if (heraldSchemaReady.has(db)) return true;
  const placeholders = HERALD_ROOM_SCHEMA_OBJECTS.map(() => "(type = ? AND name = ?)").join(" OR ");
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE ${placeholders}`)
    .bind(...HERALD_ROOM_SCHEMA_OBJECTS.flat())
    .first<{ n: number }>();
  const ready = row?.n === HERALD_ROOM_SCHEMA_OBJECTS.length;
  if (ready) heraldSchemaReady.add(db);
  return ready;
}

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
    if (!(await heraldRoomSchemaReady(env.DB))) {
      console.warn("HERALD_ROOM_SCHEMA_MISSING");
      return roomRefusal("unavailable", request.method);
    }
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
    ["GET", "HEAD", "OPTIONS"].includes(request.method) ||
    response.status < 200 ||
    response.status >= 300 ||
    !env.HERALD_ROOMS
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
