-- Fable §7.9/§10.4: private, byte-verified artifact uploads. This migration
-- does not publish bytes, add ledger evidence, or confer scientific standing.
CREATE TABLE artifact_uploads (
  upload_id TEXT PRIMARY KEY CHECK (length(upload_id) = 35 AND substr(upload_id, 1, 3) = 'AU-'
    AND substr(upload_id, 4) NOT GLOB '*[^a-f0-9]*'),
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  credential_id TEXT NOT NULL REFERENCES fellow_tokens(credential_id),
  sponsor_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
  size_bytes INTEGER NOT NULL CHECK (typeof(size_bytes) = 'integer' AND size_bytes BETWEEN 1 AND 20971520),
  encoding TEXT NOT NULL CHECK (encoding IN ('text', 'lake-archive')),
  state TEXT NOT NULL DEFAULT 'presigned' CHECK (state IN ('presigned', 'verified', 'quarantined', 'expired')),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at),
  expires_at INTEGER NOT NULL CHECK (expires_at = created_at + 86400000),
  put_expires_at INTEGER NOT NULL CHECK (put_expires_at > created_at AND put_expires_at <= created_at + 900000),
  key_hash TEXT NOT NULL CHECK (length(key_hash) = 64 AND key_hash NOT GLOB '*[^a-f0-9]*'),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^a-f0-9]*'),
  replay_ciphertext TEXT NOT NULL,
  replay_iv TEXT NOT NULL,
  sponsor_daily_bytes INTEGER NOT NULL CHECK (typeof(sponsor_daily_bytes) = 'integer' AND sponsor_daily_bytes BETWEEN 1 AND 10737418240),
  fellow_daily_manifests INTEGER NOT NULL CHECK (typeof(fellow_daily_manifests) = 'integer' AND fellow_daily_manifests BETWEEN 1 AND 1000),
  lease_token TEXT,
  lease_until INTEGER,
  content_type TEXT CHECK (content_type IN ('text/plain; charset=utf-8', 'application/gzip')),
  inspected_members INTEGER,
  expanded_bytes INTEGER,
  verified_at INTEGER,
  failure_code TEXT CHECK (failure_code IN ('CONTENT_REFUSED', 'MANIFEST_MISMATCH')),
  UNIQUE (fellow_id, key_hash),
  CHECK (encoding <> 'text' OR size_bytes <= 5242880),
  CHECK ((lease_token IS NULL AND lease_until IS NULL) OR
    (state = 'presigned' AND lease_token IS NOT NULL AND length(lease_token) = 32 AND lease_token NOT GLOB '*[^a-f0-9]*'
      AND typeof(lease_until) = 'integer' AND lease_until > updated_at)),
  CHECK ((state = 'verified' AND content_type IS NOT NULL AND typeof(inspected_members) = 'integer' AND inspected_members BETWEEN 1 AND 4096
    AND typeof(expanded_bytes) = 'integer' AND expanded_bytes BETWEEN 1 AND 67108864
    AND typeof(verified_at) = 'integer' AND verified_at = updated_at AND lease_token IS NULL
    AND failure_code IS NULL) OR (state <> 'verified' AND content_type IS NULL AND inspected_members IS NULL
    AND expanded_bytes IS NULL AND verified_at IS NULL)),
  CHECK ((state = 'quarantined' AND failure_code IS NOT NULL) OR (state <> 'quarantined' AND failure_code IS NULL))
);
CREATE INDEX artifact_uploads_fellow_budget_idx ON artifact_uploads (fellow_id, created_at, size_bytes);
CREATE INDEX artifact_uploads_sponsor_budget_idx ON artifact_uploads (sponsor_id, created_at, size_bytes);
CREATE INDEX artifact_uploads_pending_idx ON artifact_uploads (expires_at) WHERE state = 'presigned';

