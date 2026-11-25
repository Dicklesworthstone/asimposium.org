import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import {
  INTEGRITY_CASES_SCHEMA_ID,
  PublicIntegrityNoticesQuerySchema,
  PublicIntegrityNoticesResponseSchema,
} from "@asimposium/contracts/integrity-cases";
import {
  integrityNoticesPath,
  renderIntegrityNoticesHtml,
  renderIntegrityNoticesMarkdown,
} from "@asimposium/render";
import { Hono } from "hono";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import { readPublicIntegrityNotices } from "./integrity-read.ts";

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
          title: "Invalid integrity-notice continuation",
          detail:
            "Use only one after parameter containing the complete next_after case identifier.",
          fixHint: "Start at the public notice collection and follow its next link unchanged.",
        }
      : kind === "not-found"
        ? {
            status: 404,
            code: "PROBLEM_NOT_FOUND" as const,
            title: "Public notice source unavailable",
            detail: "No readable public problem matches this request.",
            fixHint: "Choose a readable problem from /problems.json.",
          }
        : {
            status: 503,
            code: "INTERNAL_ERROR" as const,
            title: "Integrity notices are temporarily unavailable",
            detail: "The bounded public notice projection could not be verified.",
            fixHint: "Retry this unchanged request without advancing your continuation.",
          }),
    ...(kind === "unavailable"
      ? {}
      : {
          rule: "A5" as const,
          extensions: {
            schema: INTEGRITY_CASES_SCHEMA_ID,
            example: { method: "GET", path: "/p/P-EXAMPLE/integrity.json" },
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

export function createIntegrityNoticeRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  for (const format of ["json", "md", "html"] as const) {
    app.on(["GET", "HEAD"], `/p/:id/integrity.${format}`, async (c) => {
      const problem = c.req.param("id");
      const params = new URL(c.req.url).searchParams;
      const query = PublicIntegrityNoticesQuerySchema.safeParse(Object.fromEntries(params));
      if (
        !PublicLedgerProblemIdSchema.safeParse(problem).success ||
        !query.success ||
        [...params.keys()].some((key) => params.getAll(key).length !== 1)
      )
        return refusal(c.req.method, "query");
      const after = query.data.after;
      try {
        const result = await readPublicIntegrityNotices(c.env.DB, problem, after);
        const face = PublicIntegrityNoticesResponseSchema.parse(result.face);
        const body =
          format === "json"
            ? `${JSON.stringify(face)}\n`
            : format === "md"
              ? renderIntegrityNoticesMarkdown(face)
              : renderIntegrityNoticesHtml(face);
        const bytes = new TextEncoder().encode(body);
        if (bytes.byteLength > 256 * 1024) return refusal(c.req.method, "unavailable");
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        const etag = `"integrity-notices-${format}-${digest}"`;
        const canonical = integrityNoticesPath(face.problem_id, format, after);
        const next =
          face.next_after === null
            ? null
            : integrityNoticesPath(face.problem_id, format, face.next_after);
        const headers = new Headers({
          "content-type": MEDIA[format],
          "cache-control": result.unlisted
            ? "private, no-store"
            : "public, max-age=0, must-revalidate",
          "content-location": canonical,
          "x-content-type-options": "nosniff",
          link: `</schemas/integrity-cases.v1.json>; rel="describedby"; type="application/schema+json", <${canonical}>; rel="canonical"${next === null ? "" : `, <${next}>; rel="next"`}`,
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
        const notFound = error instanceof Error && "code" in error && error.code === "NOT_FOUND";
        return refusal(c.req.method, notFound ? "not-found" : "unavailable");
      }
    });
  }
  app.on(["GET", "HEAD"], "/p/:id/integrity", (c) => {
    const url = new URL(c.req.url);
    return c.redirect(`${url.pathname}.md${url.search}`, 308);
  });
  return app;
}
