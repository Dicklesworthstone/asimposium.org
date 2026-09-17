-- Explicit publication is a separate, irreversible command. Upload verification
-- remains private and byte-only. No scientific evidence row is changed here.
CREATE VIEW artifact_publication_evidence AS
SELECT v.problem_id, v.evidence_id, e.id AS evidence_event_id,
  e.payload_sha256 AS evidence_sha256, c.payload_json AS evidence_json,
  e.actor_fellow_id AS fellow_id, e.actor_sponsor_id AS sponsor_id
FROM evidence v JOIN events e ON e.problem_id = v.problem_id AND e.object_id = v.evidence_id
  AND e.object_kind = 'evidence' AND e.type = 'evidence.created' AND e.object_version = 1
  AND e.actor_fellow_id = v.author_fellow_id
JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
JOIN problems p ON p.id = e.problem_id AND p.status <> 'private-draft' AND e.seq <= p.public_seq
WHERE length(CAST(c.payload_json AS BLOB)) BETWEEN 1 AND 524288;

CREATE TABLE artifact_publications (
  publication_id TEXT PRIMARY KEY CHECK (length(publication_id) = 35 AND substr(publication_id,1,3) = 'AP-'
    AND substr(publication_id,4) NOT GLOB '*[^a-f0-9]*'),
  event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
  event_sha256 TEXT NOT NULL CHECK (length(event_sha256) = 64 AND event_sha256 NOT GLOB '*[^a-f0-9]*'),
  upload_id TEXT NOT NULL REFERENCES artifact_uploads(upload_id),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  evidence_id TEXT NOT NULL,
  evidence_event_id TEXT NOT NULL REFERENCES events(id),
  evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^a-f0-9]*'),
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  sponsor_id TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES fellow_tokens(credential_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  reservation_id TEXT NOT NULL UNIQUE REFERENCES public_write_attempt_reservations(reservation_id),
  key_hash TEXT NOT NULL CHECK (length(key_hash) = 64 AND key_hash NOT GLOB '*[^a-f0-9]*'),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^a-f0-9]*'),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
  size_bytes INTEGER NOT NULL CHECK (typeof(size_bytes) = 'integer' AND size_bytes BETWEEN 1 AND 20971520),
  encoding TEXT NOT NULL CHECK (encoding IN ('text','lake-archive')),
  content_type TEXT NOT NULL CHECK (content_type IN ('text/plain; charset=utf-8','application/gzip')),
  screening_sha256 TEXT NOT NULL CHECK (length(screening_sha256) = 64 AND screening_sha256 NOT GLOB '*[^a-f0-9]*'),
  artifact_origin TEXT NOT NULL CHECK (artifact_origin IN ('https://artifacts.asimposium.org','https://artifacts-staging.asimposium.org')),
  license TEXT NOT NULL CHECK (license = 'CC-BY-4.0'),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  UNIQUE (fellow_id,key_hash),
  UNIQUE (upload_id,evidence_event_id),
  FOREIGN KEY (problem_id,evidence_id) REFERENCES evidence(problem_id,evidence_id)
);

