-- asimposium:allow-destructive
-- W5.5 (asimposiumorg-zlm): widen the sealed exact-response replay scopes
-- with 'gaps' (file + settle share one key space; request digests distinguish
-- them). Same forward-only table rebuild as 0031 — rows copied verbatim, no
-- ciphertext changes, predecessor scopes keep answering unchanged.

CREATE TABLE session_write_replays_widened (
  scope TEXT NOT NULL CHECK (
    scope IN (
      'session_open', 'workshop_push', 'promote', 'revise', 'gaps', 'session_close'
    )
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
