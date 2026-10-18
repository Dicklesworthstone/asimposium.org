-- Refresh a private whole-object PUT without minting another byte reservation
-- or extending the immutable manifest's completion/replay deadline. Original
-- declaration receipts stay immutable; each renewal has its own sealed replay.
CREATE TABLE artifact_put_renewals (
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  key_hash TEXT NOT NULL CHECK (length(key_hash) = 64 AND key_hash NOT GLOB '*[^a-f0-9]*'),
  upload_id TEXT NOT NULL REFERENCES artifact_uploads(upload_id),
  credential_id TEXT NOT NULL REFERENCES fellow_tokens(credential_id),
  sponsor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  authorized_at INTEGER NOT NULL CHECK (typeof(authorized_at) = 'integer' AND authorized_at >= created_at),
  put_expires_at INTEGER NOT NULL CHECK (typeof(put_expires_at) = 'integer'
    AND put_expires_at > authorized_at AND put_expires_at <= created_at + 900000),
  replay_ciphertext TEXT NOT NULL,
  replay_iv TEXT NOT NULL,
  PRIMARY KEY (fellow_id, key_hash)
);
CREATE INDEX artifact_put_renewals_upload_idx ON artifact_put_renewals (upload_id, put_expires_at);

CREATE TRIGGER artifact_put_renewal_state BEFORE INSERT ON artifact_put_renewals
WHEN NOT EXISTS (
  SELECT 1 FROM artifact_uploads u WHERE u.upload_id = NEW.upload_id
    AND u.state = 'presigned' AND u.expires_at > NEW.authorized_at
    AND NEW.put_expires_at <= u.expires_at
    AND (u.lease_until IS NULL OR u.lease_until <= NEW.authorized_at)
) BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_STATE_CONFLICT');
END;

CREATE TRIGGER artifact_put_renewal_authorized BEFORE INSERT ON artifact_put_renewals
WHEN NOT EXISTS (
  SELECT 1 FROM artifact_uploads u JOIN artifact_upload_write_authority a
    ON a.credential_id = u.credential_id AND a.fellow_id = u.fellow_id
      AND a.sponsor_id = u.sponsor_id AND a.session_id = u.session_id AND a.problem_id = u.problem_id
  WHERE u.upload_id = NEW.upload_id AND u.fellow_id = NEW.fellow_id
    AND u.credential_id = NEW.credential_id AND u.sponsor_id = NEW.sponsor_id
    AND a.issued_at <= NEW.authorized_at AND a.expires_at > NEW.authorized_at
    AND a.opened_at <= strftime('%Y-%m-%dT%H:%M:%fZ', NEW.authorized_at / 1000.0, 'unixepoch')
    AND a.idle_close_at > strftime('%Y-%m-%dT%H:%M:%fZ', NEW.authorized_at / 1000.0, 'unixepoch')
    AND (json_extract(a.granted_resources_json, '$.fellowGrantExpiresAt') IS NULL
      OR json_extract(a.granted_resources_json, '$.fellowGrantExpiresAt') > NEW.authorized_at)
    AND (json_extract(a.granted_resources_json, '$.eventBudget') IS NULL OR
      (SELECT COUNT(*) FROM events e WHERE e.writer_credential_id = a.credential_id)
        < json_extract(a.granted_resources_json, '$.eventBudget'))
    AND (json_extract(a.granted_resources_json, '$.artifactBudgetBytes') IS NULL OR
      (SELECT COALESCE(SUM(size_bytes), 0) FROM artifact_uploads WHERE fellow_id = a.fellow_id)
        <= json_extract(a.granted_resources_json, '$.artifactBudgetBytes'))
) BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_AUTHORITY_CHANGED');
END;

-- Bound capability/replay storage even if a client repeatedly chooses new keys.
-- Renewal never touches the original manifest/byte/count reservation.
CREATE TRIGGER artifact_put_renewal_budget BEFORE INSERT ON artifact_put_renewals
WHEN (SELECT COUNT(*) FROM artifact_put_renewals WHERE upload_id = NEW.upload_id) >= 96
BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_RENEWAL_LIMIT');
END;
CREATE TRIGGER artifact_put_renewal_immutable_update BEFORE UPDATE ON artifact_put_renewals BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_RENEWAL_IMMUTABLE');
END;
CREATE TRIGGER artifact_put_renewal_immutable_delete BEFORE DELETE ON artifact_put_renewals BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_RENEWAL_IMMUTABLE');
END;
