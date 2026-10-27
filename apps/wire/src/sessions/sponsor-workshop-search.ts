import { SponsorIdSchema } from "@asimposium/contracts";
import {
  WORKSHOP_SEARCH_MAX_RESPONSE_BYTES,
  WORKSHOP_SEARCH_PAGE_LIMIT,
  WORKSHOP_SEARCH_SCHEMA,
  type WorkshopSearchItem,
  WorkshopSearchItemSchema,
  WorkshopSearchRequestSchema,
  WorkshopSearchResponseSchema,
  workshopSearchPageIsValid,
  workshopSearchTerms,
} from "@asimposium/contracts/workshop-search";
import { Hono } from "hono";
import { cancelUnconsumedRequestBody, parseExactJsonBytes } from "../auth/http.ts";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import type { SessionRouterOptions } from "./router-core.ts";

export const SPONSOR_WORKSHOP_SEARCH_ROUTE = "/v1/sponsors/workshops/search";
const MAX_REQUEST_BYTES = 2048;
const owned = `f.sponsor_id = ?1 AND sponsor.tombstoned_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM private_draft_erasures erased WHERE erased.problem_id = w.problem_id)`;
const joins = `JOIN enrollment_fellows f ON f.fellow_id = w.fellow_id
  JOIN sponsors sponsor ON sponsor.sponsor_id = f.sponsor_id
  JOIN problems p ON p.id = w.problem_id`;
const selected = `w.workshop_id, w.fellow_id, w.problem_id, w.type, w.title,
  substr(w.body_md, 1, 140) AS excerpt,
  CASE WHEN w.cas_hash IS NULL THEN 'inline-body' ELSE 'stored-extract' END AS body_coverage,
  w.current_version AS version, w.workshop_seq, w.state`;

function privateNoStore(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
}
const unavailable = () =>
  privateNoStore(
    validatedProblem({
      status: 503,
      code: "INTERNAL_ERROR",
      title: "Private workshop search is unavailable",
      detail: "The complete search page could not be read under current ownership and draft state.",
      fixHint:
        "Retry the same search. If this persists, report the time without sharing private text.",
    }),
  );
const invalid = (status: 400 | 422) =>
  privateNoStore(
    validatedProblem({
      status,
      code: status === 400 ? "SCHEMA_INVALID" : "WORKSHOP_READ_BODY_INVALID",
      title: "Invalid private workshop search",
      detail:
        "Use a signed JSON body with query, optional fellow_id, problem_id, state, and after. Query text belongs in the body, never the URL.",
      fixHint:
        "Search one to eight words, at most 160 characters total. Copy next_cursor into after for another page.",
      rule: "A5",
      extensions: { schema: WORKSHOP_SEARCH_SCHEMA, example: { query: "counterexample path" } },
    }),
  );

/** A private search page reads no R2 body and emits no public event. Ownership
 * is resolved before row selection and rechecked immediately before release.
 * FTS matches are literal AND terms; no global score or hit count is exposed. */
