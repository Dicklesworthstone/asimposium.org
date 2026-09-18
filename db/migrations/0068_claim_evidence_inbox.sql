-- Fable §7.1: evidence against an exact claim version belongs in its author's
-- feedback loop, including refutations that did not arrive as a review.
-- Deploy the evidence-capable Worker BEFORE enabling this additional capture
-- trigger. It needs only the existing 0066 queue; older consumers cannot
-- interpret evidence jobs. Do not backfill old evidence as new notifications.
--
-- Capture after content insertion so hypothesis evidence does not create an
-- irrelevant claim-notification job. The event, content and queue still share
-- the originating publication transaction. Delivery verifies the digest and
-- exact routing fields again; no authored text enters the queue or notice.
CREATE TRIGGER claim_evidence_inbox_enqueue_after_content
AFTER INSERT ON event_content
WHEN NEW.redacted_at IS NULL
  AND json_extract(CASE WHEN json_valid(NEW.payload_json)
    THEN NEW.payload_json ELSE '{}' END, '$.bears_on_kind') = 'claim'
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
