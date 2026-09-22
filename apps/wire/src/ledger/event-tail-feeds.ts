import type { D1Database } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope";
import {
  type ProblemExportEvent,
  serializeProblemExport,
  verifyProblemExportChain,
} from "../krater/export";
import { readCheckpoints, readEvents } from "../krater/krater";
import {
  collectPublicExportEvents,
  PUBLIC_EXPORT_MAX_BYTES,
  PUBLIC_EXPORT_MAX_EVENTS,
  PublicExportUnavailableError,
  readPublicExportCut,
  readPublicExportPayloads,
  revalidatePublicExportCut,
} from "./event-export-snapshot";

export {
  eventTailFeedResponse,
  renderEventTailAtom,
  renderEventTailJsonFeed,
  renderEventTailRss,
} from "./event-feed-http";

async function buildPublicExportResponse(
  request: Request,
  problemId: string,
  problemTitle: string,
  db: D1Database,
  unlisted: boolean,
): Promise<Response> {
  const cut = await readPublicExportCut(db, problemId);
  const events = await collectPublicExportEvents(
    cut,
    (afterSeq, limit) => readEvents(db, problemId, afterSeq, limit),
    request.signal,
  );
  const checkpoints = (await readCheckpoints(db, problemId)).filter(
    (checkpoint) => checkpoint.checkpointSeq <= cut.through,
  );
  const payloads = await readPublicExportPayloads(db, cut, events, request.signal);
  const exportEvents: ProblemExportEvent[] = events.map((event) => {
    const payloadJson = payloads.get(event.eventId);
    if (payloadJson === undefined) throw new PublicExportUnavailableError();
    return { ...event, payloadJson };
  });

  const ndjson = serializeProblemExport({
    problemId,
    problemTitle,
    events: exportEvents,
    checkpoints,
    generatedAt: new Date().toISOString(),
  });

  if (new TextEncoder().encode(ndjson).byteLength > PUBLIC_EXPORT_MAX_BYTES) {
    throw new PublicExportUnavailableError();
  }
  // Use the same strict v3 grammar and integrity law as offline consumers.
  // Never publish a successful terminal record for a broken or incomplete archive.
  if (!(await verifyProblemExportChain(ndjson)).intact) throw new PublicExportUnavailableError();
  request.signal.throwIfAborted();
  const stream = new Response(ndjson).body!.pipeThrough(new CompressionStream("gzip"));
  const compressedBuffer = await new Response(stream).arrayBuffer();
  const bytes = new Uint8Array(compressedBuffer);

  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const etag = `"export-gzip-${hash}"`;

  const current = await revalidatePublicExportCut(db, cut);
  request.signal.throwIfAborted();
  const noindex = unlisted || current.unlisted;
  const headers = new Headers({
    "content-type": "application/gzip",
    "content-disposition": `attachment; filename="${problemId}.export.jsonl.gz"`,
    // Full payloads can be withdrawn without advancing the event cursor.
    // Unlike public envelope feeds, these archives must not be served stale.
    "cache-control": "private, no-store",
    "content-length": String(bytes.byteLength),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    etag,
  });
  if (noindex) headers.set("x-robots-tag", "noindex, nofollow");

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

/** Recover through bounded public faces when strict v3 completeness is unavailable. */
export async function eventTailExportResponse(
  request: Request,
  problemId: string,
  problemTitle: string,
  db: D1Database,
  unlisted: boolean,
): Promise<Response> {
  try {
    return await buildPublicExportResponse(request, problemId, problemTitle, db, unlisted);
  } catch (error) {
    if (!(error instanceof PublicExportUnavailableError)) throw error;
    const response = validatedProblem({
      status: 500,
      code: "INTERNAL_ERROR",
      title: "The public archive is unavailable",
      detail:
        `A complete, currently public v3 archive within ${PUBLIC_EXPORT_MAX_EVENTS} events and ` +
        `${PUBLIC_EXPORT_MAX_BYTES} uncompressed bytes could not be established. No partial archive was returned.`,
      fixHint:
        `Read /p/${encodeURIComponent(problemId)}/events.ndjson?since=0&limit=200 instead. ` +
        "Follow page_end.next and available public object links; unavailable payloads must not be replaced with placeholders.",
      headers: { "cache-control": "private, no-store" },
    });
    return request.method === "HEAD"
      ? new Response(null, { status: response.status, headers: response.headers })
      : response;
  }
}
