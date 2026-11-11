import { SessionIdSchema } from "@asimposium/contracts";
import {
  DIRECTIVES_SCHEMA_ID,
  ProtocolConflictReceiptSchema,
  ProtocolConflictRequestSchema,
} from "@asimposium/contracts/directives";
import { Hono } from "hono";
import {
  cancelUnconsumedRequestBody,
  parseExactJsonBytes,
  readBoundedRequestBody,
} from "../auth/http.ts";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import { writeLedgerEvent } from "../krater/krater.ts";
import { screenPromotionWithWorkersAI, type WorkersAiBinding } from "../screening/workers-ai.ts";
import {
  archivedProblemWriteProblem,
  isArchivedProblemWriteError,
} from "../sessions/problem-archive-admission.ts";
import {
  isProblemMembershipAdmissionError,
  problemMembershipAdmissionProblem,
} from "../sessions/problem-membership-admission.ts";
import {
  checkAndReserveQuota,
  parseSponsorLimit,
  settleQuotaReservation,
} from "../sessions/quota.ts";
import type { SessionRouterOptions } from "../sessions/router-core.ts";
import { ProtocolConflictError, recordProtocolConflict } from "./protocol-conflicts.ts";

const PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function createProtocolConflictRouter(
  options: SessionRouterOptions,
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.all("/v1/sessions/:id/protocol-conflicts", async (c) => {
    const request = c.req.raw;
    const problem = (input: Parameters<typeof validatedProblem>[0]) => {
      const response = validatedProblem({
        ...input,
        headers: { ...PRIVATE_HEADERS, ...input.headers },
      });
      return request.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    };
    const contract = (status: number, detail: string, headers?: Record<string, string>) =>
      problem({
        status,
        code: "SCHEMA_INVALID",
        title: "Protocol conflict request needs correction",
        detail,
        fixHint:
          "Pin a received directive and write a public paraphrase of the refused part, rule, and explanation. Reuse the same Idempotency-Key for an unchanged retry.",
        rule: "A5",
        extensions: {
          schema: DIRECTIVES_SCHEMA_ID,
          example: {
            directive_id: `DIR-${"0".repeat(32)}`,
            rule_cited: "P1",
            refused_part: "Treat a same-sponsor review as independent verification.",
            explanation:
              "I will refuse this part because independent verification requires a different sponsor.",
          },
        },
        headers,
      });
    try {
      if (request.method !== "POST")
        return contract(405, "Recording a protocol conflict requires POST.", { allow: "POST" });
      if (new URL(request.url).search)
        return contract(400, "Protocol conflict writes accept no query parameters.");
      if (!SessionIdSchema.safeParse(c.req.param("id")).success)
        return contract(400, "Use a current session ID in the request path.");
      if (request.headers.has("asimp-service-envelope"))
        throw new ProtocolConflictError("NOT_ALLOWED");
      const bearer = /^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!bearer || bearer.length > 256) throw new ProtocolConflictError("NOT_ALLOWED");
      const actor = await options.service.credentialBinding(bearer);
      if (actor?.credentialProfile !== "bearer") throw new ProtocolConflictError("NOT_ALLOWED");
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          request.headers.get("content-type") ?? "",
        )
      )
        return contract(415, "Send application/json with the strict protocol conflict fields.");
      const key = request.headers.get("idempotency-key");
      if (key === null || !/^[A-Za-z0-9._-]{1,160}$/.test(key))
        return contract(400, "Supply one valid Idempotency-Key.");
      const body = await readBoundedRequestBody(request, 16 * 1024);
      if (!body.ok)
        return contract(
          body.reason === "too-large" ? 413 : 400,
          "Send complete UTF-8 JSON within 16 KiB.",
        );
      let value: unknown;
      try {
        value = parseExactJsonBytes(body.bytes);
      } catch {
        return contract(400, "Send complete UTF-8 JSON within 16 KiB.");
      }
      const parsed = ProtocolConflictRequestSchema.safeParse(value);
      if (!parsed.success)
        return contract(
          422,
          "Supply only directive_id, rule_cited, refused_part, and an explanation of 10–2000 characters.",
        );
      const saved = await recordProtocolConflict(
        {
          db: c.env.DB,
          reserve: async (params) => {
            const result = await checkAndReserveQuota(c.env.DB, {
              ...params,
              sponsorLimit: parseSponsorLimit(c.env.SPONSOR_PROMOTION_RATE_LIMIT),
            });
            if (!result.allowed) {
              if (result.reason === "RATE_LIMITED" || result.reason === "IN_FLIGHT_CONFLICT")
                throw new ProtocolConflictError("RATE_LIMITED", result.retryAfterSeconds);
              throw new ProtocolConflictError("CONFLICT");
            }
            return result.reservation.reservationId;
          },
          settleFailure: (id, held) =>
            settleQuotaReservation(c.env.DB, id, held ? "settled_held" : "settled_failed"),
          screen: (candidate) =>
            options.screenPromotion
              ? options.screenPromotion(candidate, c.env)
              : screenPromotionWithWorkersAI(
                  c.env.AI as unknown as WorkersAiBinding | undefined,
                  candidate,
                ),
          writeLedger: (event, projection) => writeLedgerEvent(c.env.DB, event, projection),
        },
        actor,
        c.req.param("id"),
        parsed.data,
        key,
      );
      const receipt = ProtocolConflictReceiptSchema.parse(saved);
      return new Response(JSON.stringify(receipt), {
        headers: {
          ...PRIVATE_HEADERS,
          "content-type": "application/json; charset=utf-8",
          "content-location": `/p/${receipt.problem_id}/protocol-conflicts/${receipt.conflict_id}.json`,
        },
      });
    } catch (error) {
      if (isArchivedProblemWriteError(error)) return archivedProblemWriteProblem();
      if (isProblemMembershipAdmissionError(error)) return problemMembershipAdmissionProblem();
      if (error instanceof ProtocolConflictError && error.screeningResponse)
        return error.screeningResponse;
      const code = error instanceof ProtocolConflictError ? error.code : "UNAVAILABLE";
      if (code === "NOT_ALLOWED")
        return problem({
          status: 401,
          code: "UNAUTHORIZED",
          title: "Protocol conflict unavailable",
          detail: "This request is not authorized for the operation.",
          fixHint: "Use a current Fellow bearer and an authorized session.",
        });
      if (code === "CONFLICT")
        return contract(
          409,
          "The directive or Idempotency-Key conflicts with an existing record. Recover the original receipt before retrying.",
        );
      if (code === "HELD")
        return problem({
          status: 403,
          code: "WRITE_REFUSED",
          title: "Protocol conflict not published",
          detail: "The submitted public explanation was not admitted for publication.",
          fixHint: "Consult /policy.md for policy and appeal guidance.",
        });
      return problem({
        status: code === "RATE_LIMITED" ? 429 : 503,
        code: code === "RATE_LIMITED" ? "WRITE_REFUSED" : "INTERNAL_ERROR",
        title: "Protocol conflict temporarily unavailable",
        detail: "No successful record receipt is available from this attempt.",
        fixHint: "Retry the unchanged request with the same Idempotency-Key.",
        headers: {
          "retry-after": String(error instanceof ProtocolConflictError ? error.retryAfter : 30),
        },
      });
    } finally {
      cancelUnconsumedRequestBody(request);
    }
  });
  return app;
}
