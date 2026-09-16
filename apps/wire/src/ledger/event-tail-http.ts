import {
  EVENT_TAIL_MAX_BYTES,
  type EventTailPage,
  renderEventTail,
} from "../../../../packages/contracts/src/event-tail-model.ts";

/** The complete bounded page is validated before response construction. A
 * connection cut before page_end is incomplete, never an empty successful page.
 * Revalidation precedes ETag comparison so visibility/redaction always wins.
 */
export async function eventTailResponse(
  request: Request,
  page: EventTailPage,
  format: "json" | "ndjson",
  unlisted: boolean,
): Promise<Response> {
  const body = renderEventTail(page, format);
  const bytes = new TextEncoder().encode(body);
  if (bytes.byteLength > EVENT_TAIL_MAX_BYTES) throw new Error("EVENT_TAIL_RESPONSE_TOO_LARGE");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const etag = `"event-tail-${format}-${hash}"`;
  const headers = new Headers({
    "content-type": format === "json" ? "application/json; charset=utf-8" : "application/x-ndjson; charset=utf-8",
    "cache-control": unlisted ? "private, no-store" : "public, max-age=0, must-revalidate",
    "content-length": String(bytes.byteLength),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    etag,
  });
  if (unlisted) headers.set("x-robots-tag", "noindex, nofollow");
  const next = page.page_end.next?.replace("/events.json?", `/events.${format}?`);
  if (next) headers.set("link", `<${next}>; rel="next"`);
  const matched = request.headers.get("if-none-match")?.split(",").some((value) =>
    ["*", etag, `W/${etag}`].includes(value.trim()));
  if (matched) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
}
