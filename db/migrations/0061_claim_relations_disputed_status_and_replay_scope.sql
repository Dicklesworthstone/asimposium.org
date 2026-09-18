-- asimposium:allow-destructive
-- W5.5 Relation edge dispute lifecycle and replay scope (asimposiumorg-zlm)

-- 1. Widen session_write_replays to include 'dispute_relation'
CREATE TABLE session_write_replays_widened (
  scope TEXT NOT NULL CHECK (scope IN (
    'session_open', 'workshop_push', 'promote', 'revise', 'reanchor', 'gaps',
    'relations', 'dispute_relation', 'review', 'hypotheses', 'hypothesis-kill', 'evidence',
    'synthesize', 'dead_end', 'ask_question', 'lease_question', 'answer_question',
    'withdraw_question', 'retract', 'conflicts', 'resolve_conflict',
    'acquire_lease', 'release_lease', 'challenge_lease', 'session_close', 'session_heartbeat',
    'events_batch', 'citations', 'correct_citation'
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

-- 2. Widen claim_relations to allow status IN ('asserted', 'disputed') and record dispute attribution
CREATE TABLE claim_relations_widened (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  kind TEXT NOT NULL CHECK (
    kind IN (
      'implies', 'equivalent-to', 'contradicts',
      'narrows', 'generalizes', 'uses-definition', 'addresses-gap'
    )
  ),
  source_claim_id TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  target_ref TEXT NOT NULL CHECK (
    target_ref GLOB 'C-*@*' OR target_ref GLOB 'G-[0-9]*'
  ),
  status TEXT NOT NULL DEFAULT 'asserted' CHECK (status IN ('asserted', 'disputed')),
  asserted_by_event TEXT NOT NULL,
  asserted_by_fellow TEXT NOT NULL,
  created_at TEXT NOT NULL,
  disputed_by_event TEXT,
  disputed_by_fellow TEXT,
  disputed_at TEXT,
  PRIMARY KEY (
    problem_id, kind, source_claim_id, source_version, target_ref
  ),
  CHECK (
    kind = 'addresses-gap'
    OR source_claim_id != substr(target_ref, 1, instr(target_ref, '@') - 1)
  ),
  FOREIGN KEY (problem_id, source_claim_id) REFERENCES claims(problem_id, id)
);

INSERT INTO claim_relations_widened (
  problem_id, kind, source_claim_id, source_version, target_ref,
  status, asserted_by_event, asserted_by_fellow, created_at,
  disputed_by_event, disputed_by_fellow, disputed_at
)
SELECT
  problem_id, kind, source_claim_id, source_version, target_ref,
  status, asserted_by_event, asserted_by_fellow, created_at,
  NULL, NULL, NULL
FROM claim_relations;

DROP TABLE claim_relations;
ALTER TABLE claim_relations_widened RENAME TO claim_relations;

CREATE INDEX claim_relations_problem_idx ON claim_relations (problem_id);
