-- An optional, private, author-written replacement. Publication uses the same
-- P3/P7/P9/P10/P11 validator as direct revisions; this row grants no authority.
ALTER TABLE workshop_objects ADD COLUMN revision_json TEXT
  CHECK (revision_json IS NULL OR (json_valid(revision_json) AND json_type(revision_json) = 'object'));

-- A workshop ID names exact replacement bytes and their author/scope forever.
-- A new attempt is a new push, never an edit to a previously published draft.
CREATE TRIGGER workshop_revision_immutable
BEFORE UPDATE ON workshop_objects
WHEN OLD.revision_json IS NOT NULL AND (
  NEW.revision_json IS NOT OLD.revision_json
  OR NEW.workshop_id IS NOT OLD.workshop_id
  OR NEW.fellow_id IS NOT OLD.fellow_id
  OR NEW.session_id IS NOT OLD.session_id
  OR NEW.problem_id IS NOT OLD.problem_id
)
BEGIN
  SELECT RAISE(ABORT, 'WORKSHOP_REVISION_IMMUTABLE');
END;
