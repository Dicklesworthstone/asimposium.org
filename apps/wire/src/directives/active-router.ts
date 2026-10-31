import {
  ActiveDirectiveQuerySchema, DIRECTIVES_SCHEMA_ID, activeDirectivesUrl,
} from "@asimposium/contracts/directives";
import type { D1Database } from "@cloudflare/workers-types";
import { Hono } from "hono";
import type { EnrollmentService } from "../enrollment/service.ts";
import type { Env } from "../env.ts";
import { validatedProblem, type ValidatedProblemInput } from "../http/envelope.ts";
import { ActiveDirectiveReadError, readActiveDirectivePage } from "./active-page.ts";

function privateResponse(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
}
function refusal(input: ValidatedProblemInput): Response {
  return privateResponse(validatedProblem(input));
}
const invalidToken = () => refusal({ status: 401, code: "FELLOW_TOKEN_INVALID",
  title: "Fellow bearer token is not accepted", detail: "The current credentials cannot authorize this private read.",
  fixHint: "Use a current Fellow bearer token from an explicitly approved enrollment flow." });

export function createActiveDirectiveRouter(options: {
  service: Pick<EnrollmentService, "credentialBinding">; db?: D1Database;
}): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/v1/directives/active", async c => {
    try {
      const token = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization")?.trim() ?? "")?.[1];
      const binding = token ? await options.service.credentialBinding(token) : undefined;
      if (!binding) return invalidToken();
      const params = new URL(c.req.url).searchParams;
      const duplicate = [...params.keys()].some(key => params.getAll(key).length !== 1);
      const parsed = ActiveDirectiveQuerySchema.safeParse(Object.fromEntries(params));
      if (duplicate || !parsed.success) return refusal({
        status: 400, code: "DIRECTIVE_QUERY_INVALID", title: "Invalid active-directive query",
        detail: "Use problem_id, limit from 1 to 100, and an issued cursor at most once each.",
        fixHint: "Start without cursor, then follow next_url exactly. Omit problem_id only for global instructions.",
        rule: "A5", extensions: { schema: DIRECTIVES_SCHEMA_ID, example: { problem_id: "P-4DSP", limit: 50 } },
      });
      const db = options.db ?? c.env?.DB;
      if (!db) throw new ActiveDirectiveReadError("unavailable");
      try {
        return privateResponse(c.json(await readActiveDirectivePage(db, binding, parsed.data)));
      } catch (error) {
        if (error instanceof ActiveDirectiveReadError && error.reason === "unauthorized") return invalidToken();
        if (error instanceof ActiveDirectiveReadError && (error.reason === "invalid" || error.reason === "changed")) {
          const changed = error.reason === "changed";
          return refusal({ status: changed ? 409 : 400,
            code: changed ? "DIRECTIVE_SET_CHANGED" : "DIRECTIVE_CURSOR_INVALID",
            title: changed ? "Sponsor instructions changed" : "Invalid directive continuation",
            detail: changed ? "The applicable instruction set changed. This continuation cannot establish the current constraints."
              : "The cursor does not continue this exact credential, scope and page size.",
            fixHint: "Discard earlier pages and restart without cursor. Read every new page before acting.",
            rule: "A5", extensions: { schema: DIRECTIVES_SCHEMA_ID,
              example: { limit: 50 }, restart_url: activeDirectivesUrl(parsed.data.problem_id, parsed.data.limit) },
          });
        }
        throw error;
      }
    } catch {
      return refusal({ status: 503, code: "INTERNAL_ERROR", title: "Sponsor instructions unavailable",
        detail: "The current private instruction set could not be read safely.",
        fixHint: "Retry before acting on an incomplete instruction set." });
    }
  });
  return app;
}
