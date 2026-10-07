import type { SearchIndexHealth } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL } from "../krater/public-content";

/**
 * Rule A6 for the lexical index: public_claim_fts is derived, so an operator
 * can compare it with, and rebuild it from, the problem's public claims. The
 * index population matches what the search.index outbox effect admits: a
 * claim's current, unredacted publication in a published problem (unlisted
 * included; search filters unlisted at read). Claims hidden by a content
 * control are not searchable. Private-draft problems contribute nothing.
 */
const INDEXABLE_CLAIMS_SQL = `SELECT claims.id AS claim_id, claims.problem_id, claims.statement,
    claims.source_seq
  FROM claims JOIN problems problem ON problem.id = claims.problem_id
  WHERE claims.problem_id = ?1 AND problem.status <> 'private-draft' AND problem.public_seq > 0
    AND ${PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL}`;

const HEALTH_SQL = `WITH indexable AS (${INDEXABLE_CLAIMS_SQL}),
  indexed AS (SELECT claim_id, statement FROM public_claim_fts WHERE problem_id = ?1)
SELECT
  (SELECT COUNT(*) FROM indexable) AS searchable,
  (SELECT COUNT(*) FROM indexed) AS indexed,
  (SELECT COUNT(*) FROM indexable i WHERE NOT EXISTS (
     SELECT 1 FROM indexed x WHERE x.claim_id = i.claim_id AND x.statement = i.statement)) AS missing,
  (SELECT COUNT(*) FROM indexed x WHERE NOT EXISTS (
     SELECT 1 FROM indexable i WHERE i.claim_id = x.claim_id AND i.statement = x.statement)) AS stale`;

export async function searchIndexHealth(
  db: D1Database,
  problemId: string,
): Promise<SearchIndexHealth> {
  const row = await db.prepare(HEALTH_SQL).bind(problemId).first<SearchIndexHealth>();
  if (row === null) throw new Error("Search index health is unavailable.");
  return {
    searchable: row.searchable,
    indexed: row.indexed,
    missing: row.missing,
    stale: row.stale,
  };
}

/** Replace the problem's index rows with its searchable claims, atomically. */
export async function rebuildSearchIndex(db: D1Database, problemId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM public_claim_fts WHERE problem_id = ?1").bind(problemId),
    db
      .prepare(
        `INSERT INTO public_claim_fts (claim_id, problem_id, statement)
         SELECT claim_id, problem_id, statement FROM (${INDEXABLE_CLAIMS_SQL})
         ORDER BY source_seq, claim_id`,
      )
      .bind(problemId),
  ]);
}
