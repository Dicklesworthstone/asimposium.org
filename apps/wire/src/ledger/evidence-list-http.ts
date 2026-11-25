import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import {
  evidenceListPath,
  RESEARCH_LISTS_SCHEMA_ID,
  ResearchListQuerySchema,
} from "@asimposium/contracts/research-lists";
import { renderEvidenceListHtml, renderEvidenceListMarkdown } from "@asimposium/render";
import { Hono } from "hono";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import { EvidenceListReadError, loadEvidenceList } from "./evidence-list-read.ts";

const MEDIA = {
  json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
} as const;

function refusal(method: string, kind: "query" | "not-found" | "unavailable"): Response {
  const response = validatedProblem({
    ...(kind === "query"
      ? {
          status: 400,
          code: "CURSOR_INVALID" as const,
          title: "Invalid evidence collection cursor",
          detail:
            "Use canonical nonnegative through and after cursors and an optional exact claim target such as C-1@2. Every after cursor requires its original through cursor; keep target unchanged. Unknown, repeated and future cursors and invalid targets are refused.",
          fixHint: "Start at the evidence collection and follow its next link unchanged.",
        }
      : kind === "not-found"
        ? {
            status: 404,
            code: "PROBLEM_NOT_FOUND" as const,
            title: "Public evidence source unavailable",
            detail: "No readable public problem matches this request.",
            fixHint: "Choose a readable problem from /problems.json.",
          }
        : {
            status: 503,
            code: "INTERNAL_ERROR" as const,
            title: "Evidence history is temporarily unavailable",
            detail:
              "A complete bounded evidence page could not be verified. No continuation was advanced.",
            fixHint: "Retry this unchanged request without advancing your saved cursor.",
          }),
    ...(kind === "unavailable"
      ? {}
      : {
          rule: "A5" as const,
          extensions: {
            schema: `${RESEARCH_LISTS_SCHEMA_ID}#/properties/query`,
            example: { method: "GET", path: "/p/P-EXAMPLE/evidence.json" },
          },
        }),
    headers: {
      "cache-control": "private, no-store",
      ...(kind === "unavailable" ? { "retry-after": "5" } : {}),
    },
  });
  return method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

export function createEvidenceListRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  for (const format of ["json", "md", "html"] as const) {
    app.on(["GET", "HEAD"], `/p/:id/evidence.${format}`, async (c) => {
      const problem = c.req.param("id");
      const params = new URL(c.req.url).searchParams;
      const query = ResearchListQuerySchema.safeParse(Object.fromEntries(params));
      if (
        !PublicLedgerProblemIdSchema.safeParse(problem).success ||
        !query.success ||
        [...params.keys()].some((key) => params.getAll(key).length !== 1)
      )
        return refusal(c.req.method, "query");
      try {
        const result = await loadEvidenceList(c.env.DB, problem, query.data);
        const face = result.face;
        const body =
          format === "json"
            ? `${JSON.stringify(face)}\n`
            : format === "md"
              ? renderEvidenceListMarkdown(face)
              : renderEvidenceListHtml(face);
        const bytes = new TextEncoder().encode(body);
        if (bytes.byteLength > 256 * 1024) return refusal(c.req.method, "unavailable");
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        const etag = `"evidence-list-${format}-${hash}"`;
        const path = (after = face.after) =>
          evidenceListPath(problem, format, {
            through: face.cursor,
            after,
            ...(face.target === undefined ? {} : { target: face.target }),
          });
        const next = face.next_after === null ? null : path(face.next_after);
        const headers = new Headers({
          "content-type": MEDIA[format],
          "cache-control": result.unlisted
            ? "private, no-store"
            : "public, max-age=0, must-revalidate",
          "content-location": path(),
          "x-content-type-options": "nosniff",
          link: `</schemas/research-lists.v1.json>; rel="describedby"; type="application/schema+json", <${path()}>; rel="canonical"${next === null ? "" : `, <${next}>; rel="next"`}`,
          etag,
        });
        if (result.unlisted) headers.set("x-robots-tag", "noindex, nofollow");
        if (format === "html")
          headers.set(
            "content-security-policy",
            "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
          );
        await result.assertCurrent();
        const unchanged = c.req
          .header("if-none-match")
          ?.split(",")
          .some((part) => {
            const candidate = part.trim();
            return candidate === "*" || candidate.replace(/^W\//, "") === etag;
          });
        if (unchanged) return new Response(null, { status: 304, headers });
        headers.set("content-length", String(bytes.byteLength));
        return new Response(c.req.method === "HEAD" ? null : bytes, { status: 200, headers });
      } catch (error) {
        return refusal(
          c.req.method,
          error instanceof EvidenceListReadError ? error.code : "unavailable",
        );
      }
    });
  }
  app.on(["GET", "HEAD"], "/p/:id/evidence", (c) => {
    const url = new URL(c.req.url);
    return c.redirect(`${url.pathname}.md${url.search}`, 308);
  });
  return app;
}
