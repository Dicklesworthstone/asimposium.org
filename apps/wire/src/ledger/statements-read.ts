import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import {
  type PublicStatementVersion,
  PublicStatementVersionSchema,
  STATEMENT_HISTORY_PAGE_SIZE,
  STATEMENTS_SCHEMA_ID,
  type StatementHistoryQuery,
  type StatementHistoryResponse,
  StatementHistoryResponseSchema,
  type StatementResponse,
  StatementResponseSchema,
  type StatementVersionQuery,
} from "@asimposium/contracts/statements";
import type { D1Database } from "@cloudflare/workers-types";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import { PUBLIC_EVENT_CONTENT_MAX_BYTES } from "./citation-read-integrity.ts";
import {
  type FormulationRow,
  verifyPublishedProblemFormulation,
} from "./problem-formulation-read.ts";

export class StatementReadError extends Error {
  constructor(readonly code: "query" | "not-found" | "unavailable") {
    super(`STATEMENTS_${code}`);
  }
}
interface Head {
  id: string;
  public_seq: number;
  unlisted: number;
}
const HEAD_SQL = `SELECT id, public_seq, unlisted FROM problems WHERE id=?
  AND status <> 'private-draft' AND NOT ${hiddenByContentControlSql("problems.id", "'problem'")}
  AND NOT ${hiddenByContentControlSql("problems.id", "problems.id")}`;
const SOURCE_WHERE_SQL = `e.problem_id=? AND e.object_id=e.problem_id AND e.object_kind='problem'
  AND e.type IN ('problem.admitted','problem.statement-revised') AND e.seq<=?`;

/** Body loading is bounded in SQL, including for corrupted/oversize records.
 * Selection precedes controls so withholding a version cannot substitute a
 * different source or prevent a history continuation from advancing. */
function sourceFieldsSql(bodyEligible: string): string {
  return `e.id,e.problem_id,e.seq,e.type,e.object_id,e.object_version,p.public_seq,e.payload_sha256,
    CASE WHEN length(CAST(screening.provenance_json AS BLOB))<=4096 THEN screening.provenance_json
      WHEN screening.provenance_json IS NOT NULL THEN '' END AS screening_provenance,
    c.payload_sha256 AS content_sha256,c.redacted_at,
    CASE WHEN ${bodyEligible} AND p.status <> 'private-draft' AND c.redacted_at IS NULL
      AND NOT ${eventContentHiddenSql("e")}
      AND length(CAST(c.payload_json AS BLOB))<=${PUBLIC_EVENT_CONTENT_MAX_BYTES}
      THEN c.payload_json END AS payload_json`;
}
const SOURCE_JOINS_SQL = `JOIN problems p ON p.id=e.problem_id
  LEFT JOIN event_content c ON c.event_id=e.id
  LEFT JOIN screening_publications screening ON screening.event_id=e.id`;
const HISTORY_SQL = `WITH selected AS (
  SELECT e.id,e.problem_id,e.seq,e.type,e.object_id,e.object_version,e.payload_sha256
  FROM events e WHERE ${SOURCE_WHERE_SQL} AND e.seq>?
  ORDER BY e.seq ASC LIMIT ${STATEMENT_HISTORY_PAGE_SIZE + 1}
)
SELECT ${sourceFieldsSql(`e.seq IN (SELECT seq FROM selected ORDER BY seq ASC LIMIT ${STATEMENT_HISTORY_PAGE_SIZE})`)}
FROM selected e ${SOURCE_JOINS_SQL} ORDER BY e.seq ASC`;
const EXACT_SQL = `SELECT ${sourceFieldsSql("1=1")} FROM events e ${SOURCE_JOINS_SQL}
  WHERE ${SOURCE_WHERE_SQL} AND e.object_version=? ORDER BY e.seq ASC LIMIT 2`;

function checkedHead(value: Head | null | undefined, problem: string): Head {
  if (!value) throw new StatementReadError("not-found");
  if (
    value.id !== problem ||
    !Number.isSafeInteger(value.public_seq) ||
    value.public_seq < 0 ||
    ![0, 1].includes(value.unlisted)
  )
    throw new StatementReadError("unavailable");
  return value;
}
async function capturedHead(db: D1Database, problem: string, through?: number) {
  if (!PublicLedgerProblemIdSchema.safeParse(problem).success)
    throw new StatementReadError("not-found");
  const head = checkedHead(await db.prepare(HEAD_SQL).bind(problem).first<Head>(), problem);
  const cursor = through ?? head.public_seq;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > head.public_seq)
    throw new StatementReadError("query");
  return { cursor };
}
async function publicVersion(
  problem: string,
  cursor: number,
  row: FormulationRow,
): Promise<PublicStatementVersion | undefined> {
  const source = await verifyPublishedProblemFormulation(problem, cursor, row);
  if (!source) return undefined;
  const { id: _id, current_statement_version: version, ...formulation } = source.problem;
  const parsed = PublicStatementVersionSchema.safeParse({
    ...formulation,
    version,
    source_fellow_id: source.source_fellow_id,
    acting_principal: source.acting_principal,
    publication: source.publication,
    ...(source.screening_notice === undefined ? {} : { screening_notice: source.screening_notice }),
  });
  return parsed.success ? parsed.data : undefined;
}

