-- Fable §8.1 / Appendix C: rename the display label, never the area identity.
-- The append-only event is also the replay receipt; the title projection reads
-- its latest per-area sequence. No existing event or taxonomy row is rewritten.
CREATE TABLE area_rename_events (
  event_id TEXT PRIMARY KEY CHECK (event_id GLOB 'OA-*'),
  area_slug TEXT NOT NULL CHECK (length(area_slug) BETWEEN 1 AND 64),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  previous_event_id TEXT REFERENCES area_rename_events(event_id),
  operator_id TEXT NOT NULL CHECK (length(operator_id) BETWEEN 1 AND 128),
  old_title TEXT NOT NULL CHECK (length(old_title) BETWEEN 1 AND 128),
  new_title TEXT NOT NULL CHECK (length(trim(new_title)) BETWEEN 2 AND 120),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 10 AND 1000),
  before_state_digest TEXT NOT NULL CHECK (length(before_state_digest) = 64),
  after_state_digest TEXT NOT NULL CHECK (length(after_state_digest) = 64),
  key_digest TEXT NOT NULL CHECK (length(key_digest) = 64),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  step_up_authenticated_at INTEGER NOT NULL,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)
    AND json_extract(receipt_json, '$.audit_event_id') IS event_id
    AND json_extract(receipt_json, '$.area_id') IS area_slug
    AND json_extract(receipt_json, '$.new_title') IS new_title
    AND json_extract(receipt_json, '$.renamed_at') IS created_at
    AND json_extract(receipt_json, '$.ok') IS 1),
  created_at TEXT NOT NULL,
  UNIQUE (area_slug, seq),
  UNIQUE (operator_id, key_digest)
);
CREATE TRIGGER area_rename_sequence_guard BEFORE INSERT ON area_rename_events
WHEN NEW.seq <> (SELECT COALESCE(MAX(seq), 0) + 1 FROM area_rename_events WHERE area_slug = NEW.area_slug)
  OR NEW.previous_event_id IS NOT (SELECT event_id FROM area_rename_events
    WHERE area_slug = NEW.area_slug ORDER BY seq DESC LIMIT 1)
  OR CAST(strftime('%s', NEW.created_at) AS INTEGER) - NEW.step_up_authenticated_at NOT BETWEEN 0 AND 900
BEGIN SELECT RAISE(ABORT, 'AREA_RENAME_SEQUENCE_CONFLICT'); END;
CREATE TRIGGER area_rename_audit AFTER INSERT ON area_rename_events BEGIN
  INSERT INTO operator_audit
    (event_id, seq, operator_id, action, target_id, reason, before_state_digest, after_state_digest, created_at)
  VALUES (NEW.event_id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM operator_audit),
    NEW.operator_id, 'area.rename', NEW.area_slug, NEW.reason,
    NEW.before_state_digest, NEW.after_state_digest, NEW.created_at);
END;
CREATE TRIGGER area_renames_append_only_update BEFORE UPDATE ON area_rename_events
BEGIN SELECT RAISE(ABORT, 'AREA_RENAME_APPEND_ONLY'); END;
CREATE TRIGGER area_renames_append_only_delete BEFORE DELETE ON area_rename_events
BEGIN SELECT RAISE(ABORT, 'AREA_RENAME_APPEND_ONLY'); END;
