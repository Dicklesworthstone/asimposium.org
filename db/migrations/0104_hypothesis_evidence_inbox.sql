-- Fable §7.1 / 1e7: material evidence about an attack route reaches its author
-- through the existing causal inbox. No old evidence is backfilled as new mail.
-- Deploy the hypothesis-capable consumer before enabling this capture trigger.
CREATE TRIGGER hypothesis_evidence_inbox_enqueue_after_content
AFTER INSERT ON event_content
WHEN NEW.redacted_at IS NULL
  AND json_extract(CASE WHEN json_valid(NEW.payload_json)
    THEN NEW.payload_json ELSE '{}' END, '$.bears_on_kind') = 'hypothesis'
BEGIN
  INSERT INTO inbox_event_deliveries (event_id, queued_at, updated_at)
  SELECT e.id, CAST(unixepoch('subsec') * 1000 AS INTEGER),
    CAST(unixepoch('subsec') * 1000 AS INTEGER)
  FROM events e JOIN problems p ON p.id = e.problem_id
  WHERE e.id = NEW.event_id AND e.payload_sha256 = NEW.payload_sha256
    AND e.type = 'evidence.created' AND e.object_kind = 'evidence'
    AND p.status <> 'private-draft'
  ON CONFLICT (event_id) DO NOTHING;
END;
