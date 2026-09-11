-- asimposium:allow-destructive
-- Retain every encrypted response while adding the heartbeat replay scope.
CREATE TABLE session_write_replays_widened (
  scope TEXT NOT NULL CHECK (scope IN (
    'session_open', 'workshop_push', 'promote', 'revise', 'reanchor', 'gaps',
    'relations', 'review', 'hypotheses', 'hypothesis-kill', 'evidence',
    'synthesize', 'dead_end', 'ask_question', 'lease_question', 'answer_question',
    'withdraw_question', 'retract', 'conflicts', 'resolve_conflict',
    'acquire_lease', 'release_lease', 'challenge_lease', 'session_close', 'session_heartbeat'
  )),
  principal_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_ciphertext TEXT NOT NULL,
  response_initialization_vector TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  claim_token TEXT,
  PRIMARY KEY (scope, principal_scope, idempotency_key)
);
INSERT INTO session_write_replays_widened
SELECT * FROM session_write_replays;
DROP TABLE session_write_replays;
ALTER TABLE session_write_replays_widened RENAME TO session_write_replays;
CREATE INDEX session_write_replays_expiry_idx ON session_write_replays (expires_at);
CREATE UNIQUE INDEX session_write_replays_claim_token_idx
  ON session_write_replays (claim_token) WHERE claim_token IS NOT NULL;
