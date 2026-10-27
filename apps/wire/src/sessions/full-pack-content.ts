import {
  AnswerQuestionRequestSchema,
  AskQuestionRequestSchema,
  ClaimDependencyPinsSchema,
  ClaimPublicationDraftSchema,
  ClaimReanchorRequestSchema,
  ClaimReanchorResponseSchema,
  ClaimRevisionSchema,
  ConflictIdSchema,
  CorrectCitationRequestSchema,
  EvidenceRequestSchema,
  GapFileRequestSchema,
  GapTransitionRequestSchema,
  HypothesisKillRequestSchema,
  HypothesisRequestSchema,
  LeaseQuestionRequestSchema,
  LeaseQuestionResponseSchema,
  NormalizeConflictRequestSchema,
  ProblemGovernanceEventSchema,
  QuestionIdSchema,
  RecordCitationRequestSchema,
  RecordDeadEndRequestSchema,
  RelationDisputeRequestSchema,
  RelationFileRequestSchema,
  ResolveConflictRequestSchema,
  RetractionIdSchema,
  RetractionKindSchema,
  RetractRequestSchema,
  ReviewRequestSchema,
  SynthesisIdSchema,
  SynthesizeRequestSchema,
  SynthesizeResponseSchema,
  WithdrawQuestionRequestSchema,
} from "@asimposium/contracts";
import type { PublicEventEnvelope } from "@asimposium/contracts/event-tail";
import { HypothesisLifecyclePublicationSchema } from "@asimposium/contracts/hypotheses";
import { ScientificWithdrawalReceiptSchema } from "@asimposium/contracts/scientific-withdrawals";
import type { D1Database } from "@cloudflare/workers-types";
import type { z } from "zod";
import { eventContentHiddenSql } from "../krater/public-content.ts";
import { verifiedCitationContent } from "../ledger/citation-read-integrity.ts";
import { readPublishedProblemResolution } from "../ledger/problem-resolution-read.ts";

export const FULL_PACK_SOURCE_BYTES = 65_536;
const TOTAL_SOURCE_BYTES = 262_144;
const SUPPORTED = new Set([
  "claim.created",
  "claim.revised",
  "claim.reanchored",
  "hypothesis.created",
  "hypothesis.killed",
  "hypothesis.deferred",
  "hypothesis.resumed",
  "hypothesis.narrowed",
  "hypothesis.superseded",
  "evidence.created",
  "review.created",
  "citation.recorded",
  "citation.corrected",
  "dead_end.recorded",
  "question.asked",
  "question.leased",
  "question.answered",
  "question.withdrawn",
  "gap.filed",
  "gap.closed-by",
  "gap.withdrawn",
  "relation.asserted",
  "relation.disputed",
  "conflict.normalized",
  "conflict.resolved",
  "object.retracted",
  "synthesis.created",
  "problem.resolved",
]);

export type FullPackContentOmission =
  | "undisclosed_event"
  | "unsupported_record"
  | "content_unavailable"
  | "source_byte_limit"
  | "item_size_limit"
  | "token_budget";

export interface FullPackRecord {
  readonly envelope: PublicEventEnvelope;
  readonly content: Readonly<Record<string, unknown>> | null;
  readonly content_omitted: FullPackContentOmission | null;
}

/** Public write schemas are the field allowlist, including nested objects.
 * Allocated/private writer bookkeeping never becomes a public field merely
 * because it is present in hash-verified event content. Null optional values
 * are the writer's stored representation of an absent request field. */
function requestFields<T extends Record<string, z.ZodType>>(
  schema: z.ZodObject<T>,
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
  const value: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    if (payload[key] === undefined) continue;
    if (payload[key] === null && field.isOptional() && !field.safeParse(null).success) continue;
    value[key] = payload[key];
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return null;
  const decoded = parsed.data as Record<string, unknown>;
  // A publication is immutable evidence. Request defaults are useful at write
  // time, but must not fabricate fields absent from its committed payload.
  return Object.fromEntries(Object.keys(value).map((key) => [key, decoded[key]]));
}

