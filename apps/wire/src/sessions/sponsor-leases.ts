import {
  SPONSOR_LEASE_LIST_MAX_RESPONSE_BYTES,
  SPONSOR_LEASE_LIST_PAGE_LIMIT,
  SponsorIdSchema,
  SponsorLeaseListRequestSchema,
  SponsorLeaseListResponseSchema,
  SponsorLeaseSummarySchema,
  sponsorLeaseListPageIsValid,
} from "@asimposium/contracts";
import { Hono } from "hono";
import { cancelUnconsumedRequestBody, parseExactJsonBytes } from "../auth/http.ts";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import type { SessionRouterOptions } from "./router-core.ts";

const ROUTE = "/v1/sponsors/leases";
const SCHEMA = "https://a.asimposium.org/schemas/sessions.v1.json";
const MAX_REQUEST_BYTES = 2048;

function privateResponse(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
}

const unavailable = () =>
  privateResponse(
    validatedProblem({
      status: 503,
      code: "INTERNAL_ERROR",
      title: "The active leases are unavailable",
      detail: "The complete private lease page could not be read safely.",
      fixHint: "Retry shortly. If this persists, report the time of the request.",
    }),
  );

// Select only recovery coordinates, not problem text, workshop bodies, or an
// old sponsor's objective. Current sponsorship controls access after transfer.
const selectedFields = `SELECT l.lease_id, l.problem_id, l.fellow_id,
       f.name AS fellow_name, l.object_ref AS object, l.object_kind,
       l.parallel_safe, l.status, l.leased_at, l.leased_until
  FROM enrollment_fellows f
  JOIN sponsors s ON s.sponsor_id = f.sponsor_id AND s.tombstoned_at IS NULL
  JOIN leases l ON l.fellow_id = f.fellow_id
  WHERE f.sponsor_id = ? AND l.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM private_draft_erasures e WHERE e.problem_id = l.problem_id)`;

function parseRow(row: Record<string, unknown>) {
  return SponsorLeaseSummarySchema.parse({
    ...row,
    parallel_safe: row.parallel_safe === 1 ? true : row.parallel_safe === 0 ? false : undefined,
  });
}

export function createSponsorLeasesRouter(
  options: Pick<SessionRouterOptions, "verifiedSponsor">,
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(() => unavailable());
  app.post("/v1/sponsors/leases", async (c) => {
    let sponsorId: string;
    let rawBody: Uint8Array;
    try {
      const verified = await options.verifiedSponsor?.(c.req.raw, ROUTE, "lease.list");
      if (verified instanceof Response) return privateResponse(verified);
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

    let input: unknown;
    try {
      if (new URL(c.req.url).search === "" && rawBody.byteLength <= MAX_REQUEST_BYTES)
        input = parseExactJsonBytes(rawBody);
    } catch {
      input = undefined;
    }
    const request = SponsorLeaseListRequestSchema.safeParse(input);
    if (!request.success)
      return privateResponse(
        validatedProblem({
          status: 422,
          code: "SCHEMA_INVALID",
          title: "Invalid active lease request",
          detail:
            "This private read accepts only an optional after lease ID in a signed JSON body.",
          fixHint: "Send {} for the first page, or {after: next_cursor} from the preceding page.",
          rule: "A5",
          extensions: { schema: SCHEMA, example: {} },
        }),
      );

    const after = request.data.after ?? null;
    const result = await c.env.DB.prepare(
      `${selectedFields}
        AND (? IS NULL OR l.lease_id COLLATE BINARY > ?)
        ORDER BY l.lease_id COLLATE BINARY
        LIMIT ${SPONSOR_LEASE_LIST_PAGE_LIMIT + 1}`,
    )
      .bind(sponsorId, after, after)
      .all<Record<string, unknown>>();
    const rows = (result.results ?? []).map(parseRow);
    if (rows.length > SPONSOR_LEASE_LIST_PAGE_LIMIT + 1) return unavailable();

    // Recheck current authority and all selected metadata, including the
    // lookahead. A transfer, erasure, or release during the read fails closed.
    const sponsor = await c.env.DB.prepare(
      "SELECT sponsor_id FROM sponsors WHERE sponsor_id = ? AND tombstoned_at IS NULL",
    )
      .bind(sponsorId)
      .first();
    if (!sponsor) return unavailable();
    if (rows.length > 0) {
      const recheck = await c.env.DB.prepare(
        `${selectedFields}
          AND l.lease_id IN (SELECT value FROM json_each(?))
          ORDER BY l.lease_id COLLATE BINARY`,
      )
        .bind(sponsorId, JSON.stringify(rows.map((row) => row.lease_id)))
        .all<Record<string, unknown>>();
      if (JSON.stringify((recheck.results ?? []).map(parseRow)) !== JSON.stringify(rows))
        return unavailable();
    }

    const leases = rows.slice(0, SPONSOR_LEASE_LIST_PAGE_LIMIT);
    const response = SponsorLeaseListResponseSchema.parse({
      schema: SCHEMA,
      sponsor_id: sponsorId,
      leases,
      next_cursor: rows.length > SPONSOR_LEASE_LIST_PAGE_LIMIT ? leases.at(-1)?.lease_id : null,
    });
    if (!sponsorLeaseListPageIsValid(response, request.data)) return unavailable();
    const body = new TextEncoder().encode(JSON.stringify(response));
    if (body.byteLength > SPONSOR_LEASE_LIST_MAX_RESPONSE_BYTES) return unavailable();
    return privateResponse(
      new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(body.byteLength),
        },
      }),
    );
  });
  return app;
}
