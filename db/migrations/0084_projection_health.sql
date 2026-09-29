-- 0084: projection health (Fable §5 Krater, bead asimposiumorg-79n).
--
-- Projections are derived from the event log (Rule A6). When the operator
-- projection repair (ops:projection-rebuild) finds drift it cannot repair by
-- insertion, the stored boards keep serving, and the problem's public faces
-- must say so rather than present them as sound. This row is that record. It
-- is operational state, not ledger: the repair route upserts it, and a later
-- repair that ends consistent sets it back. No backfill.
CREATE TABLE projection_health (
  problem_id TEXT PRIMARY KEY REFERENCES problems(id),
  status TEXT NOT NULL CHECK (status IN ('drift', 'consistent')),
  source_cursor INTEGER NOT NULL CHECK (source_cursor >= 0),
  drift_count INTEGER NOT NULL CHECK (drift_count >= 0),
  recorded_at TEXT NOT NULL
);
