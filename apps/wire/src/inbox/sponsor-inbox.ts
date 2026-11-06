import {
  INBOX_SCHEMA_ID,
  type ProblemCode,
  SPONSOR_INBOX_MAX_RESPONSE_BYTES,
  SponsorIdSchema,
  SponsorInboxItemSchema,
  type SponsorInboxRequest,
  SponsorInboxRequestSchema,
  type SponsorInboxResponse,
  SponsorInboxResponseSchema,
  sponsorInboxPageIsValid,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { cancelUnconsumedRequestBody, parseExactJsonBytes } from "../auth/http.ts";
import type { DirectiveRouterOptions } from "../directives/router.ts";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import { UNEXPIRED_INBOX_NOTICE_SQL, VISIBLE_INBOX_NOTICE_SQL } from "./follow-access.ts";

export const SPONSOR_INBOX_ROUTE = "/v1/sponsors/inbox";
const MAX_REQUEST_BYTES = 2048;

// Scope both content and counts inside the read. A transferred Fellow carries
// research notices, but a former sponsor's private instructions never transfer
// to the new sponsor's console. Numbered parameters are code-owned throughout.
const eligibleNotices = `WITH owned_fellow AS (
  SELECT f.fellow_id, f.name FROM enrollment_fellows f
  JOIN sponsors s ON s.sponsor_id = f.sponsor_id AND s.tombstoned_at IS NULL
  WHERE f.sponsor_id = ?1 AND f.fellow_id = ?2
), eligible AS (
  SELECT fellow_inbox_notices.* FROM fellow_inbox_notices
  JOIN owned_fellow f ON f.fellow_id = fellow_inbox_notices.fellow_id
  WHERE ${VISIBLE_INBOX_NOTICE_SQL}
    AND ${UNEXPIRED_INBOX_NOTICE_SQL.replace("?", "?3")}
    AND (fellow_inbox_notices.notice_type <> 'sponsor_directive' OR EXISTS (
      SELECT 1 FROM sponsor_directives d
      WHERE d.notice_id = fellow_inbox_notices.id
        AND d.fellow_id = fellow_inbox_notices.fellow_id AND d.sponsor_id = ?1
    ))
)`;

interface InboxSnapshot {
  name: string;
  notices_json: string;
}

/** Private read only: no acknowledgements, new credentials or session effects.
 * The page and its lookahead use the same ownership/visibility snapshot. A
 * second scoped read checks that every selected notice is still visible and
 * that sponsorship has not changed before releasing any content or count. */
export async function readSponsorInbox(
  db: D1Database,
  sponsorId: string,
  input: SponsorInboxRequest,
  now = Date.now(),
): Promise<SponsorInboxResponse | undefined> {
  const request = SponsorInboxRequestSchema.parse(input);
  const snapshot = await db
    .prepare(`${eligibleNotices}, page AS (
      SELECT * FROM eligible WHERE seq > ?4 AND (?6 = 0 OR acknowledged_at IS NULL)
      ORDER BY seq ASC LIMIT ?5
    ) SELECT name, (SELECT json_group_array(json_object(
      'id', id, 'type', notice_type, 'seq', seq, 'created_at', created_at,
      'acknowledged_at', acknowledged_at, 'expires_at', expires_at,
      'caused_by_event_id', caused_by_event_id, 'problem_id', problem_id,
      'target_id', target_id, 'title', title, 'detail', detail, 'impact_kind', impact_kind
    )) FROM page) AS notices_json FROM owned_fellow`)
    .bind(
      sponsorId,
      request.fellow_id,
      now,
      request.since ?? 0,
      request.limit + 1,
      request.unacknowledged_only === true ? 1 : 0,
    )
    .first<InboxSnapshot>();
  if (snapshot === null) return undefined;
  // Validate the lookahead too: malformed rows cannot establish has_more.
  const rows = SponsorInboxItemSchema.array()
    .max(request.limit + 1)
    .parse(JSON.parse(snapshot.notices_json));
  const pins = rows.map(({ id, seq, acknowledged_at }) => ({ id, seq, acknowledged_at }));
  const current = await db
    .prepare(`${eligibleNotices} SELECT name,
      (SELECT COUNT(*) FROM eligible WHERE acknowledged_at IS NULL) AS unacknowledged,
      (SELECT COUNT(*) FROM eligible n JOIN json_each(?4) pin
        ON n.id = json_extract(pin.value, '$.id')
        AND n.seq = json_extract(pin.value, '$.seq')
        AND n.acknowledged_at IS json_extract(pin.value, '$.acknowledged_at')) AS matched
      FROM owned_fellow`)
    .bind(sponsorId, request.fellow_id, now, JSON.stringify(pins))
    .first<{ name: string; unacknowledged: number; matched: number }>();
  if (current === null) return undefined;
  if (current.matched !== rows.length) throw new Error("SPONSOR_INBOX_CHANGED");
  const items = rows.slice(0, request.limit);
  const hasMore = rows.length > request.limit;
  const response = SponsorInboxResponseSchema.parse({
    schema: INBOX_SCHEMA_ID,
    sponsor_id: sponsorId,
    fellow_id: request.fellow_id,
    fellow_name: current.name,
    items,
    next_cursor: items.at(-1)?.seq ?? null,
    has_more: hasMore,
    fellow_unacknowledged_count: current.unacknowledged,
    omitted: hasMore ? ["limit_reached"] : [],
  });
  if (!sponsorInboxPageIsValid(response, request)) throw new Error("SPONSOR_INBOX_PAGE_INVALID");
  return response;
}

function privateResponse(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
}

function refusal(status: number, code: ProblemCode, detail: string, fixHint: string): Response {
  return privateResponse(
    validatedProblem({
      status,
      code,
      title: "Fellow notices are unavailable",
      detail,
      fixHint,
      ...(code === "SCHEMA_INVALID"
        ? {
            rule: "A5" as const,
            extensions: {
              schema: INBOX_SCHEMA_ID,
              example: { fellow_id: "fellow-example", limit: 25 },
            },
          }
        : {}),
    }),
  );
}

const unavailable = () =>
  refusal(
    503,
    "INTERNAL_ERROR",
    "The complete inbox page could not be read under current sponsorship and visibility.",
    "Retry the same request. If this persists, report the time without sharing private text.",
  );

export function createSponsorInboxRouter(
  options: Pick<DirectiveRouterOptions, "verifiedSponsor"> & { readonly db?: D1Database },
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(() => unavailable());
  app.post(SPONSOR_INBOX_ROUTE, async (c) => {
    let sponsorId: string;
    let rawBody: Uint8Array;
    try {
      const verified = await options.verifiedSponsor(c.req.raw, SPONSOR_INBOX_ROUTE, "inbox.read");
      if (verified instanceof Response) return privateResponse(verified);
      if (
        verified.principal.type !== "sponsor" ||
        !SponsorIdSchema.safeParse(verified.principal.sponsorId).success ||
        !(verified.rawBody instanceof Uint8Array)
      )
        return unavailable();
      sponsorId = verified.principal.sponsorId;
      rawBody = verified.rawBody;
    } finally {
      cancelUnconsumedRequestBody(c.req.raw);
    }
    if (new URL(c.req.url).search !== "" || rawBody.byteLength > MAX_REQUEST_BYTES)
      return refusal(
        400,
        "SCHEMA_INVALID",
        "Use a bounded signed JSON body without query parameters.",
        "Send fellow_id and optional since, limit and unacknowledged_only in the signed body.",
      );
    let input: unknown;
    try {
      input = parseExactJsonBytes(rawBody);
    } catch {
      input = undefined;
    }
    const parsed = SponsorInboxRequestSchema.safeParse(input);
    if (!parsed.success)
      return refusal(
        422,
        "SCHEMA_INVALID",
        "The inbox request does not match the contract.",
        "Send a Fellow ID and copy the previous next_cursor into since for another page.",
      );
    const db = options.db ?? c.env.DB;
    const response = await readSponsorInbox(db, sponsorId, parsed.data);
    if (response === undefined)
      return refusal(
        404,
        "INBOX_NOT_FOUND",
        "The requested Fellow is not available to this sponsor.",
        "Select a Fellow currently listed in your sponsor console.",
      );
    const bytes = new TextEncoder().encode(JSON.stringify(response));
    if (bytes.byteLength > SPONSOR_INBOX_MAX_RESPONSE_BYTES) return unavailable();
    return privateResponse(
      new Response(bytes, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );
  });
  return app;
}
