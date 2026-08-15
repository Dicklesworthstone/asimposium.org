PRAGMA foreign_keys = ON;

-- W3.5 hardening (asimposiumorg-xdy).
--
-- The human code mapping is deliberately reclaimable after thirty minutes,
-- while the proposal remains for its separate twenty-four-hour retention
-- period. Keep the poll-handle expiry on the enrollment so removing an
-- expired mapping cannot make the protocol boundary depend on cleanup timing.
ALTER TABLE enrollment_records ADD COLUMN device_expires_at INTEGER;
ALTER TABLE enrollment_records ADD COLUMN device_mapping_reclaimed_at INTEGER;

UPDATE enrollment_records
   SET device_expires_at = (
     SELECT d.expires_at
       FROM device_codes d
      WHERE d.enrollment_id = enrollment_records.enrollment_id
   )
 WHERE kind = 'device';

-- Device starts share the same 24-hour encrypted replay law as other writes.
-- SQLite cannot widen a CHECK constraint in place, so rebuild this unreferenced
-- table without weakening its load-bearing request_digest NOT NULL abort.
CREATE TABLE enrollment_idempotency_with_device_start (
  scope TEXT NOT NULL CHECK (scope IN ('mint', 'claim', 'decision', 'poll', 'device-start')),
  principal_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_ciphertext TEXT NOT NULL,
  response_initialization_vector TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, principal_scope, idempotency_key)
);
INSERT INTO enrollment_idempotency_with_device_start (
  scope, principal_scope, idempotency_key, request_digest,
  response_ciphertext, response_initialization_vector, expires_at
)
SELECT scope, principal_scope, idempotency_key, request_digest,
       response_ciphertext, response_initialization_vector, expires_at
  FROM enrollment_idempotency;
DROP TABLE enrollment_idempotency;
ALTER TABLE enrollment_idempotency_with_device_start RENAME TO enrollment_idempotency;

-- Successful code lookups are not security events and are never read. Older
-- 0009 code recorded them; remove that non-authoritative amplification surface
-- once, then the Worker persists failures only.
DELETE FROM device_lookup_attempts WHERE success = 1;

-- Unauthenticated starts are bounded before a sponsor is associated. The
-- bucket is a keyed HMAC-SHA-256 of the Cloudflare-authenticated client address;
-- raw addresses never enter D1 through this path.
CREATE TABLE device_start_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_bucket TEXT NOT NULL
    CHECK (length(client_bucket) = 64 AND client_bucket NOT GLOB '*[^0-9a-f]*'),
  attempted_at INTEGER NOT NULL
);
CREATE INDEX device_start_attempts_bucket_time
  ON device_start_attempts (client_bucket, attempted_at);

-- Refuse to install the new cleanup semantics over a pre-existing impossible
-- 0009 state. The guard table lives only for this assertion; a failed insert
-- aborts the migration transaction before any new behavior becomes serviceable.
CREATE TABLE device_flow_migration_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);
INSERT INTO device_flow_migration_guard (valid)
SELECT CASE WHEN EXISTS (
  SELECT 1
    FROM enrollment_records e
    LEFT JOIN enrollment_proposals p ON p.enrollment_id = e.enrollment_id
    LEFT JOIN device_codes d ON d.enrollment_id = e.enrollment_id
   WHERE (e.kind = 'device' AND (
          e.device_expires_at IS NULL
          OR d.enrollment_id IS NULL
          OR p.enrollment_id IS NULL
          OR d.expires_at != e.device_expires_at
          OR d.created_at != e.created_at
          OR d.expires_at <= d.created_at
          OR d.expires_at > p.expires_at
          OR length(d.user_code_hash) != 64
          OR d.user_code_hash GLOB '*[^0-9a-f]*'
        ))
      OR e.kind NOT IN ('join-url', 'device')
      OR (e.kind != 'device' AND d.enrollment_id IS NOT NULL)
) THEN 0 ELSE 1 END;
DROP TABLE device_flow_migration_guard;

-- A record can be either an ordinary sponsor-minted enrollment or a device
-- enrollment with a durable poll expiry. Binding the sponsor later does not
-- alter this invariant.
CREATE TRIGGER enrollment_records_device_shape_insert
BEFORE INSERT ON enrollment_records
BEGIN
  SELECT CASE
    WHEN NEW.kind = 'device'
      AND (
        NEW.device_expires_at IS NULL
        OR NEW.device_expires_at <= NEW.created_at
        OR (
          NEW.device_mapping_reclaimed_at IS NOT NULL
          AND NEW.device_mapping_reclaimed_at < NEW.device_expires_at
        )
      )
      THEN RAISE(ABORT, 'DEVICE_RECORD_EXPIRY_INVALID')
    WHEN NEW.kind = 'join-url'
      AND (NEW.device_expires_at IS NOT NULL OR NEW.device_mapping_reclaimed_at IS NOT NULL)
      THEN RAISE(ABORT, 'JOIN_RECORD_DEVICE_EXPIRY_FORBIDDEN')
    WHEN NEW.kind NOT IN ('join-url', 'device')
      THEN RAISE(ABORT, 'ENROLLMENT_KIND_INVALID')
  END;
