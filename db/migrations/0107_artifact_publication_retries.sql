-- asimposium:allow-destructive
-- Owner recovery settles existing consent. It neither replaces a publication
-- nor replenishes the original screening/attempt/byte reservations.
ALTER TABLE artifact_publication_jobs ADD COLUMN retry_generation INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(retry_generation) = 'integer' AND retry_generation BETWEEN 0 AND 8);

CREATE TABLE artifact_publication_retries (
  retry_id TEXT PRIMARY KEY CHECK (length(retry_id) = 36 AND substr(retry_id,1,4) = 'APR-'
    AND substr(retry_id,5) NOT GLOB '*[^a-f0-9]*'),
  publication_id TEXT NOT NULL REFERENCES artifact_publications(publication_id),
  retry_generation INTEGER NOT NULL CHECK (typeof(retry_generation) = 'integer' AND retry_generation BETWEEN 1 AND 8),
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  sponsor_id TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES fellow_tokens(credential_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  key_hash TEXT NOT NULL CHECK (length(key_hash) = 64 AND key_hash NOT GLOB '*[^a-f0-9]*'),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^a-f0-9]*'),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  held_at INTEGER NOT NULL CHECK (typeof(held_at) = 'integer' AND held_at > 0 AND held_at <= created_at),
  prior_attempts INTEGER NOT NULL CHECK (typeof(prior_attempts) = 'integer' AND prior_attempts BETWEEN 0 AND 1000000),
  prior_screen_attempts INTEGER NOT NULL CHECK (typeof(prior_screen_attempts) = 'integer' AND prior_screen_attempts BETWEEN 0 AND 2),
  prior_last_screen_json TEXT CHECK (prior_last_screen_json IS NULL OR (json_valid(prior_last_screen_json) AND length(prior_last_screen_json) <= 4096)),
  target_event_id TEXT NOT NULL REFERENCES events(id),
  target_sha256 TEXT NOT NULL CHECK (length(target_sha256) = 64 AND target_sha256 NOT GLOB '*[^a-f0-9]*'),
  UNIQUE(publication_id,retry_generation),
  UNIQUE(fellow_id,key_hash)
);

-- Keep every historical generation-zero audit row and its original identity.
-- Recovery cycles have their own append-only, generation-qualified history;
-- queued/held may recur without erasing or ignoring an earlier transition.
CREATE TABLE artifact_publication_retry_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id TEXT NOT NULL,
  retry_generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','held','release-authorized','published')),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  attempts INTEGER NOT NULL CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 1000000),
  screen_attempts INTEGER NOT NULL CHECK (typeof(screen_attempts) = 'integer' AND screen_attempts BETWEEN 0 AND 3),
  failure_code TEXT CHECK (failure_code IN ('screening-held','dependency-unavailable','binding-unavailable','content-unavailable')),
  UNIQUE(publication_id,retry_generation,state),
  FOREIGN KEY(publication_id,retry_generation) REFERENCES artifact_publication_retries(publication_id,retry_generation)
);

