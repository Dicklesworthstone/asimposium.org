import {
  PublicLedgerProblemIdSchema,
  RETRACTIONS_LIST_DEFAULT_LIMIT,
  RETRACTIONS_SCHEMA_ID,
  RetractionsListQuerySchema,
  RetractionsListResponseSchema,
  retractionsListPath,
} from "@asimposium/contracts";
import { escapeHtml } from "@asimposium/render";
import type { Context } from "hono";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import {
  loadProblemRetractions,
  RetractionReadError,
  renderRetractionsHtmlFragment,
  renderRetractionsMarkdown,
} from "./retractions.ts";

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
          title: "Invalid retraction selection",
          detail:
            "Use canonical nonnegative safe integers for through and after, and limit from 1 to 200. A continuation requires its original through cursor. An exact R- target cannot combine with after. Unknown and repeated parameters are refused.",
          fixHint:
            "Follow the collection's next link unchanged, or select one correction with target and an optional through cursor.",
        }
      : kind === "not-found"
        ? {
            status: 404,
            code: "PROBLEM_NOT_FOUND" as const,
            title: "Public retraction unavailable",
            detail: "No readable public problem or selected correction matches this request.",
            fixHint: "Choose a public problem and a published retraction reference.",
          }
        : {
            status: 503,
            code: "INTERNAL_ERROR" as const,
            title: "Retraction source temporarily unavailable",
            detail:
              "The immutable correction could not be read and verified. This is not an empty history or evidence that the correction was undone.",
            fixHint: "Retry the unchanged request without advancing your saved cursor.",
          }),
    ...(kind === "unavailable"
      ? {}
      : {
          rule: "A5" as const,
          extensions: {
            schema: RETRACTIONS_SCHEMA_ID,
            example: { method: "GET", path: "/p/P-EXAMPLE/retractions.json?target=R-1" },
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

/** All faces use the same exact-source and pagination contract. Current
 * controls precede conditional responses, including historical selections. */
export async function handleRetractionsList(
  c: Context<{ Bindings: Env }>,
  format: keyof typeof MEDIA,
): Promise<Response> {
  const problem = c.req.param("id");
  const params = new URL(c.req.url).searchParams;
  const query = RetractionsListQuerySchema.safeParse(Object.fromEntries(params));
  if (
    !problem ||
    !PublicLedgerProblemIdSchema.safeParse(problem).success ||
    !query.success ||
    [...params.keys()].some((key) => params.getAll(key).length !== 1)
  )
    return refusal(c.req.method, "query");
  try {
    const {
      problem: scope,
      target_status: targetStatus,
      ...read
    } = await loadProblemRetractions(c.env.DB, problem, query.data);
    if (!scope || targetStatus === "not-found") return refusal(c.req.method, "not-found");
    if (targetStatus === "unavailable") return refusal(c.req.method, "unavailable");
    const face = RetractionsListResponseSchema.parse({
      schema: RETRACTIONS_SCHEMA_ID,
      problem_id: problem,
      ...read,
    });
    const path = (after = face.after) =>
      retractionsListPath(problem, format, {
        through: face.cursor,
        limit: query.data.limit ?? RETRACTIONS_LIST_DEFAULT_LIMIT,
        ...(face.target === null ? { after } : { target: face.target }),
      });
    const next = face.next_after === null ? null : path(face.next_after);
    const position = `Public ledger cursor: ${face.cursor}; corrections after event #${face.after} examined through #${face.scanned_through}. Current visibility controls still apply to this snapshot.`;
    const body =
      format === "json"
        ? JSON.stringify(face)
        : format === "md"
          ? `${renderRetractionsMarkdown(problem, face.retractions, face.omitted)}\n\n${position}\n${next === null ? "" : `\n[More retractions](${next})\n`}`
          : `${renderRetractionsHtmlFragment(problem, face.retractions, face.omitted)}\n<nav aria-label="Retraction pages"><p>${position}</p>${next === null ? "" : `<a rel="next" href="${escapeHtml(next)}">More retractions</a>`}</nav>`;
    const bytes = new TextEncoder().encode(body);
    if (bytes.byteLength > (format === "json" ? 4 : 16) * 1024 * 1024)
      return refusal(c.req.method, "unavailable");
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const etag = `"retractions-${format}-${digest}"`;
    const headers = new Headers({
      "content-type": MEDIA[format],
      "cache-control": scope.unlisted ? "private, no-store" : "public, max-age=0, must-revalidate",
      "content-location": path(),
      "x-content-type-options": "nosniff",
      link: `</schemas/retractions.v1.json>; rel="describedby"; type="application/schema+json", <${path()}>; rel="canonical"${next === null ? "" : `, <${next}>; rel="next"`}`,
      etag,
    });
    if (scope.unlisted) headers.set("x-robots-tag", "noindex, nofollow");
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
      error instanceof RetractionReadError && error.code === "CURSOR_INVALID"
        ? "query"
        : "unavailable",
    );
  }
}
