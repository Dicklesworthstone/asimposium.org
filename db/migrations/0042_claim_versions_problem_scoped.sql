-- asimposium:allow-destructive
-- W5.3 / Fable Rev 3.1 §6.1: public claim identifiers are problem-scoped
-- (C-1 in problem A is distinct from C-1 in problem B). Migration 0021 made
-- claims and claim_projections composite-keyed on (problem_id, id).
-- Migration 0023 introduced claim_versions with PRIMARY KEY (claim_id, version)
-- and claim_deps with PRIMARY KEY (claim_id, depends_on_claim_id),
-- which prevented more than one problem from ever storing a claim with the same id.
-- Rebuild claim_versions with PRIMARY KEY (problem_id, claim_id, version) and
-- claim_deps with PRIMARY KEY (problem_id, claim_id, depends_on_claim_id).

CREATE TABLE claim_versions_scoped (
  claim_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  version INTEGER NOT NULL CHECK (version > 0),
  kind TEXT NOT NULL,
  statement TEXT NOT NULL CHECK (length(statement) BETWEEN 1 AND 8192),
  falsifier TEXT,
  content_digest TEXT NOT NULL CHECK (content_digest GLOB 'sha256:[0-9a-f]*'),
  editor_fellow_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, claim_id, version),
  FOREIGN KEY (problem_id, claim_id) REFERENCES claims(problem_id, id)
);

INSERT INTO claim_versions_scoped (
  claim_id, problem_id, version, kind, statement, falsifier, content_digest, editor_fellow_id, created_at
)
SELECT claim_id, problem_id, version, kind, statement, falsifier, content_digest, editor_fellow_id, created_at
FROM claim_versions;

DROP TABLE claim_versions;
ALTER TABLE claim_versions_scoped RENAME TO claim_versions;

CREATE INDEX claim_versions_problem_idx ON claim_versions (problem_id, claim_id, version);

CREATE TRIGGER claim_versions_immutable_update
BEFORE UPDATE ON claim_versions
BEGIN
  SELECT RAISE(ABORT, 'CLAIM_VERSION_IMMUTABLE');
END;

CREATE TRIGGER claim_versions_immutable_delete
BEFORE DELETE ON claim_versions
BEGIN
  SELECT RAISE(ABORT, 'CLAIM_VERSION_IMMUTABLE');
END;

CREATE TABLE claim_deps_scoped (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  claim_id TEXT NOT NULL,
  depends_on_claim_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, claim_id, depends_on_claim_id),
  CHECK (claim_id != depends_on_claim_id),
  FOREIGN KEY (problem_id, claim_id) REFERENCES claims(problem_id, id),
  FOREIGN KEY (problem_id, depends_on_claim_id) REFERENCES claims(problem_id, id)
);

INSERT INTO claim_deps_scoped (
  problem_id, claim_id, depends_on_claim_id, created_at
)
SELECT problem_id, claim_id, depends_on_claim_id, created_at
FROM claim_deps;

DROP TABLE claim_deps;
ALTER TABLE claim_deps_scoped RENAME TO claim_deps;

CREATE INDEX claim_deps_problem_idx ON claim_deps (problem_id, claim_id);

CREATE TRIGGER claim_deps_immutable_delete
BEFORE DELETE ON claim_deps
BEGIN
  SELECT RAISE(ABORT, 'CLAIM_DEP_IMMUTABLE');
END;
