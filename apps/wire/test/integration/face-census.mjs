import {
  LateProducerDegradedFaceSchema,
  PUBLIC_RESOURCE_REGISTRY,
} from "../../../../packages/contracts/src/public-resources.ts";

// Shared same-cursor public face census (beads asimposiumorg-lu59 / 92x, Rule
// A1 Diptych). Every registry entry whose URL parameters the caller can
// resolve is fetched on every agent suffix at one quiet ledger state. Each
// face must answer 200 with an ETag that revalidates to 304 and declare the
// CC BY 4.0 license, the Markdown face must state the JSON cursor, and a TOON
// face must equal the rows derived from its JSON face. Lanes
// that create particular object kinds call this with their real ids.

/** Cursors a Markdown face states as its own ("cursor: N", "Cursor: seq N",
 * "cursor N", "?cursor=N"): never any bare number in the body, so a face
 * stating the wrong cursor cannot pass by mentioning the right one elsewhere
 * (independent verification 4). */
function statedCursors(markdown) {
  return [...markdown.matchAll(/\bcursor(?::\s*(?:seq\s+)?|\s+|=)(\d+)\b/gi)].map((m) =>
    Number(m[1]),
  );
}
/** The TOON face of a uniform list, derived independently from its JSON face
 * at the same cursor (lu59: TOON content was never compared). Returns null for
 * kinds without a TOON face. */
function expectedToon(kind, json) {
  const field = (value) =>
    String(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, "\\n");
  if (kind === "problems-index") {
    const rows = json.problems.map((p) =>
      [
        p.id,
        p.public_seq,
        p.status,
        p.created_at,
        p.updated_at,
        p.title === null ? "none" : field(p.title),
      ].join("|"),
    );
    const footer = `[control:page_end|next_after:${json.next_after ?? "none"}|omitted:${json.omitted.length}]`;
    return ["id|public_seq|status|created_at|updated_at|title", ...rows, footer].join("\n") + "\n";
  }
  if (kind === "events-tail") {
    const rows = json.events.map((envelope) =>
      envelope.event === null
        ? `none|${envelope.seq}|undisclosed|none|none`
        : [
            envelope.event.id,
            envelope.seq,
            envelope.event.type,
            envelope.event.object_id,
            envelope.event.created_at,
          ].join("|"),
    );
    const footer = `[control:page_end|next_cursor:${json.page_end.next_cursor}|has_more:${json.page_end.has_more}]`;
    return ["id|seq|type|object_id|created_at", ...rows, footer].join("\n") + "\n";
  }
  return null;
}
const AGENT_SUFFIXES = new Set([".md", ".json", ".html", ".toon", ".ndjson", ".bib", ".csl.json"]);