export function createSponsorWorkshopSearchRouter(
  options: Pick<SessionRouterOptions, "verifiedSponsor">,
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(() => unavailable());
  app.post(SPONSOR_WORKSHOP_SEARCH_ROUTE, async (c) => {
    let sponsorId: string;
    let rawBody: Uint8Array;
    try {
      const verified = await options.verifiedSponsor?.(
        c.req.raw,
        SPONSOR_WORKSHOP_SEARCH_ROUTE,
        "workshop.search",
      );
      if (verified instanceof Response) return privateNoStore(verified);
      const principal = verified?.principal;
      if (
        principal?.type !== "sponsor" ||
        !SponsorIdSchema.safeParse(principal.sponsorId).success ||
        !(verified?.rawBody instanceof Uint8Array)
      )
        return unavailable();
      sponsorId = principal.sponsorId;
      rawBody = new Uint8Array(verified.rawBody);
    } finally {
      cancelUnconsumedRequestBody(c.req.raw);
    }
    if (new URL(c.req.url).search !== "" || rawBody.byteLength > MAX_REQUEST_BYTES)
      return invalid(400);
    let input: unknown;
    try {
      input = parseExactJsonBytes(rawBody);
    } catch {
      return invalid(422);
    }
    const parsed = WorkshopSearchRequestSchema.safeParse(input);
    if (!parsed.success) return invalid(422);
    const request = parsed.data;
    const terms = workshopSearchTerms(request.query);
    if (!terms) return invalid(422);
    // The term grammar has no quote characters, but quoting every term keeps
    // FTS operators such as OR and NEAR ordinary search words.
    const match = terms.map((term) => `"${term}"`).join(" AND ");
    const found = (
      await c.env.DB.prepare(
        `SELECT ${selected} FROM private_workshop_search
       JOIN workshop_objects w ON w.rowid = private_workshop_search.rowid ${joins}
       WHERE ${owned} AND private_workshop_search MATCH ?2
         AND (?3 IS NULL OR w.fellow_id = ?3)
         AND (?4 IS NULL OR w.problem_id = ?4)
         AND (?5 IS NULL OR w.state = ?5)
         AND (?6 IS NULL OR w.workshop_id COLLATE BINARY > ?6)
       ORDER BY w.workshop_id COLLATE BINARY LIMIT ${WORKSHOP_SEARCH_PAGE_LIMIT + 1}`,
      )
        .bind(
          sponsorId,
          match,
          request.fellow_id ?? null,
          request.problem_id ?? null,
          request.state ?? null,
          request.after ?? null,
        )
        .all<WorkshopSearchItem>()
    ).results;
    if (!Array.isArray(found) || found.length > WORKSHOP_SEARCH_PAGE_LIMIT + 1)
      return unavailable();
    // Validate the lookahead as well: even the existence of another page is
    // private metadata, so neither malformed nor formerly owned rows qualify.
    const rows = found.map((row) => WorkshopSearchItemSchema.parse(row));
    const items = rows.slice(0, WORKSHOP_SEARCH_PAGE_LIMIT);
    const response = WorkshopSearchResponseSchema.parse({
      schema: WORKSHOP_SEARCH_SCHEMA,
      sponsor_id: sponsorId,
      query: request.query,
      coverage: "titles-and-stored-draft-text",
      items,
      next_cursor: rows.length > WORKSHOP_SEARCH_PAGE_LIMIT ? items.at(-1)?.workshop_id : null,
    });
    if (!workshopSearchPageIsValid(response, request)) return unavailable();
    const bytes = new TextEncoder().encode(JSON.stringify(response));
    if (bytes.byteLength > WORKSHOP_SEARCH_MAX_RESPONSE_BYTES) return unavailable();

    // Bound the final check to this page and its one-row lookahead. A transfer,
    // account/private-draft deletion, revision or archival race withholds the
    // entire response. No partial hits or former owner's excerpts escape.
    const current = await c.env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM json_each(?2) pin
       JOIN workshop_objects w ON w.workshop_id = json_extract(pin.value, '$.workshop_id')
       ${joins}
       WHERE ${owned}
         AND w.fellow_id = json_extract(pin.value, '$.fellow_id')
         AND w.problem_id = json_extract(pin.value, '$.problem_id')
         AND w.current_version = json_extract(pin.value, '$.version')
         AND w.workshop_seq = json_extract(pin.value, '$.workshop_seq')
         AND w.state = json_extract(pin.value, '$.state')
         AND w.type = json_extract(pin.value, '$.type')
         AND w.title = json_extract(pin.value, '$.title')
         AND substr(w.body_md, 1, 140) = json_extract(pin.value, '$.excerpt')
         AND (CASE WHEN w.cas_hash IS NULL THEN 'inline-body' ELSE 'stored-extract' END)
           = json_extract(pin.value, '$.body_coverage')) AS current
       FROM sponsors WHERE sponsor_id = ?1 AND tombstoned_at IS NULL`,
    )
      .bind(sponsorId, JSON.stringify(rows))
      .first<{ current: number }>();
    if (!current || current.current !== rows.length) return unavailable();
    return new Response(bytes, {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        "x-robots-tag": "noindex, nofollow",
        "content-type": "application/json; charset=utf-8",
        "content-length": String(bytes.byteLength),
      },
    });
  });
  return app;
}
