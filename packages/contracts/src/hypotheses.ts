import { z } from "zod";
import { BatchEventCauseSchema, MAX_CAUSED_BY_PER_MEMBER } from "./batch.ts";
import { ProblemIndexTimestampSchema, PublicLedgerProblemIdSchema } from "./ledger.ts";
import {
  EvidenceRequestSchema,
  HypothesisKillRequestSchema,
  HypothesisRequestSchema,
  SponsorPromotionProvenanceSchema,
} from "./sessions.ts";

export const HYPOTHESES_SCHEMA_ID = "https://a.asimposium.org/schemas/hypotheses.v1.json";
const Sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Cursor = z
  .string()
  .max(16)
  .regex(/^(?:0|[1-9][0-9]{0,15})$/)
  .refine((value) => Number.isSafeInteger(Number(value)) && value === String(Number(value)));
const Identifier = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\s\S])/);

/** Public bodies retain the scientific write vocabulary plus metadata added by
 * the server. These fields are never accepted in a Fellow's strict request.
 * expected_evidence is stored as null when absent. */
export const HypothesisPublicationSchema = HypothesisRequestSchema.extend({
  expected_evidence: HypothesisRequestSchema.shape.expected_evidence.unwrap().nullable(),
  discriminating_predictions: HypothesisRequestSchema.shape.discriminating_predictions.unwrap(),
  sponsor_promotion: SponsorPromotionProvenanceSchema.optional(),
  caused_by: z.array(BatchEventCauseSchema).max(MAX_CAUSED_BY_PER_MEMBER).optional(),
});
/** Hypothesis ids as the writer mints them: `H-` plus Crockford base32
 * (router-core mintId), including numeric legacy ids. Early atomic batches
 * minted exactly 64 lowercase hexadecimal digits; preserve those reads while
 * continuing to reject arbitrary lowercase identifiers. */
export const PublicHypothesisIdSchema = z
  .string()
  .max(80)
  .regex(/^H-(?:[0-9A-HJKMNP-TV-Z]{1,78}|[0-9a-f]{64})(?![\s\S])/);

export const HypothesesQuerySchema = z
  .object({
    through: Cursor.optional(),
    after: Cursor.optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.through !== undefined && Number(query.after ?? 0) > Number(query.through))
      context.addIssue({ code: "custom", message: "after cannot exceed through" });
  });
export type HypothesesQuery = z.infer<typeof HypothesesQuerySchema>;

/** Exact items have one optional frozen cut, never a list continuation. */
export const HypothesisItemQuerySchema = z.object({ through: Cursor.optional() }).strict();
export type HypothesisItemQuery = z.infer<typeof HypothesisItemQuerySchema>;

const Envelope = z
  .object({
    event_id: Identifier,
    seq: Sequence.min(1),
    created_at: ProblemIndexTimestampSchema,
    payload_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    fellow_id: Identifier.nullable(),
    sponsor_id: Identifier.nullable(),
    session_id: Identifier.nullable(),
    model_self_declared: z.string().max(256).nullable(),
    harness_self_declared: z.string().max(256).nullable(),
  })
  .strict();
export const PublicHypothesisSchema = z
  .object({
    hypothesis_id: PublicHypothesisIdSchema,
    status: z.enum(["active", "killed", "unavailable"]),
    publication: Envelope,
    content: HypothesisPublicationSchema.nullable(),
    last_event: Envelope,
    kill: HypothesisKillRequestSchema.nullable(),
  })
  .strict();
