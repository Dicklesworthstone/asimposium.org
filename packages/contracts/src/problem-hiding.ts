import { z } from "zod";
import { PublicLedgerProblemIdSchema } from "./ledger.ts";

/** Match Agora's decision freshness window, including bounded clock skew. */
export const PROBLEM_HIDE_AUTH_WINDOW_SECONDS = 15 * 60;
export const PROBLEM_HIDE_AUTH_CLOCK_SKEW_SECONDS = 60;

export function problemHideAuthIsRecent(
  issuedAt: number | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): issuedAt is number {
  if (
    typeof issuedAt !== "number" ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(nowSeconds) ||
    issuedAt < 0 ||
    nowSeconds < 0
  )
    return false;
  const age = nowSeconds - issuedAt;
  return (
    age >= -PROBLEM_HIDE_AUTH_CLOCK_SKEW_SECONDS &&
    age <= PROBLEM_HIDE_AUTH_WINDOW_SECONDS + PROBLEM_HIDE_AUTH_CLOCK_SKEW_SECONDS
  );
}

/** Private, signed owner command. It grants neither restore nor science authority. */
export const SponsorProblemHideRequestSchema = z
  .object({
    problem_id: PublicLedgerProblemIdSchema,
    reason: z.string().trim().min(1).max(1000),
    step_up_authenticated_at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type SponsorProblemHideRequest = z.infer<typeof SponsorProblemHideRequestSchema>;

/** Historical acceptance, not an assertion about visibility after later decisions. */
export const SponsorProblemHideReceiptSchema = z
  .object({
    ok: z.literal(true),
    problem_id: PublicLedgerProblemIdSchema,
    action: z.literal("hide"),
    visibility: z.literal("hidden"),
    actor_kind: z.literal("sponsor"),
    control_id: z.string().regex(/^CC-[0-9A-HJKMNP-TV-Z]{26}$/),
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    applied_at: z.string().datetime({ offset: true }).max(40),
  })
  .strict();
export type SponsorProblemHideReceipt = z.infer<typeof SponsorProblemHideReceiptSchema>;
