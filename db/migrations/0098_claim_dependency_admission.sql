-- Fable 6.5 / 7.2: publication pins are premises, including their ancestry.
-- Run at the writer's NULL -> settled replay transition, after event/content
-- insertion but inside the same D1 batch. This covers claim create/revise,
-- sponsor promotion and batch members without a separate write path. Replay
-- reads and ledger-only restore do not settle a new replay, so historical
-- claims remain restorable after their premises have changed.
--
-- This checks immutable publication identities and current availability, not
-- truth or evidence grades. Digests are compared to the stored envelopes;
-- cryptographic byte verification remains the application's read-side job.
-- The application recognizes SCIENTIFIC_REFERENCE_CHANGED and D1 rolls back
-- the failed batch, including cursors, projections, outbox and replay state.
CREATE TRIGGER claim_dependency_admission_before_settlement
BEFORE UPDATE OF event_id ON idempotency
WHEN OLD.event_id IS NULL AND NEW.event_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM events root
    WHERE root.id = NEW.event_id AND root.problem_id = NEW.problem_id
      AND root.object_kind = 'claim' AND root.type IN ('claim.created', 'claim.revised')
      -- The low-level writer also retains pre-pin publications. It may still
      -- record them, but a modern publication cannot treat their absent
      -- ancestry as complete. Modern route writers always supply this field.
      AND EXISTS (
        SELECT 1 FROM event_content body WHERE body.event_id = root.id
          AND CASE WHEN json_valid(body.payload_json)
            THEN json_type(body.payload_json, '$.dependency_pins') IS NOT NULL ELSE 1 END
      )
  )
BEGIN
  SELECT CASE WHEN EXISTS (
    WITH RECURSIVE
    root AS MATERIALIZED (
      SELECT e.id, e.problem_id, e.seq, e.object_id
      FROM events e WHERE e.id = NEW.event_id AND e.problem_id = NEW.problem_id
    ),
    -- UNION (not UNION ALL) visits a shared premise only once. The extra
    -- identity is a bounded proof of truncation, never silently ignored.
    walk(id) AS (
      SELECT id FROM root
      UNION
      SELECT json_extract(CASE WHEN pin.type = 'object' THEN pin.value ELSE '{}' END, '$.event_id')
      FROM walk
      JOIN events parent ON parent.id = walk.id
      JOIN root ON root.problem_id = parent.problem_id
      JOIN event_content c ON c.event_id = parent.id
        AND c.payload_sha256 = parent.payload_sha256 AND c.redacted_at IS NULL
      JOIN json_each(CASE WHEN length(CAST(c.payload_json AS BLOB)) <= 65536
        THEN CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END
        ELSE '{}' END, '$.dependency_pins') pin
      WHERE CAST(pin.key AS INTEGER) BETWEEN 0 AND 15
      LIMIT 65
    ),
    nodes AS MATERIALIZED (
      SELECT walk.id AS requested_id, e.id, e.problem_id, e.seq, e.object_id,
        e.object_kind, e.type, e.object_version, e.payload_sha256,
        c.event_id AS content_id, c.payload_sha256 AS content_sha256, c.redacted_at,
        length(CAST(c.payload_json AS BLOB)) AS source_bytes,
        CASE WHEN length(CAST(c.payload_json AS BLOB)) <= 65536
          THEN CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END
          ELSE '{}' END AS body
      FROM walk
      LEFT JOIN events e ON e.id = walk.id
      LEFT JOIN event_content c ON c.event_id = e.id
    ),
    pins AS MATERIALIZED (
      SELECT n.id AS parent_id, n.seq AS parent_seq, pin.type AS pin_type,
        CASE WHEN pin.type = 'object' THEN pin.value ELSE '{}' END AS body
      FROM nodes n JOIN json_each(n.body, '$.dependency_pins') pin
      WHERE CAST(pin.key AS INTEGER) BETWEEN 0 AND 15
    )
    SELECT 1 FROM root
    WHERE
      (SELECT COUNT(*) FROM nodes) > 64
      OR COALESCE((SELECT SUM(source_bytes) FROM nodes), 0) > 262144
      OR EXISTS (
        SELECT 1 FROM nodes n WHERE
          n.id IS NULL OR n.problem_id IS NOT root.problem_id
          OR n.object_kind IS NOT 'claim'
          OR n.type NOT IN ('claim.created', 'claim.revised')
          OR n.content_id IS NULL OR n.redacted_at IS NOT NULL
          OR n.content_sha256 IS NOT n.payload_sha256 OR n.source_bytes > 65536
          OR n.seq > root.seq
          OR json_type(n.body) IS NOT 'object'
          OR json_extract(n.body, '$.claim_id') IS NOT n.object_id
          OR json_type(n.body, '$.statement') IS NOT 'text'
          -- Missing legacy pin history is unknown, not an empty graph. An
          -- existing leaf may be re-published with an explicit pin list.
          OR json_type(n.body, '$.dependency_pins') IS NOT 'array'
          OR json_array_length(n.body, '$.dependency_pins') > 16
          OR (n.type = 'claim.created' AND n.object_version <> 1)
          OR (n.type = 'claim.revised' AND (
            n.object_version < 2 OR json_extract(n.body, '$.base_version') IS NOT n.object_version - 1
          ))
          OR (n.id <> root.id AND (
            n.object_id = root.object_id
            OR EXISTS (
              SELECT 1 FROM events later
              WHERE later.problem_id = root.problem_id AND later.object_id = n.object_id
                AND later.object_kind = 'claim' AND later.type IN ('claim.created', 'claim.revised')
                AND later.seq <= root.seq AND later.object_version > n.object_version
            )
            OR EXISTS (
              SELECT 1 FROM retractions r
              -- An unavailable closing envelope does not establish that
              -- this author's retained withdrawal has ceased to apply.
              JOIN events author ON author.problem_id = root.problem_id AND author.object_id = n.object_id
                AND author.object_kind = 'claim' AND author.type = 'claim.created' AND author.object_version = 1
                AND author.actor_fellow_id = r.author_fellow_id
              WHERE r.problem_id = root.problem_id AND r.seq <= root.seq
                AND r.target_object IN (n.object_id, n.object_id || '@' || n.object_version)
            )
          ))
          OR EXISTS (
            SELECT 1 FROM content_controls hidden
            WHERE hidden.problem_id = root.problem_id AND hidden.target_ref IN ('problem', n.object_id)
              AND hidden.visibility = 'hidden'
              AND hidden.version = (SELECT MAX(current.version) FROM content_controls current
                WHERE current.problem_id = hidden.problem_id AND current.target_ref = hidden.target_ref)
          )
      )
      OR EXISTS (
        SELECT 1 FROM pins pin
        LEFT JOIN nodes child ON child.id = json_extract(pin.body, '$.event_id')
        LEFT JOIN claim_versions version ON version.problem_id = root.problem_id
          AND version.claim_id = child.object_id AND version.version = child.object_version
        WHERE pin.pin_type <> 'object' OR child.id IS NULL OR version.claim_id IS NULL
          OR json_extract(pin.body, '$.claim_id') IS NOT child.object_id
          OR json_type(pin.body, '$.version') IS NOT 'integer'
          OR json_extract(pin.body, '$.version') IS NOT child.object_version
          OR json_extract(pin.body, '$.payload_digest') IS NOT child.payload_sha256
          OR json_extract(pin.body, '$.content_digest') IS NOT version.content_digest
          OR child.seq >= pin.parent_seq
      )
  ) THEN RAISE(ABORT, 'SCIENTIFIC_REFERENCE_CHANGED: claim dependency history is closed, unavailable, or unbounded') END;
END;
