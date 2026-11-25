import { FellowTokenSchema } from "@asimposium/contracts";
import type {
  WebSocketRequestResponsePair as AutoResponsePair,
  DurableObjectState,
  WebSocket as WorkerSocket,
} from "@cloudflare/workers-types";
import {
  roomCursor,
  roomName,
  workshopRoomName,
} from "../../../../packages/contracts/src/herald-room-model.ts";
import { D1EnrollmentStore } from "../enrollment/d1-store.ts";
import { HeraldRoomController } from "./room-controller.ts";
import { closeRoomSocket, type RoomSocket } from "./room-core.ts";
import { roomRefusal } from "./room-http.ts";
import { liveWorkshopRoomHead, verifyWorkshopRoomTicket } from "./room-ticket.ts";
import type { HeraldRuntimeEnv } from "./runtime.ts";

const GENERATION_KEY = "public-room-generation-v1";
const USED_TICKETS_KEY = "workshop-room-used-tickets-v1";
const MAX_STORED_NONCES = 256;
/** Explicit provider globals keep the Worker adapter out of the browser/Node
 * type universe. No provider class is imported as a runtime npm dependency. */
const host = globalThis as unknown as {
  WebSocketPair: new () => { 0: WorkerSocket; 1: WorkerSocket };
  WebSocketRequestResponsePair: new (request: string, response: string) => AutoResponsePair;
};

/** One exported hibernating Durable Object per public problem. D1 remains the
 * only scientific authority; storage holds just an idempotent wake generation. */
export class HeraldRoom {
  private readonly controller: HeraldRoomController;
  constructor(ctx: DurableObjectState, env: HeraldRuntimeEnv) {
    const store = new D1EnrollmentStore(env.DB);
    ctx.setWebSocketAutoResponse(new host.WebSocketRequestResponsePair("ping", "pong"));
    ctx.setHibernatableWebSocketEventTimeout(10_000);
    this.controller = new HeraldRoomController({
      db: env.DB,
      validToken: (token) => FellowTokenSchema.safeParse(token).success,
      authenticate: async (hash, now) => {
        // The SAME atomic lifecycle/profile/expiry/sponsor-panic authority used
        // by EnrollmentService. The room never reconstructs its own auth SQL.
        const binding = await store.authenticateCredential(hash, now, "bearer");
        return binding === undefined
          ? undefined
          : {
              fellowId: binding.fellowId,
              sponsorId: binding.sponsorId,
              ...(binding.grantedResources.problemBinding === undefined
                ? {}
                : { problemBinding: binding.grantedResources.problemBinding }),
            };
      },
      verifyWorkshopTicket: (ticket, now) =>
        verifyWorkshopRoomTicket(
          ticket,
          {
            signingKey: env.CHECKPOINT_SIGNING_KEY,
            verifyKeys: env.CHECKPOINT_VERIFY_KEYS,
          },
          now,
        ),
      workshopHead: (sponsorId, fellowId, problemId) =>
        liveWorkshopRoomHead(env.DB, sponsorId, fellowId, problemId),
      refuse: roomRefusal,
      port: {
        owns: (problem) =>
          env.HERALD_ROOMS !== undefined &&
          String(env.HERALD_ROOMS.idFromName(roomName(problem))) === ctx.id.toString(),
        ownsWorkshop: (fellowId, problemId) =>
          env.HERALD_ROOMS !== undefined &&
          String(env.HERALD_ROOMS.idFromName(workshopRoomName(fellowId, problemId))) ===
            ctx.id.toString(),
        sockets: () => ctx.getWebSockets(),
        accept: (socket, tags) => ctx.acceptWebSocket(socket as WorkerSocket, tags),
        lastPing: (socket) =>
          ctx.getWebSocketAutoResponseTimestamp(socket as WorkerSocket)?.getTime() ?? null,
        alarmAt: () => ctx.storage.getAlarm(),
        setAlarm: (at) => ctx.storage.setAlarm(at),
        deleteAlarm: () => ctx.storage.deleteAlarm(),
        generation: async () => (await ctx.storage.get<number>(GENERATION_KEY)) ?? 0,
        rememberGeneration: async (generation) => {
          // Concurrent older delivery cannot replace a newer idempotence mark.
          await ctx.storage.transaction(async (tx) => {
            const current = (await tx.get<number>(GENERATION_KEY)) ?? 0;
            if (!roomCursor(current)) throw new Error("HERALD_GENERATION_INVALID");
            if (generation > current) await tx.put(GENERATION_KEY, generation);
          });
        },
        consumeTicketNonce: async (nonce, expMs, now) => {
          let accepted = false;
          await ctx.storage.transaction(async (tx) => {
            const stored = (await tx.get<Record<string, number>>(USED_TICKETS_KEY)) ?? {};
            const active: Record<string, number> = {};
            for (const [key, expiresAt] of Object.entries(stored)) {
              if (typeof expiresAt === "number" && expiresAt > now) active[key] = expiresAt;
            }
            if (Object.hasOwn(active, nonce)) {
              accepted = false;
              return;
            }
            const keys = Object.keys(active);
            if (keys.length >= MAX_STORED_NONCES) {
              // Fail closed rather than evicting unexpired nonces under flood.
              accepted = false;
              return;
            }
            active[nonce] = expMs;
            await tx.put(USED_TICKETS_KEY, active);
            accepted = true;
          });
          return accepted;
        },
        pair: () => {
          const pair = new host.WebSocketPair();
          return { client: pair[0], server: pair[1] };
        },
        upgraded: (client, protocol) =>
          new Response(null, {
            status: 101,
            webSocket: client,
            headers: {
              "cache-control": "private, no-store",
              "referrer-policy": "no-referrer",
              ...(protocol === null ? {} : { "sec-websocket-protocol": protocol }),
            },
          } as ResponseInit & { webSocket: unknown }),
      },
    });
  }
  fetch(request: Request): Promise<Response> {
    return this.controller.fetch(request);
  }
  webSocketMessage(socket: WorkerSocket, message: string | ArrayBuffer): Promise<void> {
    return this.controller.webSocketMessage(socket, message);
  }
  webSocketClose(socket: WorkerSocket): void {
    closeRoomSocket(socket, 1000, "Room closed");
  }
  webSocketError(socket: RoomSocket): void {
    closeRoomSocket(socket, 1011, "Room unavailable; use event-tail recovery");
  }
  alarm(): Promise<void> {
    return this.controller.alarm();
  }
}
