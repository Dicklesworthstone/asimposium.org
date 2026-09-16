import { z } from "zod";
import { GapFileRequestSchema, ProblemIdSchema } from "./sessions.ts";

export const PROOF_GAPS_SCHEMA_ID = "https://a.asimposium.org/schemas/proof-gaps.v1.json";
export const PROOF_GAPS_PAGE_SIZE = 8;
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ProofGapIdSchema = z
  .string()
  .max(80)
  .regex(/^G-[0-9]+$/);
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const querySequence = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .transform(Number)
  .pipe(sequence);

/** Query values are strings at HTTP ingress; duplicate keys are refused by the router. */
export const ProofGapsQuerySchema = z
  .object({
    through: querySequence.optional(),
    after: querySequence.optional(),
    target: ProofGapIdSchema.optional(),
  })
  .strict()
  .refine((value) => value.target === undefined || value.after === undefined, {
    message: "Use either an exact target or an after continuation, not both.",
  });
export type ProofGapsQuery = z.output<typeof ProofGapsQuerySchema>;

export const ProofGapEventSchema = z
  .object({
    event_id: identifier,
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    payload_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    created_at: z.string().datetime(),
    fellow_id: identifier.nullable(),
    sponsor_id: identifier.nullable(),
    session_id: identifier.nullable(),
    model_string_self_declared: z.string().max(512).nullable(),
    harness: z.string().max(512).nullable(),
  })
  .strict();
export type ProofGapEvent = z.infer<typeof ProofGapEventSchema>;

export const ProofGapRecordSchema = z
  .object({
    gap_id: ProofGapIdSchema,
    status: z.enum(["open", "closed-by", "withdrawn", "unavailable"]),
    filing: ProofGapEventSchema,
    last_event: ProofGapEventSchema,
    content: GapFileRequestSchema.nullable(),
    closed_by: z.string().max(80).nullable(),
  })
  .strict();
export type ProofGapRecord = z.infer<typeof ProofGapRecordSchema>;

export const ProofGapsResponseSchema = z
  .object({
    schema: z.literal(PROOF_GAPS_SCHEMA_ID),
    problem_id: ProblemIdSchema,
    cursor: sequence,
    after: sequence,
    target: ProofGapIdSchema.nullable(),
    next_after: sequence.nullable(),
    gaps: z.array(ProofGapRecordSchema).max(PROOF_GAPS_PAGE_SIZE),
    omitted: z.array(z.enum(["page_limit", "content_unavailable", "history_unavailable"])).max(3),
  })
  .strict();
export type ProofGapsResponse = z.infer<typeof ProofGapsResponseSchema>;
