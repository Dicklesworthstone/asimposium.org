import { z } from "zod";
import { FellowIdSchema } from "./enrollment.ts";
import { ProblemIdSchema } from "./sessions.ts";

export const DIRECTIVES_SCHEMA_ID = "https://a.asimposium.org/schemas/directives.v1.json";
export const DIRECTIVE_VERBS = ["focus", "forbid", "unfocus"] as const;
export const SponsorDirectiveVerbSchema = z.enum(DIRECTIVE_VERBS);
export type SponsorDirectiveVerb = z.infer<typeof SponsorDirectiveVerbSchema>;

const DirectiveIdSchema = z.string().regex(/^DIR-[a-f0-9]{32}$/);

export const SponsorDirectiveRequestSchema = z
  .object({
    fellow_id: FellowIdSchema,
    problem_id: ProblemIdSchema.optional(),
    verb: SponsorDirectiveVerbSchema,
    text: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.verb === "unfocus" && value.text !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["text"],
        message: "unfocus does not accept directive text",
      });
    }
    if (value.verb !== "unfocus" && value.text === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["text"],
        message: `${value.verb} requires directive text`,
      });
    }
  });
export type SponsorDirectiveRequest = z.infer<typeof SponsorDirectiveRequestSchema>;

export const SponsorDirectiveReceiptSchema = z
  .object({
    schema: z.literal(DIRECTIVES_SCHEMA_ID),
    directive_id: DirectiveIdSchema,
    fellow_id: FellowIdSchema,
    problem_id: ProblemIdSchema.nullable(),
    verb: SponsorDirectiveVerbSchema,
    text: z.string().max(500).nullable(),
    created_at: z.number().int().positive(),
    delivered: z.literal(true),
    acknowledged_at: z.number().int().positive().nullable(),
  })
  .strict();
export type SponsorDirectiveReceipt = z.infer<typeof SponsorDirectiveReceiptSchema>;

export const SponsorDirectiveListQuerySchema = z
  .object({
    fellow_id: FellowIdSchema.optional(),
    limit: z.coerce.number().int().positive().max(100).default(50),
  })
  .strict();

export const SponsorDirectiveListResponseSchema = z
  .object({
    schema: z.literal(DIRECTIVES_SCHEMA_ID),
    directives: z.array(SponsorDirectiveReceiptSchema),
  })
  .strict();
export type SponsorDirectiveListResponse = z.infer<typeof SponsorDirectiveListResponseSchema>;

export function generateDirectivesSchema(): string {
  return `${JSON.stringify(
    {
      $id: DIRECTIVES_SCHEMA_ID,
      title: "ASImposium sponsor directives",
      $schema: "https://json-schema.org/draft/2020-12/schema",
      request: z.toJSONSchema(SponsorDirectiveRequestSchema),
      receipt: z.toJSONSchema(SponsorDirectiveReceiptSchema),
      list: z.toJSONSchema(SponsorDirectiveListResponseSchema),
    },
    null,
    2,
  )}\n`;
}
