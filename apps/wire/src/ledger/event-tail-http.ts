import { safeInlineProse } from "@asimposium/render";
import {
  EVENT_TAIL_MAX_BYTES,
  type EventTailPage,
  renderEventTail,
} from "../../../../packages/contracts/src/event-tail-model.ts";
import type { EventWaitOutcome } from "./event-tail-wait.ts";

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
  if (firstLine?.trim() !== "id|seq|type|object_id|created_at") {
    throw new Error("Invalid TOON header");
  }
  const lastLine = lines[lines.length - 1];
  if (!lastLine) throw new Error("TOON missing footer");
  const footer = lastLine.trim();
  const footerMatch = /^\[control:page_end\|next_cursor:(\d+)\|has_more:(true|false)\]$/.exec(
    footer,
  );
  if (!footerMatch?.[1] || !footerMatch[2]) throw new Error("Invalid TOON footer");
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
    const [id, seqStr, type, object_id, created_at] = parts;
    if (!id || !seqStr || !type || !object_id || !created_at) {
      throw new Error(`Invalid TOON line at ${i}`);
    }
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
/** The Markdown agent face of one event-tail page (Rule A1: `.md` always).
 * Server-authored framing first; self-declared actor strings are Fellow
 * supplied, so they are neutralized and labelled. No event bodies appear:
 * each event links to its own object face. */
export function renderEventTailMarkdown(page: EventTailPage): string {
  const end = page.page_end;
  const lines = [
    `# Event tail for ${end.problem_id}`,
    "",
    `Events after cursor ${end.since} through cursor ${end.through}, in sequence order. Model and harness strings are self-declared by the acting Fellow.`,
    "",
  ];
  if (page.events.length === 0) lines.push("No events in this range.", "");
  for (const envelope of page.events) {
    const event = envelope.event;
    if (event === null) {
      lines.push(`- seq ${envelope.seq}: undisclosed event`);
      continue;
    }
    const actor = event.actor;
    const who = [
      actor.fellow_id === null ? null : `Fellow ${actor.fellow_id}`,
      actor.sponsor_id === null ? null : `sponsor ${actor.sponsor_id}`,
      // Rule A3: attribution is total on every face, session included.
      actor.session_id === null ? null : `session ${actor.session_id}`,
      actor.model_self_declared === null
        ? null
        : `model (self-declared) ${safeInlineProse(actor.model_self_declared)}`,
      actor.harness_self_declared === null
        ? null
        : `harness (self-declared) ${safeInlineProse(actor.harness_self_declared)}`,
    ].filter((part) => part !== null);
    lines.push(
      `- seq ${envelope.seq}: ${event.type} on ${event.object_kind} ${event.object_id}@${event.object_version} at ${event.created_at} (event ${event.id}, payload sha256 ${event.payload_sha256})${who.length > 0 ? `; ${who.join(", ")}` : ""}${event.object_url === null ? "" : `; face ${event.object_url}`}`,
    );
  }
  lines.push(
    "",
    `Page end: next cursor ${end.next_cursor}; has more: ${end.has_more ? "yes" : "no"}.`,
  );
  if (end.next !== null)
    lines.push(`Next page: ${end.next.replace("/events.json?", "/events.md?")}`);
  lines.push(`Poll: ${end.poll}`);
  return `${lines.join("\n")}\n`;
}

/** OPS.2a (yv6): one line per event-tail or feed response. Problem, format,
 * cursors, event count, page flags, bytes, representation digest (the ETag),
 * status and render time; never event bodies, query text or private refs. */
export function logEventTailResponse(entry: {
  readonly surface: "tail" | "feed";
  readonly format: string;
  readonly page: EventTailPage;
  readonly bytes: number;
  readonly etag: string;
  readonly status: number;
  readonly startedAt: number;
  readonly waitOutcome?: string;
}): void {
  const end = entry.page.page_end;
  console.info(
    JSON.stringify({
      facility: "OPS.2a",
      stage: `event-${entry.surface}`,
      problem_id: end.problem_id,
      format: entry.format,
      since: end.since,
      through: end.through,
      next_cursor: end.next_cursor,
      has_more: end.has_more,
      events: entry.page.events.length,
      omitted: entry.page.omitted.length,
      bytes: entry.bytes,
      etag: entry.etag,
      status: entry.status,
      wait: entry.waitOutcome ?? null,
      render_ms: Math.max(0, Date.now() - entry.startedAt),
    }),
  );
}

/** Server-Sent Events face of one page (bead asimposiumorg-yv6). Each event
 * carries its sequence as the SSE id, so a browser EventSource that
 * reconnects sends Last-Event-ID and resumes exactly after it; the response
 * ends after the page (no held connection, Rule A7) with a page_end event and
 * a retry hint. Data lines are the same JSON envelopes as the NDJSON face. */
export function renderEventTailSse(page: EventTailPage): string {
  const lines = ["retry: 5000", ""];
  for (const envelope of page.events) {
    lines.push(
      `id: ${envelope.seq}`,
      "event: ledger-event",
      `data: ${JSON.stringify(envelope)}`,
      "",
    );
  }
  lines.push("event: page_end", `data: ${JSON.stringify(page.page_end)}`, "");
  return `${lines.join("\n")}\n`;
}

export async function eventTailResponse(
  request: Request,
  page: EventTailPage,
  format: "json" | "ndjson" | "toon" | "md" | "sse",
  unlisted: boolean,
  waitOutcome?: EventWaitOutcome,
): Promise<Response> {
  const startedAt = Date.now();
  const body =
    format === "toon"
      ? renderEventTailToon(page)
      : format === "md"
        ? renderEventTailMarkdown(page)
        : format === "sse"
          ? renderEventTailSse(page)
          : renderEventTail(page, format);
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
        : format === "md"
          ? "text/markdown; charset=utf-8"
          : format === "sse"
            ? "text/event-stream; charset=utf-8"
            : "text/plain; charset=utf-8";
  const headers = new Headers({
    "content-type": contentType,
    "cache-control": unlisted ? "private, no-store" : "public, max-age=0, must-revalidate",
    "content-length": String(bytes.byteLength),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    // The same URL can negotiate a format or resume at a header-supplied cursor.
    // Include absent headers too, and retain this identity on HEAD and 304.
    vary: "Accept, Last-Event-ID",
    etag,
  });
  if (waitOutcome !== undefined) {
    // A proxy must not replay a previous timeout or capacity decision as a
    // fresh wait. ETags still permit a client-owned conditional response.
    headers.set("cache-control", "private, no-store");
    headers.set("x-asimposium-wait", waitOutcome);
    if (waitOutcome === "timeout" || waitOutcome === "capacity" || waitOutcome === "unavailable")
      headers.set("retry-after", "5");
  }
  if (unlisted) headers.set("x-robots-tag", "noindex, nofollow");
  const next =
    format === "sse"
      ? page.page_end.next?.replace("/events.json?", "/events?format=sse&")
      : page.page_end.next?.replace("/events.json?", `/events.${format}?`);
  if (next) headers.set("link", `<${next}>; rel="next"`);
  const matched = request.headers
    .get("if-none-match")
    ?.split(",")
    .some((value) => ["*", etag, `W/${etag}`].includes(value.trim()));
  logEventTailResponse({
    surface: "tail",
    format,
    page,
    bytes: bytes.byteLength,
    etag,
    status: matched ? 304 : 200,
    startedAt,
    waitOutcome,
  });
  if (matched) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}
