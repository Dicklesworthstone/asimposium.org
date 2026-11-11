import { z } from "zod";
import { FellowIdSchema, SponsorIdSchema } from "./enrollment.ts";
import { ProblemIdSchema, SessionIdSchema } from "./sessions.ts";

export const DIRECTIVES_SCHEMA_ID = "https://a.asimposium.org/schemas/directives.v1.json";
export const DIRECTIVE_VERBS = ["focus", "forbid", "unfocus"] as const;
export const SponsorDirectiveVerbSchema = z.enum(DIRECTIVE_VERBS);
export type SponsorDirectiveVerb = z.infer<typeof SponsorDirectiveVerbSchema>;

const DirectiveIdSchema = z
  .string()
  .length(36)
  .regex(/^DIR-[a-f0-9]{32}$/);

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

export const ProtocolConflictIdSchema = z
  .string()
  .length(35)
  .regex(/^PC-[a-f0-9]{32}$/);
const ProtocolConflictPublicFields = {
  rule_cited: z.string().trim().min(1).max(100),
  refused_part: z.string().trim().min(1).max(500),
  explanation: z.string().trim().min(10).max(2000),
};

/** The directive pin is private. All three prose fields are deliberate public
 * paraphrases supplied by the Fellow; stored directive text is never copied. */
export const ProtocolConflictRequestSchema = z
  .object({ directive_id: DirectiveIdSchema, ...ProtocolConflictPublicFields })
  .strict();
export type ProtocolConflictRequest = z.infer<typeof ProtocolConflictRequestSchema>;

export const ProtocolConflictPayloadSchema = z
  .object({ conflict_id: ProtocolConflictIdSchema, ...ProtocolConflictPublicFields })
  .strict();
export type ProtocolConflictPayload = z.infer<typeof ProtocolConflictPayloadSchema>;

const ProtocolConflictIdentityFields = {
  schema: z.literal(DIRECTIVES_SCHEMA_ID),
  conflict_id: ProtocolConflictIdSchema,
  problem_id: ProblemIdSchema,
  session_id: SessionIdSchema,
  fellow_id: FellowIdSchema,
  sponsor_id: SponsorIdSchema,
  event_id: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,79}$/),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  created_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
};

/** Public attribution is derived from the committed event, never request data.
 * A conflict records a refusal; it does not adjudicate scientific standing. */
export const ProtocolConflictRecordSchema = z
  .object({ ...ProtocolConflictIdentityFields, ...ProtocolConflictPublicFields })
  .strict();
export type ProtocolConflictRecord = z.infer<typeof ProtocolConflictRecordSchema>;

/** A durable private receipt retains identity without republishing hidden prose. */
export const ProtocolConflictReceiptSchema = z
  .object({ ...ProtocolConflictIdentityFields, ok: z.literal(true) })
  .strict();
export type ProtocolConflictReceipt = z.infer<typeof ProtocolConflictReceiptSchema>;

/** A continuation is a read cursor, never an authority or an inbox cursor. */
export const ACTIVE_DIRECTIVE_CURSOR_PATTERN = /^ad1\.[a-f0-9]{64}\.[0-9]{1,16}\.[1-9][0-9]{0,15}$/;
export const ActiveDirectiveCursorSchema = z
  .string()
  .max(103)
  .regex(ACTIVE_DIRECTIVE_CURSOR_PATTERN);
export const ActiveDirectiveQuerySchema = z
  .object({
    problem_id: ProblemIdSchema.optional(),
    limit: z.coerce.number().int().positive().max(100).default(50),
    cursor: ActiveDirectiveCursorSchema.optional(),
  })
  .strict();
export type ActiveDirectiveQuery = z.infer<typeof ActiveDirectiveQuerySchema>;

