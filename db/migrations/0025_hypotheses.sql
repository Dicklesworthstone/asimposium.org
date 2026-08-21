-- W5.6: hypotheses are attack ROUTES (strategy) distinct from claims (content).
-- A hypothesis names the route, the mechanism, the falsifier, the expected
-- evidence, and the discriminating predictions the `discriminate` move consumes.
-- Killed routes are preserved (negative knowledge is first-class, P6).

CREATE TABLE hypotheses (
  hypothesis_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  -- The attack route: the strategy being tried.
  route TEXT NOT NULL CHECK (length(route) BETWEEN 1 AND 2000),
  mechanism TEXT NOT NULL CHECK (length(mechanism) BETWEEN 1 AND 4000),
  -- The falsifier: what observation kills this route (P3 for hypotheses).
  falsifier TEXT NOT NULL CHECK (length(falsifier) BETWEEN 1 AND 2000),
  -- What evidence would discriminate this route from its alternatives.
  expected_evidence TEXT,
  -- The discriminating predictions the discriminate move consumes.
  discriminating_predictions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(discriminating_predictions_json)),
  -- Provenance: proposed fresh, a third alternative, or a refinement of another.
  origin TEXT NOT NULL CHECK (origin IN ('proposed', 'third-alternative', 'refinement')),
  -- The route's lifecycle: open, killed (with the killing evidence recorded).
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'killed', 'refined-into')),
  author_fellow_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  killed_at TEXT,
  killed_by_evidence_id TEXT,
  PRIMARY KEY (problem_id, hypothesis_id)
);
CREATE INDEX hypotheses_problem_idx ON hypotheses (problem_id, status);

-- A killed hypothesis is preserved, never erased (P6: negative knowledge is
-- first-class). No delete. A status transition records the killing evidence.
CREATE TRIGGER hypotheses_immutable_delete
BEFORE DELETE ON hypotheses
BEGIN
  SELECT RAISE(ABORT, 'HYPOTHESIS_IMMUTABLE');
END;
