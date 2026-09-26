import { PUBLIC_RESOURCE_REGISTRY } from "../../../../packages/contracts/src/public-resources.ts";

// Shared same-cursor public face census (beads asimposiumorg-lu59 / 92x, Rule
// A1 Diptych). Every registry entry whose URL parameters the caller can
// resolve is fetched on every agent suffix at one quiet ledger state. Each
// face must answer 200 with an ETag that revalidates to 304 and declare the
// CC BY 4.0 license, and the Markdown face must state the JSON cursor. Lanes
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
const AGENT_SUFFIXES = new Set([".md", ".json", ".toon", ".ndjson", ".bib", ".csl.json"]);

/** Registry kinds whose item faces no Worker route serves yet (bead
 * asimposiumorg-qvzk). A 404 on exactly these kinds is reported, not failed;
 * serving one makes the census fail until it is removed here, so the list
 * can only shrink. */
export const UNSERVED_ITEM_FACES = Object.freeze({
  bead: "asimposiumorg-qvzk",
  kinds: ["hypothesis", "evidence", "review", "relation"],
});

/** @returns {Promise<{ rows: object[], covered: string[], skipped: string[], lateUnserved: string[], failures: object[] }>} */
export async function faceCensus({ worker, origin, userAgent, params, kinds }) {
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
    const suffixes = entry.allowed_suffixes.filter((suffix) => AGENT_SUFFIXES.has(suffix));
    // JSON first, so the Markdown face can be compared with its cursor.
    suffixes.sort((a, b) => (a === ".json" ? -1 : b === ".json" ? 1 : 0));
    for (const suffix of suffixes) {
      const path =
        suffix === ".json" && entry.json_url ? resolve(entry.json_url) : withSuffix(base, suffix);
      const response = await fetchFace(path);
      const text = await response.text();
      const etag = response.headers.get("etag");
      const revalidated = etag ? (await fetchFace(path, { "if-none-match": etag })).status : null;
      if (suffix === ".json" && response.status === 200) {
        try {
          const cursor = JSON.parse(text).cursor;
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
        license:
          (response.headers.get("link") ?? "").includes(
            '<https://creativecommons.org/licenses/by/4.0/>; rel="license"',
          ) ||
          text.includes("CC-BY-4.0") ||
          text.includes("CC BY 4.0"),
        cursorAgrees:
          suffix === ".md" && jsonCursor !== undefined
            ? statedCursors(text).length > 0 &&
              statedCursors(text).every((cursor) => cursor === jsonCursor)
            : null,
      });
    }
  }

  const lateUnserved = [
    ...new Set(rows.filter((r) => r.late && r.status === 404).map((r) => r.kind)),
  ];
  // A registry entry labelled as a late producer may not be served yet (Rule
  // A4: labelled truthfully); anything else must be.
  const knownUnserved = rows.filter(
    (row) => UNSERVED_ITEM_FACES.kinds.includes(row.kind) && row.status === 404,
  );
  const failures = rows.filter(
    (row) =>
      !knownUnserved.includes(row) &&
      !(row.late && row.status === 404) &&
      (row.status !== 200 ||
        !row.etag ||
        row.revalidated !== 304 ||
        !row.license ||
        row.cursorAgrees === false),
  );
  // A tracked kind that is now served (200) means the list above is stale.
  for (const row of rows)
    if (UNSERVED_ITEM_FACES.kinds.includes(row.kind) && row.status === 200)
      failures.push({ ...row, stale: `remove ${row.kind} from UNSERVED_ITEM_FACES` });
  const unservedKinds = [...new Set(knownUnserved.map((row) => row.kind))];
  return { rows, covered, skipped, lateUnserved, unservedKinds, failures };
}
