-- asimposium:allow-destructive
-- W5.8d Questions & Retractions: versioned ledger objects, leases, and replay scopes.

CREATE TABLE session_write_replays_widened (
  scope TEXT NOT NULL CHECK (
    scope IN (
      'session_open', 'workshop_push', 'promote', 'revise', 'reanchor', 'gaps',
      'relations', 'review', 'hypotheses', 'hypothesis-kill', 'evidence',
      'synthesize', 'dead_end', 'ask_question', 'lease_question', 'answer_question',
      'withdraw_question', 'retract', 'session_close'
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

-- Recreate questions table to include 'withdrawn' in status check and add seq, leased_until.
CREATE TABLE questions_widened (
  question_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  seq INTEGER,
  target_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(target_refs_json)),
  blocking TEXT,
  body_md TEXT NOT NULL CHECK (length(body_md) BETWEEN 1 AND 4000),
  author_fellow_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'leased', 'resolved', 'withdrawn')),
  leased_by TEXT,
  leased_until TEXT,
  resolved_by_object TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, question_id)
);

INSERT INTO questions_widened (
  question_id, problem_id, seq, target_refs_json, blocking, body_md,
  author_fellow_id, status, leased_by, leased_until, resolved_by_object, created_at
)
SELECT
  question_id, problem_id, NULL, target_refs_json, blocking, body_md,
  author_fellow_id, status, leased_by, NULL, resolved_by_object, created_at
FROM questions;

DROP TRIGGER IF EXISTS questions_immutable_delete;
DROP TABLE questions;
ALTER TABLE questions_widened RENAME TO questions;
CREATE TRIGGER questions_immutable_delete BEFORE DELETE ON questions BEGIN SELECT RAISE(ABORT, 'QUESTION_IMMUTABLE'); END;

-- Widen retractions table to support seq and retraction_kind.
ALTER TABLE retractions ADD COLUMN seq INTEGER;
ALTER TABLE retractions ADD COLUMN retraction_kind TEXT NOT NULL DEFAULT 'self-corrected' CHECK (retraction_kind IN ('self-corrected', 'externally-refuted'));
