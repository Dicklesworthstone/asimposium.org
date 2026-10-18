import {
  type ProblemDetail,
  ProblemGovernanceEventSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { eventContentHiddenSql } from "../krater/public-content.ts";
import {
  type CitationContentRow,
  PUBLIC_EVENT_CONTENT_MAX_BYTES,
  verifiedCitationContent,
} from "./citation-read-integrity.ts";

export interface PublishedProblemFormulation {
  readonly problem: Pick<
    ProblemDetail,
    | "id"
    | "title"
    | "current_statement_version"
    | "statement"
    | "falsifier"
    | "motivation"
    | "updated_at"
  >;
  readonly source_fellow_id: string;
  readonly acting_principal: { readonly type: "sponsor"; readonly id: string };
  readonly publication: {
    readonly event_id: string;
    readonly seq: number;
    readonly payload_sha256: string;
  };
}

interface FormulationRow extends CitationContentRow {
  id: string;
  type: string;
  object_id: string;
  object_version: number;
}

// Select the latest source before checking availability. A withdrawn current
// formulation never falls back to older text or a retained mutable projection.
const FORMULATION_SQL = `
SELECT e.id, e.problem_id, e.seq, e.type, e.object_id,
  e.object_version, p.public_seq, e.payload_sha256,
  c.payload_sha256 AS content_sha256, c.redacted_at,
  CASE WHEN length(CAST(c.payload_json AS BLOB)) <= ${PUBLIC_EVENT_CONTENT_MAX_BYTES} THEN c.payload_json END AS payload_json
FROM problems p JOIN events e ON e.id = (
  SELECT source.id FROM events source
  WHERE source.problem_id = p.id AND source.object_id = p.id
    AND source.object_kind = 'problem'
    AND source.type IN ('problem.admitted', 'problem.statement-revised')
    AND source.seq <= ?
  ORDER BY source.seq DESC LIMIT 1
)
LEFT JOIN event_content c ON c.event_id = e.id
WHERE p.id = ? AND p.status != 'private-draft'
  AND NOT ${eventContentHiddenSql("e")}`;

/** Complete published formulation at a captured public cursor.
 * Current problem/object/version/event controls always apply, including to
 * historical reads. This verifies formulation bytes, not every problem field
 * or scientific standing. A current-detail caller also checks its captured
 * current_statement_version against the returned source version. */
export async function readPublishedProblemFormulation(
  db: D1Database,
  problemId: string,
  through: number,
): Promise<PublishedProblemFormulation | undefined> {
  if (!Number.isSafeInteger(through) || through < 0) return undefined;
  const result = await db
    .prepare(FORMULATION_SQL)
    .bind(through, problemId)
    .all<FormulationRow>();
  const row = result.results[0];
  if (
    result.results.length !== 1 ||
    row === undefined ||
    row.seq > through ||
    row.object_id !== problemId
  ) {
    return undefined;
  }
  const payload = await verifiedCitationContent(problemId, row, PUBLIC_EVENT_CONTENT_MAX_BYTES);
  const parsed = ProblemGovernanceEventSchema.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.problem.id !== problemId ||
    parsed.data.problem.current_statement_version !== row.object_version ||
    (row.type === "problem.admitted"
      ? parsed.data.action !== "publish"
      : parsed.data.action !== "revise-statement")
  ) {
    return undefined;
  }
  const event = parsed.data;
  return {
    problem: {
      id: event.problem.id,
      title: event.problem.title,
      current_statement_version: event.problem.current_statement_version,
      statement: event.problem.statement,
      falsifier: event.problem.falsifier,
      motivation: event.problem.motivation,
      updated_at: event.problem.updated_at,
    },
    source_fellow_id: event.source_fellow_id,
    acting_principal: event.acting_principal,
    publication: {
      event_id: row.id,
      seq: row.seq,
      payload_sha256: row.payload_sha256,
    },
  };
}
