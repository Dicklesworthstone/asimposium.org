-- asimposium:allow-destructive
-- W5 correctness: the review, hypothesis, hypothesis-kill, and evidence
-- routes now use the same 24-hour sealed replay and Krater event transaction
-- as claims, gaps, and relations. Existing replay ciphertext is copied byte
-- for byte; only the closed scope vocabulary widens.

CREATE TABLE session_write_replays_widened (
  scope TEXT NOT NULL CHECK (
    scope IN (
      'session_open', 'workshop_push', 'promote', 'revise', 'gaps',
      'relations', 'review', 'hypotheses', 'hypothesis-kill', 'evidence',
      'session_close'
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

-- These object tables are projections of their immutable ledger events. New
-- rows bind the exact event and public cursor that produced them; NULL is
-- retained only for pre-migration rows whose missing event is historical debt.
ALTER TABLE reviews ADD COLUMN source_event_id TEXT;
ALTER TABLE reviews ADD COLUMN source_seq INTEGER CHECK (source_seq IS NULL OR source_seq > 0);
CREATE UNIQUE INDEX reviews_source_event_idx
  ON reviews (source_event_id) WHERE source_event_id IS NOT NULL;
CREATE UNIQUE INDEX reviews_source_seq_idx
  ON reviews (problem_id, source_seq) WHERE source_seq IS NOT NULL;

ALTER TABLE hypotheses ADD COLUMN body_md TEXT
  CHECK (body_md IS NULL OR length(body_md) BETWEEN 1 AND 65536);
ALTER TABLE hypotheses ADD COLUMN source_event_id TEXT;
ALTER TABLE hypotheses ADD COLUMN source_seq INTEGER CHECK (source_seq IS NULL OR source_seq > 0);
ALTER TABLE hypotheses ADD COLUMN kill_reason TEXT
  CHECK (kill_reason IS NULL OR length(kill_reason) BETWEEN 1 AND 2000);
ALTER TABLE hypotheses ADD COLUMN kill_event_id TEXT;
ALTER TABLE hypotheses ADD COLUMN kill_source_seq INTEGER
  CHECK (kill_source_seq IS NULL OR kill_source_seq > 0);
CREATE UNIQUE INDEX hypotheses_source_event_idx
  ON hypotheses (source_event_id) WHERE source_event_id IS NOT NULL;
CREATE UNIQUE INDEX hypotheses_source_seq_idx
  ON hypotheses (problem_id, source_seq) WHERE source_seq IS NOT NULL;
CREATE UNIQUE INDEX hypotheses_kill_event_idx
  ON hypotheses (kill_event_id) WHERE kill_event_id IS NOT NULL;
CREATE UNIQUE INDEX hypotheses_kill_seq_idx
  ON hypotheses (problem_id, kill_source_seq) WHERE kill_source_seq IS NOT NULL;

ALTER TABLE evidence ADD COLUMN source_event_id TEXT;
ALTER TABLE evidence ADD COLUMN source_seq INTEGER CHECK (source_seq IS NULL OR source_seq > 0);
CREATE UNIQUE INDEX evidence_source_event_idx
  ON evidence (source_event_id) WHERE source_event_id IS NOT NULL;
CREATE UNIQUE INDEX evidence_source_seq_idx
  ON evidence (problem_id, source_seq) WHERE source_seq IS NOT NULL;