/** History is a bounded immutable publication scan, not statement-table
 * enumeration. Even an all-withheld page advances to its captured next cut. */
export async function loadStatementHistory(
  db: D1Database,
  problem: string,
  query: StatementHistoryQuery = {},
): Promise<{ face: StatementHistoryResponse; unlisted: boolean }> {
  const { cursor } = await capturedHead(db, problem, query.through);
  const after = query.after ?? 0;
  if (!Number.isSafeInteger(after) || after < 0 || after > cursor)
    throw new StatementReadError("query");
  const snapshot = await db.batch([
    db.prepare(HEAD_SQL).bind(problem),
    db.prepare(HISTORY_SQL).bind(problem, cursor, after),
  ]);
  if (snapshot.length !== 2 || snapshot.some((result) => !result.success))
    throw new StatementReadError("unavailable");
  const head = checkedHead(snapshot[0]?.results[0] as Head | undefined, problem);
  if (head.public_seq < cursor) throw new StatementReadError("unavailable");
  const rows = snapshot[1]?.results as FormulationRow[] | undefined;
  if (!rows || rows.length > STATEMENT_HISTORY_PAGE_SIZE + 1)
    throw new StatementReadError("unavailable");
  let previous = after;
  let previousVersion = 0;
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.seq) ||
      row.seq <= previous ||
      row.seq > cursor ||
      row.problem_id !== problem ||
      row.object_id !== problem ||
      !Number.isSafeInteger(row.object_version) ||
      row.object_version <= previousVersion
    )
      throw new StatementReadError("unavailable");
    previous = row.seq;
    previousVersion = row.object_version;
  }
  const admitted = rows.slice(0, STATEMENT_HISTORY_PAGE_SIZE);
  const statements: PublicStatementVersion[] = [];
  const omitted = new Set<StatementHistoryResponse["omitted"][number]>();
  for (const row of admitted) {
    const version = await publicVersion(problem, cursor, row);
    if (version) statements.push(version);
    else omitted.add("content_unavailable");
  }
  const scanned = admitted.at(-1)?.seq ?? after;
  const next = rows.length > STATEMENT_HISTORY_PAGE_SIZE ? scanned : null;
  if (next !== null) omitted.add("page_limit");
  return {
    face: StatementHistoryResponseSchema.parse({
      schema: STATEMENTS_SCHEMA_ID,
      problem_id: problem,
      cursor,
      after,
      scanned_through: scanned,
      next_after: next,
      count: statements.length,
      statements,
      omitted: [...omitted],
    }),
    unlisted: head.unlisted === 1,
  };
}

/** An exact public version can be unavailable, but can never become another
 * version. A duplicate source identity is corruption, not a tie to resolve. */
export async function loadStatementVersion(
  db: D1Database,
  problem: string,
  version: number,
  query: StatementVersionQuery = {},
): Promise<{ face: StatementResponse; unlisted: boolean }> {
  if (!Number.isSafeInteger(version) || version < 1) throw new StatementReadError("query");
  const { cursor } = await capturedHead(db, problem, query.through);
  const snapshot = await db.batch([
    db.prepare(HEAD_SQL).bind(problem),
    db.prepare(EXACT_SQL).bind(problem, cursor, version),
  ]);
  if (snapshot.length !== 2 || snapshot.some((result) => !result.success))
    throw new StatementReadError("unavailable");
  const head = checkedHead(snapshot[0]?.results[0] as Head | undefined, problem);
  if (head.public_seq < cursor) throw new StatementReadError("unavailable");
  const rows = snapshot[1]?.results as FormulationRow[] | undefined;
  if (!rows || rows.length > 1) throw new StatementReadError("unavailable");
  const row = rows[0];
  const statement =
    row?.object_version === version ? await publicVersion(problem, cursor, row) : undefined;
  if (!statement) throw new StatementReadError("not-found");
  return {
    face: StatementResponseSchema.parse({
      schema: STATEMENTS_SCHEMA_ID,
      problem_id: problem,
      cursor,
      statement,
    }),
    unlisted: head.unlisted === 1,
  };
}
