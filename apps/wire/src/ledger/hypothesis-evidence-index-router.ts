import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import { HYPOTHESES_SCHEMA_ID, HypothesesQuerySchema, PublicHypothesisIdSchema } from "@asimposium/contracts/hypotheses";
import { renderHypothesisEvidenceIndexHtml, renderHypothesisEvidenceIndexMarkdown } from "@asimposium/render/hypothesis-evidence-index";
import { Hono } from "hono";
import type { Env } from "../env";
import { validatedProblem } from "../http/envelope";
import { hypothesisEvidenceIndexResponse } from "./hypothesis-evidence-index-face";
import { HypothesisReadError } from "./hypotheses-read";
import { loadHypothesisEvidenceIndex } from "./hypotheses-service";

function refusal(kind: "query" | "missing" | "unavailable", method: string): Response {
  const response = kind === "unavailable" ? validatedProblem({
    status: 500, code: "INTERNAL_ERROR", title: "The hypothesis evidence index is unavailable",
    detail: "A complete bounded index page could not be established. No continuation was advanced.",
    fixHint: "Retry the same request without advancing your saved cursor.",
    headers: { "cache-control": "private, no-store", "retry-after": "5" },
  }) : validatedProblem({
    status: kind === "query" ? 400 : 404,
    code: kind === "query" ? "CURSOR_INVALID" : "PROBLEM_NOT_FOUND",
    title: kind === "query" ? "Invalid hypothesis evidence query" : "Public hypothesis is unavailable",
    detail: kind === "query"
      ? "Use one canonical through cursor and one exclusive after sequence. Unknown or duplicate query fields, after beyond through and future cursors are refused."
      : "No verified public hypothesis is available at this identifier and snapshot.",
    fixHint: kind === "query" ? "Follow the next link unchanged, keeping through fixed."
      : "Choose a readable hypothesis from the public hypothesis list.",
    rule: "A5",
    extensions: { schema: `${HYPOTHESES_SCHEMA_ID}#/properties/evidence_index_query`,
      example: { method: "GET", path: "/p/P-DEMO/hypotheses/H-1/evidence.json" } },
    headers: { "cache-control": "private, no-store" },
  });
  return method === "HEAD" ? new Response(null,{status:response.status,headers:response.headers}) : response;
}
export function createHypothesisEvidenceIndexRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.on(["GET","HEAD"],"/p/:id/hypotheses/:hid/evidence",c => {
    const url = new URL(c.req.url);
    return c.redirect(`${url.pathname}.md${url.search}`,308);
  });
  for (const format of ["json","md","html"] as const) {
    app.on(["GET","HEAD"],`/p/:id/hypotheses/:hid/evidence.${format}`,async c => {
      const problemId = c.req.param("id"), hypothesisId = c.req.param("hid");
      const params = new URL(c.req.url).searchParams;
      const query = HypothesesQuerySchema.safeParse(Object.fromEntries(params));
      if (!PublicLedgerProblemIdSchema.safeParse(problemId).success ||
        !PublicHypothesisIdSchema.safeParse(hypothesisId).success || !query.success ||
        [...params.keys()].some(key => params.getAll(key).length !== 1)) return refusal("query",c.req.method);
      try {
        const result = await loadHypothesisEvidenceIndex(c.env.DB,problemId,hypothesisId,query.data);
        if (result === null) return refusal("missing",c.req.method);
        const body = format === "json" ? JSON.stringify(result.face)
          : format === "md" ? renderHypothesisEvidenceIndexMarkdown(result.face) : renderHypothesisEvidenceIndexHtml(result.face);
        return await hypothesisEvidenceIndexResponse(c.req.raw,body,format,result.face,result.unlisted);
      } catch(error) {
        return refusal(error instanceof HypothesisReadError && error.code === "CURSOR_INVALID" ? "query" : "unavailable",c.req.method);
      }
    });
  }
  return app;
}
