import {
  AdminSponsorSuspensionRequestSchema,
  SPONSOR_SUSPENSION_SCHEMA_ID,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope";
import { scanFieldsForCredentials, secretShapedContentProblem } from "../screening/credential-scan";
import {
  readSponsorSuspension,
  readSponsorSuspensionStatus,
  SponsorSuspensionError,
  suspendSponsor,
} from "./sponsor-suspension";

const EXAMPLE = {
  sponsor_id: "usr_reviewed_example",
  expected_revision: 0,
  reviewed_case_id: `QC-${"0".repeat(26)}`,
  basis: "egregious-reviewed-case",
  reason: "A trained operator reviewed this egregious case and its account consequences.",
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
      title: "The reviewed suspension does not match its contract",
      detail,
      fixHint:
        "Read the current account state, review an already rejected case for that sponsor, then explicitly confirm the egregious-case suspension with recent authentication and an Idempotency-Key.",
      rule: "A5",
      extensions: { schema: SPONSOR_SUSPENSION_SCHEMA_ID, example: EXAMPLE },
    }),
  );
}

export async function sponsorSuspensionHttp(input: {
  db: D1Database;
  sponsorId: string;
  operatorId?: string;
  method: "GET" | "POST";
  body?: unknown;
  idempotencyKey?: string;
}): Promise<Response> {
  try {
    if (input.method === "GET")
      return privateResponse(
        Response.json(
          input.operatorId === undefined
            ? await readSponsorSuspensionStatus(input.db, input.sponsorId)
            : await readSponsorSuspension(input.db, input.sponsorId),
        ),
      );
    const parsed = AdminSponsorSuspensionRequestSchema.safeParse(input.body);
    if (!parsed.success) return invalid("The body has missing, invalid or unsupported fields.");
    if (!input.operatorId || !input.idempotencyKey)
      return invalid("Operator authority and an Idempotency-Key are required.");
    const secrets = scanFieldsForCredentials({ reason: parsed.data.reason });
    if (secrets.length > 0) return privateResponse(secretShapedContentProblem(secrets, EXAMPLE));
    return privateResponse(
      Response.json(
        await suspendSponsor(
          input.db,
          input.sponsorId,
          input.operatorId,
          parsed.data,
          input.idempotencyKey,
        ),
      ),
    );
  } catch (error) {
    if (error instanceof SponsorSuspensionError) {
      if (error.code === "TARGET")
        return invalid("The signed sponsor id must match the request path.");
      if (error.code === "STEP_UP")
        return privateResponse(
          validatedProblem({
            status: 403,
            code: "STEP_UP_REQUIRED",
            title: "Recent authentication is required",
            detail: "This action requires recent authentication.",
            fixHint:
              "Sign in again, review the account and case, then submit the command from Agora.",
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
            ? "No manageable sponsor matches this request"
            : "The reviewed suspension cannot be applied",
          detail: missing
            ? "The sponsor account is not available."
            : error.code === "CASE"
              ? "This case is not an already rejected case for the selected sponsor. Nothing was changed."
              : "No new suspension was applied. The current state or replay key does not match this command.",
          fixHint:
            "Read the account and reviewed case again. Reuse an accepted command's exact intent and key only to retrieve its receipt.",
          rule: "A5",
          extensions: {
            schema: SPONSOR_SUSPENSION_SCHEMA_ID,
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
        title: "The sponsor control is temporarily unavailable",
        detail: "The account control could not be read or committed safely.",
        fixHint:
          "Retry later. Reuse the exact command and key to recover a possibly accepted receipt.",
      }),
    );
  }
}
