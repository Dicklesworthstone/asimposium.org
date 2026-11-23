-- asimposium:allow-destructive
-- Citation reuse is a relationship between two exact public publications.
-- Older notices recorded only the reuse side; their source cannot be recovered
-- from immutable metadata without interpreting prose. Do not backfill guesses.
CREATE TABLE citation_reuse_notice_sources (
  notice_id TEXT PRIMARY KEY,
  origin_event_id TEXT NOT NULL REFERENCES events(id),
  origin_sha256 TEXT NOT NULL,
  reuse_event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
  reuse_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (origin_event_id <> reuse_event_id)
);

-- Creation and every inbox read share this publication boundary. Projections
-- locate a current source; only its exact public event authorizes a notice.
-- Present-day controls apply even after the linked citation is corrected.
CREATE VIEW citation_reuse_publications AS
SELECT e.id AS event_id, e.problem_id, e.object_id AS citation_id,
  e.object_version AS version, e.seq, e.actor_fellow_id AS fellow_id,
  e.payload_sha256,
  json_extract(CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END,
    '$.locator_kind') AS locator_kind,
  json_extract(CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END,
    '$.canonical_locator') AS canonical_locator
FROM events e
JOIN problems p ON p.id = e.problem_id AND p.status <> 'private-draft'
  AND e.seq > 0 AND e.seq <= p.public_seq
JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
  AND c.redacted_at IS NULL AND json_valid(c.payload_json)
  AND length(CAST(c.payload_json AS BLOB)) <= 65536
WHERE e.object_kind = 'citation' AND e.actor_fellow_id IS NOT NULL
  AND ((e.type = 'citation.recorded' AND e.object_version = 1)
    OR (e.type = 'citation.corrected' AND e.object_version > 1))
  AND json_extract(CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END,
    '$.citation_id') = e.object_id
  AND json_extract(CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END,
    '$.locator_kind') IN ('doi', 'arxiv', 'isbn', 'url')
  AND json_type(CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END,
    '$.canonical_locator') = 'text'
  AND length(json_extract(CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END,
    '$.canonical_locator')) > 0
  AND NOT EXISTS (
    SELECT 1 FROM content_controls hidden
    WHERE hidden.problem_id = e.problem_id AND hidden.visibility = 'hidden'
      AND hidden.target_ref IN ('problem', e.problem_id, e.object_id,
        e.object_id || '@' || e.object_version, '#' || e.seq)
      AND hidden.version = (SELECT MAX(latest.version) FROM content_controls latest
        WHERE latest.problem_id = hidden.problem_id AND latest.target_ref = hidden.target_ref)
  )
  AND NOT EXISTS (SELECT 1 FROM scientific_withdrawals w WHERE w.source_event_id = e.id)
  AND NOT EXISTS (
    SELECT 1 FROM events duplicate WHERE duplicate.problem_id = e.problem_id
      AND duplicate.object_kind = 'citation' AND duplicate.object_id = e.object_id
      AND duplicate.object_version = e.object_version AND duplicate.id <> e.id
      AND duplicate.type IN ('citation.recorded', 'citation.corrected')
      AND duplicate.seq <= p.public_seq
  );

DROP TRIGGER citation_reused_impact_echo_after_insert;

-- Pin the recipient's current exact source before emitting its notice. Hidden
-- or private earlier citations cannot suppress a later eligible recorder.
-- Immutable content is inserted before citation projections. Repairing a
-- projection must never invent a past recipient or authorize a legacy notice.
CREATE TRIGGER citation_reused_impact_echo_after_content
AFTER INSERT ON event_content
WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = NEW.event_id
  AND e.type = 'citation.recorded' AND e.object_kind = 'citation' AND e.object_version = 1)
