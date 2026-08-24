PRAGMA foreign_keys = ON;

-- Krater chain v1 authenticated payload bytes and ordering, but did not bind
-- the canonical event-envelope row digest. Existing event rows are immutable,
-- and production migrations deliberately refuse destructive trigger/table
-- replacement, so v2 is an additive integrity authority over those rows.
-- The legacy digest columns remain stored for audit history; Worker reads,
-- replay, exports, checkpoints, and new writes use only the v2 sidecars.

ALTER TABLE problems
  ADD COLUMN chain_version INTEGER CHECK (chain_version IS NULL OR chain_version = 2);

ALTER TABLE krater_integrity_backfill
  ADD COLUMN chain_version INTEGER CHECK (chain_version IS NULL OR chain_version = 2);

CREATE TABLE event_chain_v2 (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  seq INTEGER NOT NULL CHECK (seq > 0),
  row_digest TEXT NOT NULL,
  chain_digest TEXT NOT NULL,
  chain_version INTEGER NOT NULL CHECK (chain_version = 2),
  UNIQUE (problem_id, seq)
);

CREATE INDEX event_chain_v2_problem_seq_idx
  ON event_chain_v2 (problem_id, seq);

-- Backfill inserts the sidecar directly, so its event identity must be bound
-- at the table boundary as tightly as the after-insert copy used by new
-- writes. A valid digest cannot be attached to another problem or sequence.
CREATE TRIGGER event_chain_v2_binding_before_insert
BEFORE INSERT ON event_chain_v2
WHEN NOT EXISTS (
  SELECT 1 FROM events e
  WHERE e.id = NEW.event_id
    AND e.problem_id = NEW.problem_id
    AND e.seq = NEW.seq
)
BEGIN
  SELECT RAISE(ABORT, 'KRATER_CHAIN_V2_EVENT_BINDING_MISMATCH');
END;

CREATE TABLE checkpoint_chain_v2 (
  problem_id TEXT NOT NULL,
  checkpoint_seq INTEGER NOT NULL CHECK (checkpoint_seq > 0),
  root_chain_digest TEXT NOT NULL,
  checkpoint_digest TEXT NOT NULL,
  chain_version INTEGER NOT NULL CHECK (chain_version = 2),
  PRIMARY KEY (problem_id, checkpoint_seq),
  FOREIGN KEY (problem_id, checkpoint_seq)
    REFERENCES integrity_checkpoints(problem_id, checkpoint_seq)
);

-- The sidecar root is meaningful only when it names the exact v2 event link
-- at the same problem sequence. This also constrains direct replay inserts;
-- the legacy-checkpoint trigger below covers only the new-write copy path.
CREATE TRIGGER checkpoint_chain_v2_binding_before_insert
BEFORE INSERT ON checkpoint_chain_v2
WHEN NOT EXISTS (
  SELECT 1 FROM event_chain_v2 c
  WHERE c.problem_id = NEW.problem_id
    AND c.seq = NEW.checkpoint_seq
    AND c.chain_version = 2
    AND c.chain_digest = NEW.root_chain_digest
)
BEGIN
  SELECT RAISE(ABORT, 'KRATER_CHECKPOINT_CHAIN_V2_BINDING_MISMATCH');
END;

-- Applying the schema never invents v2 digests. Each problem remains refused
-- until the Worker replays its immutable envelopes and atomically installs the
-- complete v2 sidecars plus the v2 problem head.
UPDATE krater_integrity_backfill
SET state = 'required', completed_at = NULL
WHERE chain_version IS NULL;

-- A post-cutover writer may insert an event only after a v2 problem head is
-- installed. The existing v1-era trigger still enforces equality between the
-- event's compatibility chain_digest column and the durable problem head.
CREATE TRIGGER events_chain_v2_before_insert
BEFORE INSERT ON events
WHEN NOT EXISTS (
  SELECT 1 FROM problems p
  WHERE p.id = NEW.problem_id
    AND p.chain_version = 2
    AND p.chain_digest = NEW.chain_digest
)
BEGIN
  SELECT RAISE(ABORT, 'KRATER_CHAIN_VERSION_MISMATCH');
END;

-- New writes carry the canonical v2 row and chain digests in the ordinary
-- event INSERT. Copy them into the sole v2 authority in the same transaction;
-- legacy rows receive these sidecars only through bounded replay.
CREATE TRIGGER events_chain_v2_after_insert
AFTER INSERT ON events
BEGIN
  INSERT INTO event_chain_v2
    (event_id, problem_id, seq, row_digest, chain_digest, chain_version)
  VALUES
    (NEW.id, NEW.problem_id, NEW.seq, NEW.row_digest, NEW.chain_digest, 2);
END;

CREATE TRIGGER event_chain_v2_immutable_before_update
BEFORE UPDATE ON event_chain_v2
BEGIN
  SELECT RAISE(ABORT, 'KRATER_CHAIN_V2_IMMUTABLE');
END;

CREATE TRIGGER event_chain_v2_immutable_before_delete
BEFORE DELETE ON event_chain_v2
BEGIN
  SELECT RAISE(ABORT, 'KRATER_CHAIN_V2_IMMUTABLE');
END;

CREATE TRIGGER checkpoints_chain_v2_before_insert
BEFORE INSERT ON integrity_checkpoints
WHEN NOT EXISTS (
  SELECT 1 FROM event_chain_v2 c
  WHERE c.problem_id = NEW.problem_id
    AND c.seq = NEW.checkpoint_seq
    AND c.chain_version = 2
    AND c.chain_digest = NEW.root_chain_digest
)
BEGIN
  SELECT RAISE(ABORT, 'KRATER_CHECKPOINT_CHAIN_VERSION_MISMATCH');
END;

CREATE TRIGGER checkpoints_chain_v2_after_insert
AFTER INSERT ON integrity_checkpoints
BEGIN
  INSERT INTO checkpoint_chain_v2
    (problem_id, checkpoint_seq, root_chain_digest, checkpoint_digest, chain_version)
  VALUES
    (NEW.problem_id, NEW.checkpoint_seq, NEW.root_chain_digest, NEW.checkpoint_digest, 2);
END;

CREATE TRIGGER checkpoint_chain_v2_immutable_before_update
BEFORE UPDATE ON checkpoint_chain_v2
BEGIN
  SELECT RAISE(ABORT, 'KRATER_CHECKPOINT_CHAIN_V2_IMMUTABLE');
END;

CREATE TRIGGER checkpoint_chain_v2_immutable_before_delete
BEFORE DELETE ON checkpoint_chain_v2
BEGIN
  SELECT RAISE(ABORT, 'KRATER_CHECKPOINT_CHAIN_V2_IMMUTABLE');
END;
