-- Content availability bookkeeping, not a second scientific ledger. Only
-- immutable public event IDs are retained while their payload is missing.
-- A later payload restoration must invalidate directory snapshots without
-- double-counting ordinary appends, whose transaction owns public_cursor.
CREATE TABLE public_content_removals (
  event_id TEXT PRIMARY KEY REFERENCES events(id)
) STRICT;

-- Cover payloads already missing when this migration is installed. New
-- publications insert their event and content atomically and need no witness.
INSERT INTO public_content_removals(event_id)
SELECT e.id FROM events e JOIN problems p ON p.id = e.problem_id
WHERE p.status <> 'private-draft' AND e.seq <= p.public_seq
  AND NOT EXISTS (SELECT 1 FROM event_content c WHERE c.event_id = e.id);

-- Existing lawful-redaction guards remain authoritative. Count availability
-- changes, not repeated redactions or edits to an already-withheld timestamp.
CREATE TRIGGER event_content_redaction_public_cursor
AFTER UPDATE OF redacted_at ON event_content
WHEN (OLD.redacted_at IS NULL) <> (NEW.redacted_at IS NULL)
  AND EXISTS (
    SELECT 1 FROM events e JOIN problems p ON p.id = e.problem_id
    WHERE e.id = NEW.event_id AND e.payload_sha256 = NEW.payload_sha256
      AND p.status <> 'private-draft' AND e.seq <= p.public_seq
  )
BEGIN
  UPDATE public_cursor SET cursor = cursor + 1 WHERE singleton = 1;
END;

-- Keep a witness even for an unavailable removed row: replacing it with
-- matching public content can make a previously absent scientific need live.
CREATE TRIGGER event_content_delete_public_cursor
AFTER DELETE ON event_content
WHEN EXISTS (
  SELECT 1 FROM events e JOIN problems p ON p.id = e.problem_id
  WHERE e.id = OLD.event_id AND p.status <> 'private-draft' AND e.seq <= p.public_seq
)
BEGIN
  INSERT OR IGNORE INTO public_content_removals(event_id) VALUES (OLD.event_id);
  UPDATE public_cursor SET cursor = cursor + 1 WHERE singleton = 1
    AND OLD.redacted_at IS NULL
    AND EXISTS (SELECT 1 FROM events e
      WHERE e.id = OLD.event_id AND e.payload_sha256 = OLD.payload_sha256);
END;

CREATE TRIGGER event_content_restore_public_cursor
AFTER INSERT ON event_content
WHEN NEW.redacted_at IS NULL
  AND EXISTS (SELECT 1 FROM public_content_removals WHERE event_id = NEW.event_id)
  AND EXISTS (
    SELECT 1 FROM events e JOIN problems p ON p.id = e.problem_id
    WHERE e.id = NEW.event_id AND e.payload_sha256 = NEW.payload_sha256
      AND p.status <> 'private-draft' AND e.seq <= p.public_seq
  )
BEGIN
  UPDATE public_cursor SET cursor = cursor + 1 WHERE singleton = 1;
  DELETE FROM public_content_removals WHERE event_id = NEW.event_id;
END;
