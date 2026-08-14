PRAGMA foreign_keys = ON;

-- Forward-only repair for databases that already applied 0001 before Krater
-- integrity was introduced. NULL never stands for a digest: rows are marked
-- required until the Worker derives every digest from durable envelope data.
ALTER TABLE problems ADD COLUMN chain_digest TEXT;
ALTER TABLE events ADD COLUMN row_digest TEXT;
ALTER TABLE events ADD COLUMN chain_digest TEXT;
ALTER TABLE event_content ADD COLUMN redacted_at TEXT;
ALTER TABLE event_content ADD COLUMN redaction_reason TEXT;

CREATE TABLE krater_integrity_backfill (
  problem_id TEXT PRIMARY KEY REFERENCES problems(id),
  state TEXT NOT NULL CHECK (state IN ('required', 'complete')),
  legacy_event_count INTEGER NOT NULL CHECK (legacy_event_count >= 0),
  completed_at TEXT
);

INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at)
SELECT p.id, 'required', COUNT(e.id), NULL
FROM problems p
LEFT JOIN events e ON e.problem_id = p.id
GROUP BY p.id;

-- Checkpoints are deliberately unsigned-v0. ADR-23's signed checkpoint
-- format, key identifier, verification, and publication range are not yet
-- implemented and must not be inferred from this foundation.
CREATE TABLE integrity_checkpoints (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  checkpoint_seq INTEGER NOT NULL CHECK (checkpoint_seq > 0),
  root_chain_digest TEXT NOT NULL,
  checkpoint_digest TEXT NOT NULL,
  checkpoint_version INTEGER NOT NULL CHECK (checkpoint_version = 1),
  checkpoint_mode TEXT NOT NULL CHECK (checkpoint_mode = 'unsigned-v0'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, checkpoint_seq)
);

-- Envelopes are immutable, except for a one-time integrity backfill that may
-- fill both previously-NULL digest columns while retaining every other value.
CREATE TRIGGER events_immutable_before_update
BEFORE UPDATE ON events
WHEN NEW.id IS NOT OLD.id
  OR NEW.problem_id IS NOT OLD.problem_id
  OR NEW.seq IS NOT OLD.seq
  OR NEW.type IS NOT OLD.type
  OR NEW.object_kind IS NOT OLD.object_kind
  OR NEW.object_id IS NOT OLD.object_id
  OR NEW.object_version IS NOT OLD.object_version
  OR NEW.payload_sha256 IS NOT OLD.payload_sha256
  OR NEW.created_at IS NOT OLD.created_at
  OR NOT (
    OLD.row_digest IS NULL
    AND OLD.chain_digest IS NULL
    AND NEW.row_digest IS NOT NULL
    AND NEW.chain_digest IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM krater_integrity_backfill b
      WHERE b.problem_id = OLD.problem_id AND b.state = 'required'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'KRATER_EVENT_ENVELOPE_IMMUTABLE');
END;

CREATE TRIGGER events_immutable_before_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'KRATER_EVENT_ENVELOPE_IMMUTABLE');
END;

CREATE TRIGGER event_content_lawful_redaction_only
BEFORE UPDATE ON event_content
WHEN NEW.event_id IS NOT OLD.event_id
  OR NEW.payload_sha256 IS NOT OLD.payload_sha256
  OR NEW.redacted_at IS NULL
  OR NEW.redaction_reason IS NULL
BEGIN
  SELECT RAISE(ABORT, 'KRATER_CONTENT_REDACTION_INVALID');
END;

CREATE TRIGGER events_chain_head_before_insert
BEFORE INSERT ON events
WHEN NEW.row_digest IS NULL
  OR NEW.chain_digest IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM problems
    WHERE id = NEW.problem_id
      AND public_seq = NEW.seq
      AND chain_digest = NEW.chain_digest
  )
  OR NOT EXISTS (
    SELECT 1 FROM krater_integrity_backfill
    WHERE problem_id = NEW.problem_id AND state = 'complete'
  )
BEGIN
  SELECT RAISE(ABORT, 'KRATER_CHAIN_HEAD_MISMATCH');
END;
