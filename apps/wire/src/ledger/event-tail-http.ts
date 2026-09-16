import {
  EVENT_TAIL_MAX_BYTES,
  type EventTailPage,
  renderEventTail,
} from "@asimposium/contracts/event-tail";

export interface ParsedToonEvent {
  id: string;
  seq: number;
  type: string;
  object_id: string;
  created_at: string;
}

export function parseEventTailToon(toon: string): {
  events: ParsedToonEvent[];
  control: { control: "page_end"; next_cursor: number; has_more: boolean };
} {
  const lines = toon.trimEnd().split("\n");
  if (lines.length < 2) throw new Error("TOON missing header or footer");
  const firstLine = lines[0];
  if (!firstLine || firstLine.trim() !== "id|seq|type|object_id|created_at") {
    throw new Error("Invalid TOON header");
  }
  const lastLine = lines[lines.length - 1];
  if (!lastLine) throw new Error("TOON missing footer");
  const footer = lastLine.trim();
  const footerMatch = /^\[control:page_end\|next_cursor:(\d+)\|has_more:(true|false)\]$/.exec(
    footer,
  );
  if (!footerMatch || !footerMatch[1] || !footerMatch[2]) throw new Error("Invalid TOON footer");
  const next_cursor = parseInt(footerMatch[1], 10);
  const has_more = footerMatch[2] === "true";

  const events: ParsedToonEvent[] = [];
  for (let i = 1; i < lines.length - 1; i++) {
    const rawLine = lines[i];
    if (!rawLine) continue;
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("|");
    if (parts.length !== 5) throw new Error(`Invalid TOON line at ${i}`);
    const id = parts[0]!;
    const seqStr = parts[1]!;
    const type = parts[2]!;
    const object_id = parts[3]!;
    const created_at = parts[4]!;
    const seq = parseInt(seqStr, 10);
    if (!Number.isSafeInteger(seq)) throw new Error(`Invalid TOON seq at ${i}`);
    events.push({ id, seq, type, object_id, created_at });
  }

  return { events, control: { control: "page_end", next_cursor, has_more } };
}

export function renderEventTailToon(page: EventTailPage): string {
  const header = "id|seq|type|object_id|created_at";
  const rows = page.events.map((envelope) => {
    if (envelope.event !== null) {
      return `${envelope.event.id}|${envelope.seq}|${envelope.event.type}|${envelope.event.object_id}|${envelope.event.created_at}`;
    }
    return `none|${envelope.seq}|undisclosed|none|none`;
  });
  const footer = `[control:page_end|next_cursor:${page.page_end.next_cursor}|has_more:${page.page_end.has_more}]`;
  const toon = [header, ...rows, footer].join("\n") + "\n";

  // Lossless round-trip check
  const roundTrip = parseEventTailToon(toon);
  if (roundTrip.events.length !== page.events.length) {
    throw new Error("TOON round-trip failed: event count mismatch");
  }
  for (let i = 0; i < page.events.length; i++) {
    const orig = page.events[i];
    const dec = roundTrip.events[i];
    if (!orig || !dec) {
      throw new Error(`TOON round-trip failed: missing event at ${i}`);
    }
    if (dec.seq !== orig.seq) {
      throw new Error(`TOON round-trip failed: event ${i} seq mismatch`);
    }
    if (orig.event !== null) {
      if (
        dec.id !== orig.event.id ||
        dec.type !== orig.event.type ||
        dec.object_id !== orig.event.object_id ||
        dec.created_at !== orig.event.created_at
      ) {
        throw new Error(`TOON round-trip failed: event ${i} field mismatch`);
      }
    }
  }
  if (
    roundTrip.control.next_cursor !== page.page_end.next_cursor ||
    roundTrip.control.has_more !== page.page_end.has_more
  ) {
    throw new Error("TOON round-trip failed: control record mismatch");
  }

  return toon;
}

/** The complete bounded page is validated before response construction. A
 * connection cut before page_end is incomplete, never an empty successful page.
 * Revalidation precedes ETag comparison so visibility/redaction always wins.
 */
export async function eventTailResponse(
  request: Request,
  page: EventTailPage,
  format: "json" | "ndjson" | "toon",
  unlisted: boolean,
): Promise<Response> {
  const body = format === "toon" ? renderEventTailToon(page) : renderEventTail(page, format);
  const bytes = new TextEncoder().encode(body);
  if (bytes.byteLength > EVENT_TAIL_MAX_BYTES) throw new Error("EVENT_TAIL_RESPONSE_TOO_LARGE");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const etag = `"event-tail-${format}-${hash}"`;
  const contentType =
    format === "json"
      ? "application/json; charset=utf-8"
      : format === "ndjson"
        ? "application/x-ndjson; charset=utf-8"
        : "text/plain; charset=utf-8";
  const headers = new Headers({
    "content-type": contentType,
    "cache-control": unlisted ? "private, no-store" : "public, max-age=0, must-revalidate",
    "content-length": String(bytes.byteLength),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    etag,
  });
  if (unlisted) headers.set("x-robots-tag", "noindex, nofollow");
  const next = page.page_end.next?.replace("/events.json?", `/events.${format}?`);
  if (next) headers.set("link", `<${next}>; rel="next"`);
  const matched = request.headers
    .get("if-none-match")
    ?.split(",")
    .some((value) => ["*", etag, `W/${etag}`].includes(value.trim()));
  if (matched) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}
