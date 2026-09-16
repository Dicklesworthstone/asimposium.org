/** Read-only query plans. Admission order is immutable; ranking is page-local.
 * All SQL values are bound. Never derive queue priority from engagement data. */
export const REVIEW_QUEUE_MAX_SCOPE_EVENTS = 512;
export const REVIEW_QUEUE_MAX_SCOPE_BYTES = 1024 * 1024;
export const REVIEW_QUEUE_MAX_DEPENDENTS = 32;

export const REVIEW_QUEUE_DISCOVERY_SQL = `
WITH admitted AS (
  SELECT p.id AS problem_id, p.public_seq AS cursor,
    a.object_id AS claim_id, a.id AS admission_id, a.created_at,
    h.id AS head_id, h.object_version AS version
  FROM problems p
  JOIN events a ON a.problem_id = p.id AND a.object_kind = 'claim'
    AND a.type = 'claim.created' AND a.object_version = 1 AND a.seq <= p.public_seq
  JOIN events h ON h.problem_id = p.id AND h.object_kind = 'claim'
    AND h.object_id = a.object_id AND h.type IN ('claim.created', 'claim.revised')
    AND h.seq = (SELECT MAX(e.seq) FROM events e WHERE e.problem_id = p.id
      AND e.object_kind = 'claim' AND e.object_id = a.object_id
      AND e.type IN ('claim.created', 'claim.revised') AND e.seq <= p.public_seq)
  WHERE p.unlisted = 0 AND p.status NOT IN ('private-draft', 'resolved', 'retired', 'archived')
    AND (? IS NULL OR p.id = ?)
    AND (a.created_at > ? OR (a.created_at = ? AND a.id > ?))
  ORDER BY a.created_at ASC, a.id ASC LIMIT ?
)
SELECT admitted.*,
  (SELECT COUNT(*) FROM (SELECT 1 FROM events e
    WHERE e.problem_id = admitted.problem_id AND e.seq <= admitted.cursor LIMIT 513)) AS scope_events,
  (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) FROM (
    SELECT c.payload_json FROM events e LEFT JOIN event_content c ON c.event_id = e.id
    WHERE e.problem_id = admitted.problem_id AND e.seq <= admitted.cursor LIMIT 513
  )) AS scope_bytes
FROM admitted ORDER BY created_at ASC, admission_id ASC`;

/** Body and dependency metadata are read in the same D1 batch as the shared
 * scientific fold. Present-day visibility/redaction wins over captured cursors.
 * Dependency edges are declarations, not proof of the implied mathematics. */
export const REVIEW_QUEUE_METADATA_SQL = `
SELECT p.id AS problem_id, h.id AS event_id, h.object_id AS claim_id,
  h.object_version AS version, h.seq, h.payload_sha256,
  c.payload_json,
  a.id AS admission_id, a.created_at, a.actor_fellow_id AS author_fellow_id,
  a.actor_sponsor_id AS author_sponsor_id, a.payload_sha256 AS author_payload_sha256,
  ac.payload_json AS author_payload_json,
  v.kind, v.statement, v.falsifier, v.content_digest,
  (SELECT json_group_array(json(dependency_json)) FROM (
    SELECT json_object('event_id', de.id, 'claim_id', de.object_id,
      'payload_sha256', de.payload_sha256, 'payload_json', dc.payload_json) AS dependency_json
    FROM events de JOIN event_content dc ON dc.event_id = de.id
      AND dc.payload_sha256 = de.payload_sha256 AND dc.redacted_at IS NULL
    WHERE de.problem_id = p.id AND de.object_kind = 'claim'
      AND de.type IN ('claim.created', 'claim.revised') AND de.object_id <> h.object_id
      AND de.seq <= ? AND de.seq > h.seq
      AND de.seq = (SELECT MAX(dh.seq) FROM events dh
        WHERE dh.problem_id = de.problem_id AND dh.object_id = de.object_id
          AND dh.object_kind = 'claim' AND dh.type IN ('claim.created', 'claim.revised')
          AND dh.seq <= ?)
      AND length(CAST(dc.payload_json AS BLOB)) <= 32768
      AND EXISTS (SELECT 1 FROM json_each(
        CASE WHEN json_valid(dc.payload_json) THEN dc.payload_json ELSE '{}' END, '$.dependency_pins') pin
        WHERE pin.type = 'object'
          AND json_extract(CASE WHEN pin.type = 'object' THEN pin.value ELSE '{}' END, '$.claim_id') = h.object_id
          AND json_extract(CASE WHEN pin.type = 'object' THEN pin.value ELSE '{}' END, '$.version') = h.object_version
          AND json_extract(CASE WHEN pin.type = 'object' THEN pin.value ELSE '{}' END, '$.event_id') = h.id
          AND json_extract(CASE WHEN pin.type = 'object' THEN pin.value ELSE '{}' END, '$.payload_digest') = h.payload_sha256
          AND json_extract(CASE WHEN pin.type = 'object' THEN pin.value ELSE '{}' END, '$.content_digest') = v.content_digest)
      AND NOT EXISTS (SELECT 1 FROM retractions r JOIN events re
        ON re.problem_id = r.problem_id AND re.object_id = r.retraction_id
          AND re.object_kind = 'retraction' AND re.type = 'object.retracted' AND re.seq = r.seq
        WHERE r.problem_id = p.id AND re.seq <= ?
          AND (r.target_object = de.object_id OR r.target_object = de.object_id || '@' || de.object_version))
    ORDER BY de.seq ASC, de.id ASC LIMIT 33
  )) AS dependents_json
FROM problems p JOIN events h ON h.problem_id = p.id
  AND h.id = ? AND h.object_kind = 'claim' AND h.type IN ('claim.created', 'claim.revised')
JOIN claim_versions v ON v.problem_id = p.id AND v.claim_id = h.object_id
  AND v.version = h.object_version
JOIN events a ON a.problem_id = p.id AND a.object_id = h.object_id
  AND a.object_kind = 'claim' AND a.type = 'claim.created' AND a.object_version = 1
JOIN event_content c ON c.event_id = h.id AND c.payload_sha256 = h.payload_sha256
  AND c.redacted_at IS NULL AND length(CAST(c.payload_json AS BLOB)) <= 32768
JOIN event_content ac ON ac.event_id = a.id AND ac.payload_sha256 = a.payload_sha256
  AND ac.redacted_at IS NULL AND length(CAST(ac.payload_json AS BLOB)) <= 32768
WHERE p.id = ? AND p.unlisted = 0
  AND p.status NOT IN ('private-draft', 'resolved', 'retired', 'archived')
  AND h.seq <= ? AND h.seq <= p.public_seq AND a.seq <= h.seq
LIMIT 1`;