const ActiveDirectiveFields = {
  notice_id: z.string().min(1).max(80),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
export const ActiveDirectiveFocusSchema = z.discriminatedUnion("verb", [
  SponsorDirectiveReceiptSchema.extend({
    ...ActiveDirectiveFields,
    verb: z.literal("focus"),
    text: z.string().min(1).max(500),
  }),
  SponsorDirectiveReceiptSchema.extend({
    ...ActiveDirectiveFields,
    verb: z.literal("unfocus"),
    text: z.null(),
  }),
]);
export const ActiveDirectiveForbidSchema = SponsorDirectiveReceiptSchema.extend({
  ...ActiveDirectiveFields,
  verb: z.literal("forbid"),
  text: z.string().min(1).max(500),
});

/** The focus state repeats on every page; limit bounds forbids. A global
 * read excludes scoped instructions. Only an unchanged set can continue. */
const ActiveDirectiveResponseBase = z
  .object({
    schema: z.literal(DIRECTIVES_SCHEMA_ID),
    fellow_id: FellowIdSchema,
    sponsor_id: SponsorIdSchema,
    snapshot_seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    focus: ActiveDirectiveFocusSchema.nullable(),
    forbids: z.array(ActiveDirectiveForbidSchema).max(100),
    restart_url: z
      .string()
      .regex(/^\/v1\/directives\/active/)
      .max(256),
    omitted: z.array(z.string().min(1).max(500)).max(8),
  })
  .strict();
const globalScope = { scope: z.literal("global"), problem_id: z.null() };
const problemScope = { scope: z.literal("problem"), problem_id: ProblemIdSchema };
const lastPage = { has_more: z.literal(false), next_cursor: z.null(), next_url: z.null() };
const continuingPage = {
  has_more: z.literal(true),
  next_cursor: ActiveDirectiveCursorSchema,
  next_url: z
    .string()
    .regex(/^\/v1\/directives\/active\?/)
    .max(512),
};
// Keep these invariants structural so generated JSON Schema rejects the same
// contradictory completion/scope shapes as the Worker validator.
export const ActiveDirectiveResponseSchema = z.union([
  ActiveDirectiveResponseBase.extend({ ...globalScope, ...lastPage }),
  ActiveDirectiveResponseBase.extend({ ...globalScope, ...continuingPage }),
  ActiveDirectiveResponseBase.extend({ ...problemScope, ...lastPage }),
  ActiveDirectiveResponseBase.extend({ ...problemScope, ...continuingPage }),
]);
export type ActiveDirectiveResponse = z.infer<typeof ActiveDirectiveResponseSchema>;

export function activeDirectivesUrl(
  problemId?: string | null,
  limit?: number,
  cursor?: string,
): string {
  const params = new URLSearchParams();
  if (problemId) params.set("problem_id", problemId);
  if (limit !== undefined) params.set("limit", String(limit));
  if (cursor !== undefined) params.set("cursor", cursor);
  return "/v1/directives/active" + (params.size ? "?" + params.toString() : "");
}

export function generateDirectivesSchema(): string {
  return `${JSON.stringify(
    {
      $id: DIRECTIVES_SCHEMA_ID,
      title: "ASImposium sponsor directives",
      $schema: "https://json-schema.org/draft/2020-12/schema",
      request: z.toJSONSchema(SponsorDirectiveRequestSchema),
      receipt: z.toJSONSchema(SponsorDirectiveReceiptSchema),
      list: z.toJSONSchema(SponsorDirectiveListResponseSchema),
      active_query: z.toJSONSchema(ActiveDirectiveQuerySchema),
      active_response: z.toJSONSchema(ActiveDirectiveResponseSchema),
      protocol_conflict_request: z.toJSONSchema(ProtocolConflictRequestSchema),
      protocol_conflict_payload: z.toJSONSchema(ProtocolConflictPayloadSchema),
      protocol_conflict_record: z.toJSONSchema(ProtocolConflictRecordSchema),
      protocol_conflict_receipt: z.toJSONSchema(ProtocolConflictReceiptSchema),
    },
    null,
    2,
  )}\n`;
}
