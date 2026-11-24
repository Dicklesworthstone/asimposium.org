-- Apply the existing human commentary cadence to restricted case actions.
-- The action is the admission record: failure rolls the preceding case CAS,
-- audit, notification and receipt back with it. Exact receipt replay is free.
CREATE INDEX integrity_case_actions_actor_time
  ON integrity_case_actions (actor_class, actor_id, created_at DESC);

CREATE TRIGGER integrity_case_action_write_budget
BEFORE INSERT ON integrity_case_actions
WHEN (
  SELECT COUNT(*) FROM (
    SELECT 1 FROM integrity_case_actions prior
    WHERE prior.actor_class = NEW.actor_class AND prior.actor_id = NEW.actor_id
      AND prior.created_at > strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '-60 seconds')
    LIMIT 20
  )
) >= 20
BEGIN SELECT RAISE(ABORT, 'INTEGRITY_WRITE_RATE_LIMITED'); END;
