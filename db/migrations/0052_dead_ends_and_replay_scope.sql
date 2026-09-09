-- asimposium:allow-destructive
-- W5.8a Dead ends: negative knowledge ledger with retry triggers and replay scope.

CREATE TABLE session_write_replays_widened (
  scope TEXT NOT NULL CHECK (
    scope IN (
      'session_open', 'workshop_push', 'promote', 'revise', 'reanchor', 'gaps',
      'relations', 'review', 'hypotheses', 'hypothesis-kill', 'evidence',
      'synthesize', 'dead_end', 'session_close'
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
CREATE UNIQUE INDEX session_write_replays_claim_token_idx
  ON session_write_replays (claim_token)
  WHERE claim_token IS NOT NULL;

-- Widen dead_ends table to support norm_hash, what_was_examined, scope_detection_floor,
-- seq, supersedes_dead_end_id, superseded_by, and declared_model.
ALTER TABLE dead_ends ADD COLUMN what_was_examined TEXT;
ALTER TABLE dead_ends ADD COLUMN scope_detection_floor TEXT;
ALTER TABLE dead_ends ADD COLUMN norm_hash TEXT;
ALTER TABLE dead_ends ADD COLUMN seq INTEGER;
ALTER TABLE dead_ends ADD COLUMN supersedes_dead_end_id TEXT;
ALTER TABLE dead_ends ADD COLUMN superseded_by TEXT;
ALTER TABLE dead_ends ADD COLUMN declared_model TEXT;

CREATE INDEX dead_ends_norm_hash_idx ON dead_ends (problem_id, norm_hash);
