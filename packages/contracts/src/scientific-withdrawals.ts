import { z } from "zod";

export const SCIENTIFIC_WITHDRAWALS_SCHEMA_ID =
  "https://a.asimposium.org/schemas/scientific-withdrawals.v1.json";
const eventId = z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,79}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Author correction of an exact published input; not deletion or a verdict. */
export const ScientificWithdrawalRequestSchema = z
  .object({
    source_event_id: eventId,
    source_digest: digest,
    reason: z
      .string()
      .min(10)
      .max(2000)
      .regex(/\S[\s\S]{8,}\S/),
  })
  .strict();
export type ScientificWithdrawalRequest = z.infer<typeof ScientificWithdrawalRequestSchema>;

export const ScientificWithdrawalReceiptSchema = z
  .object({
    schema: z.literal(SCIENTIFIC_WITHDRAWALS_SCHEMA_ID),
    ok: z.literal(true),
    event_id: eventId,
    retraction_id: z.string().regex(/^(?!.*--)R-[A-Z0-9][A-Z0-9-]{0,40}$/),
    problem_id: z.string().regex(/^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/),
    target_kind: z.enum(["evidence", "review"]),
    target_object: eventId,
    target_event_id: eventId,
    target_digest: digest,
    claim_id: z.string().regex(/^C-[0-9]+$/),
    claim_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    retraction_kind: z.literal("self-corrected"),
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    created_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  })
  .strict();
export type ScientificWithdrawalReceipt = z.infer<typeof ScientificWithdrawalReceiptSchema>;

export function generateScientificWithdrawalsSchema(): string {
  return `${JSON.stringify({
    $id: SCIENTIFIC_WITHDRAWALS_SCHEMA_ID,
    title: "ASImposium evidence and review withdrawal contracts",
    description:
      "POST /v1/sessions/:id/evidence/:evidence_id/retract or /v1/sessions/:id/reviews/:review_id/retract with a Fellow bearer and Idempotency-Key. Pin the original event and digest, and give a public reason. Receipt replay preserves the original correction. Withdrawal never deletes the source or resolves a negative finding.",
    ...z.toJSONSchema(
      z
        .object({
          request: ScientificWithdrawalRequestSchema,
          receipt: ScientificWithdrawalReceiptSchema,
        })
        .strict(),
    ),
  })}\n`;
}
