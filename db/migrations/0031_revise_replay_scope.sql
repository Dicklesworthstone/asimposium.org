-- W5.3 revision route (asimposiumorg-6w1): widen the sealed exact-response
-- replay scopes with 'revise'. SQLite cannot ALTER a CHECK constraint, so the
-- table is rebuilt and every existing row copied verbatim — a replay cache
-- keyed (scope, principal_scope, idempotency_key); no ciphertext changes, so
-- the running Worker keeps answering predecessor-scope replays unchanged
-- (forward-only cutover per the migration README).

CREATE TABLE session_write_replays_widened (
  scope TEXT NOT NULL CHECK (
    scope IN ('session_open', 'workshop_push', 'promote', 'revise', 'session_close')
  ),
  principal_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_ciphertext TEXT NOT NULL,
  response_initialization_vector TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  claim_token TEXT,
  PRIMARY KEY (scope, principal_scope, idempotency_key)
);

INSERT INTO session_write_replays_widened (
  scope, principal_scope, idempotency_key, request_digest,
  response_ciphertext, response_initialization_vector, expires_at, claim_token
)
SELECT
  scope, principal_scope, idempotency_key, request_digest,
  response_ciphertext, response_initialization_vector, expires_at, claim_token
FROM session_write_replays;

DROP TABLE session_write_replays;
ALTER TABLE session_write_replays_widened RENAME TO session_write_replays;

CREATE INDEX session_write_replays_expiry_idx ON session_write_replays (expires_at);
