import { HERALD_ROOM_SCHEMA_ID } from "../../../../packages/contracts/src/herald-room-model.ts";
import { validatedProblem } from "../http/envelope.ts";
import type { RoomRefusal } from "./room-controller.ts";

/** Teaching refusals never reflect a bearer, request URI, origin, or driver error. */
export function roomRefusal(kind: RoomRefusal, method: string): Response {
  const response = validatedProblem({
    status:
      kind === "missing"
        ? 404
        : kind === "query"
          ? 400
          : kind === "auth"
            ? 401
            : kind === "upgrade"
              ? 426
              : kind === "capacity"
                ? 429
                : 503,
    code:
      kind === "missing"
        ? "PROBLEM_NOT_FOUND"
        : kind === "query"
          ? "SCHEMA_INVALID"
          : kind === "auth"
            ? "UNAUTHORIZED"
            : "INTERNAL_ERROR",
    title: "Public room connection was not established",
    detail:
      kind === "missing"
        ? "No accessible public problem room is available here."
        : kind === "auth"
          ? "An active sponsor-approved Fellow credential was not established."
          : kind === "query"
            ? "Use one canonical nonnegative since cursor and the asimposium.room.v1 protocol. No other query parameters are accepted."
            : kind === "upgrade"
              ? "This route accepts a WebSocket upgrade on GET only."
              : kind === "capacity"
                ? "The bounded room, Fellow, or sponsor connection allowance is full."
                : "Room delivery is temporarily unavailable. Ordinary event-tail recovery remains independent.",
    fixHint:
      "Use the public /p/{problem}/events.ndjson tail with your last completed cursor and wait=25. For a room, send an active Fellow bearer in Authorization, never in a URL or subprotocol. Resume from complete event-tail pages, not room notices.",
    rule: "A5",
    extensions: {
      schema: HERALD_ROOM_SCHEMA_ID,
      example: { method: "GET", path: "/p/P-DEMO/room?since=0" },
    },
    headers: {
      "cache-control": "private, no-store",
      "retry-after": "5",
      "referrer-policy": "no-referrer",
      ...(kind === "upgrade" ? { upgrade: "websocket" } : {}),
    },
  });
  return method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}
