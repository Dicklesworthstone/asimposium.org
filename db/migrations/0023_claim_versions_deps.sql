-- W5.3: the claim is the atomic reviewable unit, version-pinned so no edit
-- silently strengthens (P9) and dependencies form a DAG (P10).
--
-- claim_versions: every edit mints @n+1 with a content digest and RESETS
-- disposition to open. The row is immutable — a version, once written, is the
-- permanent record a review pins (C-n@v).
--
-- claim_deps: the depends_on edges. The DAG is enforced at write by the
-- batch planner (P10 cycle refusal); this table records the edges.

CREATE TABLE claim_versions (
  claim_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  version INTEGER NOT NULL CHECK (version > 0),
  -- The claim-kind vocabulary is the contracts ClaimKindSchema; the validator
  -- owns the conjecture-class falsifier requirement (P3), so the schema admits
  -- a missing falsifier and the route refuses it with the teaching citation.
  kind TEXT NOT NULL,
  statement TEXT NOT NULL CHECK (length(statement) BETWEEN 1 AND 8192),
  falsifier TEXT,
  -- The content digest of this exact version (statement + falsifier + kind), so
  -- a review's pin is verifiable and a drift is detectable.
  content_digest TEXT NOT NULL CHECK (content_digest GLOB 'sha256:[0-9a-f]*'),
  -- The Fellow who minted this version (the author on v1; the editor after).
  editor_fellow_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (claim_id, version)
);
CREATE INDEX claim_versions_problem_idx ON claim_versions (problem_id, claim_id, version);

-- Immutability: a version is the permanent record. No update, no delete.
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

-- The depends_on edges. The DAG invariant (P10) is enforced at write time by
-- the batch planner's topological check; the table records the resolved edges
-- with the server's permanent claim ids (client temp ids never persist).
CREATE TABLE claim_deps (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  claim_id TEXT NOT NULL,
  depends_on_claim_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (claim_id, depends_on_claim_id),
  CHECK (claim_id != depends_on_claim_id),
  FOREIGN KEY (claim_id, problem_id) REFERENCES claim_versions(claim_id, problem_id)
);
CREATE INDEX claim_deps_problem_idx ON claim_deps (problem_id, claim_id);

-- Dependencies are append-only (a published dependency is load-bearing; removing
-- it would silently weaken a dependent claim).
CREATE TRIGGER claim_deps_immutable_delete
BEFORE DELETE ON claim_deps
BEGIN
  SELECT RAISE(ABORT, 'CLAIM_DEP_IMMUTABLE');
END;
