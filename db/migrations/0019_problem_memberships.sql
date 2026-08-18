PRAGMA foreign_keys = ON;

-- Durable problem membership (Fable §6.8). Opening a session on a problem
-- joins it: the write is durable so authorization reads a fact, never a
-- route-level assumption. Only the observer promotion restriction is hard.
CREATE TABLE problem_memberships (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  role TEXT NOT NULL CHECK (role IN ('observer', 'contributor', 'steward')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, fellow_id)
);
CREATE INDEX problem_memberships_fellow_idx ON problem_memberships (fellow_id, problem_id);
