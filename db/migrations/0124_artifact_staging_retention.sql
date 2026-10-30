-- Expired upload capabilities must not leave their raw staging bytes forever.
-- This queue owns only incoming/artifacts/<upload-id> and its immutable parts;
-- it never grants deletion authority over CAS, public deliveries, or backups.
CREATE TABLE artifact_staging_retention (
  upload_id TEXT PRIMARY KEY REFERENCES artifact_uploads(upload_id),
  next_attempt_at INTEGER CHECK (next_attempt_at IS NULL OR
    (typeof(next_attempt_at) = 'integer' AND next_attempt_at > 0)),
  held INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1)),
  deletion_pending INTEGER NOT NULL DEFAULT 0 CHECK (deletion_pending IN (0, 1)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempts) = 'integer' AND attempts >= 0),
  last_cleared_at INTEGER CHECK (last_cleared_at IS NULL OR
    (typeof(last_cleared_at) = 'integer' AND last_cleared_at > 0)),
  lease_token TEXT,
  lease_until INTEGER,
  CHECK (deletion_pending = 0 OR (held = 0 AND lease_token IS NOT NULL)),
  CHECK ((lease_token IS NULL AND lease_until IS NULL) OR
    (held = 0 AND lease_token IS NOT NULL AND length(lease_token) = 32 AND lease_token NOT GLOB '*[^a-f0-9]*'
      AND typeof(lease_until) = 'integer' AND lease_until > 0))
);
CREATE INDEX artifact_staging_retention_due_idx
  ON artifact_staging_retention (held, next_attempt_at, upload_id);
CREATE INDEX artifact_staging_retention_pending_idx
  ON artifact_staging_retention (upload_id) WHERE deletion_pending = 1;

-- Wait for the original 24-hour completion window and the existing one-minute
-- verification lease. PUT renewals cannot extend that completion window.
-- Quarantined manifests are excluded from this automatic retention path.
INSERT INTO artifact_staging_retention (upload_id, next_attempt_at)
SELECT upload_id, CASE WHEN state = 'quarantined' THEN NULL ELSE expires_at + 60000 END
FROM artifact_uploads;

CREATE TRIGGER artifact_staging_retention_created AFTER INSERT ON artifact_uploads BEGIN
  INSERT INTO artifact_staging_retention (upload_id, next_attempt_at)
  VALUES (NEW.upload_id, NEW.expires_at + 60000);
END;
CREATE TRIGGER artifact_staging_retention_quarantined AFTER UPDATE OF state ON artifact_uploads
WHEN NEW.state = 'quarantined' BEGIN
  UPDATE artifact_staging_retention SET next_attempt_at = NULL WHERE upload_id = NEW.upload_id;
END;

-- An operator hold must be acknowledged before cleanup takes a durable lease.
-- A hold requested while deletion is in flight fails rather than falsely
-- claiming to preserve bytes whose storage operation has already started.
CREATE TRIGGER artifact_staging_retention_hold BEFORE UPDATE OF held ON artifact_staging_retention
WHEN NEW.held <> OLD.held AND (OLD.lease_token IS NOT NULL OR OLD.deletion_pending = 1) BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_STAGING_RETENTION_BUSY');
END;
CREATE TRIGGER artifact_staging_retention_identity BEFORE UPDATE ON artifact_staging_retention
WHEN NEW.upload_id IS NOT OLD.upload_id BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_STAGING_RETENTION_IMMUTABLE');
END;
CREATE TRIGGER artifact_staging_retention_no_delete BEFORE DELETE ON artifact_staging_retention BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_STAGING_RETENTION_IMMUTABLE');
END;
