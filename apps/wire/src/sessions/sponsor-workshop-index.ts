import {
  SPONSOR_WORKSHOP_INDEX_MAX_RESPONSE_BYTES,
  SPONSOR_WORKSHOP_INDEX_PAGE_LIMIT,
  SponsorIdSchema,
  type SponsorWorkshopIndexItem,
  SponsorWorkshopIndexRequestSchema,
  SponsorWorkshopIndexResponseSchema,
  sponsorWorkshopIndexPageIsValid,
} from "@asimposium/contracts";
import { Hono } from "hono";
import { cancelUnconsumedRequestBody, parseExactJsonBytes } from "../auth/http.ts";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import type { SessionRouterOptions } from "./router-core.ts";

const ROUTE = "/v1/sponsors/workshops";
const SCHEMA = "https://a.asimposium.org/schemas/sessions.v1.json";
const MAX_REQUEST_BYTES = 2048;

function privateNoStore(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

const unavailable = () =>
  privateNoStore(
    validatedProblem({
      status: 503,
      code: "INTERNAL_ERROR",
      title: "The workshop directory is unavailable",
      detail: "The complete private directory page could not be read safely.",
      fixHint: "Retry shortly. If this persists, report the time of the request.",
    }),
  );

/** Private discovery for actual work, independent of a mint-time assignment
 * and of the sponsor's currently displayed Fellows inventory page. */
export function createSponsorWorkshopIndexRouter(
  options: Pick<SessionRouterOptions, "verifiedSponsor">,
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(() => unavailable());

  app.post(ROUTE, async (c) => {
    let sponsorId: string;
    let rawBody: Uint8Array;
    try {
      const verified = await options.verifiedSponsor?.(c.req.raw, ROUTE, "workshop.list");
      if (verified instanceof Response) return privateNoStore(verified);
      // Copy verifier-owned authority and bytes before an asynchronous store
      // read. A custom verifier cannot mutate them during business logic.
      const principal = verified?.principal;
      const type = principal?.type;
      const id = principal?.sponsorId;
      const bytes = verified?.rawBody;
      if (
        type !== "sponsor" ||
        typeof id !== "string" ||
        !SponsorIdSchema.safeParse(id).success ||
        !(bytes instanceof Uint8Array)
      )
        return unavailable();
      sponsorId = id;
      rawBody = new Uint8Array(bytes);
    } catch {
      return unavailable();
    } finally {
      cancelUnconsumedRequestBody(c.req.raw);
    }

    if (new URL(c.req.url).search !== "" || rawBody.byteLength > MAX_REQUEST_BYTES) {
      return privateNoStore(
        validatedProblem({
          status: 400,
          code: "SCHEMA_INVALID",
          title: "Invalid workshop directory request",
          detail: "This private read accepts a bounded signed JSON body and no query parameters.",
          fixHint: "Send {} for the first page, or {after: next_cursor} from the preceding page.",
          rule: "A5",
          extensions: { schema: SCHEMA, example: {} },
        }),
      );
    }

    let input: unknown;
    try {
      input = parseExactJsonBytes(rawBody);
    } catch {
      input = undefined;
    }
    const request = SponsorWorkshopIndexRequestSchema.safeParse(input);
    if (!request.success) {
      return privateNoStore(
        validatedProblem({
          status: 422,
          code: "WORKSHOP_READ_BODY_INVALID",
          title: "Invalid workshop directory cursor",
          detail:
            "The signed body must contain only an optional after cursor with Fellow and problem IDs.",
          fixHint:
            "Send {} for the first page, or copy the complete next_cursor object into after.",
          rule: "A5",
          extensions: { schema: SCHEMA, example: {} },
        }),
      );
    }

    const after = request.data.after;
    // The covering private index is ordered by immutable identity, not by
    // mutable recency. Editing an earlier draft cannot skip an unseen pair.
    // Only current ownership joins reach workshop rows. No body, title, CAS
    // reference, problem formulation or grant secret is selected.
    const rows = await c.env.DB.prepare(
      `SELECT f.fellow_id, f.name AS fellow_name, w.problem_id,
              MAX(w.workshop_seq) AS workshop_cursor
       FROM enrollment_fellows f
       JOIN sponsors s ON s.sponsor_id = f.sponsor_id AND s.tombstoned_at IS NULL
       JOIN workshop_objects w ON w.fellow_id = f.fellow_id
       WHERE f.sponsor_id = ?
         AND (? IS NULL OR f.fellow_id COLLATE BINARY > ?
           OR (f.fellow_id = ? AND w.problem_id COLLATE BINARY > ?))
       GROUP BY f.fellow_id, w.problem_id
       ORDER BY f.fellow_id COLLATE BINARY, w.problem_id COLLATE BINARY
       LIMIT ${SPONSOR_WORKSHOP_INDEX_PAGE_LIMIT + 1}`,
    )
      .bind(
        sponsorId,
        after?.fellow_id ?? null,
        after?.fellow_id ?? null,
        after?.fellow_id ?? null,
        after?.problem_id ?? null,
      )
      .all<SponsorWorkshopIndexItem>();
    const found = rows.results ?? [];
    const workshops = found.slice(0, SPONSOR_WORKSHOP_INDEX_PAGE_LIMIT);
    const last = workshops.at(-1);
    const response = SponsorWorkshopIndexResponseSchema.parse({
      schema: SCHEMA,
      sponsor_id: sponsorId,
      workshops,
      next_cursor:
        found.length > SPONSOR_WORKSHOP_INDEX_PAGE_LIMIT && last !== undefined
          ? { fellow_id: last.fellow_id, problem_id: last.problem_id }
          : null,
    });
    if (!sponsorWorkshopIndexPageIsValid(response, request.data)) return unavailable();

    // A transfer or account deletion during the read must not release the
    // formerly owned directory, including the one-row pagination lookahead.
    // This check is bounded by the page plus that one row.
    const fellowIds = [...new Set(found.map((item) => item.fellow_id))];
    const authority = await c.env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM enrollment_fellows f
         WHERE f.sponsor_id = s.sponsor_id
           AND f.fellow_id IN (${fellowIds.map(() => "?").join(",") || "NULL"})) AS owned
       FROM sponsors s WHERE s.sponsor_id = ? AND s.tombstoned_at IS NULL`,
    )
      .bind(...fellowIds, sponsorId)
      .first<{ owned: number }>();
    if (!authority || authority.owned !== fellowIds.length) return unavailable();

    const body = new TextEncoder().encode(JSON.stringify(response));
    if (body.byteLength > SPONSOR_WORKSHOP_INDEX_MAX_RESPONSE_BYTES) return unavailable();
    return new Response(body, {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        "content-type": "application/json; charset=utf-8",
        "content-length": String(body.byteLength),
      },
    });
  });
  return app;
}
