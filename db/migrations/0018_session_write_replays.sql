PRAGMA foreign_keys = ON;

-- Session-route write replay (Rule A5: Idempotency-Key honored 24h on writes).
-- The enrollment replay table's scope CHECK is closed to the enrollment
-- routes, so the session protocol gets its own store with the same shape:
-- sealed exact-response replay, keyed by (scope, principal, key), with the
-- request digest refusing same-key/different-payload reuse as a conflict.
CREATE TABLE session_write_replays (
  scope TEXT NOT NULL CHECK (scope IN ('session_open', 'workshop_push', 'promote', 'session_close')),
  principal_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_ciphertext TEXT NOT NULL,
  response_initialization_vector TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, principal_scope, idempotency_key)
);
CREATE INDEX session_write_replays_expiry_idx ON session_write_replays (expires_at);
