-- asimposium:allow-destructive
-- W4.3 Workshop pushes, revisions, and archival (Fable §7.4 / §6.1 / §10.3).
-- Align workshop object types to Fable §290: scratch | claim-draft | evidence-draft | dead-end-draft | note.
-- Add current_version, state, and ledger_intent_json to workshop_objects.
-- Create immutable workshop_revisions log for private version history and compare-and-swap recovery.

CREATE TABLE workshop_objects_widened (
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
  UNIQUE (problem_id, fellow_id, workshop_seq)
);

INSERT INTO workshop_objects_widened (
  workshop_id, problem_id, fellow_id, session_id, workshop_seq,
  type, title, body_md, cas_hash, relates_to_json, force_note,
  revision_json, current_version, state, ledger_intent_json, created_at, updated_at
)
SELECT
  workshop_id, problem_id, fellow_id, session_id, workshop_seq,
  CASE
    WHEN type = 'draft' THEN 'claim-draft'
    WHEN type = 'dead-end' THEN 'dead-end-draft'
    WHEN type IN ('computation', 'friction', 'artifact-ref') THEN 'scratch'
    ELSE type
  END,
  title, body_md, cas_hash, relates_to_json, force_note,
  revision_json, 1, 'open', NULL, created_at, NULL
FROM workshop_objects;

DROP TABLE workshop_objects;
ALTER TABLE workshop_objects_widened RENAME TO workshop_objects;

CREATE INDEX workshop_objects_sponsor_view_idx
  ON workshop_objects (problem_id, fellow_id, workshop_seq);

CREATE INDEX workshop_objects_state_idx
  ON workshop_objects (problem_id, fellow_id, state);

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

CREATE TRIGGER workshop_revision_immutable
BEFORE UPDATE ON workshop_objects
WHEN OLD.revision_json IS NOT NULL AND (
  NEW.revision_json IS NOT OLD.revision_json
  OR NEW.workshop_id IS NOT OLD.workshop_id
  OR NEW.fellow_id IS NOT OLD.fellow_id
  OR NEW.session_id IS NOT OLD.session_id
  OR NEW.problem_id IS NOT OLD.problem_id
)
BEGIN
  SELECT RAISE(ABORT, 'WORKSHOP_REVISION_IMMUTABLE');
END;

CREATE TABLE workshop_revisions (
  workshop_id TEXT NOT NULL REFERENCES workshop_objects(workshop_id) ON DELETE CASCADE,
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
  PRIMARY KEY (workshop_id, version)
);

CREATE INDEX workshop_revisions_lookup_idx
  ON workshop_revisions (workshop_id, version);

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

-- Backfill initial revision for all existing workshop objects
INSERT OR IGNORE INTO workshop_revisions (
  workshop_id, version, problem_id, fellow_id, session_id,
  type, title, body_md, cas_hash, relates_to_json,
  ledger_intent_json, revision_json, revise_action, created_at
)
SELECT
  workshop_id, current_version, problem_id, fellow_id, session_id,
  type, title, body_md, cas_hash, relates_to_json,
  ledger_intent_json, revision_json, 'create', created_at
FROM workshop_objects;
