import {
  SPONSOR_FOLLOW_LIMIT,
  SPONSOR_FOLLOW_PAGE_SIZE,
  SPONSOR_FOLLOWS_SCHEMA_ID,
  SponsorFollowListResponseSchema,
  SponsorFollowQuerySchema,
  SponsorFollowRequestSchema,
  SponsorIdSchema,
} from "@asimposium/contracts";
import { Hono } from "hono";
import type { DirectiveRouterOptions } from "../directives/router.ts";
import type { Env } from "../env.ts";
import { problem } from "../http/envelope.ts";
import { readSponsorFollowActivity, unavailableSponsorFollow } from "./sponsor-follow-activity.ts";
import {
  currentSponsorFollowRows, listSponsorFollowRows, setSponsorFollow, SponsorFollowError,
} from "./sponsor-follows.ts";

export const SPONSOR_FOLLOW_ROUTE = "/v1/sponsors/follows";
function privateResponse(response: Response) {
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}
function refusal(status: number, code: string, detail: string, hint: string) {
  return privateResponse(problem({
    status, code, title: "Problem follow was not accepted", detail, fixHint: hint, rule: "A5",
    extensions: {
      schema: SPONSOR_FOLLOWS_SCHEMA_ID,
      example: { problem_id: "P-DEMO", following: true },
    },
  }));
}

export function createSponsorFollowRouter(
  options: Pick<DirectiveRouterOptions, "verifiedSponsor">,
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.get(SPONSOR_FOLLOW_ROUTE, async c => {
    const verified = await options.verifiedSponsor(c.req.raw, SPONSOR_FOLLOW_ROUTE, "list-follows");
    if (verified instanceof Response) return privateResponse(verified);
    const sponsor = SponsorIdSchema.parse(verified.principal.sponsorId);
    const params = new URL(c.req.url).searchParams;
    if ([...params.keys()].some(key => key !== "after") || params.getAll("after").length > 1)
      return refusal(400, "CURSOR_INVALID", "The follow cursor is invalid.", "Use the returned next_after once, or start from the first page.");
    const parsed = SponsorFollowQuerySchema.safeParse(
      params.has("after") ? { after: params.get("after") } : {},
    );
    if (!parsed.success)
      return refusal(400, "CURSOR_INVALID", "The follow cursor is invalid.", "Use the returned next_after unchanged.");
    const rows = await listSponsorFollowRows(c.env.DB, sponsor, parsed.data.after);
    if (rows.length > SPONSOR_FOLLOW_PAGE_SIZE + 1)
      throw new Error("SPONSOR_FOLLOW_PAGE_INVALID");
    const selected = rows.slice(0, SPONSOR_FOLLOW_PAGE_SIZE);
    const results = await Promise.all(selected.map(async row => {
      try { return await readSponsorFollowActivity(c.env.DB, row); }
      catch { return unavailableSponsorFollow(row); }
    }));
    const current = await currentSponsorFollowRows(c.env.DB, sponsor, selected.map(row => row.problem_id));
    const currentById = new Map(current.map(row => [row.problem_id, row]));
    const follows = results.flatMap(item => {
      const row = currentById.get(item.problem_id);
      // A remove-and-refollow is a new preference, not the old preview.
      if (!row || row.followed_at !== item.followed_at) return [];
      return [row.cursor === null || (item.cursor !== null && row.cursor < item.cursor)
        ? unavailableSponsorFollow(row) : item];
    });
    return privateResponse(c.json(SponsorFollowListResponseSchema.parse({
      schema: SPONSOR_FOLLOWS_SCHEMA_ID,
      sponsor_id: sponsor,
      follows,
      next_after: rows.length > SPONSOR_FOLLOW_PAGE_SIZE
        ? selected.at(-1)?.problem_id ?? null : null,
    })));
  });

  app.post(SPONSOR_FOLLOW_ROUTE, async c => {
    const verified = await options.verifiedSponsor(c.req.raw, SPONSOR_FOLLOW_ROUTE, "set-follow");
    if (verified instanceof Response) return privateResponse(verified);
    const sponsor = SponsorIdSchema.parse(verified.principal.sponsorId);
    if (new URL(c.req.url).search)
      return refusal(400, "SCHEMA_INVALID", "Follow changes do not accept query parameters.", "Send the exact problem and desired following state in the signed body.");
    const key = c.req.header("idempotency-key");
    if (key === undefined || !/^[A-Za-z0-9._-]{1,160}$/.test(key))
      return refusal(400, "IDEMPOTENCY_KEY_INVALID", "A stable Idempotency-Key is required.", "Reuse the same key for an unchanged retry; use a new key for a new decision.");
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(verified.rawBody)); }
    catch { value = undefined; }
    const parsed = SponsorFollowRequestSchema.safeParse(value);
    if (!parsed.success)
      return refusal(422, "SCHEMA_INVALID", "The follow request does not match the contract.", "Send a canonical problem_id and following: true or false.");
    try {
      return privateResponse(c.json(await setSponsorFollow(c.env.DB, sponsor, parsed.data, key)));
    } catch (error) {
      if (!(error instanceof SponsorFollowError)) throw error;
      if (error.reason === "conflict")
        return refusal(409, "IDEMPOTENCY_CONFLICT", "This key belongs to another follow decision.", "Retry the original body or use a new key for a new decision.");
      if (error.reason === "limit")
        return refusal(429, "RATE_LIMITED", `A sponsor can follow at most ${SPONSOR_FOLLOW_LIMIT} problems.`, "Unfollow another problem before adding one.");
      return refusal(404, "PROBLEM_NOT_FOUND", "The problem is not publicly available.", "Choose a readable public problem. Following never grants private access.");
    }
  });
  return app;
}