BEGIN
  INSERT INTO citation_reuse_notice_sources (
    notice_id, origin_event_id, origin_sha256, reuse_event_id, reuse_sha256, created_at
  )
  SELECT first_source.notice_id, first_source.origin_event_id, first_source.origin_sha256,
    first_source.reuse_event_id, first_source.reuse_sha256, first_source.created_at
  FROM (
  SELECT 'N-citation-reused-' || reuse.problem_id || '-' || reuse.citation_id AS notice_id,
    origin.event_id AS origin_event_id, origin.payload_sha256 AS origin_sha256,
    reuse.event_id AS reuse_event_id, reuse.payload_sha256 AS reuse_sha256,
    origin.fellow_id AS origin_fellow_id, reuse.fellow_id AS reuse_fellow_id,
    CAST(unixepoch(reuse_event.created_at, 'subsec') * 1000 AS INTEGER) AS created_at
  FROM citation_reuse_publications reuse
  JOIN events reuse_event ON reuse_event.id = reuse.event_id
  JOIN citations head ON head.canonical_locator = reuse.canonical_locator
    AND head.locator_kind = reuse.locator_kind
  JOIN citation_reuse_publications origin ON origin.problem_id = head.problem_id
    AND origin.citation_id = head.citation_id AND origin.version = head.version
    AND origin.seq = head.seq AND origin.fellow_id = head.author_fellow_id
    AND origin.canonical_locator = reuse.canonical_locator
    AND origin.locator_kind = reuse.locator_kind
  JOIN enrollment_fellows recipient ON recipient.fellow_id = origin.fellow_id
  WHERE reuse.event_id = NEW.event_id AND reuse.version = 1
    AND origin.event_id <> reuse.event_id
    AND length(reuse.problem_id) + length(reuse.citation_id) <= 60
    AND NOT EXISTS (SELECT 1 FROM fellow_inbox_notices legacy
      WHERE legacy.id = 'N-citation-reused-' || reuse.problem_id || '-' || reuse.citation_id)
    AND NOT EXISTS (SELECT 1 FROM events newer WHERE newer.problem_id = origin.problem_id
      AND newer.object_kind = 'citation' AND newer.object_id = origin.citation_id
      AND newer.type IN ('citation.recorded', 'citation.corrected') AND newer.seq > origin.seq
      AND newer.seq <= (SELECT public_seq FROM problems WHERE id = origin.problem_id))
  ORDER BY head.created_at, origin.problem_id, origin.citation_id
  LIMIT 1
  ) first_source
  WHERE first_source.origin_fellow_id <> first_source.reuse_fellow_id
  ON CONFLICT DO NOTHING;
END;

-- This runs in the citation's transaction. A replay cannot issue another
-- source pin or notice, and a failure rolls back both with the publication.
CREATE TRIGGER citation_reuse_notice_after_source
AFTER INSERT ON citation_reuse_notice_sources
BEGIN
  INSERT INTO fellow_inbox_notices (
    id, fellow_id, problem_id, notice_type, seq, title, detail, impact_kind,
    caused_by_event_id, target_id, acknowledged_at, expires_at, created_at
  )
  SELECT NEW.notice_id, origin.fellow_id, reuse.problem_id, 'impact_echo',
    (SELECT CASE WHEN COALESCE(MAX(n.seq), 0) < 9007199254740991
      THEN COALESCE(MAX(n.seq), 0) + 1 ELSE NULL END
     FROM fellow_inbox_notices n WHERE n.fellow_id = origin.fellow_id),
    'A source you cited was cited again',
    'Your citation ' || origin.citation_id || '@' || origin.version || ' on ' || origin.problem_id ||
      ' names the same source as ' || reuse.citation_id || '@' || reuse.version || ' on ' || reuse.problem_id ||
      '. Read both before relying on either; a shared source is not agreement.',
    'citation_reused', reuse.event_id, reuse.citation_id, NULL, NULL,
    NEW.created_at
  FROM citation_reuse_publications origin JOIN citation_reuse_publications reuse
    ON origin.locator_kind = reuse.locator_kind AND origin.canonical_locator = reuse.canonical_locator
      AND origin.fellow_id <> reuse.fellow_id
  WHERE origin.event_id = NEW.origin_event_id AND origin.payload_sha256 = NEW.origin_sha256
    AND reuse.event_id = NEW.reuse_event_id AND reuse.payload_sha256 = NEW.reuse_sha256
  ON CONFLICT (id) DO NOTHING;
END;
