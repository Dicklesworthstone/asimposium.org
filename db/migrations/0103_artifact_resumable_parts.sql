-- Resumable private uploads reuse the original manifest and byte reservation.
-- Acknowledged part digests are immutable; late R2 writes cannot replace them.
CREATE TABLE artifact_resumable_uploads (
  upload_id TEXT PRIMARY KEY REFERENCES artifact_uploads(upload_id),
  credential_id TEXT NOT NULL REFERENCES fellow_tokens(credential_id),
  started_at INTEGER NOT NULL CHECK (typeof(started_at) = 'integer' AND started_at > 0),
  lease_token TEXT NOT NULL CHECK (length(lease_token) = 32 AND lease_token NOT GLOB '*[^a-f0-9]*')
);

CREATE TABLE artifact_upload_parts (
  upload_id TEXT NOT NULL REFERENCES artifact_resumable_uploads(upload_id),
  part_number INTEGER NOT NULL CHECK (typeof(part_number) = 'integer' AND part_number BETWEEN 1 AND 4),
  credential_id TEXT NOT NULL REFERENCES fellow_tokens(credential_id),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
  size_bytes INTEGER NOT NULL CHECK (typeof(size_bytes) = 'integer' AND size_bytes BETWEEN 1 AND 5242880),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  acknowledged_at INTEGER CHECK (acknowledged_at IS NULL OR
    (typeof(acknowledged_at) = 'integer' AND acknowledged_at >= created_at)),
  lease_token TEXT NOT NULL CHECK (length(lease_token) = 32 AND lease_token NOT GLOB '*[^a-f0-9]*'),
  PRIMARY KEY (upload_id, part_number)
);

CREATE TRIGGER artifact_resumable_authorized BEFORE INSERT ON artifact_resumable_uploads
WHEN NOT EXISTS (
  SELECT 1 FROM artifact_uploads u JOIN artifact_upload_write_authority a
    ON a.credential_id = u.credential_id AND a.fellow_id = u.fellow_id
      AND a.sponsor_id = u.sponsor_id AND a.session_id = u.session_id AND a.problem_id = u.problem_id
  WHERE u.upload_id = NEW.upload_id AND u.credential_id = NEW.credential_id
    AND u.state = 'presigned' AND u.expires_at > NEW.started_at
    AND u.lease_token = NEW.lease_token AND u.lease_until > NEW.started_at
    AND a.issued_at <= NEW.started_at AND a.expires_at > NEW.started_at
    AND a.opened_at <= strftime('%Y-%m-%dT%H:%M:%fZ', NEW.started_at / 1000.0, 'unixepoch')
    AND a.idle_close_at > strftime('%Y-%m-%dT%H:%M:%fZ', NEW.started_at / 1000.0, 'unixepoch')
    AND (json_extract(a.granted_resources_json, '$.fellowGrantExpiresAt') IS NULL
      OR json_extract(a.granted_resources_json, '$.fellowGrantExpiresAt') > NEW.started_at)
    AND (json_extract(a.granted_resources_json, '$.eventBudget') IS NULL OR
      (SELECT COUNT(*) FROM events e WHERE e.writer_credential_id = a.credential_id)
        < json_extract(a.granted_resources_json, '$.eventBudget'))
    AND (json_extract(a.granted_resources_json, '$.artifactBudgetBytes') IS NULL OR
      (SELECT COALESCE(SUM(size_bytes), 0) FROM artifact_uploads WHERE fellow_id = a.fellow_id)
        <= json_extract(a.granted_resources_json, '$.artifactBudgetBytes'))
) BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_AUTHORITY_CHANGED');
END;

CREATE TRIGGER artifact_part_authorized BEFORE INSERT ON artifact_upload_parts
WHEN NEW.acknowledged_at IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM artifact_uploads u JOIN artifact_upload_write_authority a
    ON a.credential_id = u.credential_id AND a.fellow_id = u.fellow_id
      AND a.sponsor_id = u.sponsor_id AND a.session_id = u.session_id AND a.problem_id = u.problem_id
  WHERE u.upload_id = NEW.upload_id AND u.credential_id = NEW.credential_id
    AND u.state = 'presigned' AND u.expires_at > NEW.created_at
    AND u.lease_token = NEW.lease_token AND u.lease_until > NEW.created_at
    AND NEW.size_bytes = MIN(5242880, u.size_bytes - (NEW.part_number - 1) * 5242880)
    AND a.issued_at <= NEW.created_at AND a.expires_at > NEW.created_at
    AND a.opened_at <= strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at / 1000.0, 'unixepoch')
    AND a.idle_close_at > strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at / 1000.0, 'unixepoch')
    AND (json_extract(a.granted_resources_json, '$.fellowGrantExpiresAt') IS NULL
      OR json_extract(a.granted_resources_json, '$.fellowGrantExpiresAt') > NEW.created_at)
    AND (json_extract(a.granted_resources_json, '$.eventBudget') IS NULL OR
      (SELECT COUNT(*) FROM events e WHERE e.writer_credential_id = a.credential_id)
        < json_extract(a.granted_resources_json, '$.eventBudget'))
    AND (json_extract(a.granted_resources_json, '$.artifactBudgetBytes') IS NULL OR
      (SELECT COALESCE(SUM(size_bytes), 0) FROM artifact_uploads WHERE fellow_id = a.fellow_id)
        <= json_extract(a.granted_resources_json, '$.artifactBudgetBytes'))
) BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_AUTHORITY_CHANGED');
END;

