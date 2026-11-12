import {
  SPONSOR_WORKSHOP_CURSOR_MAX_RESPONSE_BYTES,
  SponsorIdSchema,
  SponsorWorkshopCursorRequestSchema,
  SponsorWorkshopCursorResponseSchema,
} from "@asimposium/contracts";
import { Hono } from "hono";
import { cancelUnconsumedRequestBody, parseExactJsonBytes } from "../auth/http.ts";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import type { SessionRouterOptions } from "./router-core.ts";
import { sponsorCanReadWorkshop, sponsorWorkshopNotFound } from "./sponsor-workshop-access.ts";

const ROUTE = "/v1/sponsors/workshop/cursor";
const SCHEMA = "https://a.asimposium.org/schemas/sessions.v1.json";
const MAX_REQUEST_BYTES = 2048;

function privateNoStore(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

function unavailable(): Response {
  return validatedProblem({
    status: 503,
    code: "INTERNAL_ERROR",
    title: "Workshop updates are temporarily unavailable",
    detail: "The private workshop cursor could not be read safely.",
    fixHint: "Retry shortly. If this persists, report the time of the request.",
    headers: { "cache-control": "private, no-store", "retry-after": "5" },
  });
}

/** A signed sponsor read over the private covering index. Polling this route
 * never loads workshop bodies or private R2 objects. */
export function createSponsorWorkshopCursorRouter(
  options: Pick<SessionRouterOptions, "verifiedSponsor">,
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(() => unavailable());

  app.post(ROUTE, async (c) => {
    let sponsorId: string;
    let rawBody: Uint8Array;
    try {
      const verified = await options.verifiedSponsor?.(c.req.raw, ROUTE, "workshop.read");
      if (verified instanceof Response) return privateNoStore(verified);
      // Only the verifier's authenticated bytes and principal carry authority.
      const principal = verified?.principal;
      const type = principal?.type;
      const id = principal?.sponsorId;
      const bytes = verified?.rawBody;
      if (
        type !== "sponsor" ||
        typeof id !== "string" ||
        !SponsorIdSchema.safeParse(id).success ||
        !(bytes instanceof Uint8Array)
      )
        return unavailable();
      sponsorId = id;
      rawBody = new Uint8Array(bytes);
    } catch {
      return unavailable();
    } finally {
      cancelUnconsumedRequestBody(c.req.raw);
    }

    let input: unknown;
    try {
      input =
        new URL(c.req.url).search === "" && rawBody.byteLength <= MAX_REQUEST_BYTES
          ? parseExactJsonBytes(rawBody)
          : undefined;
    } catch {
      input = undefined;
    }
    const request = SponsorWorkshopCursorRequestSchema.safeParse(input);
    if (!request.success) {
      return privateNoStore(
        validatedProblem({
          status: 422,
          code: "WORKSHOP_READ_BODY_INVALID",
          title: "Invalid workshop cursor request",
          detail:
            "The bounded signed JSON body must contain exactly problem_id and fellow_id, with no query parameters.",
          fixHint: "Send the problem and one of your own Fellows in the signed JSON body.",
          rule: "A5",
          extensions: {
            schema: SCHEMA,
            example: { problem_id: "P-4DSP", fellow_id: "fellow-01JXYZ" },
          },
        }),
      );
    }
    const { problem_id: problemId, fellow_id: fellowId } = request.data;
    // The existing (fellow_id, problem_id, workshop_seq) covering index finds
    // the current head without materializing bodies, titles, or CAS references.
    const row = await c.env.DB.prepare(
      `SELECT f.fellow_id,
              (SELECT COALESCE(MAX(w.workshop_seq), 0)
               FROM workshop_objects w
               WHERE w.fellow_id = f.fellow_id AND w.problem_id = ?) AS workshop_cursor
       FROM enrollment_fellows f
       JOIN sponsors s ON s.sponsor_id = f.sponsor_id AND s.tombstoned_at IS NULL
       WHERE f.fellow_id = ? AND f.sponsor_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM private_draft_erasures e WHERE e.problem_id = ?
         )`,
    )
      .bind(problemId, fellowId, sponsorId, problemId)
      .first<{ fellow_id: string; workshop_cursor: number }>();
    if (row === null || row === undefined) return sponsorWorkshopNotFound();
    const response = SponsorWorkshopCursorResponseSchema.parse({
      schema: SCHEMA,
      sponsor_id: sponsorId,
      problem_id: problemId,
      fellow_id: fellowId,
      workshop_cursor: row.workshop_cursor,
    });
    const body = new TextEncoder().encode(JSON.stringify(response));
    if (body.byteLength > SPONSOR_WORKSHOP_CURSOR_MAX_RESPONSE_BYTES) return unavailable();
    if (!(await sponsorCanReadWorkshop(c.env.DB, sponsorId, fellowId, problemId))) {
      return sponsorWorkshopNotFound();
    }
    return new Response(body, {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        "content-type": "application/json; charset=utf-8",
        "content-length": String(body.byteLength),
      },
    });
  });
  return app;
}
