import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";

import { D1EnrollmentStore } from "./d1-store.ts";
import { createEnrollmentRouter } from "./router.ts";
import { EnrollmentService } from "./service.ts";

interface LocalEnrollmentEnv {
  DB: D1Database;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function localBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Local-D1-only S-1 harness entrypoint. It is intentionally not imported by
 * `src/index.ts` or the production app. Its two setup routes exist solely to
 * drive a real workerd D1 binding through the mountable enrollment router.
 */
export default {
  async fetch(
    request: Request,
    env: LocalEnrollmentEnv,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const service = new EnrollmentService({ store: new D1EnrollmentStore(env.DB) });
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/__s1/mint") {
      const body = await localBody(request);
      if (body === undefined || typeof body.sponsor_id !== "string" || body.request === undefined) {
        return response({ code: "LOCAL_INPUT_INVALID" }, 400);
      }
      try {
        const minted = await service.mint(
          { type: "sponsor", sponsorId: body.sponsor_id },
          body.request as never,
        );
        return response(minted, 201);
      } catch {
        return response({ code: "LOCAL_MINT_FAILED" }, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/__s1/approve") {
      const body = await localBody(request);
      if (
        body === undefined ||
        typeof body.sponsor_id !== "string" ||
        typeof body.enrollment_id !== "string"
      ) {
        return response({ code: "LOCAL_INPUT_INVALID" }, 400);
      }
      try {
        await service.decide({ type: "sponsor", sponsorId: body.sponsor_id }, body.enrollment_id, {
          decision: "approve",
        });
        return response({ status: "approved" });
      } catch {
        return response({ code: "LOCAL_APPROVAL_FAILED" }, 400);
      }
    }

    return createEnrollmentRouter({ service }).fetch(request);
  },
};
