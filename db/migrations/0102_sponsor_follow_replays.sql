PRAGMA foreign_keys = ON;

-- Private preference receipts, not a second activity feed. Scientific activity
-- remains in events and the canonical review queue. An old successful follow
-- retry must not reverse a later explicit unfollow.
CREATE TABLE sponsor_follow_replays (
  sponsor_id TEXT NOT NULL REFERENCES sponsors(sponsor_id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  problem_id TEXT NOT NULL,
  following INTEGER NOT NULL CHECK (following IN (0, 1)),
  followed_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claim_token TEXT NOT NULL,
  PRIMARY KEY (sponsor_id, idempotency_key),
  CHECK ((following = 1 AND followed_at IS NOT NULL) OR
         (following = 0 AND followed_at IS NULL))
);
CREATE INDEX sponsor_follow_replays_expiry_idx
  ON sponsor_follow_replays (sponsor_id, expires_at);