END;

CREATE TRIGGER enrollment_records_device_shape_update
BEFORE UPDATE OF kind, created_at, device_expires_at, device_mapping_reclaimed_at
ON enrollment_records
BEGIN
  SELECT CASE
    WHEN NEW.kind IS NOT OLD.kind
      THEN RAISE(ABORT, 'ENROLLMENT_KIND_IMMUTABLE')
    WHEN OLD.kind = 'device' AND NEW.created_at IS NOT OLD.created_at
      THEN RAISE(ABORT, 'DEVICE_RECORD_CREATED_AT_IMMUTABLE')
    WHEN NEW.device_expires_at IS NOT OLD.device_expires_at
      THEN RAISE(ABORT, 'DEVICE_RECORD_EXPIRY_IMMUTABLE')
    WHEN OLD.device_mapping_reclaimed_at IS NOT NULL
      AND NEW.device_mapping_reclaimed_at IS NOT OLD.device_mapping_reclaimed_at
      THEN RAISE(ABORT, 'DEVICE_MAPPING_RECLAMATION_IMMUTABLE')
    WHEN NEW.kind = 'device'
      AND (
        NEW.device_expires_at IS NULL
        OR NEW.device_expires_at <= NEW.created_at
        OR (
          NEW.device_mapping_reclaimed_at IS NOT NULL
          AND NEW.device_mapping_reclaimed_at < NEW.device_expires_at
        )
      )
      THEN RAISE(ABORT, 'DEVICE_RECORD_EXPIRY_INVALID')
    WHEN NEW.kind = 'join-url'
      AND (NEW.device_expires_at IS NOT NULL OR NEW.device_mapping_reclaimed_at IS NOT NULL)
      THEN RAISE(ABORT, 'JOIN_RECORD_DEVICE_EXPIRY_FORBIDDEN')
    WHEN NEW.kind NOT IN ('join-url', 'device')
      THEN RAISE(ABORT, 'ENROLLMENT_KIND_INVALID')
  END;
END;

-- A device proposal's identity and retention boundary are the other half of
-- the triple checked above. Status/grant/token fields remain mutable through
-- their normal state transitions, but moving or retiming the proposal would
-- silently invalidate the retained poll expiry.
CREATE TRIGGER enrollment_proposals_device_identity_update
BEFORE UPDATE OF enrollment_id, created_at, expires_at ON enrollment_proposals
WHEN EXISTS (
  SELECT 1 FROM enrollment_records
   WHERE enrollment_id IN (OLD.enrollment_id, NEW.enrollment_id) AND kind = 'device'
)
BEGIN
  SELECT CASE
    WHEN NEW.enrollment_id IS NOT OLD.enrollment_id
      THEN RAISE(ABORT, 'DEVICE_PROPOSAL_ENROLLMENT_IMMUTABLE')
    WHEN NEW.created_at IS NOT OLD.created_at
      THEN RAISE(ABORT, 'DEVICE_PROPOSAL_CREATED_AT_IMMUTABLE')
    WHEN NEW.expires_at IS NOT OLD.expires_at
      THEN RAISE(ABORT, 'DEVICE_PROPOSAL_EXPIRY_IMMUTABLE')
  END;
END;

-- The short-code row must point at the matching device record and proposal,
-- use the same exclusive expiry as the poll handle, and never outlive the
-- proposal it locates. The hash is fixed-width lowercase SHA-256.
CREATE TRIGGER device_codes_shape_insert
BEFORE INSERT ON device_codes
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM enrollment_records e
      JOIN enrollment_proposals p ON p.enrollment_id = e.enrollment_id
     WHERE e.enrollment_id = NEW.enrollment_id
       AND e.kind = 'device'
       AND e.device_mapping_reclaimed_at IS NULL
       AND e.device_expires_at = NEW.expires_at
       AND NEW.created_at = e.created_at
       AND NEW.expires_at > NEW.created_at
       AND NEW.expires_at <= p.expires_at
       AND length(NEW.user_code_hash) = 64
       AND NEW.user_code_hash NOT GLOB '*[^0-9a-f]*'
  ) THEN RAISE(ABORT, 'DEVICE_CODE_SHAPE_INVALID') END;
END;

CREATE TRIGGER device_codes_immutable
BEFORE UPDATE ON device_codes
BEGIN
  SELECT RAISE(ABORT, 'DEVICE_CODE_IMMUTABLE');
END;
