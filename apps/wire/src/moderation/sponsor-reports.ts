import {
  REPORTS_SCHEMA_ID,
  SPONSOR_REPORTS_MAX_RESPONSE_BYTES,
  SponsorIdSchema,
  SponsorReportSummarySchema,
  type SponsorReportsRequest,
  SponsorReportsRequestSchema,
  type SponsorReportsResponse,
  SponsorReportsResponseSchema,
  sponsorReportsMatchRequest,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { z } from "zod";
import { cancelUnconsumedRequestBody, parseExactJsonBytes } from "../auth/http.ts";
import type { DirectiveRouterOptions } from "../directives/router.ts";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";

export const SPONSOR_REPORTS_ROUTE = "/v1/sponsors/reports/list";

// Accountability is frozen at filing. Transferring a Fellow does not transfer
// its former sponsor's report history or expose reports from its new sponsor.
// Select metadata only: notes, decision prose and operator identities stay private.
const SNAPSHOT_SQL = `SELECT (
  SELECT json_group_array(json_object(
    'report_id', report_id, 'problem_id', problem_id, 'target', target_ref,
    'reason', reason, 'reporter_class', reporter_class, 'status', status,
    'created_at', created_at, 'resolved_at', resolved_at
  )) FROM (
    SELECT report_id, problem_id, COALESCE(source_ref, target_ref) AS target_ref, reason, reporter_class, status,
      created_at, resolved_at FROM reports
    WHERE reporter_sponsor_id = ?1
      AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND report_id < ?3))
    ORDER BY created_at DESC, report_id DESC LIMIT ?4
  )
) AS reports_json FROM sponsors WHERE sponsor_id = ?1 AND tombstoned_at IS NULL`;

export async function readSponsorReports(
  db: D1Database,
  sponsorId: string,
  request: SponsorReportsRequest,
): Promise<SponsorReportsResponse | undefined> {
  const read = () =>
    db
      .prepare(SNAPSHOT_SQL)
      .bind(
        sponsorId,
        request.before?.created_at ?? null,
        request.before?.report_id ?? null,
        request.limit + 1,
      )
      .first<{ reports_json: string }>();
  const snapshot = await read();
  if (snapshot === null) return undefined;
  if (
    typeof snapshot.reports_json !== "string" ||
    new TextEncoder().encode(snapshot.reports_json).length > SPONSOR_REPORTS_MAX_RESPONSE_BYTES
  )
    throw new Error("SPONSOR_REPORTS_SNAPSHOT_INVALID");
  const rows = z
    .array(SponsorReportSummarySchema)
    .max(request.limit + 1)
    .parse(JSON.parse(snapshot.reports_json));
  const reports = rows.slice(0, request.limit);
  const hasMore = rows.length > request.limit;
  const last = reports.at(-1);
  const response = SponsorReportsResponseSchema.parse({
    schema: REPORTS_SCHEMA_ID,
    sponsor_id: sponsorId,
    reports,
    has_more: hasMore,
    next_cursor:
      hasMore && last !== undefined
        ? { created_at: last.created_at, report_id: last.report_id }
        : null,
  });
  if (!sponsorReportsMatchRequest(sponsorId, request, response))
    throw new Error("SPONSOR_REPORTS_PAGE_INVALID");
  // Do not release a page after account deletion or changed resolution state.
  const current = await read();
  if (current === null) return undefined;
  if (current.reports_json !== snapshot.reports_json) throw new Error("SPONSOR_REPORTS_CHANGED");
  return response;
}

function privateResponse(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
}

function unavailable(): Response {
  return privateResponse(
    validatedProblem({
      status: 503,
      code: "INTERNAL_ERROR",
      title: "Report history could not be read",
      detail: "A complete report history under current account authority could not be established.",
      fixHint:
        "Refresh the page to read your reports. Do not copy private report notes into diagnostics.",
    }),
  );
}

export function createSponsorReportsRouter(
  options: Pick<DirectiveRouterOptions, "verifiedSponsor"> & { readonly db?: D1Database },
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(() => unavailable());
  app.post(SPONSOR_REPORTS_ROUTE, async (c) => {
    let sponsorId: string;
    let rawBody: Uint8Array;
    try {
      const verified = await options.verifiedSponsor(
        c.req.raw,
        SPONSOR_REPORTS_ROUTE,
        "sponsor.reports.list",
      );
      if (verified instanceof Response) return privateResponse(verified);
      if (
        verified.principal.type !== "sponsor" ||
        !SponsorIdSchema.safeParse(verified.principal.sponsorId).success ||
        !(verified.rawBody instanceof Uint8Array)
      )
        return unavailable();
      sponsorId = verified.principal.sponsorId;
      rawBody = new Uint8Array(verified.rawBody);
    } finally {
      cancelUnconsumedRequestBody(c.req.raw);
    }
    let input: unknown;
    if (
      new URL(c.req.url).search === "" &&
      c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json" &&
      rawBody.byteLength <= 2048
    ) {
      try {
        input = parseExactJsonBytes(rawBody);
      } catch {
        input = undefined;
      }
    }
    const parsed = SponsorReportsRequestSchema.safeParse(input);
    if (!parsed.success)
      return privateResponse(
        validatedProblem({
          status: 422,
          code: "SCHEMA_INVALID",
          title: "Invalid report history request",
          detail: "Use a bounded signed JSON request without query parameters.",
          fixHint: "Send an optional limit and copy next_cursor into before to read older reports.",
          rule: "A5",
          extensions: { schema: REPORTS_SCHEMA_ID, example: { limit: 20 } },
        }),
      );
    const response = await readSponsorReports(options.db ?? c.env.DB, sponsorId, parsed.data);
    if (response === undefined)
      return privateResponse(
        validatedProblem({
          status: 404,
          code: "ROUTE_NOT_FOUND",
          title: "No report history is available",
          detail: "No active sponsor account matches this request.",
          fixHint: "Sign in to your current sponsor account and refresh the console.",
        }),
      );
    const bytes = new TextEncoder().encode(JSON.stringify(response));
    if (bytes.byteLength > SPONSOR_REPORTS_MAX_RESPONSE_BYTES) return unavailable();
    return privateResponse(
      new Response(bytes, { headers: { "content-type": "application/json; charset=utf-8" } }),
    );
  });
  return app;
}
