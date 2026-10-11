-- asimposium:allow-destructive
-- The workshop head is a mutable projection over immutable private revisions.
-- 0057 retained the older guard that froze revision_json on the head itself,
-- preventing a corrected typed replacement from becoming the current draft.
-- Reconcile only from the already-recorded current immutable version, then
-- permit a new payload only with the next version, a new cursor and retained
-- prior history. The application appends the new revision in the same batch.
DROP TRIGGER workshop_revision_immutable;

UPDATE workshop_objects
SET revision_json = (
  SELECT r.revision_json FROM workshop_revisions r
  WHERE r.workshop_id = workshop_objects.workshop_id
    AND r.version = workshop_objects.current_version
    AND r.problem_id = workshop_objects.problem_id
    AND r.fellow_id = workshop_objects.fellow_id
)
WHERE EXISTS (
  SELECT 1 FROM workshop_revisions r
  WHERE r.workshop_id = workshop_objects.workshop_id
    AND r.version = workshop_objects.current_version
    AND r.problem_id = workshop_objects.problem_id
    AND r.fellow_id = workshop_objects.fellow_id
    AND r.revision_json IS NOT workshop_objects.revision_json
);

CREATE TRIGGER workshop_revision_immutable
BEFORE UPDATE ON workshop_objects
WHEN NEW.workshop_id IS NOT OLD.workshop_id
  OR NEW.fellow_id IS NOT OLD.fellow_id
  OR NEW.session_id IS NOT OLD.session_id
  OR NEW.problem_id IS NOT OLD.problem_id
  OR (
    NEW.revision_json IS NOT OLD.revision_json
    AND (
      NEW.current_version IS NOT OLD.current_version + 1
      OR NEW.workshop_seq <= OLD.workshop_seq
      OR NOT EXISTS (
        SELECT 1 FROM workshop_revisions r
        WHERE r.workshop_id = OLD.workshop_id
          AND r.version = OLD.current_version
          AND r.problem_id = OLD.problem_id
          AND r.fellow_id = OLD.fellow_id
          AND r.revision_json IS OLD.revision_json
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'WORKSHOP_REVISION_IMMUTABLE');
END;
