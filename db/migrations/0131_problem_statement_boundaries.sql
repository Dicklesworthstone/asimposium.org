-- Fable §6.1: a versioned problem can carry an explicit research boundary.
-- NULL means a legacy formulation never recorded the bundle, not empty text.
ALTER TABLE problem_statement_versions ADD COLUMN scope TEXT
  CHECK (scope IS NULL OR length(scope) BETWEEN 1 AND 4096);
ALTER TABLE problem_statement_versions ADD COLUMN out_of_scope TEXT
  CHECK (out_of_scope IS NULL OR length(out_of_scope) BETWEEN 1 AND 4096);
ALTER TABLE problem_statement_versions ADD COLUMN success_criteria TEXT
  CHECK (success_criteria IS NULL OR length(success_criteria) BETWEEN 1 AND 4096);

ALTER TABLE sponsor_problem_briefs ADD COLUMN scope TEXT
  CHECK (scope IS NULL OR length(scope) BETWEEN 1 AND 4096);
ALTER TABLE sponsor_problem_briefs ADD COLUMN out_of_scope TEXT
  CHECK (out_of_scope IS NULL OR length(out_of_scope) BETWEEN 1 AND 4096);
ALTER TABLE sponsor_problem_briefs ADD COLUMN success_criteria TEXT
  CHECK (success_criteria IS NULL OR length(success_criteria) BETWEEN 1 AND 4096);

CREATE TRIGGER problem_statement_boundary_bundle_insert
BEFORE INSERT ON problem_statement_versions
WHEN (NEW.scope IS NULL) + (NEW.out_of_scope IS NULL) + (NEW.success_criteria IS NULL) NOT IN (0, 3)
BEGIN
  SELECT RAISE(ABORT, 'PROBLEM_BOUNDARY_BUNDLE_INCOMPLETE');
END;

-- An old client cannot remove boundaries merely by omitting the new fields.
-- Earlier historical versions may still be reconstructed in any replay order.
CREATE TRIGGER problem_statement_boundaries_preserved
BEFORE INSERT ON problem_statement_versions
WHEN NEW.scope IS NULL AND NEW.out_of_scope IS NULL AND NEW.success_criteria IS NULL
  AND EXISTS (SELECT 1 FROM problem_statement_versions previous
    WHERE previous.problem_id = NEW.problem_id AND previous.version < NEW.version
      AND previous.scope IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'PROBLEM_BOUNDARIES_REQUIRED');
END;

-- The existing all-column immutable UPDATE trigger also protects these new
-- version bytes. Its lawful private-erasure DELETE exception stays untouched.
CREATE TRIGGER sponsor_problem_boundary_bundle_insert
BEFORE INSERT ON sponsor_problem_briefs
WHEN (NEW.scope IS NULL) + (NEW.out_of_scope IS NULL) + (NEW.success_criteria IS NULL) NOT IN (0, 3)
BEGIN
  SELECT RAISE(ABORT, 'PROBLEM_BOUNDARY_BUNDLE_INCOMPLETE');
END;

CREATE TRIGGER sponsor_problem_boundary_bundle_update
BEFORE UPDATE OF scope, out_of_scope, success_criteria ON sponsor_problem_briefs
WHEN (NEW.scope IS NULL) + (NEW.out_of_scope IS NULL) + (NEW.success_criteria IS NULL) NOT IN (0, 3)
BEGIN
  SELECT RAISE(ABORT, 'PROBLEM_BOUNDARY_BUNDLE_INCOMPLETE');
END;

CREATE TRIGGER sponsor_problem_boundaries_preserved
BEFORE UPDATE OF scope, out_of_scope, success_criteria ON sponsor_problem_briefs
WHEN OLD.scope IS NOT NULL AND NEW.scope IS NULL
BEGIN
  SELECT RAISE(ABORT, 'PROBLEM_BOUNDARIES_REQUIRED');
END;
