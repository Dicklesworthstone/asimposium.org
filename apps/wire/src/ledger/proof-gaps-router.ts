import { ProblemIdSchema } from "@asimposium/contracts";
import { PROOF_GAPS_SCHEMA_ID, ProofGapsQuerySchema } from "@asimposium/contracts/proof-gaps";
import { renderProjection } from "@asimposium/render";
import { Hono } from "hono";
import type { Env } from "../env";
import { validatedProblem } from "../http/envelope";
import { proofGapResponse, proofGapsProjection } from "./proof-gaps-face";
import { ProofGapReadError } from "./proof-gaps-read";
import { loadProofGaps } from "./proof-gaps-service";

function refusal(kind: ProofGapReadError["code"], method: string): Response {
  const response = validatedProblem(kind === "query" ? {
    status: 400, code: "CURSOR_INVALID", title: "Choose a valid proof-gap snapshot",
    detail: "Use one canonical through cursor, and either one after filing cursor or one exact target=G-n. Unknown and repeated parameters are refused.",
    fixHint: "Follow the next link unchanged, or omit parameters for the current gap history.",
    rule: "A5", extensions: { schema: `${PROOF_GAPS_SCHEMA_ID}#/properties/query`,
      example: { method: "GET", path: "/p/P-DEMO/gaps.json?target=G-2" } },
    headers: { "cache-control": "private, no-store" },
  } : kind === "not-found" ? {
    status: 404, code: "PROBLEM_NOT_FOUND", title: "Public problem not found",
    detail: "No readable public problem exists at this identifier.",
    fixHint: "Choose a problem from /problems.json.",
    headers: { "cache-control": "private, no-store" },
  } : {
    status: 500, code: "INTERNAL_ERROR", title: "Proof-gap history is unavailable",
    detail: "The bounded history could not be established. This is not an empty gap list.",
    fixHint: "Retry the unchanged request without advancing your saved cursor.",
    headers: { "cache-control": "private, no-store", "retry-after": "5" },
  });
  return method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
}

export function createProofGapRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  for (const format of ["json", "md", "html"] as const) {
    app.on(["GET", "HEAD"], `/p/:id/gaps.${format}`, async (c) => {
      const problem = c.req.param("id");
      const params = new URL(c.req.url).searchParams;
      const query = ProofGapsQuerySchema.safeParse(Object.fromEntries(params));
      if (!ProblemIdSchema.safeParse(problem).success || !query.success ||
          [...params.keys()].some((key) => params.getAll(key).length !== 1)) return refusal("query", c.req.method);
      try {
        const result = await loadProofGaps(c.env.DB, problem, query.data);
        const body = format === "json" ? JSON.stringify(result.face)
          : renderProjection(proofGapsProjection(result.face), format === "html" ? "html-fragment" : "md").body;
        return await proofGapResponse(c.req.raw, body, format, result.face, result.unlisted);
      } catch (error) {
        return refusal(error instanceof ProofGapReadError ? error.code : "unavailable", c.req.method);
      }
    });
  }
  app.on(["GET", "HEAD"], "/p/:id/gaps", (c) => {
    if (!ProblemIdSchema.safeParse(c.req.param("id")).success) return refusal("query", c.req.method);
    return c.redirect(`/p/${c.req.param("id")}/gaps.md${new URL(c.req.url).search}`, 308);
  });
  return app;
}
