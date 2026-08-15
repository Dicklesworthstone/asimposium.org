PRAGMA foreign_keys = ON;

-- A malformed outbox row is retained as audit evidence but is no longer
-- drainable work. Leaving it pending makes every bounded wrap revisit it,
-- inflates backlog status forever, and lets a poison prefix tax every later
-- delivery. Keep the original pending/delivered state machine intact and add
-- an orthogonal quarantine marker so this migration is safe on production's
-- forward-only, non-destructive path.
ALTER TABLE outbox ADD COLUMN quarantine_code TEXT CHECK (
    quarantine_code IS NULL OR quarantine_code IN (
      'OUTBOX_EVENT_INVALID',
      'OUTBOX_KIND_INVALID',
      'OUTBOX_DEDUPE_INVALID',
      'OUTBOX_PAYLOAD_INVALID'
    )
);

ALTER TABLE outbox ADD COLUMN quarantined_at TEXT CHECK (
  (quarantined_at IS NULL AND quarantine_code IS NULL)
  OR (
    quarantined_at IS NOT NULL
    AND quarantine_code IS NOT NULL
    AND state = 'pending'
    AND delivered_at IS NULL
  )
);

CREATE INDEX outbox_drainable_idx
  ON outbox (state, quarantined_at, id)
  WHERE state = 'pending' AND quarantined_at IS NULL;
