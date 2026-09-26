-- 0083: disposition-change notices (Fable §7.1 inbox, bead asimposiumorg-1e7).
--
-- Dispositions are computed, never stored (ADR-9), so a change is detected by
-- recomputing a claim's standing just before and at each event that can move
-- it. This queue row is written in the same transaction as the event; the
-- scheduled pass (apps/wire/src/inbox/disposition-change.ts) compares the two
-- folds and notifies the claim's author and its prior reviewers, never the
-- actor. Rollbacks and idempotent replays leave no phantom row. No backfill.
CREATE TABLE disposition_change_deliveries (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'delivered', 'unchanged', 'quarantined')),
  queued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  failure_code TEXT
);
CREATE INDEX disposition_change_deliveries_pending_idx
  ON disposition_change_deliveries (queued_at, event_id) WHERE state = 'pending';

CREATE TRIGGER disposition_change_enqueue_after_insert
AFTER INSERT ON events
WHEN NEW.type IN ('review.created', 'evidence.created', 'object.retracted', 'claim.revised')
  AND EXISTS (SELECT 1 FROM problems WHERE id = NEW.problem_id AND status <> 'private-draft')
BEGIN
  INSERT INTO disposition_change_deliveries (event_id, problem_id, queued_at, updated_at)
  VALUES (NEW.id, NEW.problem_id, CAST(unixepoch('subsec') * 1000 AS INTEGER),
    CAST(unixepoch('subsec') * 1000 AS INTEGER))
  ON CONFLICT (event_id) DO NOTHING;
END;
