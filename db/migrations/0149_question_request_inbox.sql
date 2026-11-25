-- Asking an object-level question must reach the referenced authors as well as
-- remain on the public question board. Delivery resolves bounded references
-- from the immutable question and rechecks current controls in its transaction.
-- No historical backfill: only newly published questions create delivery work.
CREATE TRIGGER inbox_question_requests_enqueue_after_insert
AFTER INSERT ON events
WHEN NEW.type = 'question.asked' AND NEW.object_kind = 'question'
  AND NEW.object_version = 1
  AND EXISTS (SELECT 1 FROM problems p WHERE p.id = NEW.problem_id
    AND p.status <> 'private-draft')
BEGIN
  INSERT INTO inbox_event_deliveries (event_id, queued_at, updated_at)
  VALUES (NEW.id,
    CAST(unixepoch('subsec') * 1000 AS INTEGER),
    CAST(unixepoch('subsec') * 1000 AS INTEGER))
  ON CONFLICT (event_id) DO NOTHING;
END;