// A lease publication records the issued interval, not the request's TTL.
// Select its public receipt fields without fabricating a TTL on replay.
const QuestionLeasePublicationSchema = LeaseQuestionResponseSchema.pick({
  leased_by: true,
  leased_until: true,
}).extend({
  objective: LeaseQuestionRequestSchema.shape.objective,
  deliverable: LeaseQuestionRequestSchema.shape.deliverable,
});

const ClaimWithdrawalPublicationSchema = ScientificWithdrawalReceiptSchema.options[0].pick({
  target_kind: true,
  target_object: true,
  target_event_id: true,
  target_digest: true,
  claim_id: true,
  claim_version: true,
  retraction_kind: true,
});
const HypothesisWithdrawalPublicationSchema = ScientificWithdrawalReceiptSchema.options[1].pick({
  target_kind: true,
  target_object: true,
  target_event_id: true,
  target_digest: true,
  hypothesis_id: true,
  retraction_kind: true,
});
const WITHDRAWAL_PINS = [
  "target_kind",
  "target_event_id",
  "target_digest",
  "claim_id",
  "claim_version",
  "hypothesis_id",
] as const;

/** Relation writers commit an exact source ref instead of the request's
 * separate ID/version fields. Decode through the write contract, but retain
 * the committed representation and never invent request fields in history. */
function relationFields(
  event: NonNullable<PublicEventEnvelope["event"]>,
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
  if (event.object_version !== 1 || typeof payload.source !== "string") return null;
  const source = /^(C-[A-Za-z0-9][A-Za-z0-9._:-]*)@([1-9][0-9]*)$/.exec(payload.source);
  if (!source || !Number.isSafeInteger(Number(source[2]))) return null;
  const request = {
    ...payload,
    source_claim_id: source[1],
    source_version: Number(source[2]),
  };
  const decoded =
    event.type === "relation.asserted"
      ? requestFields(RelationFileRequestSchema, request)
      : requestFields(RelationDisputeRequestSchema, request);
  if (
    decoded === null ||
    event.object_id !== `${payload.source}-${decoded.kind}-${decoded.target}` ||
    (event.type === "relation.disputed" &&
      event.actor.fellow_id !== null &&
      payload.disputed_by !== event.actor.fellow_id)
  )
    return null;
  const { source_claim_id: _claimId, source_version: _version, ...fields } = decoded;
  return { ...fields, source: payload.source };
}

