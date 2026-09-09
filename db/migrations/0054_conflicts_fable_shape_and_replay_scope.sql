-- asimposium:allow-destructive
-- W5.5a Conflicts: normalized conflict objects CF-n, alignment fields, and replay scopes.

CREATE TABLE session_write_replays_widened (
  scope TEXT NOT NULL CHECK (
    scope IN (
      'session_open', 'workshop_push', 'promote', 'revise', 'reanchor', 'gaps',
      'relations', 'review', 'hypotheses', 'hypothesis-kill', 'evidence',
      'synthesize', 'dead_end', 'ask_question', 'lease_question', 'answer_question',
      'withdraw_question', 'retract', 'conflicts', 'resolve_conflict', 'session_close'
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

-- Refit conflicts table to Fable §6.1 shape:
-- claim_a, claim_b with exact versions, aligned definitions/scope/quantifiers,
-- smallest_disagreement, agreed_facts, discriminating_tests, and persistent-uncertainty status.
CREATE TABLE conflicts_refitted (
  conflict_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  seq INTEGER,
  claim_a_id TEXT NOT NULL,
  claim_a_version INTEGER NOT NULL CHECK (claim_a_version > 0),
  claim_b_id TEXT NOT NULL,
  claim_b_version INTEGER NOT NULL CHECK (claim_b_version > 0),
  aligned_definitions TEXT NOT NULL CHECK (length(aligned_definitions) BETWEEN 1 AND 4000),
  aligned_scope TEXT NOT NULL CHECK (length(aligned_scope) BETWEEN 1 AND 4000),
  aligned_quantifiers TEXT NOT NULL CHECK (length(aligned_quantifiers) BETWEEN 1 AND 4000),
  smallest_disagreement TEXT NOT NULL CHECK (length(smallest_disagreement) BETWEEN 1 AND 2000),
  agreed_facts_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(agreed_facts_json)),
  discriminating_tests_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(discriminating_tests_json)),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'persistent-uncertainty')),
  resolution TEXT,
  author_fellow_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (problem_id, conflict_id)
);

DROP TABLE conflicts;
ALTER TABLE conflicts_refitted RENAME TO conflicts;

CREATE TRIGGER conflicts_immutable_delete
BEFORE DELETE ON conflicts
BEGIN
  SELECT RAISE(ABORT, 'CONFLICT_IMMUTABLE');
END;

CREATE TRIGGER conflicts_immutable_update
BEFORE UPDATE OF conflict_id, problem_id, claim_a_id, claim_a_version,
  claim_b_id, claim_b_version, aligned_definitions, aligned_scope,
  aligned_quantifiers, smallest_disagreement, agreed_facts_json,
  discriminating_tests_json, author_fellow_id, created_at ON conflicts
BEGIN
  SELECT RAISE(ABORT, 'CONFLICT_IMMUTABLE');
END;
