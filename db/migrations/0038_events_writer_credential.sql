-- W4/W9 budget law (Fable §5 grant budgets; bead wqlf): a credential's
-- eventBudget is grant-wide, so every event row durably attributes the
-- writing credential and one commit-time trigger makes the final check
-- atomic with the append. Grant resources are stored under both spellings
-- across harness seeds and the D1 store, so the guard reads either. Legacy
-- rows keep NULL writer_credential_id and NULL never trips the guard, so
-- backfill-free migration cannot strand an existing ledger.
ALTER TABLE events ADD COLUMN writer_credential_id TEXT;

CREATE TRIGGER events_event_budget_guard
BEFORE INSERT ON events
WHEN NEW.writer_credential_id IS NOT NULL
  AND COALESCE(
        json_extract(
          (
            SELECT granted_resources_json
            FROM fellow_tokens
            WHERE credential_id = NEW.writer_credential_id
          ),
          '$.event_budget'
        ),
        json_extract(
          (
            SELECT granted_resources_json
            FROM fellow_tokens
            WHERE credential_id = NEW.writer_credential_id
          ),
          '$.eventBudget'
        )
      ) IS NOT NULL
  AND (
    SELECT COUNT(*)
    FROM events
    WHERE writer_credential_id = NEW.writer_credential_id
  )
    >= COALESCE(
         json_extract(
           (
             SELECT granted_resources_json
             FROM fellow_tokens
             WHERE credential_id = NEW.writer_credential_id
           ),
           '$.event_budget'
         ),
         json_extract(
           (
             SELECT granted_resources_json
             FROM fellow_tokens
             WHERE credential_id = NEW.writer_credential_id
           ),
           '$.eventBudget'
         )
       )
BEGIN
  SELECT RAISE(ABORT, 'EVENT_BUDGET_EXHAUSTED');
END;
