import { ProblemSlowModeRequestSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope";
import { scanFieldsForCredentials, secretShapedContentProblem } from "../screening/credential-scan";
import {
  changeProblemSlowMode,
  readProblemSlowMode,
  SlowModeError,
  type SlowModePrincipal,
} from "./slow-mode";

const EXAMPLE = {
  problem_id: "P-DEMO",
  action: "set",
  expected_revision: 0,
  limit_per_hour: 5,
  expires_at: "2026-10-26T12:00:00.000Z",
  reason: "Temporarily limit new public submissions during review.",
  step_up_authenticated_at: 1793012400,
};
function privateResponse(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
}
function invalid(detail: string): Response {
  return privateResponse(
    validatedProblem({
      status: 422,
      code: "SCHEMA_INVALID",
      title: "The temporary limit does not match its contract",
      detail,
      fixHint:
        "Use action set with a 1–19/hour cap and expiry within the next 24 hours, or action clear. Include the current revision, a reason and recent authentication from Agora.",
      rule: "A5",
      extensions: { schema: "https://a.asimposium.org/schemas/reports.v1.json", example: EXAMPLE },
    }),
  );
}

export async function problemSlowModeHttp(input: {
  db: D1Database;
  problemId: string;
  principal: SlowModePrincipal;
  method: "GET" | "POST";
  body?: unknown;
  idempotencyKey?: string;
}): Promise<Response> {
  try {
    if (input.method === "GET")
      return privateResponse(
        Response.json(await readProblemSlowMode(input.db, input.problemId, input.principal)),
      );
    const parsed = ProblemSlowModeRequestSchema.safeParse(input.body);
    if (!parsed.success) return invalid("The body has missing, invalid or unsupported fields.");
    const secrets = scanFieldsForCredentials({ reason: parsed.data.reason });
    if (secrets.length > 0) return privateResponse(secretShapedContentProblem(secrets, EXAMPLE));
    if (!input.idempotencyKey) return invalid("An Idempotency-Key is required.");
    return privateResponse(
      Response.json(
        await changeProblemSlowMode(
          input.db,
          input.problemId,
          input.principal,
          parsed.data,
          input.idempotencyKey,
        ),
      ),
    );
  } catch (error) {
    if (error instanceof SlowModeError) {
      if (error.code === "EXPIRY") return invalid("The expiry must be in the next 24 hours.");
      if (error.code === "TARGET")
        return invalid("The signed problem id must match the request path.");
      if (error.code === "STEP_UP")
        return privateResponse(
          validatedProblem({
            status: 403,
            code: "STEP_UP_REQUIRED",
            title: "Recent authentication is required",
            detail: "This action requires recent authentication.",
            fixHint: "Sign in again, then submit a new command from Agora.",
          }),
        );
      const missing = error.code === "NOT_FOUND";
      return privateResponse(
        validatedProblem({
          status: missing ? 404 : 409,
          code: missing
            ? "MODERATION_TARGET_NOT_FOUND"
            : error.code === "REPLAY_CONFLICT"
              ? "IDEMPOTENCY_CONFLICT"
              : "MODERATION_STATE_CONFLICT",
          title: missing
            ? "No manageable problem matches this request"
            : "The temporary limit command conflicts",
          detail: missing
            ? "The requested problem is not available to this principal."
            : "No new control was applied. The revision or replay key does not match this command.",
          fixHint:
            "Read the current control before changing it. Reuse an accepted command's exact body and key only to retrieve its receipt.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/reports.v1.json",
            example: EXAMPLE,
            ...(missing ? {} : { suggested_action: "refetch_and_reapply" }),
          },
        }),
      );
    }
    return privateResponse(
      validatedProblem({
        status: 503,
        code: "OPERATOR_CONTROL_UNAVAILABLE",
        title: "The temporary limit is unavailable",
        detail: "The control could not be read or applied safely.",
        fixHint: "Retry later. Reuse the exact body and key to recover an accepted receipt.",
      }),
    );
  }
}