CREATE TRIGGER artifact_publication_retry_authorized BEFORE INSERT ON artifact_publication_retries
WHEN NOT EXISTS (
  SELECT 1 FROM artifact_publication_jobs j
  JOIN artifact_publications b USING(publication_id)
  JOIN artifact_uploads u ON u.upload_id = b.upload_id AND u.state = 'verified'
    AND u.fellow_id = b.fellow_id AND u.sponsor_id = b.sponsor_id AND u.problem_id = b.problem_id
    AND u.sha256 = b.sha256 AND u.size_bytes = b.size_bytes AND u.encoding = b.encoding AND u.content_type = b.content_type
  JOIN artifact_upload_write_authority a ON a.credential_id = NEW.credential_id
    AND a.fellow_id = b.fellow_id AND a.sponsor_id = b.sponsor_id
    AND a.problem_id = b.problem_id AND a.session_id = NEW.session_id
  JOIN fellow_tokens t ON t.credential_id = a.credential_id
  JOIN artifact_publication_evidence v ON v.problem_id = b.problem_id AND v.evidence_id = b.evidence_id
    AND v.evidence_event_id = b.evidence_event_id AND v.evidence_sha256 = b.evidence_sha256
    AND v.fellow_id = b.fellow_id AND v.sponsor_id = b.sponsor_id
    AND v.target_event_id = NEW.target_event_id AND v.target_sha256 = NEW.target_sha256
  JOIN events e ON e.id = b.event_id AND e.problem_id = b.problem_id
    AND e.object_id = b.publication_id AND e.object_kind = 'artifact' AND e.object_version = 1
    AND e.type = 'artifact.publication-requested' AND e.payload_sha256 = b.event_sha256
    AND e.actor_fellow_id = b.fellow_id AND e.actor_sponsor_id = b.sponsor_id
  JOIN problems p ON p.id = e.problem_id AND p.status <> 'private-draft' AND e.seq <= p.public_seq
  JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
  WHERE j.publication_id = NEW.publication_id AND b.fellow_id = NEW.fellow_id AND b.sponsor_id = NEW.sponsor_id
    AND j.state = 'held' AND j.failure_code = 'binding-unavailable' AND j.screen_attempts < 3
    AND j.retry_generation < 8 AND NEW.retry_generation = j.retry_generation + 1
    AND j.updated_at = NEW.held_at AND j.attempts = NEW.prior_attempts
    AND j.screen_attempts = NEW.prior_screen_attempts AND j.last_screen_json IS NEW.prior_last_screen_json
    AND j.released_at IS NULL AND j.screen_receipt_json IS NULL AND j.published_at IS NULL
    AND j.delivery_cursor IS NULL AND j.lease_token IS NULL AND j.lease_until IS NULL
    AND (j.last_screen_json IS NULL OR (json_type(j.last_screen_json) = 'object'
      AND json_extract(j.last_screen_json,'$.provider_status') IN ('ok','error','timeout')
      AND json_extract(j.last_screen_json,'$.decision') IN ('pass','allow-with-warning','quarantine','reject')
      AND (json_extract(j.last_screen_json,'$.provider_status') <> 'ok'
        OR json_extract(j.last_screen_json,'$.decision') = 'pass')))
    AND json_valid(t.granted_scopes_json) AND json_type(t.granted_scopes_json) = 'array'
    AND json_valid(a.granted_resources_json) AND json_type(a.granted_resources_json) = 'object'
    AND EXISTS (SELECT 1 FROM json_each(t.granted_scopes_json) scope WHERE scope.value = 'promote')
    AND a.issued_at <= NEW.created_at AND a.expires_at > NEW.created_at
    AND a.opened_at <= strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at / 1000.0,'unixepoch')
    AND a.idle_close_at > strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at / 1000.0,'unixepoch')
    AND (json_extract(a.granted_resources_json,'$.fellowGrantExpiresAt') IS NULL
      OR (json_type(a.granted_resources_json,'$.fellowGrantExpiresAt') = 'integer'
        AND json_extract(a.granted_resources_json,'$.fellowGrantExpiresAt') > NEW.created_at))
    AND (json_extract(a.granted_resources_json,'$.eventBudget') IS NULL
      OR (json_type(a.granted_resources_json,'$.eventBudget') = 'integer'
        AND (SELECT COUNT(*) FROM events used WHERE used.writer_credential_id = a.credential_id)
          <= json_extract(a.granted_resources_json,'$.eventBudget')))
    AND (json_extract(a.granted_resources_json,'$.artifactBudgetBytes') IS NULL
      OR (json_type(a.granted_resources_json,'$.artifactBudgetBytes') = 'integer'
        AND (SELECT COALESCE(SUM(size_bytes),0) FROM artifact_uploads used WHERE used.fellow_id = a.fellow_id)
          <= json_extract(a.granted_resources_json,'$.artifactBudgetBytes')))
    AND NOT EXISTS (SELECT 1 FROM content_controls cc WHERE cc.problem_id = e.problem_id
      AND cc.target_ref IN ('problem',e.object_id,e.object_id || '@' || e.object_version,'#' || e.seq)
      AND cc.visibility = 'hidden' AND cc.version = (
        SELECT MAX(latest.version) FROM content_controls latest
        WHERE latest.problem_id = cc.problem_id AND latest.target_ref = cc.target_ref))
) BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_RETRY_REFUSED'); END;