CREATE TRIGGER artifact_resumable_immutable_update BEFORE UPDATE ON artifact_resumable_uploads BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_PART_IMMUTABLE');
END;
CREATE TRIGGER artifact_resumable_immutable_delete BEFORE DELETE ON artifact_resumable_uploads BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_PART_IMMUTABLE');
END;
CREATE TRIGGER artifact_part_immutable_update BEFORE UPDATE ON artifact_upload_parts BEGIN
  SELECT CASE WHEN OLD.acknowledged_at IS NOT NULL OR NEW.acknowledged_at IS NULL
    OR NEW.upload_id IS NOT OLD.upload_id OR NEW.part_number IS NOT OLD.part_number
    OR NEW.credential_id IS NOT OLD.credential_id OR NEW.sha256 IS NOT OLD.sha256
    OR NEW.size_bytes IS NOT OLD.size_bytes OR NEW.created_at IS NOT OLD.created_at
    THEN RAISE(ABORT, 'ARTIFACT_PART_IMMUTABLE') END;
END;
CREATE TRIGGER artifact_part_immutable_delete BEFORE DELETE ON artifact_upload_parts BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_PART_IMMUTABLE');
END;

-- Reserve one digest before storing bytes, then acknowledge it only after R2
-- succeeded. A retry keeps the original digest even when acknowledgment failed.
CREATE TRIGGER artifact_part_acknowledged BEFORE UPDATE ON artifact_upload_parts
WHEN NOT EXISTS (
  SELECT 1 FROM artifact_uploads u JOIN artifact_upload_write_authority a
    ON a.credential_id = u.credential_id AND a.fellow_id = u.fellow_id
      AND a.sponsor_id = u.sponsor_id AND a.session_id = u.session_id AND a.problem_id = u.problem_id
  WHERE u.upload_id = NEW.upload_id AND u.credential_id = NEW.credential_id
    AND u.state = 'presigned' AND u.expires_at > NEW.acknowledged_at
    AND u.lease_token = NEW.lease_token AND u.lease_until > NEW.acknowledged_at
    AND a.issued_at <= NEW.acknowledged_at AND a.expires_at > NEW.acknowledged_at
    AND a.opened_at <= strftime('%Y-%m-%dT%H:%M:%fZ', NEW.acknowledged_at / 1000.0, 'unixepoch')
    AND a.idle_close_at > strftime('%Y-%m-%dT%H:%M:%fZ', NEW.acknowledged_at / 1000.0, 'unixepoch')
    AND (json_extract(a.granted_resources_json, '$.fellowGrantExpiresAt') IS NULL
      OR json_extract(a.granted_resources_json, '$.fellowGrantExpiresAt') > NEW.acknowledged_at)
    AND (json_extract(a.granted_resources_json, '$.eventBudget') IS NULL OR
      (SELECT COUNT(*) FROM events e WHERE e.writer_credential_id = a.credential_id)
        < json_extract(a.granted_resources_json, '$.eventBudget'))
    AND (json_extract(a.granted_resources_json, '$.artifactBudgetBytes') IS NULL OR
      (SELECT COALESCE(SUM(size_bytes), 0) FROM artifact_uploads WHERE fellow_id = a.fellow_id)
        <= json_extract(a.granted_resources_json, '$.artifactBudgetBytes'))
) BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_AUTHORITY_CHANGED');
END;

-- The old sealed declaration remains replayable but new whole-object grants
-- cannot be issued after the manifest chooses private parts.
CREATE TRIGGER artifact_resumable_no_renewal BEFORE INSERT ON artifact_put_renewals
WHEN EXISTS (SELECT 1 FROM artifact_resumable_uploads WHERE upload_id = NEW.upload_id)
BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_STATE_CONFLICT');
END;
