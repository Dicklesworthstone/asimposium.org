-- W5.2 Problem governance: stewards, admission modes, merge, and fork (ADR-22, Fable §6.8).

-- 1. Extend problems with governance columns
ALTER TABLE problems ADD COLUMN admission_mode TEXT NOT NULL DEFAULT 'open'
  CHECK (admission_mode IN ('open', 'approval-required', 'invite-only', 'archived-read-only'));

ALTER TABLE problems ADD COLUMN canonical_problem_id TEXT REFERENCES problems(id);

ALTER TABLE problems ADD COLUMN forked_from_problem_id TEXT REFERENCES problems(id);

ALTER TABLE problems ADD COLUMN forked_from_cursor INTEGER CHECK (forked_from_cursor IS NULL OR forked_from_cursor >= 0);

ALTER TABLE problems ADD COLUMN writer_cap INTEGER CHECK (writer_cap IS NULL OR writer_cap > 0);

-- 2. Problem stewards table (transferable and shareable stewardship)
CREATE TABLE problem_stewards (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  sponsor_id TEXT NOT NULL,
  is_founding INTEGER NOT NULL DEFAULT 0 CHECK (is_founding IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, sponsor_id)
);

CREATE INDEX problem_stewards_sponsor_idx ON problem_stewards (sponsor_id, problem_id);

-- Backfill founding stewards from existing problems.sponsor_id
INSERT INTO problem_stewards (problem_id, sponsor_id, is_founding, created_at)
SELECT id, sponsor_id, 1, created_at
FROM problems
WHERE sponsor_id IS NOT NULL;

-- 3. Problem merges table (preserving both IDs and histories, recording claim mapping)
CREATE TABLE problem_merges (
  problem_id TEXT PRIMARY KEY REFERENCES problems(id),
  canonical_problem_id TEXT NOT NULL REFERENCES problems(id),
  claim_mapping_json TEXT NOT NULL DEFAULT '{}',
  merged_by_sponsor_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX problem_merges_canonical_idx ON problem_merges (canonical_problem_id);

-- 4. Problem forks table (recording parent ID and parent cursor)
CREATE TABLE problem_forks (
  problem_id TEXT PRIMARY KEY REFERENCES problems(id),
  parent_problem_id TEXT NOT NULL REFERENCES problems(id),
  parent_cursor INTEGER NOT NULL CHECK (parent_cursor >= 0),
  forked_by_sponsor_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX problem_forks_parent_idx ON problem_forks (parent_problem_id);
