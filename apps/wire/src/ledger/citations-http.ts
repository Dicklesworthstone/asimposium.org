import {
  CITATIONS_LIST_DEFAULT_LIMIT,
  CITATIONS_SCHEMA_ID,
  CitationReadQuerySchema,
  CitationsListQuerySchema,
  CitationsListResponseSchema,
  citationPath,
  citationsListPath,
  PublicCitationTargetSchema,
  PublicLedgerProblemIdSchema,
  SingleCitationResponseSchema,
} from "@asimposium/contracts";
import type { Context } from "hono";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import { CitationReadError } from "./citation-read.ts";
import {
  bibtexForCitation,
  cslForCitation,
  loadProblemCitations,
  loadSingleCitation,
  renderCitationsHtml,
  renderCitationsMarkdown,
  renderSingleCitationHtml,
  renderSingleCitationMarkdown,
} from "./citations.ts";

const MEDIA = {
  json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
  bib: "application/x-bibtex; charset=utf-8",
  "csl.json": "application/vnd.citationstyles.csl+json; charset=utf-8",
} as const;
type CitationFormat = keyof typeof MEDIA;
type CitationContext = Context<{ Bindings: Env }>;

function refusal(method: string, kind: "query" | "not-found" | "unavailable") {
  const response = validatedProblem({
    ...(kind === "query"
      ? {
          status: 400,
          code: "CURSOR_INVALID" as const,
          title: "Invalid citation read query",
          detail:
            "Use canonical safe integers: through and after >= 0, limit from 1 to 200, and unanchored=true or false. A continuation requires its original through cursor. Exact citation reads accept only through. Unknown and repeated parameters are refused.",
          fixHint: "Start at the citation collection and follow its next link unchanged.",
        }
      : kind === "not-found"
        ? {
            status: 404,
            code: "CITATION_NOT_FOUND" as const,
            title: "Public citation unavailable",
            detail: "No readable public problem or citation matches this request.",
            fixHint: "Choose a public problem and a citation listed in its literature collection.",
          }
        : {
            status: 503,
            code: "INTERNAL_ERROR" as const,
            title: "Citation source temporarily unavailable",
            detail:
              "The requested immutable publication could not be read and verified. This does not mean that the citation or literature collection is empty.",
            fixHint: "Retry the same request without advancing your saved cursor.",
          }),
    ...(kind === "unavailable"
      ? {}
      : {
          rule: "A5" as const,
          extensions: {
            schema: CITATIONS_SCHEMA_ID,
            example: { method: "GET", path: "/p/P-EXAMPLE/citations.json?through=20&after=8" },
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

async function representation(
  c: CitationContext,
  format: CitationFormat,
  body: string,
  unlisted: number,
  location: string,
  next: string | null = null,
): Promise<Response> {
  const bytes = new TextEncoder().encode(body);
  if (bytes.byteLength > (format === "json" || format === "csl.json" ? 6 : 32) * 1024 * 1024)
    return refusal(c.req.method, "unavailable");
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const etag = `"citations-${format}-${digest}"`;
  const headers = new Headers({
    "content-type": MEDIA[format],
    "cache-control": unlisted ? "private, no-store" : "public, max-age=0, must-revalidate",
    "content-location": location,
    "x-content-type-options": "nosniff",
    link: `</schemas/citations.v1.json>; rel="describedby"; type="application/schema+json", <${location}>; rel="canonical"${next === null ? "" : `, <${next}>; rel="next"`}`,
    etag,
  });
  if (unlisted) headers.set("x-robots-tag", "noindex, nofollow");
  // Source integrity and present-day content controls have already been
  // checked. An old validator must never bypass a withdrawal or failure.
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
}

export async function handleCitationsList(
  c: CitationContext,
  format: "json" | "md" | "html",
): Promise<Response> {
  const problem = c.req.param("id");
  const params = new URL(c.req.url).searchParams;
  const query = CitationsListQuerySchema.safeParse(Object.fromEntries(params));
  if (
    !problem ||
    !PublicLedgerProblemIdSchema.safeParse(problem).success ||
    !query.success ||
    [...params.keys()].some((key) => params.getAll(key).length !== 1)
  )
    return refusal(c.req.method, "query");
  try {
    const { problem: scope, ...read } = await loadProblemCitations(c.env.DB, problem, query.data);
    if (!scope) return refusal(c.req.method, "not-found");
    const face = CitationsListResponseSchema.parse({
      schema: CITATIONS_SCHEMA_ID,
      problem_id: problem,
      ...read,
    });
    const view = { ...face, limit: query.data.limit ?? CITATIONS_LIST_DEFAULT_LIMIT };
    const path = (after: number) =>
      citationsListPath(problem, format, {
        through: face.cursor,
        after,
        limit: view.limit,
        ...(face.unanchored === null ? {} : { unanchored: face.unanchored }),
      });
    const next = face.next_after === null ? null : path(face.next_after);
    const body =
      format === "json"
        ? JSON.stringify(face)
        : format === "md"
          ? renderCitationsMarkdown(problem, face.citations, face.omitted, view)
          : renderCitationsHtml(problem, face.citations, face.omitted, view);
    return await representation(c, format, body, scope.unlisted, path(face.after), next);
  } catch (error) {
    return refusal(
      c.req.method,
      error instanceof CitationReadError && error.code === "CURSOR_INVALID"
        ? "query"
        : "unavailable",
    );
  }
}

export async function handleSingleCitation(c: CitationContext): Promise<Response> {
  const problem = c.req.param("id");
  const targetWithSuffix = c.req.param("target");
  if (!problem || !targetWithSuffix || !PublicLedgerProblemIdSchema.safeParse(problem).success)
    return refusal(c.req.method, "not-found");
  const format: CitationFormat =
    (["csl.json", "json", "md", "html", "bib"] as const).find((candidate) =>
      targetWithSuffix.endsWith(`.${candidate}`),
    ) ?? "html";
  const target = targetWithSuffix.endsWith(`.${format}`)
    ? targetWithSuffix.slice(0, -format.length - 1)
    : targetWithSuffix;
  if (!PublicCitationTargetSchema.safeParse(target).success)
    return refusal(c.req.method, "not-found");
  const params = new URL(c.req.url).searchParams;
  const query = CitationReadQuerySchema.safeParse(Object.fromEntries(params));
  if (!query.success || [...params.keys()].some((key) => params.getAll(key).length !== 1))
    return refusal(c.req.method, "query");
  try {
    const result = await loadSingleCitation(c.env.DB, problem, target, query.data);
    if (!result) return refusal(c.req.method, "not-found");
    const { problem: scope, ...read } = result;
    const face = SingleCitationResponseSchema.parse({ schema: CITATIONS_SCHEMA_ID, ...read });
    const body =
      format === "json"
        ? JSON.stringify(face)
        : format === "csl.json"
          ? JSON.stringify(cslForCitation(face.citation))
          : format === "bib"
            ? bibtexForCitation(face.citation)
            : format === "md"
              ? renderSingleCitationMarkdown(problem, face, { ...face, target })
              : renderSingleCitationHtml(problem, face, { ...face, target });
    return await representation(
      c,
      format,
      body,
      scope.unlisted,
      citationPath(problem, target, format, {
        through: face.cursor,
      }),
    );
  } catch (error) {
    return refusal(
      c.req.method,
      error instanceof CitationReadError && error.code === "CURSOR_INVALID"
        ? "query"
        : "unavailable",
    );
  }
}
