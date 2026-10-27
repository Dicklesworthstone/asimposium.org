import {
  ClaimDependencyPinsSchema,
  ClaimPublicationDraftSchema,
  ClaimRevisionSchema,
  CorrectCitationRequestSchema,
  EvidenceRequestSchema,
  HypothesisKillRequestSchema,
  HypothesisRequestSchema,
  RecordCitationRequestSchema,
  RecordDeadEndRequestSchema,
  ReviewRequestSchema,
} from "@asimposium/contracts";
import type { PublicEventEnvelope } from "@asimposium/contracts/event-tail";
import type { D1Database } from "@cloudflare/workers-types";
import type { z } from "zod";
import { eventContentHiddenSql } from "../krater/public-content.ts";
import { verifiedCitationContent } from "../ledger/citation-read-integrity.ts";

export const FULL_PACK_SOURCE_BYTES = 65_536;
const TOTAL_SOURCE_BYTES = 262_144;
const SUPPORTED = new Set([
  "claim.created",
  "claim.revised",
  "hypothesis.created",
  "hypothesis.killed",
  "evidence.created",
  "review.created",
  "citation.recorded",
  "citation.corrected",
  "dead_end.recorded",
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

function decodeContent(
  event: NonNullable<PublicEventEnvelope["event"]>,
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
  switch (event.type) {
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
    case "hypothesis.created":
      return requestFields(HypothesisRequestSchema, payload);
    case "hypothesis.killed":
      return payload.hypothesis_id === event.object_id
        ? requestFields(HypothesisKillRequestSchema, payload)
        : null;
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
      const content = decodeContent(envelope.event, payload);
      return content === null
        ? absent("content_unavailable")
        : { envelope, content, content_omitted: null };
    }),
  );
}
