-- Hypothesis statements stay immutable. Author-owned coordination transitions
-- retain the old route, pin an event head, and optionally point to a separately
-- published successor. The legacy status is retained for older projections;
-- lifecycle_status distinguishes temporary deferral from an active route.
ALTER TABLE hypotheses ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active'
  CHECK (lifecycle_status IN ('active', 'deferred', 'narrowed', 'superseded', 'killed'));
ALTER TABLE hypotheses ADD COLUMN lifecycle_event_id TEXT;
ALTER TABLE hypotheses ADD COLUMN lifecycle_source_seq INTEGER;
ALTER TABLE hypotheses ADD COLUMN successor_hypothesis_id TEXT;

UPDATE hypotheses SET
  lifecycle_status = CASE status WHEN 'killed' THEN 'killed'
    WHEN 'refined-into' THEN 'superseded' ELSE 'active' END,
  lifecycle_event_id = COALESCE(kill_event_id, source_event_id),
  lifecycle_source_seq = COALESCE(kill_source_seq, source_seq);

CREATE INDEX hypotheses_lifecycle_idx ON hypotheses(problem_id, lifecycle_status);

-- asimposium:allow-destructive
-- SQLite cannot widen a CHECK in place. Preserve every replay and both indexes
-- while admitting the new atomic lifecycle receipt scope.
CREATE TABLE session_write_replays_widened (
  scope TEXT NOT NULL CHECK (scope IN (
    'session_open', 'workshop_push', 'promote', 'revise', 'reanchor', 'gaps',
    'relations', 'dispute_relation', 'review', 'hypotheses', 'hypothesis-kill',
    'hypothesis-lifecycle', 'evidence', 'synthesize', 'dead_end', 'ask_question',
    'lease_question', 'answer_question', 'withdraw_question', 'retract',
    'conflicts', 'resolve_conflict', 'acquire_lease', 'release_lease',
    'challenge_lease', 'session_close', 'session_heartbeat', 'events_batch',
    'citations', 'correct_citation'
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

INSERT INTO session_write_replays_widened SELECT * FROM session_write_replays;
DROP TABLE session_write_replays;
ALTER TABLE session_write_replays_widened RENAME TO session_write_replays;
CREATE INDEX session_write_replays_expiry_idx ON session_write_replays (expires_at);
CREATE UNIQUE INDEX session_write_replays_claim_token_idx
  ON session_write_replays (claim_token) WHERE claim_token IS NOT NULL;
