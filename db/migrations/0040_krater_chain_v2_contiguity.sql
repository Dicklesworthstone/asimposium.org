PRAGMA foreign_keys = ON;

-- Migration 0039 made v2 sidecars immutable and bound each row to the event or
-- checkpoint at the same identity. Complete-stream fast paths also need a
-- structural proof that a terminal sidecar cannot exist above a missing
-- predecessor. These forward-only guards make insertion order contiguous;
-- together with the existing update/delete refusals, a sidecar at sequence N
-- proves that sequences 1 through N all exist.

-- Refuse an upgrade over any partial 0039 state before relying on the new
-- insertion guards. The retained singleton is migration evidence: both CHECK
-- constraints abort the migration if a v2-signalled problem is missing even
-- one event or checkpoint sidecar that already has a durable base row.
CREATE TABLE krater_chain_v2_contiguity_migration_guard (
  migration TEXT PRIMARY KEY CHECK (migration = '0040'),
  event_gap_count INTEGER NOT NULL CHECK (event_gap_count = 0),
  checkpoint_gap_count INTEGER NOT NULL CHECK (checkpoint_gap_count = 0)
);

INSERT INTO krater_chain_v2_contiguity_migration_guard
  (migration, event_gap_count, checkpoint_gap_count)
SELECT
  '0040',
  (
    SELECT COUNT(*)
    FROM events e
    WHERE NOT EXISTS (
      SELECT 1 FROM event_chain_v2 current
      WHERE current.event_id = e.id
        AND current.problem_id = e.problem_id
        AND current.seq = e.seq
        AND current.chain_version = 2
    )
      AND (
        EXISTS (SELECT 1 FROM event_chain_v2 any_v2 WHERE any_v2.problem_id = e.problem_id)
        OR EXISTS (
          SELECT 1 FROM problems p
          WHERE p.id = e.problem_id AND p.chain_version = 2
        )
        OR EXISTS (
          SELECT 1 FROM krater_integrity_backfill b
          WHERE b.problem_id = e.problem_id AND b.chain_version = 2
        )
      )
  ),
  (
    SELECT COUNT(*)
    FROM events e
    WHERE NOT EXISTS (
      SELECT 1 FROM checkpoint_chain_v2 current
      WHERE current.problem_id = e.problem_id
        AND current.checkpoint_seq = e.seq
        AND current.chain_version = 2
    )
      AND (
        EXISTS (SELECT 1 FROM event_chain_v2 any_v2 WHERE any_v2.problem_id = e.problem_id)
        OR EXISTS (
          SELECT 1 FROM problems p
          WHERE p.id = e.problem_id AND p.chain_version = 2
        )
        OR EXISTS (
          SELECT 1 FROM krater_integrity_backfill b
          WHERE b.problem_id = e.problem_id AND b.chain_version = 2
        )
      )
  );

CREATE TRIGGER event_chain_v2_contiguous_before_insert
BEFORE INSERT ON event_chain_v2
WHEN NEW.seq > 1
  AND NOT EXISTS (
    SELECT 1 FROM event_chain_v2 prior
    WHERE prior.problem_id = NEW.problem_id
      AND prior.seq = NEW.seq - 1
      AND prior.chain_version = 2
  )
BEGIN
  SELECT RAISE(ABORT, 'KRATER_CHAIN_V2_PREDECESSOR_MISSING');
END;

CREATE TRIGGER checkpoint_chain_v2_contiguous_before_insert
BEFORE INSERT ON checkpoint_chain_v2
WHEN NEW.checkpoint_seq > 1
  AND NOT EXISTS (
    SELECT 1 FROM checkpoint_chain_v2 prior
    WHERE prior.problem_id = NEW.problem_id
      AND prior.checkpoint_seq = NEW.checkpoint_seq - 1
      AND prior.chain_version = 2
  )
BEGIN
  SELECT RAISE(ABORT, 'KRATER_CHECKPOINT_CHAIN_V2_PREDECESSOR_MISSING');
END;
