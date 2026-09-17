import { EvidenceRequestSchema, ReviewRequestSchema } from "@asimposium/contracts";
import {
  FORMAL_RECORDS_SCHEMA_ID,
  type FormalRecordsQuery,
  FormalRecordsResponseSchema,
} from "@asimposium/contracts/formal-records";
import type { D1Database } from "@cloudflare/workers-types";
import {
  type FormalRecordDecoders,
  readFormalRecordResource,
  readFormalRecords,
} from "./formal-records.ts";

/** Writer envelopes add allocated IDs and computed bookkeeping. Decode only
 * the existing request fields, never reinterpret a stored class as a verdict.
 * No shape or source implementation is selected by an HTTP request. */
function requestFields(payload: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(
    keys
      .filter((key) => payload[key] !== null && payload[key] !== undefined)
      .map((key) => [key, payload[key]]),
  );
}
const decoders: FormalRecordDecoders = {
  evidence(payload) {
    const result = EvidenceRequestSchema.safeParse(
      requestFields(payload, [
        "bears_on_kind",
        "bears_on_id",
        "bears_on_version",
        "direction",
        "kind",
        "source",
        "computation_domain_or_floor",
        "reproduction",
        "mode",
        "selected_hypothesis_id",
        "falsification_check",
        "formal_artifact",
        "body_md",
      ]),
    );
    return result.success ? result.data : null;
  },
  review(payload) {
    const result = ReviewRequestSchema.safeParse(
      requestFields(payload, [
        "scientific_provenance",
        "verification",
        "target_claim_id",
        "target_version",
        "verdict",
        "basis",
        "capable_of_failure",
        "rubric",
        "body_md",
        "client_context_cursor",
      ]),
    );
    return result.success ? result.data : null;
  },
};
export function loadFormalRecords(db: D1Database, problem: string, cursor: number, after = 0) {
  return readFormalRecords(db, problem, cursor, decoders, after);
}

/** Full public reads use the same decoded records as the formal session pack;
 * unlike pack summaries, exact source bodies are not subject to its 18k cap. */
export async function loadFormalRecordResource(
  db: D1Database,
  problem: string,
  query: FormalRecordsQuery,
) {
  const result = await readFormalRecordResource(db, problem, query, decoders);
  return {
    unlisted: result.unlisted,
    face: FormalRecordsResponseSchema.parse({
      schema: FORMAL_RECORDS_SCHEMA_ID,
      problem_id: result.problem_id,
      cursor: result.cursor,
      after: result.after,
      target: result.target,
      next_after: result.next_after,
      records: result.records,
      omitted: result.omitted,
    }),
  };
}
