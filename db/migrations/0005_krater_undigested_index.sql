PRAGMA foreign_keys = ON;

-- Deciding "is this problem's upgrade finished?" runs on every ordinary write. Without an
-- index the question `does any envelope of this problem still lack a digest?` is answered by
-- scanning every row of that problem to prove a negative, so write cost grew with history
-- even after the log stopped being materialized in the Worker.
--
-- A partial index over exactly the missing-digest predicate makes the healthy case a seek
-- into a set that is empty for every upgraded problem: rows enter this index only while they
-- are undigested, and leave it when the backfill fills both digests. It therefore stays
-- proportional to outstanding legacy work rather than to the ledger.
--
-- The predicate is written to match the probe's WHERE clause term for term, because SQLite
-- only uses a partial index when the query's restriction implies the index's own.
--
-- `IF NOT EXISTS` keeps this forward-safe for a database that already applied 0004: this
-- migration adds an index and changes no table, no row and no trigger.
CREATE INDEX IF NOT EXISTS events_undigested_idx
  ON events (problem_id, seq)
  WHERE row_digest IS NULL OR chain_digest IS NULL;