-- Operational leases are not scientific events. Each durable upload-state
-- transition, however, retains exactly one private audit event in its batch.
CREATE TABLE artifact_upload_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  upload_id TEXT NOT NULL REFERENCES artifact_uploads(upload_id),
  state TEXT NOT NULL CHECK (state IN ('presigned', 'verified', 'quarantined', 'expired')),
  created_at INTEGER NOT NULL,
  UNIQUE (upload_id, state)
);
CREATE TRIGGER artifact_upload_created AFTER INSERT ON artifact_uploads BEGIN
  INSERT INTO artifact_upload_events (upload_id, state, created_at) VALUES (NEW.upload_id, NEW.state, NEW.created_at);
END;
CREATE TRIGGER artifact_upload_transition AFTER UPDATE OF state ON artifact_uploads
WHEN NEW.state <> OLD.state BEGIN
  INSERT INTO artifact_upload_events (upload_id, state, created_at) VALUES (NEW.upload_id, NEW.state, NEW.updated_at);
END;
CREATE TRIGGER artifact_upload_events_immutable_update BEFORE UPDATE ON artifact_upload_events BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_AUDIT_IMMUTABLE');
END;
CREATE TRIGGER artifact_upload_events_immutable_delete BEFORE DELETE ON artifact_upload_events BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_AUDIT_IMMUTABLE');
END;
CREATE TRIGGER artifact_upload_immutable BEFORE UPDATE ON artifact_uploads
WHEN OLD.state <> 'presigned' OR NEW.upload_id IS NOT OLD.upload_id OR NEW.fellow_id IS NOT OLD.fellow_id
  OR NEW.credential_id IS NOT OLD.credential_id OR NEW.sponsor_id IS NOT OLD.sponsor_id
  OR NEW.session_id IS NOT OLD.session_id OR NEW.problem_id IS NOT OLD.problem_id
  OR NEW.sha256 IS NOT OLD.sha256 OR NEW.size_bytes IS NOT OLD.size_bytes OR NEW.encoding IS NOT OLD.encoding
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.put_expires_at IS NOT OLD.put_expires_at OR NEW.key_hash IS NOT OLD.key_hash
  OR NEW.request_digest IS NOT OLD.request_digest OR NEW.replay_ciphertext IS NOT OLD.replay_ciphertext
  OR NEW.replay_iv IS NOT OLD.replay_iv OR NEW.sponsor_daily_bytes IS NOT OLD.sponsor_daily_bytes
  OR NEW.fellow_daily_manifests IS NOT OLD.fellow_daily_manifests OR NEW.updated_at < OLD.updated_at
  OR (NEW.state = 'expired' AND NEW.updated_at < OLD.expires_at)
  OR (NEW.state = 'verified' AND (OLD.lease_token IS NULL OR OLD.lease_until <= NEW.updated_at
    OR NEW.updated_at >= OLD.expires_at))
BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_STATE_CONFLICT');
END;
CREATE TRIGGER artifact_upload_no_delete BEFORE DELETE ON artifact_uploads BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_MANIFEST_IMMUTABLE');
END;

-- The same mutable authorization inputs are checked again inside admission
-- and completion transactions. A stale service-level preflight is not a grant.
CREATE VIEW artifact_upload_write_authority AS
SELECT c.credential_id, c.fellow_id, c.sponsor_id, c.issued_at, c.expires_at,
  c.granted_resources_json, s.session_id, s.problem_id, s.opened_at, s.idle_close_at
FROM fellow_tokens c
JOIN enrollment_fellows f ON f.fellow_id = c.fellow_id AND f.sponsor_id = c.sponsor_id AND f.status = 'active'
JOIN enrollment_grants g ON g.fellow_id = f.fellow_id AND g.sponsor_id = f.sponsor_id
  AND g.granted_scopes_json = c.granted_scopes_json AND g.granted_resources_json = c.granted_resources_json
JOIN sessions s ON s.fellow_id = f.fellow_id AND s.closed_at IS NULL
JOIN problem_memberships m ON m.problem_id = s.problem_id AND m.fellow_id = f.fellow_id
  AND m.role IN ('observer', 'contributor', 'steward')
WHERE c.revoked_at IS NULL AND c.credential_profile = 'bearer'
  AND EXISTS (SELECT 1 FROM json_each(c.granted_scopes_json) scope WHERE scope.value = 'upload-artifacts')
  AND NOT EXISTS (SELECT 1 FROM enrollment_sponsor_security sec WHERE sec.sponsor_id = c.sponsor_id AND sec.panic_at >= c.issued_at)
  AND (json_extract(c.granted_resources_json, '$.problemBinding') IS NULL
    OR json_extract(c.granted_resources_json, '$.problemBinding') = s.problem_id);

