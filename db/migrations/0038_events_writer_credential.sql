-- W4/W9 budget law (Fable §5 grant budgets; bead wqlf): a credential's
-- eventBudget is grant-wide, so every event row durably attributes the
-- writing credential and one commit-time trigger makes the final check
-- atomic with the append. Legacy rows keep NULL (attribution began when
-- this landed) and NULL never trips the guard, so backfill-free migration
-- cannot strand an existing ledger.
ALTER TABLE events ADD COLUMN writer_credential_id TEXT;

CREATE TRIGGER events_event_budget_guard
BEFORE INSERT ON events
WHEN NEW.writer_credential_id IS NOT NULL
  AND json_extract(
        (
          SELECT granted_resources_json
          FROM fellow_tokens
          WHERE credential_id = NEW.writer_credential_id
        ),
        '$.event_budget'
      ) IS NOT NULL
  AND (
    SELECT COUNT(*)
    FROM events
    WHERE writer_credential_id = NEW.writer_credential_id
  )
    >= json_extract(
         (
           SELECT granted_resources_json
           FROM fellow_tokens
           WHERE credential_id = NEW.writer_credential_id
         ),
         '$.event_budget'
       )
BEGIN
  SELECT RAISE(ABORT, 'EVENT_BUDGET_EXHAUSTED');
END;