DROP TRIGGER artifact_publication_job_transition;
CREATE TRIGGER artifact_publication_job_transition BEFORE UPDATE ON artifact_publication_jobs
WHEN NEW.publication_id IS NOT OLD.publication_id OR NEW.updated_at < OLD.updated_at
  OR NEW.attempts < OLD.attempts OR NEW.screen_attempts < OLD.screen_attempts
  OR OLD.state = 'published'
  OR (OLD.state <> 'held' AND NEW.retry_generation IS NOT OLD.retry_generation)
  OR (OLD.state = 'release-authorized' AND (NEW.state NOT IN ('release-authorized','published')
    OR NEW.screen_receipt_json IS NOT OLD.screen_receipt_json OR NEW.released_at IS NOT OLD.released_at))
  OR (OLD.state = 'queued' AND NEW.state NOT IN ('queued','held','release-authorized'))
  OR (OLD.state = 'held' AND (NEW.state <> 'queued'
    OR NEW.retry_generation <> OLD.retry_generation + 1
    OR NEW.attempts IS NOT OLD.attempts OR NEW.screen_attempts IS NOT OLD.screen_attempts
    OR NEW.last_screen_json IS NOT OLD.last_screen_json OR NEW.failure_code IS NOT NULL
    OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL
    OR NEW.released_at IS NOT NULL OR NEW.screen_receipt_json IS NOT NULL
    OR NEW.published_at IS NOT NULL OR NEW.delivery_cursor IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM artifact_publication_retries r WHERE r.publication_id = OLD.publication_id
      AND r.retry_generation = NEW.retry_generation AND r.held_at = OLD.updated_at
      AND r.created_at = NEW.updated_at AND r.created_at = NEW.next_attempt_at
      AND r.prior_attempts = OLD.attempts AND r.prior_screen_attempts = OLD.screen_attempts
      AND r.prior_last_screen_json IS OLD.last_screen_json)))
BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_STATE_CONFLICT'); END;

CREATE TRIGGER artifact_publication_retry_enqueue AFTER INSERT ON artifact_publication_retries BEGIN
  UPDATE artifact_publication_jobs SET state = 'queued', retry_generation = NEW.retry_generation,
    updated_at = NEW.created_at, next_attempt_at = NEW.created_at, failure_code = NULL
  WHERE publication_id = NEW.publication_id AND state = 'held'
    AND retry_generation = NEW.retry_generation - 1 AND updated_at = NEW.held_at;
  SELECT CASE WHEN changes() = 1 THEN 1 ELSE RAISE(ABORT,'ARTIFACT_PUBLICATION_RETRY_REFUSED') END;
END;

DROP TRIGGER artifact_publication_state_audit;
CREATE TRIGGER artifact_publication_state_audit AFTER UPDATE OF state ON artifact_publication_jobs
WHEN NEW.state <> OLD.state BEGIN
  INSERT INTO artifact_publication_audit(publication_id,state,created_at)
    SELECT NEW.publication_id,NEW.state,NEW.updated_at WHERE NEW.retry_generation = 0;
  INSERT INTO artifact_publication_retry_audit(publication_id,retry_generation,state,created_at,attempts,screen_attempts,failure_code)
    SELECT NEW.publication_id,NEW.retry_generation,NEW.state,NEW.updated_at,NEW.attempts,NEW.screen_attempts,NEW.failure_code
    WHERE NEW.retry_generation > 0;
END;

CREATE TRIGGER artifact_publication_retry_no_update BEFORE UPDATE ON artifact_publication_retries BEGIN
  SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_RETRY_IMMUTABLE');
END;
CREATE TRIGGER artifact_publication_retry_no_delete BEFORE DELETE ON artifact_publication_retries BEGIN
  SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_RETRY_IMMUTABLE');
END;
CREATE TRIGGER artifact_publication_retry_audit_no_update BEFORE UPDATE ON artifact_publication_retry_audit BEGIN
  SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_AUDIT_IMMUTABLE');
END;
CREATE TRIGGER artifact_publication_retry_audit_no_delete BEFORE DELETE ON artifact_publication_retry_audit BEGIN
  SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_AUDIT_IMMUTABLE');
END;
