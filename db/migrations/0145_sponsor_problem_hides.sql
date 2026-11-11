-- Fable §8.2: the current owning sponsor may hide a published problem with a reason.
-- Visibility still has one append-only projection. "source" is the legacy
-- manual/community decision channel; actor_kind records the actual authority.
-- Historical immutable rows retain NULL and derive their kind from source.
ALTER TABLE content_controls ADD COLUMN actor_kind TEXT
  CHECK (
    actor_kind IS NULL
    OR (actor_kind = 'community' AND source = 'community-reports')
    OR (actor_kind IN ('sponsor', 'operator') AND source = 'operator')
  );

CREATE TABLE sponsor_problem_hide_receipts (
  sponsor_id TEXT NOT NULL REFERENCES sponsors(sponsor_id),
  key_digest TEXT NOT NULL CHECK (
    length(key_digest) = 64 AND key_digest NOT GLOB '*[^0-9a-f]*'
  ),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  control_id TEXT NOT NULL UNIQUE REFERENCES content_controls(control_id),
  control_version INTEGER NOT NULL CHECK (control_version >= 1),
  step_up_authenticated_at INTEGER NOT NULL CHECK (step_up_authenticated_at >= 0),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (sponsor_id, key_digest)
);

-- A receipt identifies this sponsor's exact control, never a later restoration,
-- a different target or an operator audit event.
CREATE TRIGGER sponsor_problem_hide_receipts_bound_control
BEFORE INSERT ON sponsor_problem_hide_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM content_controls c
  WHERE c.control_id = NEW.control_id
    AND c.problem_id = NEW.problem_id
    AND c.target_kind = 'problem' AND c.target_ref = 'problem'
    AND c.visibility = 'hidden' AND c.source = 'operator'
    AND c.actor_kind = 'sponsor' AND c.actor = NEW.sponsor_id
    AND c.reason_category = 'sponsor-requested'
    AND c.version = NEW.control_version AND c.created_at = NEW.created_at
    AND json_extract(NEW.receipt_json, '$.ok') IS 1
    AND json_extract(NEW.receipt_json, '$.problem_id') IS NEW.problem_id
    AND json_extract(NEW.receipt_json, '$.action') IS 'hide'
    AND json_extract(NEW.receipt_json, '$.visibility') IS 'hidden'
    AND json_extract(NEW.receipt_json, '$.actor_kind') IS 'sponsor'
    AND json_extract(NEW.receipt_json, '$.control_id') IS NEW.control_id
    AND json_extract(NEW.receipt_json, '$.version') IS NEW.control_version
    AND json_extract(NEW.receipt_json, '$.applied_at') IS NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'SPONSOR_PROBLEM_HIDE_RECEIPT_MISMATCH');
END;

CREATE TRIGGER sponsor_problem_hide_receipts_append_only_update
BEFORE UPDATE ON sponsor_problem_hide_receipts
BEGIN
  SELECT RAISE(ABORT, 'SPONSOR_PROBLEM_HIDE_RECEIPT_IMMUTABLE');
END;

CREATE TRIGGER sponsor_problem_hide_receipts_append_only_delete
BEFORE DELETE ON sponsor_problem_hide_receipts
BEGIN
  SELECT RAISE(ABORT, 'SPONSOR_PROBLEM_HIDE_RECEIPT_IMMUTABLE');
END;

-- A visibility change invalidates public polling even though scientific
-- public_seq is unchanged. The trigger commits or rolls back with the control;
-- receipt replay inserts no control and therefore spends no cursor.
CREATE TRIGGER content_controls_public_cursor
AFTER INSERT ON content_controls
WHEN EXISTS (
  SELECT 1 FROM problems p WHERE p.id = NEW.problem_id
    AND p.status <> 'private-draft' AND p.public_seq > 0
)
BEGIN
  UPDATE public_cursor SET cursor = cursor + 1 WHERE singleton = 1;
END;
