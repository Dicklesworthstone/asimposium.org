-- asimposium:allow-destructive
-- The UPSERT updates only a delivery generation, as in migration 0157. No
-- scientific event, content byte or private workshop state is modified.
-- Object hides/restorations change public readers without advancing the
-- scientific event cursor. Wake the existing room with a delivery generation
-- only; its current public_seq and visibility remain authoritative. The
-- separate whole-problem trigger from 0157 still evicts hidden scopes.
CREATE TRIGGER herald_room_object_control_insert
AFTER INSERT ON content_controls
WHEN NEW.target_ref <> 'problem'
  AND NEW.version = (
    SELECT MAX(version) FROM content_controls
    WHERE problem_id = NEW.problem_id AND target_ref = NEW.target_ref
  )
  AND NEW.visibility IS NOT COALESCE((
    SELECT visibility FROM content_controls
    WHERE problem_id = NEW.problem_id AND target_ref = NEW.target_ref
      AND version < NEW.version
    ORDER BY version DESC LIMIT 1
  ), 'visible')
  AND EXISTS (
    SELECT 1 FROM problems p WHERE p.id = NEW.problem_id
      AND p.status <> 'private-draft' AND p.public_seq > 0
  )
BEGIN
  INSERT INTO herald_room_outbox(problem_id, generation, requested_at)
  VALUES (NEW.problem_id, 1, CAST(strftime('%s','now') AS INTEGER) * 1000)
  ON CONFLICT(problem_id) DO UPDATE SET generation = generation + 1,
    requested_at = excluded.requested_at, retry_at = 0, attempts = 0;
END;