CREATE TRIGGER artifact_publications_authorized BEFORE INSERT ON artifact_publications
WHEN NOT EXISTS (
  SELECT 1 FROM artifact_uploads u
  JOIN artifact_upload_write_authority a ON a.credential_id = NEW.credential_id
    AND a.fellow_id = NEW.fellow_id AND a.sponsor_id = NEW.sponsor_id
    AND a.session_id = NEW.session_id AND a.problem_id = NEW.problem_id
  JOIN fellow_tokens t ON t.credential_id = a.credential_id
  JOIN problem_memberships m ON m.problem_id = a.problem_id AND m.fellow_id = a.fellow_id
    AND m.role IN ('contributor','steward')
  JOIN artifact_publication_evidence v ON v.problem_id = NEW.problem_id AND v.evidence_id = NEW.evidence_id
    AND v.evidence_event_id = NEW.evidence_event_id AND v.evidence_sha256 = NEW.evidence_sha256
    AND v.fellow_id = NEW.fellow_id AND v.sponsor_id = NEW.sponsor_id
  JOIN events e ON e.id = NEW.event_id AND e.problem_id = NEW.problem_id
    AND e.object_id = NEW.publication_id AND e.object_kind = 'artifact'
    AND e.type = 'artifact.publication-requested' AND e.object_version = 1
    AND e.payload_sha256 = NEW.event_sha256 AND e.writer_credential_id = NEW.credential_id
    AND e.actor_fellow_id = NEW.fellow_id AND e.actor_sponsor_id = NEW.sponsor_id
    AND e.actor_session_id = NEW.session_id
  JOIN public_write_attempt_reservations q ON q.reservation_id = NEW.reservation_id
    AND q.fellow_id = NEW.fellow_id AND q.sponsor_id = NEW.sponsor_id AND q.problem_id = NEW.problem_id
    AND q.session_id = NEW.session_id AND q.route = 'artifact.publish'
    AND q.idempotency_key = NEW.key_hash AND q.request_digest = NEW.request_digest
    AND q.status = 'reserved' AND q.reserved_at <= NEW.created_at AND q.expires_at > NEW.created_at
  WHERE u.upload_id = NEW.upload_id AND u.state = 'verified'
    AND u.fellow_id = NEW.fellow_id AND u.sponsor_id = NEW.sponsor_id AND u.problem_id = NEW.problem_id
    AND u.sha256 = NEW.sha256 AND u.size_bytes = NEW.size_bytes AND u.encoding = NEW.encoding
    AND u.content_type = NEW.content_type
    AND a.issued_at <= NEW.created_at AND a.expires_at > NEW.created_at
    AND a.opened_at <= strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at / 1000.0,'unixepoch')
    AND a.idle_close_at > strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at / 1000.0,'unixepoch')
    AND (json_extract(a.granted_resources_json,'$.fellowGrantExpiresAt') IS NULL
      OR json_extract(a.granted_resources_json,'$.fellowGrantExpiresAt') > NEW.created_at)
    AND EXISTS (SELECT 1 FROM json_each(t.granted_scopes_json) s WHERE s.value = 'promote')
    -- The associated event already exists at this point, hence <= rather than
    -- the pre-insert < check in centralized admission and migration 0038.
    AND (json_extract(a.granted_resources_json,'$.eventBudget') IS NULL OR
      (SELECT COUNT(*) FROM events used WHERE used.writer_credential_id = a.credential_id)
        <= json_extract(a.granted_resources_json,'$.eventBudget'))
) BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_AUTHORITY_CHANGED'); END;
CREATE TRIGGER artifact_publications_no_update BEFORE UPDATE ON artifact_publications BEGIN
  SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_IMMUTABLE');
END;
CREATE TRIGGER artifact_publications_no_delete BEFORE DELETE ON artifact_publications BEGIN
  SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_IMMUTABLE');
END;

CREATE TABLE artifact_publication_jobs (
  publication_id TEXT PRIMARY KEY REFERENCES artifact_publications(publication_id),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','held','release-authorized','published')),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at > 0),
  next_attempt_at INTEGER NOT NULL CHECK (typeof(next_attempt_at) = 'integer' AND next_attempt_at > 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 1000000),
  screen_attempts INTEGER NOT NULL DEFAULT 0 CHECK (typeof(screen_attempts) = 'integer' AND screen_attempts BETWEEN 0 AND 3),
  lease_token TEXT,
  lease_until INTEGER,
  last_screen_json TEXT CHECK (last_screen_json IS NULL OR (json_valid(last_screen_json) AND length(last_screen_json) <= 4096)),
  screen_receipt_json TEXT CHECK (screen_receipt_json IS NULL OR (json_valid(screen_receipt_json) AND length(screen_receipt_json) <= 4096)),
  released_at INTEGER CHECK (released_at IS NULL OR (typeof(released_at) = 'integer' AND released_at > 0 AND released_at <= updated_at)),
  delivery_cursor INTEGER UNIQUE CHECK (delivery_cursor IS NULL OR (typeof(delivery_cursor) = 'integer' AND delivery_cursor BETWEEN 1 AND 9007199254740991)),
  published_at INTEGER CHECK (published_at IS NULL OR (typeof(published_at) = 'integer' AND published_at <= updated_at)),
  failure_code TEXT CHECK (failure_code IN ('screening-held','dependency-unavailable','binding-unavailable','content-unavailable')),
  CHECK ((lease_token IS NULL AND lease_until IS NULL) OR (state IN ('queued','release-authorized')
    AND lease_token IS NOT NULL AND length(lease_token) = 32 AND lease_token NOT GLOB '*[^a-f0-9]*' AND typeof(lease_until) = 'integer' AND lease_until > updated_at)),
  CHECK ((state IN ('queued','held') AND released_at IS NULL AND screen_receipt_json IS NULL)
    OR (state IN ('release-authorized','published') AND released_at IS NOT NULL AND screen_receipt_json IS NOT NULL)),
  CHECK ((state = 'published' AND typeof(published_at) = 'integer' AND published_at >= released_at AND lease_token IS NULL AND failure_code IS NULL AND delivery_cursor IS NOT NULL)
    OR (state <> 'published' AND published_at IS NULL AND delivery_cursor IS NULL)),
  CHECK (state <> 'held' OR (failure_code IS NOT NULL AND lease_token IS NULL))
);
CREATE INDEX artifact_publication_jobs_due ON artifact_publication_jobs (next_attempt_at,publication_id)
  WHERE state IN ('queued','release-authorized');
