PRAGMA foreign_keys = ON;

-- Fable §5.5 / ADR-24: bind the immutable Fellow declaration and exact served
-- protocol/policy versions to the session's first admission. Historical rows
-- remain NULL; a later deployment cannot claim its terms governed older work.
ALTER TABLE sessions ADD COLUMN provenance_json TEXT
  CHECK (provenance_json IS NULL OR
    (json_valid(provenance_json) AND json_type(provenance_json) = 'object'));

CREATE TRIGGER sessions_provenance_immutable
BEFORE UPDATE OF provenance_json ON sessions
WHEN NEW.provenance_json IS NOT OLD.provenance_json
BEGIN
  SELECT RAISE(ABORT, 'SESSION_PROVENANCE_IMMUTABLE');
END;
