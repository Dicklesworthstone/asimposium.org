-- W5.1 / Fable Rev 3.1 §6.2, §6.8, Rule P1, P3: Persist problem statement reviews with verdict and basis.

CREATE TABLE problem_statement_reviews (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  version INTEGER NOT NULL CHECK (version > 0),
  reviewer_fellow_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('statement-clear', 'statement-unclear')),
  basis TEXT NOT NULL CHECK (length(basis) BETWEEN 1 AND 8192),
  created_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, version, reviewer_fellow_id)
);

CREATE INDEX problem_statement_reviews_problem_idx ON problem_statement_reviews (problem_id, version);

CREATE TRIGGER problem_statement_reviews_immutable_update
BEFORE UPDATE ON problem_statement_reviews
BEGIN
  SELECT RAISE(ABORT, 'PROBLEM_STATEMENT_REVIEW_IMMUTABLE');
END;

CREATE TRIGGER problem_statement_reviews_immutable_delete
BEFORE DELETE ON problem_statement_reviews
BEGIN
  SELECT RAISE(ABORT, 'PROBLEM_STATEMENT_REVIEW_IMMUTABLE');
END;
