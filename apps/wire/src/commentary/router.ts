import {
  COMMENTARY_SCHEMA_ID,
  type CommentaryListQuery,
  CommentaryListQuerySchema,
  SponsorCommentaryPostRequestSchema,
  SponsorCommentaryTombstoneRequestSchema,
} from "@asimposium/contracts";
import { renderCommentaryHtml, renderCommentaryMarkdown } from "@asimposium/render";
import { Hono } from "hono";
import { parseExactJsonBytes } from "../auth/http.ts";
import type { Env } from "../env.ts";
import type { PublicCandidateScreener } from "../screening/public-candidate.ts";
import { CommentaryService, commentaryContractProblem as problem, sha256Hex } from "./service.ts";

const MAX_IDEMPOTENCY_KEY = 160;

export interface CommentaryRouterOptions {
  readonly verifiedSponsor: (
    request: Request,
    route: string,
    action: string,
  ) => Promise<
    | {
        readonly principal: { readonly type: "sponsor"; readonly sponsorId: string };
        readonly rawBody: Uint8Array;
      }
    | Response
  >;
  readonly screenPromotion?: PublicCandidateScreener;
}

function privateNoStore(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

function publicCache(response: Response, etag: string, unlisted: boolean): Response {
  response.headers.set(
    "cache-control",
    unlisted ? "private, no-store" : "public, max-age=0, must-revalidate",
  );
  if (unlisted) {
    response.headers.set("x-robots-tag", "noindex, nofollow");
  }
  response.headers.set("etag", etag);
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

function commentaryNotFoundResponse(method: string): Response {
  const res = privateNoStore(
    problem({
      status: 404,
      code: "PROBLEM_NOT_FOUND",
      title: "Problem Not Found",
      detail: "No public problem is available at this identifier.",
      fixHint: "Verify the problem identifier.",
      rule: "A5",
    }),
  );
  return method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
}

async function computeEtag(face: string, body: string): Promise<string> {
  const hash = await sha256Hex(`${face}\n${body}`);
  return `"${hash}"`;
}

function ifNoneMatchMatches(header: string | null | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((s) => s.trim())
    .some((s) => s === "*" || s === etag);
}

function commentaryQuery(query: Record<string, string>): CommentaryListQuery | Response {
  const parsed = CommentaryListQuerySchema.safeParse(query);
  if (parsed.success && Number.isSafeInteger(parsed.data.cursor)) return parsed.data;
  return problem({
    status: 400,
    code: "COMMENTARY_QUERY_INVALID",
    title: "Invalid commentary page query",
    detail: "cursor must be a nonnegative safe integer and limit must be between 1 and 100.",
    fixHint: "Use the previous page's cursor and a bounded limit.",
    example: { method: "GET", path: "/p/P-DEMO/commentary.json?cursor=0&limit=50" },
  });
}

export function createCommentaryRouter(options: CommentaryRouterOptions): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // 1. POST /v1/problems/:id/commentary (sponsor service envelope write)
  app.post("/v1/problems/:id/commentary", async (c) => {
    const verified = await options.verifiedSponsor(c.req.raw, c.req.path, "post-commentary");
    if (verified instanceof Response) return privateNoStore(verified);

    const idempotencyKey = c.req.header("idempotency-key");
    if (
      !idempotencyKey ||
      idempotencyKey.length > MAX_IDEMPOTENCY_KEY ||
      !/^[A-Za-z0-9._-]+$/.test(idempotencyKey)
    ) {
      return privateNoStore(
        problem({
          status: 400,
          code: "IDEMPOTENCY_KEY_INVALID",
          title: "Invalid Idempotency Key",
          detail: "A stable Idempotency-Key header is required for sponsor commentary writes.",
          fixHint: "Provide 1-160 letters, digits, dots, underscores, or hyphens.",
          rule: "A5",
        }),
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = parseExactJsonBytes(verified.rawBody);
    } catch {
      return privateNoStore(
        problem({
          status: 400,
          code: "MALFORMED_JSON",
          title: "Malformed JSON Request",
          detail: "The request body could not be parsed as exact valid JSON.",
          fixHint: "Check your JSON syntax and try again.",
          rule: "A5",
        }),
      );
    }

    const parsed = SponsorCommentaryPostRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return privateNoStore(
        problem({
          status: 422,
          code: "COMMENTARY_BODY_INVALID",
          title: "Invalid Commentary Request",
          detail: "The commentary request body does not conform to the contracted schema.",
          fixHint:
            "Ensure problem_id is valid, body is non-empty up to 2000 chars, and relates_to contains valid references.",
          rule: "A5",
          extensions: {
            schema: COMMENTARY_SCHEMA_ID,
            errors: parsed.error.issues,
          },
        }),
      );
    }

    const problemId = c.req.param("id");
    if (parsed.data.problem_id !== problemId) {
      return privateNoStore(
        problem({
          status: 422,
          code: "PROBLEM_ID_MISMATCH",
          title: "Problem Identifier Mismatch",
          detail: `Route problem id ${problemId} does not match body problem_id ${parsed.data.problem_id}.`,
          fixHint: "Ensure the path problem id and JSON body problem_id match exactly.",
          rule: "A5",
        }),
      );
    }

    const requestDigest = await sha256Hex(verified.rawBody);
    const service = new CommentaryService({
      db: c.env.DB,
      ai: c.env.AI,
      sponsorLimit: c.env.SPONSOR_PROMOTION_RATE_LIMIT,
      ...(options.screenPromotion === undefined
        ? {}
        : { screenPromotion: options.screenPromotion }),
    });
    const result = await service.postCommentary(
      verified.principal.sponsorId,
      parsed.data,
      idempotencyKey,
      requestDigest,
    );

    if (!result.ok) {
      return privateNoStore(result.response);
    }

    const status = result.isReplay ? 200 : 201;
    return privateNoStore(
      new Response(JSON.stringify(result.item), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );
  });

  // 2. POST /v1/problems/:id/commentary/:commentaryId/tombstone (sponsor service envelope write)
  app.post("/v1/problems/:id/commentary/:commentaryId/tombstone", async (c) => {
    const verified = await options.verifiedSponsor(c.req.raw, c.req.path, "tombstone-commentary");
    if (verified instanceof Response) return privateNoStore(verified);

    const idempotencyKey = c.req.header("idempotency-key");
    if (
      !idempotencyKey ||
      idempotencyKey.length > MAX_IDEMPOTENCY_KEY ||
      !/^[A-Za-z0-9._-]+$/.test(idempotencyKey)
    ) {
      return privateNoStore(
        problem({
          status: 400,
          code: "IDEMPOTENCY_KEY_INVALID",
          title: "Invalid Idempotency Key",
          detail: "A stable Idempotency-Key header is required for commentary tombstone writes.",
          fixHint: "Provide 1-160 letters, digits, dots, underscores, or hyphens.",
          rule: "A5",
        }),
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = parseExactJsonBytes(verified.rawBody);
    } catch {
      return privateNoStore(
        problem({
          status: 400,
          code: "MALFORMED_JSON",
          title: "Malformed JSON Request",
          detail: "The request body could not be parsed as exact valid JSON.",
          fixHint: "Check your JSON syntax and try again.",
          rule: "A5",
        }),
      );
    }

    const parsed = SponsorCommentaryTombstoneRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return privateNoStore(
        problem({
          status: 422,
          code: "TOMBSTONE_BODY_INVALID",
          title: "Invalid Tombstone Request",
          detail: "The tombstone request body does not match the contracted schema.",
          fixHint: "Provide problem_id, commentary_id, and a valid reason.",
          rule: "A5",
          extensions: {
            schema: COMMENTARY_SCHEMA_ID,
            errors: parsed.error.issues,
          },
        }),
      );
    }

    const problemId = c.req.param("id");
    const commentaryId = c.req.param("commentaryId");

    if (parsed.data.problem_id !== problemId) {
      return privateNoStore(
        problem({
          status: 422,
          code: "PROBLEM_ID_MISMATCH",
          title: "Problem Identifier Mismatch",
          detail: `Route problem id ${problemId} does not match body problem_id ${parsed.data.problem_id}.`,
          fixHint: "Ensure path and body problem IDs match.",
          rule: "A5",
        }),
      );
    }

    if (parsed.data.commentary_id !== commentaryId) {
      return privateNoStore(
        problem({
          status: 422,
          code: "COMMENTARY_ID_MISMATCH",
          title: "Commentary Identifier Mismatch",
          detail: `Route commentary id ${commentaryId} does not match body commentary_id ${parsed.data.commentary_id}.`,
          fixHint: "Ensure path and body commentary IDs match.",
          rule: "A5",
        }),
      );
    }

    const requestDigest = await sha256Hex(verified.rawBody);
    const service = new CommentaryService({
      db: c.env.DB,
      ai: c.env.AI,
      sponsorLimit: c.env.SPONSOR_PROMOTION_RATE_LIMIT,
      ...(options.screenPromotion === undefined
        ? {}
        : { screenPromotion: options.screenPromotion }),
    });
    const result = await service.tombstoneCommentary(
      verified.principal.sponsorId,
      parsed.data,
      idempotencyKey,
      requestDigest,
    );

    if (!result.ok) {
      return privateNoStore(result.response);
    }

    return privateNoStore(
      new Response(JSON.stringify(result.item), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );
  });

  // 3. GET/HEAD /p/:id/commentary (canonical 308 redirect to .md face)
  app.on(["GET", "HEAD"], "/p/:id/commentary", (c) => {
    const problemId = c.req.param("id");
    const url = new URL(c.req.url);
    const redirectUrl = `/p/${encodeURIComponent(problemId)}/commentary.md${url.search}`;
    return c.redirect(redirectUrl, 308);
  });

  // 4. GET/HEAD /p/:id/commentary.md (Markdown canonical agent face)
  app.on(["GET", "HEAD"], "/p/:id/commentary.md", async (c) => {
    const problemId = c.req.param("id");
    const query = commentaryQuery(c.req.query());
    if (query instanceof Response) return privateNoStore(query);
    const service = new CommentaryService({ db: c.env.DB, ai: c.env.AI });
    const scoped = await service.listCommentariesWithScope(problemId, query);

    if (!scoped) {
      return commentaryNotFoundResponse(c.req.method);
    }

    const md = renderCommentaryMarkdown(scoped.list);
    const etag = await computeEtag("markdown", md);
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) {
      return publicCache(new Response(null, { status: 304 }), etag, scoped.unlisted);
    }

    return publicCache(
      new Response(c.req.method === "HEAD" ? null : md, {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8" },
      }),
      etag,
      scoped.unlisted,
    );
  });

  // 5. GET/HEAD /p/:id/commentary.json (JSON face)
  app.on(["GET", "HEAD"], "/p/:id/commentary.json", async (c) => {
    const problemId = c.req.param("id");
    const query = commentaryQuery(c.req.query());
    if (query instanceof Response) return privateNoStore(query);
    const service = new CommentaryService({ db: c.env.DB, ai: c.env.AI });
    const scoped = await service.listCommentariesWithScope(problemId, query);

    if (!scoped) {
      return commentaryNotFoundResponse(c.req.method);
    }

    const json = JSON.stringify(scoped.list, null, 2);
    const etag = await computeEtag("json", json);
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) {
      return publicCache(new Response(null, { status: 304 }), etag, scoped.unlisted);
    }

    return publicCache(
      new Response(c.req.method === "HEAD" ? null : json, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
      etag,
      scoped.unlisted,
    );
  });

  // 6. GET/HEAD /p/:id/commentary.html (HTML face)
  app.on(["GET", "HEAD"], "/p/:id/commentary.html", async (c) => {
    const problemId = c.req.param("id");
    const query = commentaryQuery(c.req.query());
    if (query instanceof Response) return privateNoStore(query);
    const service = new CommentaryService({ db: c.env.DB, ai: c.env.AI });
    const scoped = await service.listCommentariesWithScope(problemId, query);

    if (!scoped) {
      return commentaryNotFoundResponse(c.req.method);
    }

    const html = renderCommentaryHtml(scoped.list);
    const etag = await computeEtag("html", html);
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) {
      return publicCache(new Response(null, { status: 304 }), etag, scoped.unlisted);
    }

    return publicCache(
      new Response(c.req.method === "HEAD" ? null : html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      etag,
      scoped.unlisted,
    );
  });

  // 7. GET/HEAD /v1/problems/:id/commentary (JSON API read)
  app.on(["GET", "HEAD"], "/v1/problems/:id/commentary", async (c) => {
    const problemId = c.req.param("id");
    const query = commentaryQuery(c.req.query());
    if (query instanceof Response) return privateNoStore(query);
    const service = new CommentaryService({ db: c.env.DB, ai: c.env.AI });
    const scoped = await service.listCommentariesWithScope(problemId, query);

    if (!scoped) {
      return commentaryNotFoundResponse(c.req.method);
    }

    const json = JSON.stringify(scoped.list);
    const etag = await computeEtag("json-api", json);
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) {
      return publicCache(new Response(null, { status: 304 }), etag, scoped.unlisted);
    }
    return publicCache(
      new Response(c.req.method === "HEAD" ? null : json, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
      etag,
      scoped.unlisted,
    );
  });

  return app;
}
