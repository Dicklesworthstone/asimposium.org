PRAGMA foreign_keys = ON;

-- A malformed outbox row is retained as audit evidence but is no longer
-- drainable work. Leaving it pending makes every bounded wrap revisit it,
-- inflates backlog status forever, and lets a poison prefix tax every later
-- delivery. Rebuild the table because SQLite cannot widen a CHECK constraint.
ALTER TABLE outbox RENAME TO outbox_v0;

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_sha256 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'delivered', 'quarantined')),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  quarantined_at TEXT,
  quarantine_code TEXT CHECK (
    quarantine_code IS NULL OR quarantine_code IN (
      'OUTBOX_EVENT_INVALID',
      'OUTBOX_KIND_INVALID',
      'OUTBOX_DEDUPE_INVALID',
      'OUTBOX_PAYLOAD_INVALID'
    )
  ),
  CHECK (
    (state = 'pending' AND delivered_at IS NULL AND quarantined_at IS NULL AND quarantine_code IS NULL)
    OR (state = 'delivered' AND delivered_at IS NOT NULL AND quarantined_at IS NULL AND quarantine_code IS NULL)
    OR (state = 'quarantined' AND delivered_at IS NULL AND quarantined_at IS NOT NULL AND quarantine_code IS NOT NULL)
  )
);

INSERT INTO outbox (
  id, event_id, problem_id, kind, dedupe_key, payload_sha256, state,
  created_at, delivered_at, quarantined_at, quarantine_code
)
SELECT id, event_id, problem_id, kind, dedupe_key, payload_sha256, state,
       created_at, delivered_at, NULL, NULL
  FROM outbox_v0;

DROP TABLE outbox_v0;

CREATE INDEX outbox_pending_idx ON outbox (state, id);
