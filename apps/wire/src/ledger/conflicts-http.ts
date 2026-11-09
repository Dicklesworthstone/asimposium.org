import {
  CONFLICTS_LIST_DEFAULT_LIMIT,
  CONFLICTS_SCHEMA_ID,
  ConflictsListQuerySchema,
  ConflictsListResponseSchema,
  conflictsListPath,
  PublicLedgerProblemIdSchema,
} from "@asimposium/contracts";
import { escapeHtml } from "@asimposium/render";
import type { Context } from "hono";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import {
  ConflictReadError,
  loadProblemConflicts,
  renderConflictsHtml,
  renderConflictsMarkdown,
} from "./conflicts.ts";

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
          title: "Invalid conflict read query",
          detail:
            "Use canonical safe integers: through and after >= 0, limit from 1 to 200. A continuation requires its original through cursor. An exact target cannot be combined with after or status. Unknown and repeated parameters are refused.",
          fixHint:
            "Start at the conflict collection and follow its next link unchanged, or select a single conflict with target=CF-1.",
        }
      : kind === "not-found"
        ? {
            status: 404,
            code: "CONFLICT_NOT_FOUND" as const,
            title: "Public conflict unavailable",
            detail: "No readable public problem or conflict matches this request.",
            fixHint: "Choose a public problem and a conflict listed in its conflict collection.",
          }
        : {
            status: 503,
            code: "INTERNAL_ERROR" as const,
            title: "Conflict source temporarily unavailable",
            detail:
              "The requested immutable publication or lifecycle could not be read and verified. This is not an empty collection or evidence that a disagreement was resolved.",
            fixHint: "Retry the same request without advancing your saved cursor.",
          }),
    ...(kind === "unavailable"
      ? {}
      : {
          rule: "A5" as const,
          extensions: {
            schema: CONFLICTS_SCHEMA_ID,
            example: { method: "GET", path: "/p/P-EXAMPLE/conflicts.json?through=20&after=8" },
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

/** Exact target and collection traversal share one immutable, bounded reader.
 * Present-day controls are checked before an old representation may return 304. */
export async function handleConflictsList(
  c: Context<{ Bindings: Env }>,
  format: keyof typeof MEDIA,
): Promise<Response> {
  const problem = c.req.param("id");
  const params = new URL(c.req.url).searchParams;
  const query = ConflictsListQuerySchema.safeParse(Object.fromEntries(params));
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
    } = await loadProblemConflicts(c.env.DB, problem, query.data);
    if (!scope || targetStatus === "not-found") return refusal(c.req.method, "not-found");
    if (targetStatus === "unavailable") return refusal(c.req.method, "unavailable");
    const face = ConflictsListResponseSchema.parse({
      schema: CONFLICTS_SCHEMA_ID,
      problem_id: problem,
      ...read,
    });
    const path = (after = face.after, representation = format) =>
      conflictsListPath(problem, representation, {
        through: face.cursor,
        limit: query.data.limit ?? CONFLICTS_LIST_DEFAULT_LIMIT,
        ...(face.target === null ? { after } : { target: face.target }),
        ...(face.status === null ? {} : { status: face.status }),
      });
    const next = face.next_after === null ? null : path(face.next_after);
    const position = `Public ledger cursor: ${face.cursor}; oldest normalizations first. Examined through event #${face.scanned_through}.${face.status === null ? "" : ` Showing ${face.status} conflicts in this admission window.`}`;
    const empty =
      face.conflicts.length === 0
        ? "No matching readable conflicts in this page. Follow the continuation when one is available."
        : null;
    const markdownNavigation = `\n\n${position}\n${empty === null ? "" : `\n${empty}\n`}${next === null ? "" : `\n[More conflicts](${next})\n`}`;
    const htmlNavigation = `<nav aria-label="Conflict pages"><p>${position}</p>${empty === null ? "" : `<p>${empty}</p>`}${next === null ? "" : `<a rel="next" href="${escapeHtml(next)}">More conflicts</a>`}</nav>`;
    const body =
      format === "json"
        ? JSON.stringify(face)
        : format === "md"
          ? `${renderConflictsMarkdown(problem, face.conflicts, face.omitted)}${markdownNavigation}`
          : renderConflictsHtml(problem, face.conflicts, face.omitted, {
              navigation: htmlNavigation,
              jsonPath: path(face.after, "json"),
              markdownPath: path(face.after, "md"),
            });
    const bytes = new TextEncoder().encode(body);
    if (bytes.byteLength > (format === "json" ? 6 : 32) * 1024 * 1024)
      return refusal(c.req.method, "unavailable");
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const etag = `"conflicts-${format}-${digest}"`;
    const headers = new Headers({
      "content-type": MEDIA[format],
      "cache-control": scope.unlisted ? "private, no-store" : "public, max-age=0, must-revalidate",
      "content-location": path(),
      "x-content-type-options": "nosniff",
      link: `</schemas/conflicts.v1.json>; rel="describedby"; type="application/schema+json", <${path()}>; rel="canonical"${next === null ? "" : `, <${next}>; rel="next"`}`,
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
      error instanceof ConflictReadError && error.code === "query" ? "query" : "unavailable",
    );
  }
}
