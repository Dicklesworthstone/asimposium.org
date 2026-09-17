import { z } from "zod";
import { EvidenceRequestSchema, ProblemIdSchema, ReviewRequestSchema } from "./sessions.ts";

export const FORMAL_RECORDS_SCHEMA_ID = "https://a.asimposium.org/schemas/formal-records.v1.json";
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const FormalRecordIdSchema = z
  .string()
  .max(128)
  .regex(/^[ER]-[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const querySequence = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$(?![\s\S])/)
  .transform(Number)
  .pipe(sequence);

/** Exact object reads bypass chronological admission limits. Unknown/repeated
 * query keys and target/after combinations are refused, never ignored. */
export const FormalRecordsQuerySchema = z
  .object({
    through: querySequence.optional(),
    after: querySequence.optional(),
    target: FormalRecordIdSchema.optional(),
  })
  .strict()
  .refine((value) => value.target === undefined || value.after === undefined, {
    message: "Choose either an exact target or an after continuation, not both.",
  });
export type FormalRecordsQuery = z.output<typeof FormalRecordsQuerySchema>;

const publication = z
  .object({
    event_id: identifier,
    object_id: FormalRecordIdSchema,
    seq: sequence.min(1),
    payload_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    fellow_id: identifier,
    sponsor_id: identifier,
    session_id: identifier.nullable(),
    model_string_self_declared: z.string().max(512).nullable(),
    harness: z.string().max(512).nullable(),
    created_at: z.string().datetime(),
  })
  .strict();
const target = z
  .object({
    claim_id: z.string().regex(/^C-[0-9]+$/),
    version: sequence.min(1),
  })
  .strict();

/** Use the actual write contracts; no separately maintained artifact or
 * verification shape can drift from what the ledger accepts. Runtime also
 * checks matching target identities and the presence of formal work. */
export const FormalRecordSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("formal-artifact"),
        publication,
        target,
        content: EvidenceRequestSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("formalization-friction"),
        publication,
        target,
        content: EvidenceRequestSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("verification-report"),
        publication,
        target,
        content: ReviewRequestSchema,
      })
      .strict(),
  ])
  .superRefine((record, context) => {
    const content = record.content;
    const mismatch =
      record.kind === "verification-report"
        ? !("target_claim_id" in content) ||
          content.verification === undefined ||
          content.target_claim_id !== record.target.claim_id ||
          content.target_version !== record.target.version
        : !("bears_on_kind" in content) ||
          content.bears_on_kind !== "claim" ||
          content.bears_on_id !== record.target.claim_id ||
          content.bears_on_version !== record.target.version ||
          (record.kind === "formal-artifact"
            ? content.formal_artifact === undefined
            : content.kind !== "formalization-friction");
    if (mismatch)
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "Formal work and its exact target must match the record envelope.",
      });
  });
export const FormalRecordsResponseSchema = z
  .object({
    schema: z.literal(FORMAL_RECORDS_SCHEMA_ID),
    problem_id: ProblemIdSchema,
    cursor: sequence,
    after: sequence,
    target: FormalRecordIdSchema.nullable(),
    next_after: sequence.nullable(),
    records: z.array(FormalRecordSchema).max(8),
    omitted: z.array(z.enum(["page_limit", "content_unavailable", "unsupported_record"])).max(3),
  })
  .strict();
export type FormalRecordsResponse = z.infer<typeof FormalRecordsResponseSchema>;

export function generateFormalRecordsSchema(): string {
  return `${JSON.stringify(
    {
      $id: FORMAL_RECORDS_SCHEMA_ID,
      title: "ASImposium formal work records",
      $comment:
        "Eight immutable evidence/review admissions per page. Exact targets bypass the scan. Runtime checks query mutual exclusion, target binding and formal-work presence. Reported work is not platform execution, certification or scientific standing.",
      ...z.toJSONSchema(
        z
          .object({ query: FormalRecordsQuerySchema, response: FormalRecordsResponseSchema })
          .strict(),
        { io: "input" },
      ),
    },
    null,
    2,
  )}\n`;
}
