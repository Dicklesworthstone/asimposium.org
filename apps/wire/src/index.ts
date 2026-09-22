import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { createApp } from "./app";
import type { Env } from "./env";
import { deliverHeraldRooms } from "./herald/outbox";
import { HeraldRoom } from "./herald/room";
import { heraldRoomFetch, type HeraldRuntimeEnv, scheduleHeraldDelivery } from "./herald/runtime";
import { publicWatchFetch } from "./http/public-watch-cors";
import { deliverInboxEvents } from "./inbox/event-delivery";
import {
  artifactPublicationFetch,
  reconcileArtifactPublications,
} from "./krater/artifact-publication-runtime";
import { artifactFetch } from "./krater/artifact-runtime";
import { KraterOutboxDrainer, requestKraterOutbox } from "./krater/outbox-do";
import { expireIdleSessions } from "./sessions/idle";

/**
 * The Worker entrypoint: `a.asimposium.org`.
 *
 * The app is built once at module scope so route construction is not paid per
 * request, and the handler is a thin, typed adapter over it.
 */
const app = createApp();

export default {
  async fetch(request: Request, env: HeraldRuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    // Preserve the provider's 101/WebSocket capability outside ordinary CORS
    // response reconstruction. Internal room nudges never enter this gateway.
    const response = await heraldRoomFetch(request, env, () =>
      publicWatchFetch(request, () =>
        artifactPublicationFetch(request, env, () =>
          artifactFetch(request, env, () => app.fetch(request, env, ctx)),
        ),
      ),
    );
    scheduleHeraldDelivery(request, response, env, ctx);
    return response;
  },
  async scheduled(
    _controller: ScheduledController,
    env: HeraldRuntimeEnv,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // Apply 0078 before enabling HERALD_ROOMS. Each consumer runs even if
    // another is down; all outcomes are observed before reporting failure.
    const [sessions, outbox, inbox, artifacts, herald] = await Promise.allSettled([
      Promise.resolve().then(() => expireIdleSessions(env.DB)),
      Promise.resolve().then(() => requestKraterOutbox(env, "/nudge")),
      Promise.resolve().then(() => deliverInboxEvents(env.DB)),
      Promise.resolve().then(() => reconcileArtifactPublications(env)),
      Promise.resolve().then(() => deliverHeraldRooms(env.DB, env.HERALD_ROOMS)),
    ]);
    if (inbox.status === "fulfilled") {
      console.info(JSON.stringify({ stage: "inbox-event-delivery", ...inbox.value }));
    }
    if (artifacts.status === "fulfilled") {
      console.info(JSON.stringify({ stage: "artifact-publication-delivery", ...artifacts.value }));
    }
    if (herald.status === "fulfilled" && herald.value.enabled) {
      console.info(JSON.stringify({ stage: "herald-room-delivery", ...herald.value }));
    }
    if (sessions.status === "rejected") throw new Error("SESSION_IDLE_SWEEP_FAILED");
    if (outbox.status === "rejected" || !outbox.value.ok) {
      throw new Error("KRATER_OUTBOX_SCHEDULED_RECONCILE_FAILED");
    }
    if (inbox.status === "rejected" || inbox.value.failed > 0) {
      throw new Error("INBOX_EVENT_DELIVERY_FAILED");
    }
    if (artifacts.status === "rejected" || artifacts.value.retry > 0 || artifacts.value.lost > 0) {
      throw new Error("ARTIFACT_PUBLICATION_DELIVERY_INCOMPLETE");
    }
    if (herald.status === "rejected" || herald.value.retry > 0) {
      throw new Error("HERALD_ROOM_DELIVERY_INCOMPLETE");
    }
  },
};

export type { Env };
export { createApp, KraterOutboxDrainer, HeraldRoom };