/** The media type each face suffix must declare (parameters ignored). */
const SUFFIX_MEDIA_TYPES = {
  ".md": ["text/markdown"],
  ".json": ["application/json"],
  ".html": ["text/html"],
  ".toon": ["text/vnd.toon", "text/plain"],
  ".ndjson": ["application/x-ndjson", "application/ndjson"],
  ".bib": ["application/x-bibtex"],
  ".csl.json": ["application/vnd.citationstyles.csl+json"],
};
const mediaTypeOf = (response) =>
  (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
const licensed = (response, text) =>
  (response.headers.get("link") ?? "").includes(
    '<https://creativecommons.org/licenses/by/4.0/>; rel="license"',
  ) ||
  text.includes("CC-BY-4.0") ||
  text.includes("CC BY 4.0");

/** Registry kinds whose item faces no Worker route serves yet (bead
 * asimposiumorg-qvzk). A 404 on exactly these kinds is reported, not failed;
 * serving one makes the census fail until it is removed here, so the list
 * can only shrink. */
export const UNSERVED_ITEM_FACES = Object.freeze({
  bead: "asimposiumorg-qvzk",
  kinds: [],
});

/** @returns {Promise<{ rows: object[], covered: string[], skipped: string[], lateUnserved: string[], failures: object[] }>} */
export async function faceCensus({ worker, origin, userAgent, params, kinds, inspect }) {
  const resolve = (pattern) => {
    let unresolved = false;
    const url = pattern.replace(/:([a-zA-Z]+)/g, (_, name) => {
      if (params[name] === undefined) unresolved = true;
      return encodeURIComponent(params[name] ?? "");
    });
    return unresolved ? null : url;
  };
  // Swap the suffix of a registry URL, keeping any query string.
  const withSuffix = (url, suffix) => {
    const [path, query] = url.split("?");
    const bare = path.replace(/(\.csl\.json|\.jsonl\.gz|\.[a-z]+)$/, "");
    return `${bare}${suffix}${query ? `?${query}` : ""}`;
  };
  const fetchFace = async (path, headers = {}) =>
    worker.fetch(`${origin}${path}`, { headers: { "User-Agent": userAgent, ...headers } });

  const rows = [];
  const covered = [];
  const skipped = [];
  for (const entry of PUBLIC_RESOURCE_REGISTRY) {
    if (kinds !== undefined && !kinds.includes(entry.kind)) continue;
    const base = resolve(entry.agent_markdown_url);
    if (base === null) {
      skipped.push(entry.kind);
      continue;
    }
    covered.push(entry.kind);
    let jsonCursor;
    let jsonBody;
    // An html_url without a suffix names the Agora human route (another host),
    // not a Worker .html face.
    const agoraHtml = entry.html_url !== undefined && !entry.html_url.endsWith(".html");
    const suffixes = entry.allowed_suffixes.filter(
      (suffix) => AGENT_SUFFIXES.has(suffix) && !(suffix === ".html" && agoraHtml),
    );
    // The unsuffixed spelling an agent may try first must serve the resource
    // or 308 to its Markdown face (AGENTS.md: the first GET works or
    // redirects), never answer 404.
    {
      const bare = withSuffix(base, "");
      const response = await worker.fetch(`${origin}${bare}`, {
        headers: { "User-Agent": userAgent },
        redirect: "manual",
      });
      const bareText = await response.text();
      if (inspect) inspect(bare, bareText, response.status);
      const location = response.headers.get("location");
      const redirected = response.status === 308 && location === withSuffix(base, ".md");
      // A redirect is judged by its target (the .md row below); a bare
      // spelling that serves directly must meet the same bar as any face.
      const etag = response.headers.get("etag");
      rows.push({
        kind: entry.kind,
        late: entry.late_producer !== undefined,
        bare: true,
        path: bare,
        status: redirected ? 200 : response.status,
        etag: redirected ? null : etag !== null,
        revalidated: redirected
          ? null
          : etag
            ? (await fetchFace(bare, { "if-none-match": etag })).status
            : null,
        license: redirected ? null : licensed(response, bareText),
        // A spelling that serves directly may negotiate; caches must key on Accept.
        vary: redirected
          ? null
          : /(^|,)\s*accept\s*(,|$)/i.test(response.headers.get("vary") ?? ""),
        mediaType: null,
        head: null,
        cursorAgrees: null,
        toonAgrees: null,
        bareSpelling: response.status === 308 ? `308 -> ${location}` : String(response.status),
      });
    }
    // JSON first, so the Markdown face can be compared with its cursor.
    suffixes.sort((a, b) => (a === ".json" ? -1 : b === ".json" ? 1 : 0));
    for (const suffix of suffixes) {
      const path =
        suffix === ".json" && entry.json_url ? resolve(entry.json_url) : withSuffix(base, suffix);
      const response = await fetchFace(path);
      const text = await response.text();
      // Lanes inspect every body, refusals included (privacy canaries, forged markers).
      if (inspect) inspect(path, text, response.status);
      const etag = response.headers.get("etag");
      const revalidated = etag ? (await fetchFace(path, { "if-none-match": etag })).status : null;
      // HEAD answers with the same status and validator. (Workerd itself drops
      // HEAD bodies, so the empty-body clause is runtime-guaranteed; a handler
      // returning a body on HEAD was planted and is not observable here.)
      const headResponse = await worker.fetch(`${origin}${path}`, {
        method: "HEAD",
        headers: { "User-Agent": userAgent },
        redirect: "manual",
      });
      const headBody = await headResponse.arrayBuffer();
      const head =
        headResponse.status === response.status &&
        headResponse.headers.get("etag") === etag &&
        headBody.byteLength === 0;
      // A late producer may serve an explicit not_produced face; it must be
      // the contracted degraded shape (no placeholder data), and is reported.
      let degraded = null;
      if (suffix === ".json" && response.status === 200 && entry.late_producer !== undefined) {
        try {
          const parsed = JSON.parse(text);
          if (parsed?.state === "not_produced")
            degraded = LateProducerDegradedFaceSchema.safeParse(parsed).success;
        } catch {
          degraded = false;
        }
      }
      if (suffix === ".json" && response.status === 200) {
        try {
          jsonBody = JSON.parse(text);
          const cursor = jsonBody.cursor;
          if (typeof cursor === "number") jsonCursor = cursor;
        } catch {
          /* non-object JSON faces carry no cursor */
        }
      }
      rows.push({
        kind: entry.kind,
        late: entry.late_producer !== undefined,
        path,
        status: response.status,
        etag: etag !== null,
        revalidated,
        license: licensed(response, text),
        degraded,
        mediaType:
          response.status === 200
            ? (SUFFIX_MEDIA_TYPES[suffix] ?? []).includes(mediaTypeOf(response))
            : null,
        head,
        cursorAgrees:
          suffix === ".md" && jsonCursor !== undefined
            ? statedCursors(text).length > 0 &&
              statedCursors(text).every((cursor) => cursor === jsonCursor)
            : null,
        toonAgrees:
          suffix === ".toon" &&
          jsonBody !== undefined &&
          expectedToon(entry.kind, jsonBody) !== null
            ? text === expectedToon(entry.kind, jsonBody)
            : null,
      });
    }
  }

  const lateUnserved = [
    ...new Set(rows.filter((r) => r.late && r.status === 404).map((r) => r.kind)),
  ];
  // Every late producer now serves real data or an explicit, contracted
  // not_produced face, so a late-producer 404 is a failure like any other.
  const knownUnserved = rows.filter(
    (row) => UNSERVED_ITEM_FACES.kinds.includes(row.kind) && row.status === 404,
  );
  const failures = rows.filter(
    (row) =>
      !knownUnserved.includes(row) &&
      (row.status !== 200 ||
        row.etag === false ||
        (row.revalidated !== null && row.revalidated !== 304) ||
        (row.etag === true && row.revalidated === null) ||
        row.license === false ||
        row.mediaType === false ||
        row.degraded === false ||
        row.vary === false ||
        row.head === false ||
        row.cursorAgrees === false ||
        row.toonAgrees === false),
  );
  // A tracked kind that is now served (200) means the list above is stale.
  for (const row of rows)
    if (UNSERVED_ITEM_FACES.kinds.includes(row.kind) && row.status === 200)
      failures.push({ ...row, stale: `remove ${row.kind} from UNSERVED_ITEM_FACES` });
  const unservedKinds = [...new Set(knownUnserved.map((row) => row.kind))];
  const degradedKinds = [...new Set(rows.filter((r) => r.degraded === true).map((r) => r.kind))];
  return { rows, covered, skipped, lateUnserved, degradedKinds, unservedKinds, failures };
}
