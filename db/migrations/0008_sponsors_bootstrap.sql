PRAGMA foreign_keys = ON;

-- W3.1 (asimposiumorg-4y3): the sponsor record. First contact bootstraps a
-- row through the Worker's single writer; the sponsor_id is the canonical
-- usr_<sub> from the Agora session, so the row itself is the attribution
-- (ADR-20: a named human stands behind every Fellow). last_seen_at moves on
-- every bootstrap call; created_at never does.
CREATE TABLE sponsors (
  sponsor_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
