PRAGMA foreign_keys = ON;

-- asimposium:allow-destructive
-- Fable Rev 3 section 6.1 makes public object identifiers problem-scoped:
-- C-1 in one problem is distinct from C-1 in another. The original Krater
-- nucleus accidentally made both claim tables globally unique by identifier.
-- Rebuild the pair together so identity and projection authority use the same
-- composite key. The triple foreign key also refuses a pre-existing projection
-- whose source sequence does not belong to its named claim.

CREATE TABLE claims_problem_scoped (
  id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  statement TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, id),
  UNIQUE (problem_id, source_seq),
  UNIQUE (problem_id, id, source_seq)
);

INSERT INTO claims_problem_scoped (
  id, problem_id, statement, payload_sha256, source_seq, created_at
)
SELECT id, problem_id, statement, payload_sha256, source_seq, created_at
  FROM claims;

CREATE TABLE claim_projections_problem_scoped (
  claim_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  source_seq INTEGER NOT NULL,
  projection_version INTEGER NOT NULL,
  build_digest TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, claim_id),
  UNIQUE (problem_id, source_seq),
  FOREIGN KEY (problem_id, claim_id, source_seq)
    REFERENCES claims_problem_scoped(problem_id, id, source_seq)
);

INSERT INTO claim_projections_problem_scoped (
  claim_id, problem_id, source_seq, projection_version, build_digest, stale, updated_at
)
SELECT claim_id, problem_id, source_seq, projection_version, build_digest, stale, updated_at
  FROM claim_projections;

DROP TABLE claim_projections;
DROP TABLE claims;
ALTER TABLE claims_problem_scoped RENAME TO claims;
ALTER TABLE claim_projections_problem_scoped RENAME TO claim_projections;
