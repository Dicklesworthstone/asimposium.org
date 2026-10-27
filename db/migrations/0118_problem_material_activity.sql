-- Fable §§6.2/9.6: process traffic cannot keep an abandoned problem active.
-- This rebuildable clock is indexed so the cron never loads an entire ledger
-- to discover the next quiet problem. Event time, not mutable updated_at, wins.
ALTER TABLE problems ADD COLUMN last_material_at TEXT;
ALTER TABLE problems ADD COLUMN last_material_event_id TEXT REFERENCES events(id);

UPDATE problems SET last_material_event_id = (
  SELECT e.id FROM events e LEFT JOIN event_content c ON c.event_id = e.id
  WHERE e.problem_id = problems.id AND julianday(e.created_at) IS NOT NULL AND (
    e.type IN ('claim.created', 'claim.revised', 'evidence.created', 'review.created',
      'hypothesis.killed', 'problem.admitted')
    OR (e.type = 'dead_end.recorded'
      AND instr(COALESCE(c.payload_json, ''), 'low-substance-dead-end') = 0)
    OR (e.type IN ('problem.statement-reviewed', 'problem.statement-revised', 'problem.statement-updated')
      AND json_valid(c.payload_json)
      AND json_extract(c.payload_json, '$.previous_status') = 'sharpening')
  ) ORDER BY julianday(e.created_at) DESC, e.seq DESC LIMIT 1
);
UPDATE problems SET last_material_at = COALESCE(
  (SELECT strftime('%Y-%m-%dT%H:%M:%fZ', e.created_at) FROM events e
    WHERE e.id = problems.last_material_event_id),
  strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
);

CREATE INDEX problems_material_quiet_idx ON problems(status, last_material_at, id);

CREATE TRIGGER problem_activity_initial_clock AFTER INSERT ON problems
BEGIN
  UPDATE problems SET last_material_at = strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at)
    WHERE id = NEW.id;
END;

-- event_content is inserted inside the same Krater transaction as its event,
-- source projection, checkpoint, outbox and replay receipt. A failed write
-- therefore neither resets the clock nor wakes a dormant problem. A replay
-- inserts no new event_content and has no second activation effect.
CREATE TRIGGER problem_activity_material_content AFTER INSERT ON event_content
WHEN EXISTS (
  SELECT 1 FROM events e JOIN problems p ON p.id = e.problem_id
  WHERE e.id = NEW.event_id AND e.payload_sha256 = NEW.payload_sha256
    AND julianday(e.created_at) IS NOT NULL AND (
      e.type IN ('claim.created', 'claim.revised', 'evidence.created', 'review.created',
        'hypothesis.killed', 'problem.admitted')
      OR (e.type = 'dead_end.recorded'
        AND instr(NEW.payload_json, 'low-substance-dead-end') = 0)
      OR (e.type IN ('problem.statement-reviewed', 'problem.statement-revised', 'problem.statement-updated')
        AND p.status = 'sharpening')
    )
)
BEGIN
  UPDATE problems SET
    last_material_event_id = CASE
      WHEN last_material_event_id IS NULL OR last_material_at IS NULL OR julianday((SELECT created_at FROM events WHERE id = NEW.event_id)) >= julianday(last_material_at)
      THEN NEW.event_id ELSE last_material_event_id END,
    last_material_at = CASE
      WHEN last_material_event_id IS NULL OR last_material_at IS NULL OR julianday((SELECT created_at FROM events WHERE id = NEW.event_id)) >= julianday(last_material_at)
      THEN (SELECT strftime('%Y-%m-%dT%H:%M:%fZ', created_at) FROM events WHERE id = NEW.event_id)
      ELSE last_material_at END,
    status = CASE WHEN status = 'dormant' THEN 'active' ELSE status END
  WHERE id = (SELECT problem_id FROM events WHERE id = NEW.event_id);
END;
