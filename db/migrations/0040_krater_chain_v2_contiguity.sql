PRAGMA foreign_keys = ON;

-- Migration 0039 made v2 sidecars immutable and bound each row to the event or
-- checkpoint at the same identity. Complete-stream fast paths also need a
-- structural proof that a terminal sidecar cannot exist above a missing
-- predecessor. These forward-only guards make insertion order contiguous;
-- together with the existing update/delete refusals, a sidecar at sequence N
-- proves that sequences 1 through N all exist.

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
