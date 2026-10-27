import { z } from "zod";
import { ProblemIdSchema } from "./sessions.ts";

export const SCREENING_APPEALS_SCHEMA_ID =
  "https://a.asimposium.org/schemas/screening-appeals.v1.json";
export const APPEAL_STEP_UP_SECONDS = 15 * 60;
// Fifty 2,000-code-unit statements can require 600 KiB when JSON-escaped.
// Allow the bounded receipt and identity fields as well as ordinary Unicode.
export const SCREENING_APPEALS_MAX_RESPONSE_BYTES = 1024 * 1024;
export const ScreeningCaseIdSchema = z.string().regex(/^QC-[0-9A-HJKMNP-TV-Z]{26}$/);
export const ScreeningAppealIdSchema = z.string().regex(/^AP-[0-9A-HJKMNP-TV-Z]{26}$/);
export const ScreeningAppealRequestSchema = z
  .object({
    case_id: ScreeningCaseIdSchema,
    statement: z.string().trim().min(20).max(2000),
  })
  .strict();
export const ScreeningAppealDecisionSchema = z
  .object({
    appeal_id: ScreeningAppealIdSchema,
    decision: z.enum(["release", "uphold"]),
    reason: z.string().trim().min(20).max(1000),
    step_up_authenticated_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const ScreeningAppealReceiptSchema = z
  .object({
    appeal_id: ScreeningAppealIdSchema,
    case_id: ScreeningCaseIdSchema,
    state: z.enum(["pending", "released", "upheld"]),
    submitted_at: z.iso.datetime(),
    decided_at: z.iso.datetime().nullable(),
    audit_event_id: z.string().min(1).max(128).nullable(),
  })
  .strict();
export const SponsorScreeningCaseSchema = z
  .object({
    case_id: ScreeningCaseIdSchema,
    problem_id: ProblemIdSchema,
    fellow_id: z.string().min(1).max(128),
    route: z.string().min(1).max(64),
    state: z.enum(["pending", "released", "rejected", "superseded"]),
    created_at: z.iso.datetime(),
    appeal: ScreeningAppealReceiptSchema.nullable(),
  })
  .strict();
export const SponsorScreeningCasesResponseSchema = z
  .object({
    cases: z.array(SponsorScreeningCaseSchema).max(50),
    has_more: z.boolean(),
  })
  .strict();
export const OperatorScreeningAppealSchema = ScreeningAppealReceiptSchema.extend({
  sponsor_id: z.string().min(1).max(128),
  fellow_id: z.string().min(1).max(128),
  problem_id: ProblemIdSchema,
  statement: z.string().max(2000),
  original_operator_id: z.string().min(1).max(128),
}).strict();
export const OperatorScreeningAppealsResponseSchema = z
  .object({
    appeals: z.array(OperatorScreeningAppealSchema).max(50),
    has_more: z.boolean(),
  })
  .strict();
export const ScreeningAppealsContractsSchema = z
  .object({
    request: ScreeningAppealRequestSchema,
    decision: ScreeningAppealDecisionSchema,
    receipt: ScreeningAppealReceiptSchema,
    sponsor_cases: SponsorScreeningCasesResponseSchema,
    operator_queue: OperatorScreeningAppealsResponseSchema,
  })
  .strict();
export function generateScreeningAppealsSchema(): string {
  return `${JSON.stringify(
    { $id: SCREENING_APPEALS_SCHEMA_ID, ...z.toJSONSchema(ScreeningAppealsContractsSchema) },
    null,
    2,
  )}\n`;
}
export type ScreeningAppealRequest = z.infer<typeof ScreeningAppealRequestSchema>;
export type ScreeningAppealDecision = z.infer<typeof ScreeningAppealDecisionSchema>;
export type ScreeningAppealReceipt = z.infer<typeof ScreeningAppealReceiptSchema>;
export type SponsorScreeningCase = z.infer<typeof SponsorScreeningCaseSchema>;
export type OperatorScreeningAppeal = z.infer<typeof OperatorScreeningAppealSchema>;
