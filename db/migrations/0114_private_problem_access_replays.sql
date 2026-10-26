-- Private workspace access commands retain only an exact minimal receipt.
-- Inserting a new receipt applies its state change in the same transaction;
-- a retry never overwrites a later steward decision. No scientific event is
-- fabricated for a never-published draft.
CREATE TABLE private_problem_access_replays (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  sponsor_id TEXT NOT NULL REFERENCES sponsors(sponsor_id),
  key_hash TEXT NOT NULL CHECK (length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  receipt_json TEXT NOT NULL CHECK (length(receipt_json) <= 4096 AND json_valid(receipt_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > created_at),
  PRIMARY KEY (problem_id, sponsor_id, key_hash),
  CHECK (json_extract(receipt_json, '$.problem_id') IS problem_id),
  CHECK (json_extract(receipt_json, '$.acting_sponsor_id') IS sponsor_id),
  CHECK (json_extract(receipt_json, '$.updated_at') IS created_at),
  CHECK (json_type(receipt_json, '$.event_id') IS 'null'),
  CHECK (
    (json_extract(receipt_json, '$.action') IS 'set-admission-mode'
      AND json_extract(receipt_json, '$.mode') IN ('open', 'approval-required', 'invite-only', 'archived-read-only'))
    OR
    (json_extract(receipt_json, '$.action') IS 'manage-member'
      AND json_type(receipt_json, '$.target_fellow_id') IS 'text'
      AND length(json_extract(receipt_json, '$.target_fellow_id')) BETWEEN 1 AND 128
      AND ((json_extract(receipt_json, '$.operation') IS 'set-role'
          AND json_extract(receipt_json, '$.role') IN ('observer', 'contributor'))
        OR (json_extract(receipt_json, '$.operation') IS 'remove'
          AND json_type(receipt_json, '$.role') IS 'null')))
  )
);
CREATE INDEX private_problem_access_replays_expiry ON private_problem_access_replays(expires_at);

CREATE TRIGGER private_problem_access_current BEFORE INSERT ON private_problem_access_replays
WHEN NOT EXISTS (
  SELECT 1 FROM problems p JOIN sponsors s ON s.sponsor_id = NEW.sponsor_id
  WHERE p.id = NEW.problem_id AND p.status = 'private-draft' AND p.public_seq = 0
    AND NOT EXISTS (SELECT 1 FROM events WHERE problem_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = p.id)
    AND s.tombstoned_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = s.sponsor_id)
    AND (p.sponsor_id = s.sponsor_id OR EXISTS (SELECT 1 FROM problem_stewards
      WHERE problem_id = p.id AND sponsor_id = s.sponsor_id))
)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_PROBLEM_ACCESS_NOT_CURRENT'); END;

CREATE TRIGGER private_problem_access_minimal_receipt BEFORE INSERT ON private_problem_access_replays
WHEN (json_extract(NEW.receipt_json, '$.action') = 'set-admission-mode' AND (
    (SELECT COUNT(*) FROM json_each(NEW.receipt_json)) <> 6
    OR EXISTS (SELECT 1 FROM json_each(NEW.receipt_json) WHERE key NOT IN (
      'problem_id', 'acting_sponsor_id', 'updated_at', 'event_id', 'action', 'mode'))
  )) OR (json_extract(NEW.receipt_json, '$.action') = 'manage-member' AND (
    (SELECT COUNT(*) FROM json_each(NEW.receipt_json)) <> 8
    OR EXISTS (SELECT 1 FROM json_each(NEW.receipt_json) WHERE key NOT IN (
      'problem_id', 'acting_sponsor_id', 'updated_at', 'event_id', 'action',
      'operation', 'target_fellow_id', 'role'))
  ))
BEGIN SELECT RAISE(ABORT, 'PRIVATE_PROBLEM_ACCESS_RECEIPT_INVALID'); END;

CREATE TRIGGER private_problem_access_apply AFTER INSERT ON private_problem_access_replays
BEGIN
  UPDATE problems SET updated_at = NEW.created_at,
    admission_mode = CASE WHEN json_extract(NEW.receipt_json, '$.action') = 'set-admission-mode'
      THEN json_extract(NEW.receipt_json, '$.mode') ELSE admission_mode END
    WHERE id = NEW.problem_id;
  INSERT INTO problem_memberships(problem_id, fellow_id, role, joined_at)
    SELECT NEW.problem_id, json_extract(NEW.receipt_json, '$.target_fellow_id'),
      json_extract(NEW.receipt_json, '$.role'), NEW.created_at
    WHERE json_extract(NEW.receipt_json, '$.action') = 'manage-member'
      AND json_extract(NEW.receipt_json, '$.operation') = 'set-role'
    ON CONFLICT(problem_id, fellow_id) DO UPDATE SET role = excluded.role;
  DELETE FROM problem_memberships WHERE problem_id = NEW.problem_id
    AND fellow_id = json_extract(NEW.receipt_json, '$.target_fellow_id')
    AND json_extract(NEW.receipt_json, '$.action') = 'manage-member'
    AND json_extract(NEW.receipt_json, '$.operation') = 'remove';
END;

CREATE TRIGGER private_problem_access_immutable BEFORE UPDATE ON private_problem_access_replays
BEGIN SELECT RAISE(ABORT, 'PRIVATE_PROBLEM_ACCESS_RECEIPT_IMMUTABLE'); END;

-- Journal replay and account deletion also remove these private receipts.
-- The insertion guard prevents an older dump from resurrecting erased access.
CREATE TRIGGER private_problem_access_erase AFTER INSERT ON private_draft_erasures
BEGIN DELETE FROM private_problem_access_replays WHERE problem_id = NEW.problem_id; END;
CREATE TRIGGER private_problem_access_account_erase AFTER UPDATE OF tombstoned_at ON sponsors
WHEN NEW.tombstoned_at IS NOT NULL
BEGIN DELETE FROM private_problem_access_replays WHERE sponsor_id = NEW.sponsor_id; END;
