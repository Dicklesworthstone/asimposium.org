-- Coalesced, transactional W7 room wake-ups. This is delivery state only:
-- no event payload, credential, workshop object, or second scientific ledger.
-- Apply after 0077, before enabling HERALD_ROOMS. Existing problems need no
-- backfill: each new room connection reads the current canonical D1 head.
CREATE TABLE herald_room_outbox (
  problem_id TEXT PRIMARY KEY REFERENCES problems(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation BETWEEN 1 AND 9007199254740991),
  delivered_generation INTEGER NOT NULL DEFAULT 0 CHECK (typeof(delivered_generation) = 'integer' AND delivered_generation BETWEEN 0 AND generation),
  requested_at INTEGER NOT NULL,
  retry_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 16)
) STRICT;
CREATE INDEX herald_room_outbox_pending ON herald_room_outbox(retry_at, requested_at, problem_id)
  WHERE generation > delivered_generation;

CREATE TRIGGER herald_room_problem_insert AFTER INSERT ON problems
WHEN NEW.status <> 'private-draft'
BEGIN
  INSERT INTO herald_room_outbox(problem_id, generation, requested_at)
  VALUES (NEW.id, 1, CAST(strftime('%s','now') AS INTEGER) * 1000);
END;

CREATE TRIGGER herald_room_problem_change AFTER UPDATE OF public_seq, status, unlisted ON problems
WHEN (OLD.public_seq IS NOT NEW.public_seq OR OLD.status IS NOT NEW.status OR OLD.unlisted IS NOT NEW.unlisted)
  AND (OLD.status <> 'private-draft' OR NEW.status <> 'private-draft')
BEGIN
  INSERT INTO herald_room_outbox(problem_id, generation, requested_at)
  VALUES (NEW.id, 1, CAST(strftime('%s','now') AS INTEGER) * 1000)
  ON CONFLICT(problem_id) DO UPDATE SET generation = generation + 1,
    requested_at = excluded.requested_at, retry_at = 0, attempts = 0;
END;

-- Availability changes do not necessarily increment public_seq. They still
-- invalidate what a connected client has read, including a same-cursor page.
CREATE TRIGGER herald_room_content_insert AFTER INSERT ON event_content
BEGIN
  INSERT INTO herald_room_outbox(problem_id, generation, requested_at)
  SELECT e.problem_id, 1, CAST(strftime('%s','now') AS INTEGER) * 1000
  FROM events e JOIN problems p ON p.id = e.problem_id
  WHERE e.id = NEW.event_id AND p.status <> 'private-draft'
  ON CONFLICT(problem_id) DO UPDATE SET generation = generation + 1,
    requested_at = excluded.requested_at, retry_at = 0, attempts = 0;
END;
CREATE TRIGGER herald_room_content_redaction AFTER UPDATE OF redacted_at ON event_content
WHEN OLD.redacted_at IS NOT NEW.redacted_at
BEGIN
  INSERT INTO herald_room_outbox(problem_id, generation, requested_at)
  SELECT e.problem_id, 1, CAST(strftime('%s','now') AS INTEGER) * 1000
  FROM events e JOIN problems p ON p.id = e.problem_id
  WHERE e.id = NEW.event_id AND p.status <> 'private-draft'
  ON CONFLICT(problem_id) DO UPDATE SET generation = generation + 1,
    requested_at = excluded.requested_at, retry_at = 0, attempts = 0;
END;
CREATE TRIGGER herald_room_content_delete AFTER DELETE ON event_content
BEGIN
  INSERT INTO herald_room_outbox(problem_id, generation, requested_at)
  SELECT e.problem_id, 1, CAST(strftime('%s','now') AS INTEGER) * 1000
  FROM events e JOIN problems p ON p.id = e.problem_id
  WHERE e.id = OLD.event_id AND p.status <> 'private-draft'
  ON CONFLICT(problem_id) DO UPDATE SET generation = generation + 1,
    requested_at = excluded.requested_at, retry_at = 0, attempts = 0;
END;
