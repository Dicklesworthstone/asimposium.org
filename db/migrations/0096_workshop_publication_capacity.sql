-- asimposium:allow-destructive
-- Typed hypothesis/evidence payloads reuse the ordinary write contracts, whose
-- body_md accepts 64 Ki characters plus structured evidence. JSON escaping can
-- use six bytes per character. The former 64 KiB serialized-publication CHECK
-- rejected valid workshop writes after validation. Bound the stored JSON to the
-- existing route's 512 KiB raw-request ceiling instead; neither the request nor
-- sponsor response ceilings change. This migration runs in D1's normal atomic
-- migration transaction, with foreign keys enabled throughout.
--
-- Copy the parent and immutable history first. The replacement history refers
-- to the replacement parent, so dropping the old child and then old parent
-- cannot cascade into the preserved copy. Every identity, private byte, source
-- link, index and current trigger is retained; only this byte CHECK widens.

CREATE TABLE workshop_objects_capacity (
  workshop_id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  workshop_seq INTEGER NOT NULL CHECK (workshop_seq > 0),
  type TEXT NOT NULL CHECK (
    type IN ('scratch', 'claim-draft', 'evidence-draft', 'dead-end-draft', 'note')
  ),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body_md TEXT NOT NULL CHECK (length(body_md) BETWEEN 1 AND 65536),
  cas_hash TEXT DEFAULT NULL CHECK (cas_hash IS NULL OR cas_hash GLOB 'sha256:[0-9a-f]*'),
  relates_to_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(relates_to_json)),
  force_note INTEGER NOT NULL DEFAULT 0 CHECK (force_note IN (0, 1)),
  revision_json TEXT DEFAULT NULL CHECK (
    revision_json IS NULL OR (json_valid(revision_json) AND json_type(revision_json) = 'object')
  ),
  current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version > 0),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'archived', 'discarded')),
  ledger_intent_json TEXT DEFAULT NULL CHECK (
    ledger_intent_json IS NULL OR (json_valid(ledger_intent_json) AND json_type(ledger_intent_json) = 'object')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT DEFAULT NULL,
  publication_json TEXT DEFAULT NULL CHECK (
    publication_json IS NULL OR (
      json_valid(publication_json)
      AND json_type(publication_json) = 'object'
      AND length(CAST(publication_json AS BLOB)) <= 524288
    )
  ),
  UNIQUE (problem_id, fellow_id, workshop_seq)
);

INSERT INTO workshop_objects_capacity (
  workshop_id, problem_id, fellow_id, session_id, workshop_seq, type, title,
  body_md, cas_hash, relates_to_json, force_note, revision_json, current_version,
  state, ledger_intent_json, created_at, updated_at, publication_json
)
SELECT
  workshop_id, problem_id, fellow_id, session_id, workshop_seq, type, title,
  body_md, cas_hash, relates_to_json, force_note, revision_json, current_version,
  state, ledger_intent_json, created_at, updated_at, publication_json
FROM workshop_objects;

CREATE TABLE workshop_revisions_capacity (
  workshop_id TEXT NOT NULL REFERENCES workshop_objects_capacity(workshop_id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  type TEXT NOT NULL CHECK (
    type IN ('scratch', 'claim-draft', 'evidence-draft', 'dead-end-draft', 'note')
  ),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body_md TEXT NOT NULL CHECK (length(body_md) BETWEEN 1 AND 65536),
  cas_hash TEXT DEFAULT NULL CHECK (cas_hash IS NULL OR cas_hash GLOB 'sha256:[0-9a-f]*'),
  relates_to_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(relates_to_json)),
  ledger_intent_json TEXT DEFAULT NULL CHECK (
    ledger_intent_json IS NULL OR (json_valid(ledger_intent_json) AND json_type(ledger_intent_json) = 'object')
  ),
  revision_json TEXT DEFAULT NULL CHECK (
    revision_json IS NULL OR (json_valid(revision_json) AND json_type(revision_json) = 'object')
  ),
  revise_action TEXT NOT NULL DEFAULT 'create' CHECK (
    revise_action IN ('create', 'edit', 'keep', 'archive', 'discard')
  ),
  created_at TEXT NOT NULL,
  publication_json TEXT DEFAULT NULL CHECK (
    publication_json IS NULL OR (
      json_valid(publication_json)
      AND json_type(publication_json) = 'object'
      AND length(CAST(publication_json AS BLOB)) <= 524288
    )
  ),
  acting_sponsor_id TEXT DEFAULT NULL REFERENCES sponsors(sponsor_id),
  publication_event_id TEXT DEFAULT NULL REFERENCES events(id),
  PRIMARY KEY (workshop_id, version)
);

