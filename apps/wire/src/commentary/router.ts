import {
  COMMENTARY_SCHEMA_ID,
  CommentaryListQuerySchema,
  SponsorCommentaryPostRequestSchema,
  SponsorCommentaryTombstoneRequestSchema,
} from "@asimposium/contracts";
import {
  renderCommentaryHtml,
  renderCommentaryMarkdown,
} from "@asimposium/render";
import { Hono } from "hono";
import { parseExactJsonBytes } from "../auth/http.ts";
import type { Env } from "../env.ts";
import { problem } from "../http/envelope.ts";
import { CommentaryService, sha256Hex } from "./service.ts";

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
}

function privateNoStore(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

function publicCache(response: Response, etag: string): Response {
  response.headers.set("cache-control", "public, max-age=0, must-revalidate");
  response.headers.set("etag", etag);
  response.headers.set("x-content-type-options", "nosniff");
  return response;
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
          fixHint: "Ensure problem_id is valid, body is non-empty up to 2000 chars, and relates_to contains valid references.",
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
    const service = new CommentaryService({ db: c.env.DB, ai: c.env.AI });
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
    const service = new CommentaryService({ db: c.env.DB, ai: c.env.AI });
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

  // 3. GET /p/:id/commentary (canonical 308 redirect to .md face)
  app.get("/p/:id/commentary", (c) => {
    const problemId = c.req.param("id");
    const url = new URL(c.req.url);
    const redirectUrl = `/p/${encodeURIComponent(problemId)}/commentary.md${url.search}`;
    return c.redirect(redirectUrl, 308);
  });

  // 4. GET /p/:id/commentary.md (Markdown canonical agent face)
  app.get("/p/:id/commentary.md", async (c) => {
    const problemId = c.req.param("id");
    const query = CommentaryListQuerySchema.parse(c.req.query());
    const service = new CommentaryService({ db: c.env.DB, ai: c.env.AI });
    const list = await service.listCommentaries(problemId, query);

    if (!list) {
      return problem({
        status: 404,
        code: "PROBLEM_NOT_FOUND",
        title: "Problem Not Found",
        detail: `Problem ${problemId} does not exist.`,
        fixHint: "Verify the problem identifier.",
        rule: "A5",
      });
    }

    const md = renderCommentaryMarkdown(list);
    const etag = await computeEtag("markdown", md);
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers: { etag } });
    }

    return publicCache(
      new Response(md, {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8" },
      }),
      etag,
    );
  });

  // 5. GET /p/:id/commentary.json (JSON face)
  app.get("/p/:id/commentary.json", async (c) => {
    const problemId = c.req.param("id");
    const query = CommentaryListQuerySchema.parse(c.req.query());
    const service = new CommentaryService({ db: c.env.DB, ai: c.env.AI });
    const list = await service.listCommentaries(problemId, query);

    if (!list) {
      return problem({
        status: 404,
        code: "PROBLEM_NOT_FOUND",
        title: "Problem Not Found",
        detail: `Problem ${problemId} does not exist.`,
        fixHint: "Verify the problem identifier.",
        rule: "A5",
      });
    }

    const json = JSON.stringify(list, null, 2);
    const etag = await computeEtag("json", json);
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers: { etag } });
    }

    return publicCache(
      new Response(json, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
      etag,
    );
  });

  // 6. GET /p/:id/commentary.html (HTML face)
  app.get("/p/:id/commentary.html", async (c) => {
    const problemId = c.req.param("id");
    const query = CommentaryListQuerySchema.parse(c.req.query());
    const service = new CommentaryService({ db: c.env.DB, ai: c.env.AI });
    const list = await service.listCommentaries(problemId, query);

    if (!list) {
      return problem({
        status: 404,
        code: "PROBLEM_NOT_FOUND",
        title: "Problem Not Found",
        detail: `Problem ${problemId} does not exist.`,
        fixHint: "Verify the problem identifier.",
        rule: "A5",
      });
    }

    const html = renderCommentaryHtml(list);
    const etag = await computeEtag("html", html);
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers: { etag } });
    }

    return publicCache(
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      etag,
    );
  });

  // 7. GET /v1/problems/:id/commentary (JSON API read)
  app.get("/v1/problems/:id/commentary", async (c) => {
    const problemId = c.req.param("id");
    const query = CommentaryListQuerySchema.parse(c.req.query());
    const service = new CommentaryService({ db: c.env.DB, ai: c.env.AI });
    const list = await service.listCommentaries(problemId, query);

    if (!list) {
      return problem({
        status: 404,
        code: "PROBLEM_NOT_FOUND",
        title: "Problem Not Found",
        detail: `Problem ${problemId} does not exist.`,
        fixHint: "Verify the problem identifier.",
        rule: "A5",
      });
    }

    return new Response(JSON.stringify(list), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=0, must-revalidate",
      },
    });
  });

  return app;
}
