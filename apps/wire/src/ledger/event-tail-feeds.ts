import type { D1Database } from "@cloudflare/workers-types";
import { type ProblemExportEvent, serializeProblemExport } from "../krater/export";
import { type KraterEvent, readCheckpoints, readEvents } from "../krater/krater";

export {
  eventTailFeedResponse,
  renderEventTailAtom,
  renderEventTailJsonFeed,
  renderEventTailRss,
} from "./event-feed-http";

export async function eventTailExportResponse(
  request: Request,
  problemId: string,
  problemTitle: string,
  db: D1Database,
  unlisted: boolean,
): Promise<Response> {
  const events: KraterEvent[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = await readEvents(db, problemId, afterSeq, 200);
    if (page.length === 0) break;
    events.push(...page);
    afterSeq = page[page.length - 1]?.seq ?? afterSeq;
    if (page.length < 200) break;
  }

  const checkpoints = await readCheckpoints(db, problemId);

  const payloadByText = new Map<string, string>();
  const PAYLOAD_CHUNK = 50;
  for (let offset = 0; offset < events.length; offset += PAYLOAD_CHUNK) {
    const chunk = events.slice(offset, offset + PAYLOAD_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await db
      .prepare(
        `SELECT event_id, payload_json FROM event_content WHERE event_id IN (${placeholders})`,
      )
      .bind(...chunk.map((e) => e.eventId))
      .all<{ event_id: string; payload_json: string }>();
    for (const row of rows.results) payloadByText.set(row.event_id, row.payload_json);
  }

  const exportEvents: ProblemExportEvent[] = events.map((event) => ({
    ...event,
    payloadJson: payloadByText.get(event.eventId) ?? "{}",
  }));

  const ndjson = serializeProblemExport({
    problemId,
    problemTitle,
    events: exportEvents,
    checkpoints,
    generatedAt: new Date().toISOString(),
  });

  const stream = new Response(ndjson).body!.pipeThrough(new CompressionStream("gzip"));
  const compressedBuffer = await new Response(stream).arrayBuffer();
  const bytes = new Uint8Array(compressedBuffer);

  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const etag = `"export-gzip-${hash}"`;

  const headers = new Headers({
    "content-type": "application/gzip",
    "content-disposition": `attachment; filename="${problemId}.export.jsonl.gz"`,
    "cache-control": unlisted
      ? "private, no-store"
      : "public, max-age=60, stale-while-revalidate=300",
    "content-length": String(bytes.byteLength),
    "x-content-type-options": "nosniff",
    etag,
  });
  if (unlisted) headers.set("x-robots-tag", "noindex, nofollow");

  const matched = request.headers
    .get("if-none-match")
    ?.split(",")
    .some((value) => ["*", etag, `W/${etag}`].includes(value.trim()));
  if (matched) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : bytes, {
    status: 200,
    headers,
  });
}
