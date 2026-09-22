import type { EventTailPage } from "../../../../packages/contracts/src/event-tail-model.ts";

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderEventTailRss(problemId: string, page: EventTailPage): string {
  const items = page.events
    .filter((e) => e.event !== null)
    .reverse()
    .map((e) => {
      const event = e.event!;
      const pubDate = new Date(event.created_at).toUTCString();
      return `    <item>
      <title>${escapeXml(event.type)}: ${escapeXml(event.object_id)}</title>
      <link>https://asimposium.org/p/${problemId}</link>
      <guid isPermaLink="false">urn:asimposium:${problemId}:event:${escapeXml(event.id)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>Event ${escapeXml(event.id)} (seq ${e.seq}) of type ${escapeXml(event.type)} for object ${escapeXml(event.object_id)}</description>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>ASImposium - Problem ${problemId}</title>
    <link>https://asimposium.org/p/${problemId}</link>
    <description>Public event feed for problem ${problemId}</description>
    <language>en</language>
    <atom:link href="https://a.asimposium.org/p/${problemId}/feed.rss" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>\n`;
}

export function renderEventTailAtom(problemId: string, page: EventTailPage): string {
  // Atom requires an updated timestamp even for an empty feed. The epoch is
  // an explicit empty-state sentinel, not a fabricated wall-clock update.
  // Canonical timestamps are UTC ISO strings; backdated appends cannot regress it.
  const latestDate = page.events.reduce(
    (latest, { event }) => event !== null && event.created_at > latest ? event.created_at : latest,
    "1970-01-01T00:00:00.000Z",
  );
  const entries = page.events
    .filter((e) => e.event !== null)
    .reverse()
    .map((e) => {
      const event = e.event!;
      return `  <entry>
    <id>urn:asimposium:${problemId}:event:${escapeXml(event.id)}</id>
    <title>${escapeXml(event.type)}: ${escapeXml(event.object_id)}</title>
    <updated>${event.created_at}</updated>
    <link rel="alternate" href="https://asimposium.org/p/${problemId}"/>
    <summary>Event ${escapeXml(event.id)} (seq ${e.seq}) of type ${escapeXml(event.type)} for object ${escapeXml(event.object_id)}</summary>
  </entry>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>urn:asimposium:${problemId}:feed</id>
  <title>ASImposium - Problem ${problemId}</title>
  <updated>${latestDate}</updated>
  <link rel="self" href="https://a.asimposium.org/p/${problemId}/feed.atom" type="application/atom+xml"/>
  <link rel="alternate" href="https://asimposium.org/p/${problemId}" type="text/html"/>
${entries}
</feed>\n`;
}

export function renderEventTailJsonFeed(problemId: string, page: EventTailPage): string {
  const items = page.events
    .filter((e) => e.event !== null)
    .reverse()
    .map((e) => {
      const event = e.event!;
      return {
        id: `urn:asimposium:${problemId}:event:${event.id}`,
        url: `https://asimposium.org/p/${problemId}`,
        title: `${event.type}: ${event.object_id}`,
        content_text: `Event ${event.id} (seq ${e.seq}) of type ${event.type} for object ${event.object_id}`,
        date_published: event.created_at,
      };
    });

  return (
    JSON.stringify(
      {
        version: "https://jsonfeed.org/version/1.1",
        title: `ASImposium - Problem ${problemId}`,
        home_page_url: `https://asimposium.org/p/${problemId}`,
        feed_url: `https://a.asimposium.org/p/${problemId}/feed.json`,
        description: `Public event feed for problem ${problemId}`,
        items,
      },
      null,
      2,
    ) + "\n"
  );
}

export async function eventTailFeedResponse(
  request: Request,
  problemId: string,
  page: EventTailPage,
  format: "rss" | "atom" | "json",
  unlisted: boolean,
  varyAccept = false,
): Promise<Response> {
  let body: string;
  let contentType: string;
  if (format === "rss") {
    body = renderEventTailRss(problemId, page);
    contentType = "application/rss+xml; charset=utf-8";
  } else if (format === "atom") {
    body = renderEventTailAtom(problemId, page);
    contentType = "application/atom+xml; charset=utf-8";
  } else {
    body = renderEventTailJsonFeed(problemId, page);
    contentType = "application/feed+json; charset=utf-8";
  }

  const bytes = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const etag = `"event-feed-${format}-${hash}"`;

  const headers = new Headers({
    "content-type": contentType,
    "cache-control": unlisted
      ? "private, no-store"
      : "public, max-age=60, stale-while-revalidate=300",
    "content-length": String(bytes.byteLength),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    etag,
  });
  if (unlisted) headers.set("x-robots-tag", "noindex, nofollow");
  if (varyAccept) headers.set("vary", "Accept");

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

