import {
  SPONSOR_WORKSHOP_ROOM_TICKET_MAX_RESPONSE_BYTES,
  SponsorIdSchema,
  SponsorWorkshopRoomTicketRequestSchema,
  SponsorWorkshopRoomTicketResponseSchema,
} from "@asimposium/contracts";
import { Hono } from "hono";
import { cancelUnconsumedRequestBody, parseExactJsonBytes } from "../auth/http.ts";
import type { Env } from "../env.ts";
import { liveWorkshopRoomHead, mintWorkshopRoomTicket } from "../herald/room-ticket.ts";
import { validatedProblem } from "../http/envelope.ts";
import type { SessionRouterOptions } from "./router-core.ts";
import { sponsorWorkshopNotFound } from "./sponsor-workshop-access.ts";

const ROUTE = "/v1/sponsors/workshop/room-ticket";
const SCHEMA = "https://a.asimposium.org/schemas/sessions.v1.json";
const MAX_REQUEST_BYTES = 2048;

function privateNoStore(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

function roomUnavailable(): Response {
  return validatedProblem({
    status: 503,
    code: "ROOM_UNAVAILABLE",
    title: "Live workshop room is temporarily unavailable",
    detail:
      "Live workshop room tickets cannot be minted right now. Same-origin workshop cursor polling remains available.",
    fixHint: "Fall back to GET /console/workshop/{fellow}/{problem}/cursor and retry shortly.",
    headers: { "cache-control": "private, no-store", "retry-after": "5" },
  });
}

function wsRoomUrl(
  stoaOrigin: string | undefined,
  fellowId: string,
  problemId: string,
): string | null {
  const base = stoaOrigin?.trim() || "https://a.asimposium.org";
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/v1/workshop-room";
  parsed.search = new URLSearchParams({ fellow: fellowId, problem: problemId }).toString();
  parsed.hash = "";
  return parsed.toString();
}

/** Mints a 60s single-use Ed25519 capability ticket bridging Agora's host-only
 * sponsor cookie to a private workshop DO room on Stoa (Fable §11, S-6).
 * Fails closed with 503 ROOM_UNAVAILABLE when HERALD_ROOMS or signing key is absent. */
export function createSponsorWorkshopRoomTicketRouter(
  options: Pick<SessionRouterOptions, "verifiedSponsor">,
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(() => roomUnavailable());

  app.post(ROUTE, async (c) => {
    let sponsorId: string;
    let rawBody: Uint8Array;
    try {
      const verified = await options.verifiedSponsor?.(c.req.raw, ROUTE, "workshop.read");
      if (verified instanceof Response) return privateNoStore(verified);
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
        return roomUnavailable();
      sponsorId = id;
      rawBody = new Uint8Array(bytes);
    } catch {
      return roomUnavailable();
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
    const request = SponsorWorkshopRoomTicketRequestSchema.safeParse(input);
    if (!request.success) {
      return privateNoStore(
        validatedProblem({
          status: 422,
          code: "WORKSHOP_READ_BODY_INVALID",
          title: "Invalid workshop room ticket request",
          detail:
            "The bounded signed JSON body must contain exactly problem_id and fellow_id, with no query parameters.",
          fixHint: "Send the problem and one of your own active Fellows in the signed JSON body.",
          rule: "A5",
          extensions: {
            schema: SCHEMA,
            example: { problem_id: "P-4DSP", fellow_id: "fellow-01JXYZ" },
          },
        }),
      );
    }
    const { problem_id: problemId, fellow_id: fellowId } = request.data;
    const head = await liveWorkshopRoomHead(c.env.DB, sponsorId, fellowId, problemId);
    if (head === null) return sponsorWorkshopNotFound();

    if (!c.env.HERALD_ROOMS) return roomUnavailable();
    const roomUrl = wsRoomUrl(c.env.STOA_ORIGIN, fellowId, problemId);
    if (roomUrl === null) return roomUnavailable();
    const minted = await mintWorkshopRoomTicket(
      { sponsorId, fellowId, problemId },
      c.env.CHECKPOINT_SIGNING_KEY,
    );
    if (minted === null) return roomUnavailable();

    // Recheck ownership right before releasing the ticket.
    const rechecked = await liveWorkshopRoomHead(c.env.DB, sponsorId, fellowId, problemId);
    if (rechecked === null) return sponsorWorkshopNotFound();

    const response = SponsorWorkshopRoomTicketResponseSchema.parse({
      schema: SCHEMA,
      sponsor_id: sponsorId,
      problem_id: problemId,
      fellow_id: fellowId,
      ticket: minted.ticket,
      expires_at: minted.expiresAt,
      workshop_cursor: rechecked.cursor,
      room_url: roomUrl,
    });
    const body = new TextEncoder().encode(JSON.stringify(response));
    if (body.byteLength > SPONSOR_WORKSHOP_ROOM_TICKET_MAX_RESPONSE_BYTES) return roomUnavailable();
    return new Response(body, {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        "content-type": "application/json; charset=utf-8",
        "content-length": String(body.byteLength),
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  });

  return app;
}