CREATE TRIGGER artifact_upload_authorized_insert BEFORE INSERT ON artifact_uploads
WHEN NEW.state <> 'presigned' OR NEW.lease_token IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM artifact_upload_write_authority a WHERE a.credential_id = NEW.credential_id
    AND a.fellow_id = NEW.fellow_id AND a.sponsor_id = NEW.sponsor_id
    AND a.session_id = NEW.session_id AND a.problem_id = NEW.problem_id
    AND a.issued_at <= NEW.updated_at AND a.expires_at > NEW.updated_at
    AND a.opened_at <= strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at / 1000.0, 'unixepoch')
    AND a.idle_close_at > strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at / 1000.0, 'unixepoch')
    AND (json_extract(a.granted_resources_json, '$.fellowGrantExpiresAt') IS NULL
      OR json_extract(a.granted_resources_json, '$.fellowGrantExpiresAt') > NEW.updated_at)
    AND (json_extract(a.granted_resources_json, '$.eventBudget') IS NULL OR
      (SELECT COUNT(*) FROM events e WHERE e.writer_credential_id = a.credential_id) < json_extract(a.granted_resources_json, '$.eventBudget'))
) BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_AUTHORITY_CHANGED');
END;
CREATE TRIGGER artifact_upload_authorized_verify BEFORE UPDATE ON artifact_uploads
WHEN (NEW.state = 'verified' OR NEW.lease_token IS NOT NULL) AND NOT EXISTS (
  SELECT 1 FROM artifact_upload_write_authority a WHERE a.credential_id = NEW.credential_id
    AND a.fellow_id = NEW.fellow_id AND a.sponsor_id = NEW.sponsor_id
    AND a.session_id = NEW.session_id AND a.problem_id = NEW.problem_id
    AND a.issued_at <= NEW.updated_at AND a.expires_at > NEW.updated_at
    AND a.idle_close_at > strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at / 1000.0, 'unixepoch')
    AND (json_extract(a.granted_resources_json, '$.fellowGrantExpiresAt') IS NULL
      OR json_extract(a.granted_resources_json, '$.fellowGrantExpiresAt') > NEW.updated_at)
) BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_AUTHORITY_CHANGED');
END;

-- Reserve bytes before issuing a PUT. Expiry, failed verification, duplicate
-- bytes and token rotation do not refund issued capabilities or reset a grant.
-- The Fellow daily ceiling is the plan's 200 MiB. Sponsor/count limits must be
-- explicit deployment configuration; there is no silently unlimited fallback.
CREATE TRIGGER artifact_upload_budget BEFORE INSERT ON artifact_uploads
WHEN (SELECT COALESCE(SUM(size_bytes), 0) FROM artifact_uploads
    WHERE fellow_id = NEW.fellow_id AND created_at > NEW.created_at - 86400000) > 209715200 - NEW.size_bytes
  OR (SELECT COALESCE(SUM(size_bytes), 0) FROM artifact_uploads
    WHERE sponsor_id = NEW.sponsor_id AND created_at > NEW.created_at - 86400000) > NEW.sponsor_daily_bytes - NEW.size_bytes
  OR (SELECT COUNT(*) FROM artifact_uploads
    WHERE fellow_id = NEW.fellow_id AND created_at > NEW.created_at - 86400000) >= NEW.fellow_daily_manifests
  OR EXISTS (SELECT 1 FROM enrollment_grants g WHERE g.fellow_id = NEW.fellow_id
    AND json_extract(g.granted_resources_json, '$.artifactBudgetBytes') IS NOT NULL
    AND (SELECT COALESCE(SUM(size_bytes), 0) FROM artifact_uploads WHERE fellow_id = NEW.fellow_id)
      > json_extract(g.granted_resources_json, '$.artifactBudgetBytes') - NEW.size_bytes)
BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_BUDGET_EXHAUSTED');
END;
