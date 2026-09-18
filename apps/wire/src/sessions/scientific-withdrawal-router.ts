import {
  SCIENTIFIC_WITHDRAWALS_SCHEMA_ID,
  ScientificWithdrawalReceiptSchema,
  ScientificWithdrawalRequestSchema,
} from "@asimposium/contracts/scientific-withdrawals";
import { Hono } from "hono";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import { writeLedgerEvent } from "../krater/krater.ts";
import {
  handleScientificWithdrawalHttp,
  type ScientificWithdrawalOperations,
  WithdrawalHttpError,
} from "../ledger/scientific-withdrawal-http.ts";
import {
  ScientificWithdrawalError,
  withdrawScientificInput,
} from "../ledger/scientific-withdrawals.ts";
import { screenPromotionWithWorkersAI, type WorkersAiBinding } from "../screening/workers-ai.ts";
import { checkAndReserveQuota, parseSponsorLimit, settleQuotaReservation } from "./quota.ts";
import type { SessionRouterOptions } from "./router-core.ts";

export function scientificWithdrawalOperations(
  env: Env,
  options: SessionRouterOptions,
): ScientificWithdrawalOperations {
  return {
    schema: SCIENTIFIC_WITHDRAWALS_SCHEMA_ID,
    problem: validatedProblem,
    authenticate: (token) => options.service.credentialBinding(token),
    decode(value) {
      const parsed = ScientificWithdrawalRequestSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    },
    async withdraw(actor, session, kind, target, input, key) {
      try {
        return ScientificWithdrawalReceiptSchema.parse(
          await withdrawScientificInput(
            {
              db: env.DB,
              reserve: async (params) => {
                const result = await checkAndReserveQuota(env.DB, {
                  ...params,
                  sponsorLimit: parseSponsorLimit(env.SPONSOR_PROMOTION_RATE_LIMIT),
                });
                if (!result.allowed) {
                  if (result.reason === "RATE_LIMITED" || result.reason === "IN_FLIGHT_CONFLICT")
                    throw new ScientificWithdrawalError("RATE_LIMITED", result.retryAfterSeconds);
                  throw new ScientificWithdrawalError("CONFLICT");
                }
                return result.reservation.reservationId;
              },
              settleFailure: (id, held) =>
                settleQuotaReservation(env.DB, id, held ? "settled_held" : "settled_failed"),
              screen: (value) =>
                options.screenPromotion
                  ? options.screenPromotion(value, env)
                  : screenPromotionWithWorkersAI(
                      env.AI as unknown as WorkersAiBinding | undefined,
                      value,
                    ),
              writeLedger: (event, projection) => writeLedgerEvent(env.DB, event, projection),
            },
            actor,
            session,
            kind,
            target,
            input,
            key,
          ),
        );
      } catch (error) {
        if (error instanceof ScientificWithdrawalError) {
          const code =
            error.code === "NOT_ALLOWED" || error.code === "NOT_FOUND"
              ? "DENIED"
              : error.code === "RATE_LIMITED"
                ? "THROTTLED"
                : error.code;
          throw new WithdrawalHttpError(code, error.retryAfter);
        }
        throw new WithdrawalHttpError("UNAVAILABLE");
      }
    },
  };
}

/** Mounted ahead of the legacy claim-retraction handler; no claim route,
 * scope, replay protocol or concurrent question-withdrawal change is replaced. */
export function createScientificWithdrawalRouter(
  options: SessionRouterOptions,
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  for (const path of [
    "/v1/sessions/:id/evidence/:target/retract",
    "/v1/sessions/:id/reviews/:target/retract",
  ]) {
    app.all(
      path,
      async (c) =>
        (await handleScientificWithdrawalHttp(
          c.req.raw,
          scientificWithdrawalOperations(c.env, options),
        )) ?? c.notFound(),
    );
  }
  return app;
}
