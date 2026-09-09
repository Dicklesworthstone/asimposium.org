-- W5.1 / Fable Rev 3.1 §6.2, §6.8, Rule P3: Problem lifecycle, statement monotonicity, and sponsor briefs.

ALTER TABLE problems ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('private-draft', 'sharpening', 'active', 'dormant', 'under-result-review', 'resolved', 'retired'));
ALTER TABLE problems ADD COLUMN unlisted INTEGER NOT NULL DEFAULT 0 CHECK (unlisted IN (0, 1));
ALTER TABLE problems ADD COLUMN sponsor_id TEXT;
ALTER TABLE problems ADD COLUMN created_by_fellow_id TEXT;
ALTER TABLE problems ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE problems ADD COLUMN current_statement_version INTEGER NOT NULL DEFAULT 1 CHECK (current_statement_version > 0);
ALTER TABLE problems ADD COLUMN resolution_direction TEXT CHECK (resolution_direction IS NULL OR resolution_direction IN ('affirmed', 'refuted-as-stated', 'closed-with-negative-result'));
ALTER TABLE problems ADD COLUMN resolution_summary TEXT;
ALTER TABLE problems ADD COLUMN resolution_no_claim_boundary TEXT;
ALTER TABLE problems ADD COLUMN famous_guardrail TEXT;

ALTER TABLE claims ADD COLUMN statement_version INTEGER NOT NULL DEFAULT 1 CHECK (statement_version > 0);
ALTER TABLE claims ADD COLUMN statement_drift INTEGER NOT NULL DEFAULT 0 CHECK (statement_drift IN (0, 1));

CREATE TABLE problem_statement_versions (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  version INTEGER NOT NULL CHECK (version > 0),
  statement TEXT NOT NULL CHECK (length(statement) BETWEEN 1 AND 8192),
  norm_hash TEXT NOT NULL,
  falsifier TEXT NOT NULL CHECK (length(falsifier) BETWEEN 1 AND 8192),
  motivation TEXT NOT NULL CHECK (length(motivation) BETWEEN 1 AND 8192),
  steward_accepted_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, version)
);

CREATE INDEX problem_statement_versions_problem_idx ON problem_statement_versions (problem_id, version);

CREATE TRIGGER problem_statement_versions_immutable_update
BEFORE UPDATE ON problem_statement_versions
BEGIN
  SELECT RAISE(ABORT, 'PROBLEM_STATEMENT_VERSION_IMMUTABLE');
END;

CREATE TRIGGER problem_statement_versions_immutable_delete
BEFORE DELETE ON problem_statement_versions
BEGIN
  SELECT RAISE(ABORT, 'PROBLEM_STATEMENT_VERSION_IMMUTABLE');
END;

CREATE TABLE sponsor_problem_briefs (
  id TEXT PRIMARY KEY,
  sponsor_id TEXT NOT NULL,
  assigned_fellow_id TEXT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  statement TEXT NOT NULL CHECK (length(statement) BETWEEN 1 AND 8192),
  falsifier TEXT NOT NULL CHECK (length(falsifier) BETWEEN 1 AND 8192),
  motivation TEXT NOT NULL CHECK (length(motivation) BETWEEN 1 AND 8192),
  areas TEXT NOT NULL DEFAULT '[]',
  famous_guardrail TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn', 'adopted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX sponsor_problem_briefs_sponsor_idx ON sponsor_problem_briefs (sponsor_id, status);
CREATE INDEX sponsor_problem_briefs_fellow_idx ON sponsor_problem_briefs (assigned_fellow_id, status);
