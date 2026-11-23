-- A handback remains private to its Fellow and sponsor. Sharing is an explicit
-- designation of an already published, screened synthesis, pinned to immutable
-- event bytes. Retain the designation when its source is withheld so a later
-- arrival cannot silently receive an older, superseded handoff.
ALTER TABLE sessions ADD COLUMN shared_handoff_json TEXT
  CHECK (shared_handoff_json IS NULL OR json_valid(shared_handoff_json));

CREATE INDEX sessions_latest_shared_handoff
  ON sessions(problem_id, closed_at DESC, session_id DESC)
  WHERE closed_at IS NOT NULL AND shared_handoff_json IS NOT NULL;
