import {
  type ProblemDetail,
  ProblemGovernanceEventSchema,
  type ScreeningPublicationNotice,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { eventContentHiddenSql } from "../krater/public-content.ts";
import { publicationScreeningNotice } from "../screening/publication-notice.ts";
import {
  type CitationContentRow,
  PUBLIC_EVENT_CONTENT_MAX_BYTES,
  verifiedCitationContent,
} from "./citation-read-integrity.ts";

export interface PublishedProblemFormulation {
  readonly screening_notice?: ScreeningPublicationNotice;
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
  screening_provenance?: string | null;
  id: string;
  type: string;
  object_id: string;
  object_version: number;
}

// Select the latest source before checking availability. A withdrawn current
// formulation never falls back to older text or a retained mutable projection.
const FORMULATION_FIELDS_SQL = `e.id, e.problem_id, e.seq, e.type, e.object_id,
  e.object_version, p.public_seq, e.payload_sha256,
  screening.provenance_json AS screening_provenance,
  c.payload_sha256 AS content_sha256, c.redacted_at,
  CASE WHEN length(CAST(c.payload_json AS BLOB)) <= ${PUBLIC_EVENT_CONTENT_MAX_BYTES} THEN c.payload_json END AS payload_json`;

function formulationSourceSql(throughExpression: string): string {
  return `JOIN events e ON e.id = (
  SELECT source.id FROM events source
  WHERE source.problem_id = p.id AND source.object_id = p.id
    AND source.object_kind = 'problem'
    AND source.type IN ('problem.admitted', 'problem.statement-revised')
    AND source.seq <= ${throughExpression}
  ORDER BY source.seq DESC LIMIT 1
)
LEFT JOIN event_content c ON c.event_id = e.id
LEFT JOIN screening_publications screening ON screening.event_id = e.id`;
}

const FORMULATION_SQL = `SELECT ${FORMULATION_FIELDS_SQL}
FROM problems p ${formulationSourceSql("?")}
WHERE p.id = ? AND p.status != 'private-draft'
  AND NOT ${eventContentHiddenSql("e")}`;

const FORMULATION_PAGE_SQL = `WITH selected AS (
  SELECT json_extract(value, '$.problem_id') AS problem_id,
    json_extract(value, '$.through') AS through FROM json_each(?)
)
SELECT ${FORMULATION_FIELDS_SQL}
FROM selected JOIN problems p ON p.id = selected.problem_id
${formulationSourceSql("selected.through")}
WHERE p.status != 'private-draft' AND NOT ${eventContentHiddenSql("e")}`;

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
  if (result.results.length !== 1 || row === undefined) {
    return undefined;
  }
  return verifyPublishedProblemFormulation(problemId, through, row);
}

/** Hydrate at most one public search page without a query per result. The
 * singleton and page readers share source selection and payload verification;
 * neither reads retained statement projections as publication authority. */
export async function readPublishedProblemFormulations(
  db: D1Database,
  targets: readonly { readonly problem_id: string; readonly through: number }[],
): Promise<ReadonlyMap<string, PublishedProblemFormulation>> {
  const throughByProblem = new Map<string, number>();
  if (targets.length > 50) throw new Error("Problem formulation page exceeds its bound.");
  for (const target of targets) {
    if (
      typeof target.problem_id !== "string" ||
      target.problem_id.length < 1 ||
      target.problem_id.length > 128 ||
      !Number.isSafeInteger(target.through) ||
      target.through < 0 ||
      throughByProblem.has(target.problem_id)
    ) {
      throw new Error("Invalid problem formulation page target.");
    }
    throughByProblem.set(target.problem_id, target.through);
  }
  const formulations = new Map<string, PublishedProblemFormulation>();
  if (targets.length === 0) return formulations;
  const result = await db
    .prepare(FORMULATION_PAGE_SQL)
    .bind(JSON.stringify(targets))
    .all<FormulationRow>();
  if (result.results.length > targets.length)
    throw new Error("Problem formulation page returned too many sources.");
  const seen = new Set<string>();
  for (const row of result.results) {
    const through = throughByProblem.get(row.problem_id);
    if (through === undefined || seen.has(row.problem_id))
      throw new Error("Problem formulation page returned a foreign or duplicate source.");
    seen.add(row.problem_id);
    const formulation = await verifyPublishedProblemFormulation(row.problem_id, through, row);
    if (formulation !== undefined) formulations.set(row.problem_id, formulation);
  }
  return formulations;
}

async function verifyPublishedProblemFormulation(
  problemId: string,
  through: number,
  row: FormulationRow,
): Promise<PublishedProblemFormulation | undefined> {
  if (row.seq > through || row.object_id !== problemId) return undefined;
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
  const screeningNotice = publicationScreeningNotice(row.screening_provenance);
  return {
    ...(screeningNotice === undefined ? {} : { screening_notice: screeningNotice }),
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