function decodeContent(
  event: NonNullable<PublicEventEnvelope["event"]>,
  payload: Readonly<Record<string, unknown>>,
  scope: { readonly problem: string; readonly seq: number },
): Record<string, unknown> | null {
  switch (event.type) {
    case "problem.resolved": {
      const parsed = ProblemGovernanceEventSchema.safeParse(payload);
      if (
        !parsed.success ||
        parsed.data.action !== "resolve" ||
        event.object_id !== scope.problem ||
        parsed.data.problem.id !== scope.problem ||
        parsed.data.problem.current_statement_version !== event.object_version
      )
        return null;
      const problem = parsed.data.problem;
      // Formulation text has its own publication and controls. A resolution
      // export carries only the admitted result and closing-work declaration.
      return {
        direction: problem.resolution_direction,
        summary: problem.resolution_summary,
        no_claim_boundary: problem.resolution_no_claim_boundary,
        result_claim: problem.result_claim,
        closing_synthesis: problem.closing_synthesis,
      };
    }
    case "claim.created":
    case "claim.revised": {
      if (
        payload.claim_id !== event.object_id ||
        (event.type === "claim.revised" && payload.base_version !== event.object_version - 1)
      )
        return null;
      const decoded =
        event.type === "claim.created"
          ? requestFields(ClaimPublicationDraftSchema, payload)
          : requestFields(ClaimRevisionSchema, payload);
      if (decoded === null) return null;
      if (payload.dependency_pins !== undefined) {
        const pins = ClaimDependencyPinsSchema.safeParse(payload.dependency_pins);
        if (!pins.success) return null;
        decoded.dependency_pins = pins.data;
      }
      return decoded;
    }
    case "claim.reanchored": {
      if (payload.claim_id !== event.object_id || payload.base_version !== event.object_version)
        return null;
      const decoded = requestFields(ClaimReanchorRequestSchema, payload);
      const statement = ClaimReanchorResponseSchema.shape.statement_version.safeParse(
        payload.statement_version,
      );
      return decoded !== null && statement.success
        ? { ...decoded, statement_version: statement.data }
        : null;
    }
    case "hypothesis.created":
      return requestFields(HypothesisRequestSchema, payload);
    case "hypothesis.killed":
      return payload.hypothesis_id === event.object_id
        ? requestFields(HypothesisKillRequestSchema, payload)
        : null;
    case "hypothesis.deferred":
    case "hypothesis.resumed":
    case "hypothesis.narrowed":
    case "hypothesis.superseded": {
      const parsed = HypothesisLifecyclePublicationSchema.safeParse(payload);
      const action = { "hypothesis.deferred": "defer", "hypothesis.resumed": "resume",
        "hypothesis.narrowed": "narrow", "hypothesis.superseded": "supersede" }[event.type];
      return parsed.success && event.object_version === 1 &&
        parsed.data.hypothesis_id === event.object_id && parsed.data.action === action
        ? parsed.data : null;
    }
    case "evidence.created":
      if (payload.evidence_id !== undefined && payload.evidence_id !== event.object_id) return null;
      return payload.bears_on_kind === "claim"
        ? requestFields(EvidenceRequestSchema.options[0], payload)
        : payload.bears_on_kind === "hypothesis"
          ? requestFields(EvidenceRequestSchema.options[1], payload)
          : null;
    case "review.created":
      if (payload.review_id !== undefined && payload.review_id !== event.object_id) return null;
      return requestFields(ReviewRequestSchema, payload);
    case "citation.recorded":
      return payload.citation_id === event.object_id && event.object_version === 1
        ? requestFields(RecordCitationRequestSchema, payload)
        : null;
    case "citation.corrected":
      return payload.citation_id === event.object_id &&
        payload.base_version === event.object_version - 1
        ? requestFields(CorrectCitationRequestSchema, payload)
        : null;
    case "dead_end.recorded":
      if (payload.dead_end_id !== undefined && payload.dead_end_id !== event.object_id) return null;
      return requestFields(RecordDeadEndRequestSchema, payload);
    case "question.asked":
    case "question.leased":
    case "question.answered":
    case "question.withdrawn": {
      if (
        event.object_version !== 1 ||
        !QuestionIdSchema.safeParse(event.object_id).success ||
        payload.question_id !== event.object_id
      )
        return null;
      if (event.type === "question.asked")
        return payload.problem_id === scope.problem
          ? requestFields(AskQuestionRequestSchema, payload)
          : null;
      if (event.type === "question.answered")
        return requestFields(AnswerQuestionRequestSchema, payload);
      if (event.type === "question.withdrawn")
        return requestFields(WithdrawQuestionRequestSchema, payload);
      if (event.actor.fellow_id !== null && payload.leased_by !== event.actor.fellow_id)
        return null;
      const decoded = requestFields(QuestionLeasePublicationSchema, payload);
      return decoded !== null &&
        typeof decoded.leased_until === "string" &&
        Number.isFinite(Date.parse(decoded.leased_until)) &&
        new Date(decoded.leased_until).toISOString() === decoded.leased_until
        ? decoded
        : null;
    }
    case "gap.filed":
      return event.object_version === 1 && event.object_id === `G-${scope.seq}`
        ? requestFields(GapFileRequestSchema, payload)
        : null;
    case "gap.closed-by":
    case "gap.withdrawn":
      return event.object_version === 1 &&
        payload.gap_id === event.object_id &&
        payload.outcome === event.type.slice(4)
        ? requestFields(GapTransitionRequestSchema, payload)
        : null;
    case "relation.asserted":
    case "relation.disputed":
      return relationFields(event, payload);
    case "conflict.normalized": {
      if (
        event.object_version !== 1 ||
        !ConflictIdSchema.safeParse(event.object_id).success ||
        payload.conflict_id !== event.object_id ||
        payload.problem_id !== scope.problem ||
        payload.status !== "open" ||
        (event.actor.fellow_id !== null && payload.author_fellow_id !== event.actor.fellow_id)
      )
        return null;
      const decoded = requestFields(NormalizeConflictRequestSchema, payload);
      return decoded === null ? null : { ...decoded, status: payload.status };
    }
    case "conflict.resolved": {
      if (
        event.object_version !== 2 ||
        !ConflictIdSchema.safeParse(event.object_id).success ||
        payload.conflict_id !== event.object_id ||
        payload.problem_id !== scope.problem ||
        payload.resolved_at !== event.created_at
      )
        return null;
      const decoded = requestFields(ResolveConflictRequestSchema, payload);
      return decoded === null ? null : { ...decoded, resolved_at: payload.resolved_at };
    }
    case "object.retracted": {
      if (
        event.object_version !== 1 ||
        !RetractionIdSchema.safeParse(event.object_id).success ||
        payload.retraction_id !== event.object_id ||
        (payload.problem_id !== undefined && payload.problem_id !== scope.problem)
      )
        return null;
      const decoded = requestFields(RetractRequestSchema, payload);
      const kind = RetractionKindSchema.safeParse(payload.retraction_kind);
      if (decoded === null || !kind.success) return null;
      if (!WITHDRAWAL_PINS.some((field) => payload[field] !== undefined))
        return { ...decoded, retraction_kind: kind.data };
      // Exact evidence/review withdrawals share the generic event type. Their
      // committed source pins and affinity must survive, without turning a
      // malformed scientific withdrawal into an apparently complete generic one.
      if (
        payload.hypothesis_id !== undefined &&
        (payload.claim_id !== undefined || payload.claim_version !== undefined)
      )
        return null;
      const pins =
        payload.hypothesis_id === undefined
          ? requestFields(ClaimWithdrawalPublicationSchema, payload)
          : requestFields(HypothesisWithdrawalPublicationSchema, payload);
      return pins === null ? null : { ...decoded, ...pins };
    }
    case "synthesis.created": {
      if (
        event.object_version !== 1 ||
        !SynthesisIdSchema.safeParse(event.object_id).success ||
        (payload.synthesis_id !== undefined && payload.synthesis_id !== event.object_id) ||
        (payload.problem_id !== undefined && payload.problem_id !== scope.problem)
      )
        return null;
      const decoded = requestFields(SynthesizeRequestSchema, payload);
      if (
        decoded === null ||
        !Number.isSafeInteger(decoded.covers_through) ||
        (decoded.covers_through as number) >= scope.seq ||
        (decoded.anchors as { target_seq?: number }[]).some(
          (anchor) =>
            anchor.target_seq !== undefined &&
            anchor.target_seq > (decoded.covers_through as number),
        )
      )
        return null;
      if (payload.dropped_single_author_count !== undefined) {
        const count = SynthesizeResponseSchema.shape.dropped_single_author_count.safeParse(
          payload.dropped_single_author_count,
        );
        if (!count.success) return null;
        decoded.dropped_single_author_count = count.data;
      }
      return decoded;
    }
    default:
      return null;
  }
}

