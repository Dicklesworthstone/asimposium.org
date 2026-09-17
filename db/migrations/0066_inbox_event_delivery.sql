-- Fable §7.1: a published review or statement revision must not lose its
-- notification when the request finishes before a best-effort fan-out does.
-- This is a separate consumer queue: the existing Krater outbox deliberately
-- accepts only search.index. No public event/cursor or private body is copied.
CREATE TABLE inbox_event_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
  after_fellow_id TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'delivered', 'suppressed', 'quarantined')),
  claim_token TEXT,
  queued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  failure_code TEXT
);
CREATE INDEX inbox_event_deliveries_pending_idx
  ON inbox_event_deliveries (updated_at, id) WHERE state = 'pending';

-- The queue row and source append share the writer's transaction. Rollbacks
-- and idempotent request replays therefore cannot leave phantom deliveries.
-- Start at the deployment boundary, not with a flood of historical notices.
CREATE TRIGGER inbox_events_enqueue_after_insert
AFTER INSERT ON events
WHEN (
    (NEW.type = 'review.created' AND NEW.object_kind = 'review')
    OR (NEW.type = 'problem.statement-revised' AND NEW.object_kind = 'problem')
  ) AND EXISTS (
    SELECT 1 FROM problems WHERE id = NEW.problem_id AND status <> 'private-draft'
  )
BEGIN
  INSERT INTO inbox_event_deliveries (event_id, queued_at, updated_at)
  VALUES (NEW.id, CAST(unixepoch('subsec') * 1000 AS INTEGER),
    CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
