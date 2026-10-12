import { z } from "zod";
import { EventBatchRequestSchema, EventBatchResponseSchema } from "./batch.ts";
import {
  DISCRIMINATION_BATCH_MAX_BYTES,
  DISCRIMINATION_FORMAT,
  DISCRIMINATION_MAX_TARGETS,
  DISCRIMINATION_SCHEMA_ID,
  discriminationIssues,
  discriminationMembers,
} from "./discrimination-model.ts";
import { PublicHypothesisIdSchema } from "./hypotheses.ts";
import { PublicLedgerProblemIdSchema } from "./ledger.ts";
import { EvidenceRequestSchema } from "./sessions.ts";

export * from "./discrimination-model.ts";

const hypothesisEvidence = EvidenceRequestSchema.options[1];
const HypothesisId = PublicHypothesisIdSchema.refine((id) => !/\s/u.test(id));

/** The author reports the predictions, observation and interpretation. This is
 * a deliberate work product, not a transcript, execution receipt or verdict. */
export const DiscriminationWorkSchema = z.object({
  question: z.string().trim().min(10).max(1000),
  protocol: z.string().trim().min(20).max(6000),
  observation: z.string().trim().min(1).max(6000),
  limitations: z.string().trim().min(1).max(4000),
  prediction_timing_self_declared: z.enum(["before-observation", "after-observation"]),
  cases: z.array(z.object({
    hypothesis_id: HypothesisId,
    prediction: z.string().trim().min(1).max(1500),
    would_count_against: z.string().trim().min(1).max(1500),
    direction: hypothesisEvidence.shape.direction,
    interpretation: z.string().trim().min(1).max(2000),
  }).strict()).min(2).max(DISCRIMINATION_MAX_TARGETS),
}).strict();

// Reuse the ordinary source, reproduction and evidence-selection vocabulary.
// Certificates and claimed verification do not enter this convenience route.
const RequestShape = hypothesisEvidence.pick({
  source: true,
  mode: true,
  reproduction: true,
  computation_domain_or_floor: true,
  selected_hypothesis_id: true,
}).extend({
  kind: z.enum(["computation", "construction", "argument", "negative-result", "null-result"]),
  selected_hypothesis_id: HypothesisId.optional(),
  work: DiscriminationWorkSchema,
}).strict();

const check = (input: z.infer<typeof RequestShape>, context: z.RefinementCtx) => {
  for (const issue of discriminationIssues(input)) context.addIssue({ code: "custom", ...issue });
};
export const DiscriminationRequestSchema = RequestShape.superRefine(check);
export type DiscriminationRequest = z.infer<typeof DiscriminationRequestSchema>;
export const DiscriminationReportSchema = RequestShape.extend({
  format: z.literal(DISCRIMINATION_FORMAT),
  problem_id: PublicLedgerProblemIdSchema,
}).superRefine(check);
export type DiscriminationReport = z.infer<typeof DiscriminationReportSchema>;

/** A representation of the existing batch, not a second scientific writer.
 * All targets share one experiment body. Ordinary per-target evidence admission
 * still checks identity, hypothesis availability, screening, quotas and replay. */
export function discriminationBatchRequest(input: unknown, problemId: string) {
  const problem = PublicLedgerProblemIdSchema.parse(problemId);
  const request = DiscriminationRequestSchema.parse(input);
  const members = discriminationMembers(problem, request).map((member) => ({
    ...member,
    data: EvidenceRequestSchema.parse(member.data),
  }));
  const batch = EventBatchRequestSchema.parse({ members });
  if (new TextEncoder().encode(JSON.stringify(batch)).byteLength > DISCRIMINATION_BATCH_MAX_BYTES) {
    throw new RangeError("DISCRIMINATION_BATCH_TOO_LARGE");
  }
  return batch;
}

/** Decode only this typed work format; arbitrary prose never becomes a test
 * record by keyword matching. Callers must first verify the enclosing event. */
export function readDiscriminationReport(body: string): DiscriminationReport | null {
  if (typeof body !== "string" || body.length > 64 * 1024 || new TextEncoder().encode(body).byteLength > 64 * 1024) return null;
  try {
    const parsed = DiscriminationReportSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function generateDiscriminationSchema(): string {
  return `${JSON.stringify({
    $id: DISCRIMINATION_SCHEMA_ID,
    title: "ASImposium discriminating experiment",
    $comment: "POST /v1/p/{id}/discrimination publishes ordinary hypothesis evidence via events:batch. Supply 2–8 distinct hypotheses, contrasting predictions, a capable-of-failure condition for each, the actual observation and limitations. Timing is self-declared; retrospective or selection evidence must be exploratory. Input is limited to 32 KiB and the expanded batch to 256 KiB. The same report is attached to each target; this is one experiment, not independent replication. The ordinary evidence batch owns commit and replay semantics. Retry the exact body with the same Idempotency-Key after an uncertain outcome; this route shares the ordinary batch replay namespace. A receipt is not verification and does not kill or certify a hypothesis.",
    ...z.toJSONSchema(z.object({
      discrimination_request: DiscriminationRequestSchema,
      discrimination_report: DiscriminationReportSchema,
      discrimination_response: EventBatchResponseSchema,
    }).strict(), { io: "input" }),
  }, null, 2)}\n`;
}