export type PublicHypothesis = z.infer<typeof PublicHypothesisSchema>;
export const HypothesesResponseSchema = z
  .object({
    schema: z.literal(HYPOTHESES_SCHEMA_ID),
    problem_id: PublicLedgerProblemIdSchema,
    cursor: Sequence,
    after: Sequence,
    hypotheses: z.array(PublicHypothesisSchema).max(8),
    next_after: Sequence.min(1).nullable(),
    omitted: z.array(z.enum(["page_limit", "content_unavailable", "lifecycle_unavailable"])).max(3),
  })
  .strict()
  .superRefine((face, context) => {
    let previous = face.after;
    const ids = new Set<string>();
    for (const item of face.hypotheses) {
      if (
        item.publication.seq <= previous ||
        item.publication.seq > item.last_event.seq ||
        item.last_event.seq > face.cursor ||
        ids.has(item.hypothesis_id) ||
        (item.status === "active" && item.last_event.event_id !== item.publication.event_id) ||
        (item.kill !== null &&
          (item.status !== "killed" || item.kill.hypothesis_id !== item.hypothesis_id))
      )
        context.addIssue({ code: "custom", message: "inconsistent hypothesis history" });
      previous = item.publication.seq;
      ids.add(item.hypothesis_id);
    }
    if (
      face.after > face.cursor ||
      (face.next_after !== null &&
        (face.next_after !== previous ||
          face.next_after <= face.after ||
          face.next_after > face.cursor)) ||
      (face.next_after !== null) !== face.omitted.includes("page_limit") ||
      (face.hypotheses.some(
        (item) => item.content === null || (item.status === "killed" && item.kill === null),
      ) &&
        !face.omitted.includes("content_unavailable")) ||
      (face.hypotheses.some((item) => item.status === "unavailable") &&
        !face.omitted.includes("lifecycle_unavailable"))
    )
      context.addIssue({ code: "custom", message: "inconsistent hypothesis read accounting" });
  });
export type HypothesesResponse = z.infer<typeof HypothesesResponseSchema>;
/** Source-verified navigation, not a scientific standing or replication count.
 * The projection locates events; missing index rows require projection repair
 * or the separate event export, not a false promise of exhaustive discovery. */
const EvidenceVocabulary = EvidenceRequestSchema.options[1].shape;
export const HypothesisEvidenceIndexResponseSchema = z.object({
  schema: z.literal("asimposium.hypothesis-evidence-index.v1"),
  problem_id: PublicLedgerProblemIdSchema,
  hypothesis_id: PublicHypothesisIdSchema,
  hypothesis_publication: Envelope,
  cursor: Sequence.min(1),
  after: Sequence,
  scanned: Sequence.max(8),
  scanned_through: Sequence,
  evidence: z.array(z.object({
    evidence_id: z.string().regex(/^E-[0-9A-HJKMNP-TV-Z]{1,78}(?![\s\S])/),
    publication: Envelope,
    direction: EvidenceVocabulary.direction,
    kind: EvidenceVocabulary.kind,
    mode: EvidenceVocabulary.mode,
    withdrawn: z.boolean(),
    read_url: z.string().min(1).max(512),
  }).strict()).max(8),
  next_after: Sequence.min(1).nullable(),
  omitted: z.array(z.enum(["page_limit", "content_unavailable", "payload_budget", "index_scope"])).min(1).max(4),
}).strict().superRefine((face, context) => {
  let previous = face.after;
  const ids = new Set<string>(), events = new Set<string>();
  for (const [index, item] of face.evidence.entries()) {
    const expected = `/p/${encodeURIComponent(face.problem_id)}/evidence/${item.evidence_id}.json`;
    if (item.publication.seq <= previous || item.publication.seq > face.scanned_through ||
      item.publication.seq <= face.hypothesis_publication.seq || ids.has(item.evidence_id) ||
      events.has(item.publication.event_id) || item.read_url !== expected)
      context.addIssue({ code: "custom", path: ["evidence", index], message: "inconsistent indexed publication" });
    previous = item.publication.seq;
    ids.add(item.evidence_id); events.add(item.publication.event_id);
  }
  if (face.after > face.scanned_through || face.scanned_through > face.cursor ||
    face.hypothesis_publication.seq > face.cursor || face.evidence.length > face.scanned ||
    (face.scanned === 0 ? face.scanned_through !== face.after : face.scanned_through <= face.after) ||
    (face.next_after !== null && (face.scanned !== 8 || face.next_after !== face.scanned_through)) ||
    (face.next_after !== null) !== face.omitted.includes("page_limit") ||
    !face.omitted.includes("index_scope") || new Set(face.omitted).size !== face.omitted.length ||
    (face.evidence.length < face.scanned &&
      !face.omitted.some(reason => reason === "content_unavailable" || reason === "payload_budget")))
    context.addIssue({ code: "custom", message: "inconsistent evidence index accounting" });
});
export type HypothesisEvidenceIndexResponse = z.infer<typeof HypothesisEvidenceIndexResponseSchema>;

export const HypothesesContractsSchema = z
  .object({
    query: HypothesesQuerySchema,
    item_query: HypothesisItemQuerySchema,
    evidence_index_query: HypothesesQuerySchema,
    evidence_index_response: HypothesisEvidenceIndexResponseSchema,
    response: HypothesesResponseSchema,
  })
  .strict();
