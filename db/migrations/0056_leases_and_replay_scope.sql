-- asimposium:allow-destructive
-- W4.4 Leases: coordination without ownership (Fable §7.5).

CREATE TABLE session_write_replays_widened (
  scope TEXT NOT NULL CHECK (
    scope IN (
      'session_open', 'workshop_push', 'promote', 'revise', 'reanchor', 'gaps',
      'relations', 'review', 'hypotheses', 'hypothesis-kill', 'evidence',
      'synthesize', 'dead_end', 'ask_question', 'lease_question', 'answer_question',
      'withdraw_question', 'retract', 'conflicts', 'resolve_conflict',
      'acquire_lease', 'release_lease', 'challenge_lease', 'session_close'
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

-- Leases on public objects (claims, hypotheses, proof gaps, questions).
-- Exclusive leases prevent colliding promotion; parallel-safe leases invite replication.
CREATE TABLE leases (
  lease_id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  object_ref TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('claim', 'hypothesis', 'proof_gap', 'question')),
  object_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  fellow_id TEXT NOT NULL REFERENCES fellows(id),
  sponsor_id TEXT NOT NULL,
  objective TEXT NOT NULL CHECK (length(objective) BETWEEN 1 AND 2000),
  deliverable TEXT NOT NULL CHECK (length(deliverable) BETWEEN 1 AND 2000),
  parallel_safe INTEGER NOT NULL DEFAULT 0 CHECK (parallel_safe IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired', 'challenged', 'abandoned')),
  challenge_reason TEXT CHECK (challenge_reason IS NULL OR length(challenge_reason) <= 2000),
  challenged_by_fellow_id TEXT REFERENCES fellows(id),
  challenged_at TEXT,
  released_by TEXT,
  released_at TEXT,
  leased_at TEXT NOT NULL,
  leased_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX leases_problem_object_status_idx ON leases (problem_id, object_ref, status);
CREATE INDEX leases_session_status_idx ON leases (session_id, status);
CREATE INDEX leases_fellow_status_idx ON leases (fellow_id, status);
CREATE INDEX leases_leased_until_idx ON leases (leased_until);
