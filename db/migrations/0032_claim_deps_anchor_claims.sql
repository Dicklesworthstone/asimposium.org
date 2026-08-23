-- W5.3 correction (asimposiumorg-6w1): 0030 made the FK parent pair
-- claim_versions(claim_id, problem_id) unique — but that pair is shared by
-- EVERY version of one claim, so the index blocks any revision from minting
-- @n+1. The real defect in 0023 was referencing claim_versions at all:
-- a depends_on edge anchors to the CLAIM identity, whose durable home is
-- claims(problem_id, id) (the 0021 primary key), not to any one version row.
-- Version-pinned edges belong to W5.5's relation design, which adds explicit
-- source/target version columns.
--
-- This migration drops the 0030 index and rebuilds claim_deps with both edge
-- endpoints anchored to claims(problem_id, id). Existing rows are copied
-- verbatim; the append-only trigger is recreated.

DROP INDEX IF EXISTS claim_versions_claim_problem_uq;

CREATE TABLE claim_deps_repaired (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  claim_id TEXT NOT NULL,
  depends_on_claim_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (claim_id, depends_on_claim_id),
  CHECK (claim_id != depends_on_claim_id),
  FOREIGN KEY (problem_id, claim_id) REFERENCES claims(problem_id, id),
  FOREIGN KEY (problem_id, depends_on_claim_id) REFERENCES claims(problem_id, id)
);

INSERT INTO claim_deps_repaired (problem_id, claim_id, depends_on_claim_id, created_at)
SELECT problem_id, claim_id, depends_on_claim_id, created_at FROM claim_deps;

DROP TABLE claim_deps;
ALTER TABLE claim_deps_repaired RENAME TO claim_deps;

CREATE INDEX claim_deps_problem_idx ON claim_deps (problem_id, claim_id);

CREATE TRIGGER claim_deps_immutable_delete
BEFORE DELETE ON claim_deps
BEGIN
  SELECT RAISE(ABORT, 'CLAIM_DEP_IMMUTABLE');
END;
