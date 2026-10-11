import type { D1Database } from "@cloudflare/workers-types";

/** Publication accounting, not scientific validation: a typed citation records
 * another Fellow's attention, not agreement, independence or correctness.
 * Immutable attribution and source sequences supply the accounting window.
 * The normal write/read integrity paths remain responsible for payload hashes.
 *
 * One aggregate replaces the per-finding query loop. Nothing from a private
 * workshop is read, and no body is transferred into the Worker. */
export const DROPPED_SINGLE_AUTHOR_SQL = `
WITH cut AS (
  SELECT id AS problem_id, ? AS through FROM problems
  WHERE id = ? AND status <> 'private-draft' AND public_seq >= ?
), publications AS (
  SELECT e.object_kind, e.object_id, e.actor_fellow_id,
    CASE WHEN e.type IN ('claim.created','hypothesis.created','dead_end.recorded')
      THEN 1 ELSE 0 END AS admission
  FROM events e JOIN cut p ON p.problem_id = e.problem_id
  WHERE e.seq <= p.through AND (
    (e.object_kind = 'claim' AND e.type IN ('claim.created','claim.revised')) OR
    (e.object_kind = 'hypothesis' AND e.type = 'hypothesis.created') OR
    (e.object_kind = 'dead_end' AND e.type = 'dead_end.recorded'))
), findings AS (
  SELECT object_kind, object_id, MIN(actor_fellow_id) AS author
  FROM publications GROUP BY object_kind, object_id
  HAVING SUM(admission) = 1 AND COUNT(DISTINCT actor_fellow_id) = 1
    AND COUNT(actor_fellow_id) = COUNT(*) AND MIN(actor_fellow_id) <> ''
), sources AS (
  SELECT e.type, e.object_kind, e.actor_fellow_id AS author,
    CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END AS payload
  FROM events e JOIN cut p ON p.problem_id = e.problem_id
  JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
    AND c.redacted_at IS NULL
  WHERE e.seq <= p.through AND e.actor_fellow_id IS NOT NULL
    AND e.actor_fellow_id <> '' AND (
      (e.object_kind = 'review' AND e.type = 'review.created') OR
      (e.object_kind = 'evidence' AND e.type = 'evidence.created') OR
      (e.object_kind = 'relation' AND e.type = 'relation.asserted') OR
      (e.object_kind = 'dead_end' AND e.type = 'dead_end.recorded') OR
      (e.object_kind = 'claim' AND e.type IN ('claim.created','claim.revised')) OR
      (e.object_kind = 'synthesis' AND e.type = 'synthesis.created'))
), direct_refs AS (
  SELECT 'claim' AS kind, json_extract(payload,'$.target_claim_id') AS target, author
  FROM sources WHERE type = 'review.created'
  UNION ALL
  SELECT json_extract(payload,'$.bears_on_kind'), json_extract(payload,'$.bears_on_id'), author
  FROM sources WHERE type = 'evidence.created'
  UNION ALL
  SELECT 'dead_end', json_extract(payload,'$.supersedes_dead_end_id'), author
  FROM sources WHERE type = 'dead_end.recorded'
), relation_pins AS (
  SELECT json_extract(payload,'$.source') AS pin, author FROM sources WHERE type = 'relation.asserted'
  UNION ALL
  SELECT json_extract(payload,'$.target'), author FROM sources WHERE type = 'relation.asserted'
), relation_refs AS (
  SELECT 'claim' AS kind, substr(pin,1,instr(pin,'@')-1) AS target, author
  FROM relation_pins WHERE typeof(pin) = 'text' AND instr(pin,'@') > 1
    AND substr(pin,instr(pin,'@')+1) <> ''
    AND substr(pin,instr(pin,'@')+1) NOT GLOB '*[^0-9]*'
    AND substr(pin,instr(pin,'@')+1,1) BETWEEN '1' AND '9'
), dependency_refs AS (
  SELECT 'claim' AS kind, json_extract(j.value,'$.claim_id') AS target, s.author
  FROM sources s JOIN json_each(CASE WHEN json_type(s.payload,'$.dependency_pins') = 'array'
    THEN json_extract(s.payload,'$.dependency_pins') ELSE '[]' END) j
  WHERE s.object_kind = 'claim' AND j.type = 'object'
), synthesis_refs AS (
  SELECT json_extract(j.value,'$.target_kind') AS kind,
    json_extract(j.value,'$.target_id') AS target, s.author
  FROM sources s JOIN json_each(CASE WHEN json_type(s.payload,'$.anchors') = 'array'
    THEN json_extract(s.payload,'$.anchors') ELSE '[]' END) j
  WHERE s.type = 'synthesis.created' AND j.type = 'object'
), refs AS (
  SELECT * FROM direct_refs UNION ALL SELECT * FROM relation_refs
  UNION ALL SELECT * FROM dependency_refs UNION ALL SELECT * FROM synthesis_refs
), cited_findings AS (
  SELECT DISTINCT f.object_kind, f.object_id
  FROM findings f JOIN refs r ON r.kind = f.object_kind
    AND r.target = f.object_id AND r.author <> f.author
)
SELECT p.problem_id, p.through, (
  SELECT COUNT(*) FROM findings f
  WHERE NOT EXISTS (SELECT 1 FROM json_each(?) a WHERE a.value = f.object_id)
    AND NOT EXISTS (SELECT 1 FROM cited_findings r WHERE r.object_kind = f.object_kind
      AND r.object_id = f.object_id)
) AS count FROM cut p`;

/** Count each single-author finding once, across its revisions. Both successful
 * and negative findings remain findings; a later kill does not create another
 * author. Actual bears_on references, pinned relations, dependencies, retries
 * and previous synthesis anchors all count as typed attention from others. */
export async function computeDroppedSingleAuthorCount(
  db: D1Database,
  problemId: string,
  coversThrough: number,
  anchoredTargetIds: ReadonlySet<string> | readonly string[],
): Promise<number> {
  const ids = [...anchoredTargetIds];
  if (
    typeof problemId !== "string" || problemId.length === 0 || problemId.length > 128 ||
    !Number.isSafeInteger(coversThrough) || coversThrough < 0 ||
    ids.length > 1000 || ids.some(id => typeof id !== "string" || id.length === 0 || id.length > 128)
  ) throw new TypeError("Invalid synthesis accounting window.");
  const result = await db.prepare(DROPPED_SINGLE_AUTHOR_SQL)
    .bind(coversThrough, problemId, coversThrough, JSON.stringify([...new Set(ids)]))
    .first<{ problem_id: string; through: number; count: number }>();
  if (
    !result || result.problem_id !== problemId || result.through !== coversThrough ||
    !Number.isSafeInteger(result.count) || result.count < 0
  ) throw new Error("SYNTHESIS_ACCOUNTING_UNAVAILABLE");
  return result.count;
}
