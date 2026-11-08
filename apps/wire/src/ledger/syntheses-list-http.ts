import {
  PublicLedgerProblemIdSchema,
  SYNTHESES_LIST_DEFAULT_LIMIT,
  SYNTHESES_SCHEMA_ID,
  SynthesesListQuerySchema,
  synthesesListPath,
} from "@asimposium/contracts";
import { escapeHtml } from "@asimposium/render";
import type { Context } from "hono";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import {
  loadProblemSynthesisListPage,
  renderSynthesesHtmlFragment,
  renderSynthesesMarkdown,
} from "./synthesis.ts";
import { SynthesisReadError } from "./synthesis-read.ts";

const MEDIA = {
  json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
} as const;

function refusal(method: string, kind: "query" | "not-found" | "unavailable") {
  const response = validatedProblem({
    ...(kind === "query"
      ? {
          status: 400,
          code: "CURSOR_INVALID" as const,
          title: "Invalid synthesis collection cursor",
          detail:
            "Use canonical safe integers: through >= 0, before > 0 and limit from 1 to 200. A continuation requires its original through cursor and cannot exceed it. Unknown and repeated parameters are refused.",
          fixHint:
            "Start at the synthesis collection, then follow its next link with the returned snapshot unchanged.",
        }
      : kind === "not-found"
        ? {
            status: 404,
            code: "PROBLEM_NOT_FOUND" as const,
            title: "Public synthesis collection unavailable",
            detail: "No readable public problem matches this request.",
            fixHint: "Choose a readable public problem before browsing its syntheses.",
          }
        : {
            status: 503,
            code: "INTERNAL_ERROR" as const,
            title: "Synthesis collection temporarily unavailable",
            detail:
              "The bounded publication snapshot could not be established. This is not an empty collection.",
            fixHint: "Retry the unchanged request without advancing your saved cursor.",
          }),
    rule: "A5",
    extensions: {
      schema: SYNTHESES_SCHEMA_ID,
      example: { method: "GET", path: "/p/P-EXAMPLE/syntheses.json?through=20&before=12" },
    },
    headers: {
      "cache-control": "private, no-store",
      ...(kind === "unavailable" ? { "retry-after": "5" } : {}),
    },
  });
  return method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

/** All representations traverse the same verified immutable publications.
 * Current source controls are read before evaluating a cached representation. */
export async function handleSynthesesList(
  c: Context<{ Bindings: Env }>,
  format: keyof typeof MEDIA,
): Promise<Response> {
  const problem = c.req.param("id");
  const params = new URL(c.req.url).searchParams;
  const query = SynthesesListQuerySchema.safeParse(Object.fromEntries(params));
  if (
    !problem ||
    !PublicLedgerProblemIdSchema.safeParse(problem).success ||
    !query.success ||
    [...params.keys()].some((key) => params.getAll(key).length !== 1)
  )
    return refusal(c.req.method, "query");
  try {
    const result = await loadProblemSynthesisListPage(c.env.DB, problem, query.data);
    if (!result) return refusal(c.req.method, "not-found");
    const { face, unlisted } = result;
    const path = (before = face.before) =>
      synthesesListPath(problem, format, {
        through: face.cursor,
        ...(before === null ? {} : { before }),
        limit: query.data.limit ?? SYNTHESES_LIST_DEFAULT_LIMIT,
      });
    const next = face.next_before === null ? null : path(face.next_before);
    const position = `Publication snapshot #${face.cursor}; newest publications first${face.before === null ? "." : `, before event #${face.before}.`}`;
    const body =
      format === "json"
        ? JSON.stringify(face)
        : format === "md"
          ? `${renderSynthesesMarkdown(problem, face.syntheses, face.omitted)}\n\n${position}\n${next === null ? "" : `\n[Older syntheses](${next})\n`}`
          : `${renderSynthesesHtmlFragment(problem, face.syntheses, face.omitted)}\n<nav aria-label="Synthesis pages"><p>${position}</p>${next === null ? "" : `<a rel="next" href="${escapeHtml(next)}">Older syntheses</a>`}</nav>`;
    const bytes = new TextEncoder().encode(body);
    // JSON retains the six-MiB source budget plus envelope overhead. Escaped
    // reading faces may expand source bytes, but still have a fixed ceiling.
    if (bytes.byteLength > (format === "json" ? 8 : 48) * 1024 * 1024)
      return refusal(c.req.method, "unavailable");
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const etag = `"syntheses-${format}-${hash}"`;
    const headers = new Headers({
      "content-type": MEDIA[format],
      "cache-control": unlisted ? "private, no-store" : "public, max-age=0, must-revalidate",
      "content-location": path(),
      "x-content-type-options": "nosniff",
      link: `</schemas/syntheses.v1.json>; rel="describedby"; type="application/schema+json", <${path()}>; rel="canonical"${next === null ? "" : `, <${next}>; rel="next"`}`,
      etag,
    });
    if (unlisted) headers.set("x-robots-tag", "noindex, nofollow");
    if (format === "html")
      headers.set(
        "content-security-policy",
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      );
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
      error instanceof SynthesisReadError && error.code === "CURSOR_INVALID"
        ? "query"
        : "unavailable",
    );
  }
}
