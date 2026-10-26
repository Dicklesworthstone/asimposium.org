-- A sponsor declaration can unlock the strongest scientific standing. Queue
-- its accepted exact-target record in the same transaction as publication,
-- using the existing bounded delivery worker and inbox notice contract.
-- Unaccepted event envelopes cannot enqueue a claim change. No backfill.
CREATE TRIGGER directive_disclosure_disposition_enqueue_after_insert
AFTER INSERT ON directive_disclosure_records
WHEN EXISTS (SELECT 1 FROM problems WHERE id = NEW.problem_id AND status <> 'private-draft')
BEGIN
  INSERT INTO disposition_change_deliveries (event_id, problem_id, queued_at, updated_at)
  VALUES (NEW.event_id, NEW.problem_id, CAST(unixepoch('subsec') * 1000 AS INTEGER),
    CAST(unixepoch('subsec') * 1000 AS INTEGER))
  ON CONFLICT (event_id) DO NOTHING;
END;