INSERT INTO workshop_revisions_capacity (
  workshop_id, version, problem_id, fellow_id, session_id, type, title, body_md,
  cas_hash, relates_to_json, ledger_intent_json, revision_json, revise_action,
  created_at, publication_json, acting_sponsor_id, publication_event_id
)
SELECT
  workshop_id, version, problem_id, fellow_id, session_id, type, title, body_md,
  cas_hash, relates_to_json, ledger_intent_json, revision_json, revise_action,
  created_at, publication_json, acting_sponsor_id, publication_event_id
FROM workshop_revisions;

DROP TABLE workshop_revisions;
DROP TABLE workshop_objects;
ALTER TABLE workshop_objects_capacity RENAME TO workshop_objects;
ALTER TABLE workshop_revisions_capacity RENAME TO workshop_revisions;

CREATE INDEX workshop_objects_sponsor_view_idx
  ON workshop_objects (problem_id, fellow_id, workshop_seq);
CREATE INDEX workshop_objects_state_idx
  ON workshop_objects (problem_id, fellow_id, state);
CREATE INDEX workshop_objects_fellow_problem_cursor_idx
  ON workshop_objects (fellow_id, problem_id, workshop_seq DESC);
CREATE INDEX workshop_revisions_lookup_idx
  ON workshop_revisions (workshop_id, version);

CREATE TRIGGER workshop_objects_cas_spill_extract_insert
BEFORE INSERT ON workshop_objects
WHEN NEW.cas_hash IS NOT NULL AND length(NEW.body_md) > 280
BEGIN
  SELECT RAISE(ABORT, 'WORKSHOP_CAS_SPILL_EXTRACT_TOO_LONG');
END;

CREATE TRIGGER workshop_objects_cas_spill_extract_update
BEFORE UPDATE ON workshop_objects
WHEN NEW.cas_hash IS NOT NULL AND length(NEW.body_md) > 280
BEGIN
  SELECT RAISE(ABORT, 'WORKSHOP_CAS_SPILL_EXTRACT_TOO_LONG');
END;

-- Same mutable-head identity/history guard as 0093.
CREATE TRIGGER workshop_revision_immutable
BEFORE UPDATE ON workshop_objects
WHEN NEW.workshop_id IS NOT OLD.workshop_id
  OR NEW.fellow_id IS NOT OLD.fellow_id
  OR NEW.session_id IS NOT OLD.session_id
  OR NEW.problem_id IS NOT OLD.problem_id
  OR (
    NEW.revision_json IS NOT OLD.revision_json
    AND (
      NEW.current_version IS NOT OLD.current_version + 1
      OR NEW.workshop_seq <= OLD.workshop_seq
      OR NOT EXISTS (
        SELECT 1 FROM workshop_revisions r
        WHERE r.workshop_id = OLD.workshop_id
          AND r.version = OLD.current_version
          AND r.problem_id = OLD.problem_id
          AND r.fellow_id = OLD.fellow_id
          AND r.revision_json IS OLD.revision_json
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'WORKSHOP_REVISION_IMMUTABLE');
END;

CREATE TRIGGER workshop_revisions_immutable
BEFORE UPDATE ON workshop_revisions
BEGIN
  SELECT RAISE(ABORT, 'WORKSHOP_REVISION_IMMUTABLE');
END;

CREATE TRIGGER workshop_revisions_cas_spill_extract_insert
BEFORE INSERT ON workshop_revisions
WHEN NEW.cas_hash IS NOT NULL AND length(NEW.body_md) > 280
BEGIN
  SELECT RAISE(ABORT, 'WORKSHOP_CAS_SPILL_EXTRACT_TOO_LONG');
END;
