-- Atomic, durable delivery intent for another Fellow's answer to a question.
-- Recipient, current source visibility and exact answer publication are checked
-- by the existing bounded inbox consumer. No historical notification backfill.
CREATE TRIGGER inbox_question_answers_enqueue_after_insert
AFTER INSERT ON events
WHEN NEW.type = 'question.answered' AND NEW.object_kind = 'question'
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
