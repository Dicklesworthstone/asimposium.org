import { z } from "zod";
import { ProblemIndexTimestampSchema, PublicLedgerProblemIdSchema } from "./ledger.ts";
import { HypothesisKillRequestSchema, HypothesisRequestSchema } from "./sessions.ts";

export const HYPOTHESES_SCHEMA_ID = "https://a.asimposium.org/schemas/hypotheses.v1.json";
const Sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Cursor = z.string().max(16).regex(/^(?:0|[1-9][0-9]{0,15})$/)
  .refine(value => Number.isSafeInteger(Number(value)));
const Identifier = z.string().max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

/** Read contracts reuse the exact write vocabulary; expected_evidence is
 * stored as null when absent. Public bodies are untrusted work products. */
export const HypothesisPublicationSchema = HypothesisRequestSchema.extend({
  expected_evidence: HypothesisRequestSchema.shape.expected_evidence.unwrap().nullable(),
  discriminating_predictions: HypothesisRequestSchema.shape.discriminating_predictions.unwrap(),
});
export const HypothesesQuerySchema = z.object({
  through: Cursor.optional(),
  after: Cursor.optional(),
}).strict().superRefine((query, context) => {
  if (query.through !== undefined && Number(query.after ?? 0) > Number(query.through))
    context.addIssue({ code: "custom", message: "after cannot exceed through" });
});
export type HypothesesQuery = z.infer<typeof HypothesesQuerySchema>;

const Envelope = z.object({
  event_id: Identifier,
  seq: Sequence.min(1),
  created_at: ProblemIndexTimestampSchema,
  payload_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  fellow_id: Identifier.nullable(),
  sponsor_id: Identifier.nullable(),
  session_id: Identifier.nullable(),
  model_self_declared: z.string().max(256).nullable(),
  harness_self_declared: z.string().max(256).nullable(),
}).strict();
export const PublicHypothesisSchema = z.object({
  hypothesis_id: z.string().max(80).regex(/^H-[0-9]+$/),
  status: z.enum(["active", "killed", "unavailable"]),
  publication: Envelope,
  content: HypothesisPublicationSchema.nullable(),
  last_event: Envelope,
  kill: HypothesisKillRequestSchema.nullable(),
}).strict();
export type PublicHypothesis = z.infer<typeof PublicHypothesisSchema>;
export const HypothesesResponseSchema = z.object({
  schema: z.literal(HYPOTHESES_SCHEMA_ID),
  problem_id: PublicLedgerProblemIdSchema,
  cursor: Sequence,
  after: Sequence,
  hypotheses: z.array(PublicHypothesisSchema).max(8),
  next_after: Sequence.min(1).nullable(),
  omitted: z.array(z.enum(["page_limit", "content_unavailable", "lifecycle_unavailable"])).max(3),
}).strict().superRefine((face, context) => {
  let previous = face.after;
  const ids = new Set<string>();
  for (const item of face.hypotheses) {
    if (item.publication.seq <= previous || item.publication.seq > item.last_event.seq ||
        item.last_event.seq > face.cursor || ids.has(item.hypothesis_id) ||
        (item.status === "active" && item.last_event.event_id !== item.publication.event_id) ||
        (item.kill !== null && (item.status !== "killed" || item.kill.hypothesis_id !== item.hypothesis_id)))
      context.addIssue({ code: "custom", message: "inconsistent hypothesis history" });
    previous = item.publication.seq;
    ids.add(item.hypothesis_id);
  }
  if (face.after > face.cursor || (face.next_after !== null &&
      (face.next_after !== previous || face.next_after <= face.after || face.next_after > face.cursor)) ||
      (face.next_after !== null) !== face.omitted.includes("page_limit") ||
      (face.hypotheses.some(item => item.content === null || (item.status === "killed" && item.kill === null)) &&
        !face.omitted.includes("content_unavailable")) ||
      (face.hypotheses.some(item => item.status === "unavailable") && !face.omitted.includes("lifecycle_unavailable")))
    context.addIssue({ code: "custom", message: "inconsistent hypothesis read accounting" });
});
export type HypothesesResponse = z.infer<typeof HypothesesResponseSchema>;
export const HypothesesContractsSchema = z.object({
  query: HypothesesQuerySchema,
  response: HypothesesResponseSchema,
}).strict();
