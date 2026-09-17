import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { createApp } from "./app";
import type { Env } from "./env";
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
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // Outbox downtime must not strand abandoned work slots. Observe both jobs
    // to completion even when one fails; neither failure is reported as success.
    const [sessions, outbox] = await Promise.allSettled([
      expireIdleSessions(env.DB),
      Promise.resolve().then(() => requestKraterOutbox(env, "/nudge")),
    ]);
    if (sessions.status === "rejected") throw new Error("SESSION_IDLE_SWEEP_FAILED");
    if (outbox.status === "rejected" || !outbox.value.ok) {
      throw new Error("KRATER_OUTBOX_SCHEDULED_RECONCILE_FAILED");
    }
  },
};

export type { Env };
export { createApp, KraterOutboxDrainer };
