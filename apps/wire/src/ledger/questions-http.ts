import {
  PublicLedgerProblemIdSchema,
  QUESTIONS_LIST_DEFAULT_LIMIT,
  QUESTIONS_SCHEMA_ID,
  QuestionsListQuerySchema,
  QuestionsListResponseSchema,
  questionsListPath,
} from "@asimposium/contracts";
import { escapeHtml } from "@asimposium/render";
import type { Context } from "hono";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import {
  loadProblemQuestions,
  QuestionReadError,
  renderQuestionsHtmlFragment,
  renderQuestionsMarkdown,
} from "./questions.ts";

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
          title: "Invalid question selection",
          detail:
            "Use through and after as canonical nonnegative safe integers, limit from 1 to 200, and a declared question status or exact Q- target. An after cursor requires its original through cursor. Exact targets cannot combine with after or status. Unknown and repeated parameters are refused.",
          fixHint:
            "Start at the questions collection and follow its next link unchanged, or supply only target and an optional through cursor for an exact question.",
        }
      : kind === "not-found"
        ? {
            status: 404,
            code: "PROBLEM_NOT_FOUND" as const,
            title: "Public question source unavailable",
            detail: "No readable public problem or selected question matches this request.",
            fixHint: "Choose a readable public problem and a published question reference.",
          }
        : {
            status: 503,
            code: "INTERNAL_ERROR" as const,
            title: "Question history temporarily unavailable",
            detail:
              "The requested publication or lifecycle snapshot could not be verified. This is not an empty collection.",
            fixHint: "Retry the unchanged request without advancing your saved cursor.",
          }),
    ...(kind === "unavailable"
      ? {}
      : {
          rule: "A5" as const,
          extensions: {
            schema: QUESTIONS_SCHEMA_ID,
            example: { method: "GET", path: "/p/P-EXAMPLE/questions.json?through=20&after=5" },
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

/** One immutable source and selection contract for all three representations.
 * Current controls are rechecked before considering conditional responses. */
export async function handleQuestionsList(
  c: Context<{ Bindings: Env }>,
  format: keyof typeof MEDIA,
): Promise<Response> {
  const problem = c.req.param("id");
  const params = new URL(c.req.url).searchParams;
  const query = QuestionsListQuerySchema.safeParse(Object.fromEntries(params));
  if (
    !problem ||
    !PublicLedgerProblemIdSchema.safeParse(problem).success ||
    !query.success ||
    [...params.keys()].some((key) => params.getAll(key).length !== 1)
  )
    return refusal(c.req.method, "query");
  try {
    const result = await loadProblemQuestions(c.env.DB, problem, query.data);
    if (result.problem === null || result.target_status === "not-found")
      return refusal(c.req.method, "not-found");
    if (result.target_status === "unavailable") return refusal(c.req.method, "unavailable");
    const face = QuestionsListResponseSchema.parse({
      schema: QUESTIONS_SCHEMA_ID,
      problem_id: problem,
      cursor: result.cursor,
      after: result.after,
      scanned_through: result.scanned_through,
      next_after: result.next_after,
      target: result.target,
      status: result.status,
      questions: result.questions,
      omitted: result.omitted,
    });
    const path = (after = face.after) =>
      questionsListPath(problem, format, {
        through: face.cursor,
        ...(face.target === null ? { after } : { target: face.target }),
        limit: query.data.limit ?? QUESTIONS_LIST_DEFAULT_LIMIT,
        ...(face.status === null ? {} : { status: face.status }),
      });
    const next = face.next_after === null ? null : path(face.next_after);
    const position = `Question history at public ledger cursor: ${face.cursor}; creation events after #${face.after} examined through #${face.scanned_through}. Lifecycle states describe this snapshot, not present-day work availability. Current content controls still apply.${face.status === null ? "" : ` Filter: ${face.status}.`}`;
    const body =
      format === "json"
        ? JSON.stringify(face)
        : format === "md"
          ? `${renderQuestionsMarkdown(problem, face.questions, face.omitted)}\n\n${position}\n${next === null ? "" : `\n[More questions](${next})\n`}`
          : `${renderQuestionsHtmlFragment(problem, face.questions, face.omitted)}\n<nav aria-label="Question pages"><p>${position}</p>${next === null ? "" : `<a rel="next" href="${escapeHtml(next)}">More questions</a>`}</nav>`;
    const bytes = new TextEncoder().encode(body);
    const byteLimit = (format === "json" ? 8 : 32) * 1024 * 1024;
    if (bytes.byteLength > byteLimit) return refusal(c.req.method, "unavailable");
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const etag = `"questions-${format}-${hash}"`;
    const headers = new Headers({
      "content-type": MEDIA[format],
      "cache-control": result.problem.unlisted
        ? "private, no-store"
        : "public, max-age=0, must-revalidate",
      "content-location": path(),
      "x-content-type-options": "nosniff",
      link: `</schemas/questions.v1.json>; rel="describedby"; type="application/schema+json", <${path()}>; rel="canonical"${next === null ? "" : `, <${next}>; rel="next"`}`,
      etag,
    });
    if (result.problem.unlisted) headers.set("x-robots-tag", "noindex, nofollow");
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
      error instanceof QuestionReadError && error.code === "CURSOR_INVALID"
        ? "query"
        : "unavailable",
    );
  }
}
