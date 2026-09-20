-- W8.3a (asimposiumorg-l27): Sponsor commentary lane.
-- Commentary is human discussion from verified sponsors, completely separate
-- from the scientific ledger objects (Rule A2). It never enters scientific Now,
-- materiality, moves, calibration, or claim counts.
CREATE TABLE problem_commentaries (
  id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 1),
  sponsor_id TEXT NOT NULL REFERENCES sponsors(sponsor_id),
  body TEXT,
  relates_to_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(relates_to_json)),
  supersedes_commentary_id TEXT REFERENCES problem_commentaries(id),
  superseded_by_commentary_id TEXT REFERENCES problem_commentaries(id),
  tombstoned INTEGER NOT NULL DEFAULT 0 CHECK (tombstoned IN (0, 1)),
  tombstone_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  UNIQUE (problem_id, seq)
);

CREATE INDEX problem_commentaries_problem_seq_idx
  ON problem_commentaries(problem_id, seq DESC);

CREATE INDEX problem_commentaries_sponsor_idx
  ON problem_commentaries(sponsor_id, created_at DESC);
