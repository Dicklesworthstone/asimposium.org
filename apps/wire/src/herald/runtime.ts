import {
  roomName,
  workshopRoomName,
} from "../../../../packages/contracts/src/herald-room-model.ts";
import { SERVICE_ENVELOPE_HEADER } from "../auth/http.ts";
import type { Env } from "../env.ts";
import { deliverHeraldRooms, type HeraldNamespace } from "./outbox.ts";
import { publicRoomRoute, workshopRoomRoute } from "./room-controller.ts";
import { roomRefusal } from "./room-http.ts";

/** Optional at the application boundary: legacy environments keep HTTP reads
 * and writes working while rollout applies delivery migrations and binds the room. */
export type HeraldRuntimeEnv = Env & { readonly HERALD_ROOMS?: HeraldNamespace };

/** The ticket POST opens a read stream; it never changes scientific state. */
export function isWorkshopRoomStream(request: Request): boolean {
  return request.method === "POST" && new URL(request.url).pathname === "/v1/workshop-room";
}

function workshopStreamCors(request: Request, agoraOrigin: string | undefined): Headers | null {
  const origin = request.headers.get("origin");
  if (!origin || !agoraOrigin) return null;
  try {
    const configured = new URL(agoraOrigin);
    if (!["https:", "http:"].includes(configured.protocol) || origin !== configured.origin)
      return null;
  } catch {
    return null;
  }
  return new Headers({
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "cache-control": "private, no-store",
    vary: "Origin",
  });
}

/** The delivery objects and whole-problem moderation wake trigger. Without
 * them a room could accept connections that writes or privacy withdrawals
 * never wake, so upgrades fail closed until 0078 and 0157 are applied. */
export const HERALD_ROOM_SCHEMA_OBJECTS = [
  ["table", "herald_room_outbox"],
  ["index", "herald_room_outbox_pending"],
  ["trigger", "herald_room_problem_insert"],
  ["trigger", "herald_room_problem_change"],
  ["trigger", "herald_room_content_insert"],
  ["trigger", "herald_room_content_redaction"],
  ["trigger", "herald_room_content_delete"],
  ["trigger", "herald_room_content_control_insert"],
] as const;

// Positive results only: a database that gains the schema is picked up on the next
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
  const url = new URL(request.url);
  if (url.pathname === "/v1/workshop-room") {
    if (!["GET", "POST", "OPTIONS"].includes(request.method))
      return roomRefusal("upgrade", request.method);
    const cors =
      request.method === "GET" ? undefined : workshopStreamCors(request, env.AGORA_ORIGIN);
    if (cors === null) return roomRefusal("auth", request.method);
    const reply = (response: Response): Response => {
      if (cors === undefined) return response;
      const headers = new Headers(response.headers);
      cors.forEach((value, name) => {
        headers.set(name, value);
      });
      return new Response(response.body, { status: response.status, headers });
    };
    if (
      request.headers.has("cookie") ||
      request.headers.has("authorization") ||
      request.headers.has(SERVICE_ENVELOPE_HEADER) ||
      request.headers.has("x-fellow-id") ||
      request.headers.has("x-sponsor-id")
    ) {
      return reply(roomRefusal("auth", request.method));
    }
    const workshop = workshopRoomRoute(url);
    if (workshop === undefined) return reply(roomRefusal("query", request.method));
    if (request.method === "OPTIONS") {
      const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
        .split(",")
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean);
      if (
        request.headers.get("access-control-request-method") !== "POST" ||
        requestedHeaders.some((header) => header !== "content-type")
      )
        return roomRefusal("auth", request.method);
      return new Response(null, { status: 204, headers: cors });
    }
    try {
      if (!env.HERALD_ROOMS) return reply(roomRefusal("unavailable", request.method));
      const response = await env.HERALD_ROOMS.get(
        env.HERALD_ROOMS.idFromName(workshopRoomName(workshop.fellowId, workshop.problemId)),
      ).fetch(request);
      return reply(response);
    } catch {
      return reply(roomRefusal("unavailable", request.method));
    }
  }
  const problem = publicRoomRoute(url.pathname);
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
    isWorkshopRoomStream(request) ||
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
