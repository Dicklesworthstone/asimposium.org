-- asimposium:allow-destructive
-- W5.8c Citations: literature objects L-n, versioning, locator canonicalization,
-- and session write replays scope.

-- 1. Widen session_write_replays to include 'citations' and 'correct_citation'
CREATE TABLE session_write_replays_widened (
  scope TEXT NOT NULL CHECK (scope IN (
    'session_open', 'workshop_push', 'promote', 'revise', 'reanchor', 'gaps',
    'relations', 'review', 'hypotheses', 'hypothesis-kill', 'evidence',
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

-- 2. Drop existing triggers on citations if any so we can refit
DROP TRIGGER IF EXISTS citations_immutable_delete;

-- 3. Refit citations table with complete attribution, versioning, norm_hash, and unanchored flag
CREATE TABLE citations_refitted (
  citation_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  seq INTEGER,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 1000),
  authors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(authors_json)),
  year INTEGER CHECK (year IS NULL OR (year >= 1500 AND year <= 2200)),
  locator_kind TEXT NOT NULL CHECK (locator_kind IN ('doi', 'arxiv', 'url', 'isbn', 'manual', 'model_memory')),
  locator TEXT,
  canonical_locator TEXT,
  excerpt TEXT CHECK (excerpt IS NULL OR length(excerpt) <= 1000),
  retrieved_at TEXT,
  source_provenance TEXT NOT NULL DEFAULT 'retrieved' CHECK (source_provenance IN ('retrieved', 'model_memory')),
  unanchored INTEGER NOT NULL DEFAULT 0 CHECK (unanchored IN (0, 1)),
  norm_hash TEXT NOT NULL DEFAULT '',
  author_fellow_id TEXT NOT NULL,
  declared_model TEXT,
  sponsor_id TEXT,
  session_id TEXT,
  harness TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  PRIMARY KEY (problem_id, citation_id)
);

INSERT INTO citations_refitted (
  citation_id, problem_id, version, seq, title, authors_json, year,
  locator_kind, locator, canonical_locator, excerpt, retrieved_at,
  source_provenance, unanchored, norm_hash, author_fellow_id, created_at
)
SELECT
  citation_id, problem_id, 1, NULL, title, '[]', year,
  locator_kind, locator, locator, NULL, retrieved_at,
  CASE WHEN locator_kind = 'model_memory' THEN 'model_memory' ELSE 'retrieved' END,
  0, citation_id, author_fellow_id, created_at
FROM citations;

DROP TABLE citations;
ALTER TABLE citations_refitted RENAME TO citations;

CREATE INDEX citations_norm_hash_idx ON citations (problem_id, norm_hash);

-- Prohibit deleting citations; negative literature knowledge is permanent
CREATE TRIGGER citations_immutable_delete BEFORE DELETE ON citations
BEGIN
  SELECT RAISE(ABORT, 'CITATION_IMMUTABLE');
END;

-- 4. Create citation_versions table to store immutable historical versions of each citation
CREATE TABLE citation_versions (
  citation_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  version INTEGER NOT NULL CHECK (version > 0),
  seq INTEGER NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 1000),
  authors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(authors_json)),
  year INTEGER CHECK (year IS NULL OR (year >= 1500 AND year <= 2200)),
  locator_kind TEXT NOT NULL CHECK (locator_kind IN ('doi', 'arxiv', 'url', 'isbn', 'manual', 'model_memory')),
  locator TEXT,
  canonical_locator TEXT,
  excerpt TEXT CHECK (excerpt IS NULL OR length(excerpt) <= 1000),
  retrieved_at TEXT,
  source_provenance TEXT NOT NULL CHECK (source_provenance IN ('retrieved', 'model_memory')),
  unanchored INTEGER NOT NULL DEFAULT 0 CHECK (unanchored IN (0, 1)),
  norm_hash TEXT NOT NULL,
  editor_fellow_id TEXT NOT NULL,
  declared_model TEXT NOT NULL,
  sponsor_id TEXT,
  session_id TEXT,
  harness TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, citation_id, version),
  FOREIGN KEY (problem_id, citation_id) REFERENCES citations(problem_id, citation_id)
);

CREATE INDEX citation_versions_problem_idx ON citation_versions (problem_id, citation_id, version);

CREATE TRIGGER citation_versions_immutable_update
BEFORE UPDATE ON citation_versions
BEGIN
  SELECT RAISE(ABORT, 'CITATION_VERSION_IMMUTABLE');
END;

CREATE TRIGGER citation_versions_immutable_delete
BEFORE DELETE ON citation_versions
BEGIN
  SELECT RAISE(ABORT, 'CITATION_VERSION_IMMUTABLE');
END;