interface ContentRow {
  event_id: string;
  problem_id: string;
  seq: number;
  public_seq: number;
  payload_sha256: string;
  content_sha256: string | null;
  payload_json: string | null;
  source_bytes: number | null;
}

/** Each pin came from the canonical public-event reader. Repeat its exact
 * identity, digest, cursor and current visibility checks at body hydration.
 * SQL bounds both individual and aggregate source bytes before returning any
 * text to JavaScript; unsupported/private producers are never hydrated. */
export async function readFullPackContent(
  db: D1Database,
  problem: string,
  through: number,
  envelopes: readonly PublicEventEnvelope[],
): Promise<FullPackRecord[]> {
  const pins = envelopes.flatMap(({ seq, event, body_omitted }) =>
    event !== null && body_omitted === "separate_object_face" && SUPPORTED.has(event.type)
      ? [
          [
            seq,
            event.id,
            event.payload_sha256,
            event.type,
            event.object_kind,
            event.object_id,
            event.object_version,
          ],
        ]
      : [],
  );
  const rows =
    pins.length === 0
      ? []
      : (
          await db
            .prepare(`
    WITH admitted AS MATERIALIZED (
      SELECT e.id AS event_id,e.problem_id,e.seq,p.public_seq,e.payload_sha256,
        c.payload_sha256 AS content_sha256,
        CASE WHEN c.event_id IS NOT NULL AND c.redacted_at IS NULL
          AND NOT ${eventContentHiddenSql("e")}
          THEN length(CAST(c.payload_json AS BLOB)) END AS source_bytes
      FROM json_each(?) pin JOIN events e
        ON e.seq=json_extract(pin.value,'$[0]') AND e.id=json_extract(pin.value,'$[1]')
        AND e.payload_sha256=json_extract(pin.value,'$[2]')
        AND e.type=json_extract(pin.value,'$[3]') AND e.object_kind=json_extract(pin.value,'$[4]')
        AND e.object_id=json_extract(pin.value,'$[5]') AND e.object_version=json_extract(pin.value,'$[6]')
      JOIN problems p ON p.id=e.problem_id AND p.status<>'private-draft'
      LEFT JOIN event_content c ON c.event_id=e.id AND c.payload_sha256=e.payload_sha256
      WHERE e.problem_id=? AND e.seq<=? AND e.seq<=p.public_seq
    ), bounded AS MATERIALIZED (
      SELECT *,sum(CASE WHEN source_bytes<=${FULL_PACK_SOURCE_BYTES} THEN source_bytes ELSE 0 END)
        OVER (ORDER BY seq) AS total_bytes FROM admitted
    )
    SELECT b.*,CASE WHEN b.source_bytes<=${FULL_PACK_SOURCE_BYTES}
      AND b.total_bytes<=${TOTAL_SOURCE_BYTES} THEN c.payload_json END AS payload_json
    FROM bounded b LEFT JOIN event_content c ON c.event_id=b.event_id
      AND c.payload_sha256=b.payload_sha256
      AND b.source_bytes<=${FULL_PACK_SOURCE_BYTES} AND b.total_bytes<=${TOTAL_SOURCE_BYTES}
    ORDER BY b.seq
  `)
            .bind(JSON.stringify(pins), problem, through)
            .all<ContentRow>()
        ).results;
  const bySequence = new Map(rows.map((row) => [row.seq, row]));
  return Promise.all(
    envelopes.map(async (envelope): Promise<FullPackRecord> => {
      const absent = (reason: FullPackContentOmission): FullPackRecord => ({
        envelope,
        content: null,
        content_omitted: reason,
      });
      if (envelope.event === null) return absent("undisclosed_event");
      if (envelope.body_omitted !== "separate_object_face") return absent("content_unavailable");
      if (!SUPPORTED.has(envelope.event.type)) return absent("unsupported_record");
      const row = bySequence.get(envelope.seq);
      if (!row || row.event_id !== envelope.event.id || row.source_bytes === null)
        return absent("content_unavailable");
      if (row.payload_json === null) return absent("source_byte_limit");
      const payload = await verifiedCitationContent(problem, { ...row, redacted_at: null });
      if (payload === undefined) return absent("content_unavailable");
      const content = decodeContent(envelope.event, payload, { problem, seq: envelope.seq });
      if (content !== null && envelope.event.type === "problem.resolved") {
        const available = await readPublishedProblemResolution(db, problem, envelope.seq);
        if (available === undefined || JSON.stringify(available) !== JSON.stringify(content))
          return absent("content_unavailable");
      }
      return content === null
        ? absent("content_unavailable")
        : { envelope, content, content_omitted: null };
    }),
  );
}