CREATE TABLE artifact_publication_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id TEXT NOT NULL REFERENCES artifact_publications(publication_id),
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(publication_id,state)
);
CREATE TRIGGER artifact_publication_enqueued AFTER INSERT ON artifact_publications BEGIN
  INSERT INTO artifact_publication_jobs(publication_id,updated_at,next_attempt_at)
    VALUES(NEW.publication_id,NEW.created_at,NEW.created_at);
  INSERT INTO artifact_publication_audit(publication_id,state,created_at) VALUES(NEW.publication_id,'queued',NEW.created_at);
END;
CREATE TRIGGER artifact_publication_job_transition BEFORE UPDATE ON artifact_publication_jobs
WHEN NEW.publication_id IS NOT OLD.publication_id OR NEW.updated_at < OLD.updated_at
  OR NEW.attempts < OLD.attempts OR NEW.screen_attempts < OLD.screen_attempts
  OR OLD.state IN ('held','published')
  OR (OLD.state = 'release-authorized' AND (NEW.state NOT IN ('release-authorized','published')
    OR NEW.screen_receipt_json IS NOT OLD.screen_receipt_json OR NEW.released_at IS NOT OLD.released_at))
  OR (OLD.state = 'queued' AND NEW.state NOT IN ('queued','held','release-authorized'))
BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_STATE_CONFLICT'); END;
-- Durable pass receipt is bound to this exact artifact and complete screen.
-- 'allow-with-warning' is held until a direct-download warning surface exists.
CREATE TRIGGER artifact_publication_release_guard BEFORE UPDATE ON artifact_publication_jobs
WHEN OLD.state = 'queued' AND NEW.state = 'release-authorized' AND (
  OLD.lease_token IS NULL OR OLD.lease_token IS NOT NEW.lease_token OR OLD.lease_until <= NEW.updated_at
  OR NEW.released_at IS NOT NEW.updated_at OR NOT EXISTS (
    SELECT 1 FROM artifact_publications b
    JOIN artifact_publication_evidence v ON v.evidence_event_id = b.evidence_event_id
      AND v.evidence_sha256 = b.evidence_sha256 AND v.problem_id = b.problem_id
      AND v.evidence_id = b.evidence_id AND v.fellow_id = b.fellow_id AND v.sponsor_id = b.sponsor_id
    JOIN event_content c ON c.event_id = b.event_id AND c.payload_sha256 = b.event_sha256 AND c.redacted_at IS NULL
    WHERE b.publication_id = NEW.publication_id
      AND json_extract(NEW.screen_receipt_json,'$.version') = 'artifact-publication-policy-v1'
      AND json_extract(NEW.screen_receipt_json,'$.publication_id') = b.publication_id
      AND json_extract(NEW.screen_receipt_json,'$.artifact_sha256') = b.sha256
      AND json_extract(NEW.screen_receipt_json,'$.screening_sha256') = b.screening_sha256
      AND json_extract(NEW.screen_receipt_json,'$.evidence_sha256') = b.evidence_sha256
      AND json_extract(NEW.screen_receipt_json,'$.provider_status') = 'ok'
      AND json_extract(NEW.screen_receipt_json,'$.decision') = 'pass'
  )) BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_RELEASE_REFUSED'); END;
CREATE TRIGGER artifact_publication_state_audit AFTER UPDATE OF state ON artifact_publication_jobs
WHEN NEW.state <> OLD.state BEGIN
  INSERT INTO artifact_publication_audit(publication_id,state,created_at) VALUES(NEW.publication_id,NEW.state,NEW.updated_at);
END;
CREATE TRIGGER artifact_publication_published_guard BEFORE UPDATE OF state ON artifact_publication_jobs
WHEN NEW.state = 'published' AND (OLD.state <> 'release-authorized' OR OLD.lease_token IS NULL
  OR OLD.lease_until <= NEW.updated_at OR NEW.delivery_cursor IS NOT (SELECT cursor + 1 FROM public_cursor WHERE singleton = 1))
BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_DELIVERY_CONFLICT'); END;
CREATE TRIGGER artifact_publication_published_cursor AFTER UPDATE OF state ON artifact_publication_jobs
WHEN NEW.state = 'published' AND OLD.state <> 'published' BEGIN
  UPDATE public_cursor SET cursor = cursor + 1 WHERE singleton = 1;
END;
CREATE TRIGGER artifact_publication_job_no_delete BEFORE DELETE ON artifact_publication_jobs BEGIN
  SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_IMMUTABLE');
END;
CREATE TRIGGER artifact_publication_audit_no_update BEFORE UPDATE ON artifact_publication_audit BEGIN
  SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_AUDIT_IMMUTABLE');
END;
CREATE TRIGGER artifact_publication_audit_no_delete BEFORE DELETE ON artifact_publication_audit BEGIN
  SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_AUDIT_IMMUTABLE');
END;
