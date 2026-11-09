-- asimposium:allow-destructive
-- Declaration provenance never changes. Each explicit resumption appends a
-- separate current authorization, without extending the manifest or its budget.
CREATE TABLE artifact_upload_authorizations (
  upload_id TEXT NOT NULL REFERENCES artifact_uploads(upload_id),
  generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation BETWEEN 0 AND 96),
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  sponsor_id TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES fellow_tokens(credential_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  authorized_at INTEGER NOT NULL CHECK (typeof(authorized_at) = 'integer' AND authorized_at > 0),
  key_hash TEXT,
  PRIMARY KEY (upload_id, generation),
  UNIQUE (fellow_id, key_hash),
  CHECK ((generation = 0 AND key_hash IS NULL) OR
    (generation > 0 AND key_hash IS NOT NULL AND length(key_hash) = 64 AND key_hash NOT GLOB '*[^a-f0-9]*'))
);
CREATE INDEX artifact_upload_authorizations_session_idx ON artifact_upload_authorizations(session_id);
INSERT INTO artifact_upload_authorizations
  (upload_id, generation, fellow_id, sponsor_id, credential_id, session_id, authorized_at)
SELECT upload_id, 0, fellow_id, sponsor_id, credential_id, session_id, created_at
FROM artifact_uploads;

-- REPLACE must not remove an earlier immutable receipt through a uniqueness
-- collision when recursive delete triggers are disabled by the SQL provider.
CREATE TRIGGER artifact_upload_authority_no_duplicate_insert BEFORE INSERT ON artifact_upload_authorizations
WHEN EXISTS (SELECT 1 FROM artifact_upload_authorizations r
  WHERE (r.upload_id = NEW.upload_id AND r.generation = NEW.generation)
    OR (NEW.key_hash IS NOT NULL AND r.fellow_id = NEW.fellow_id AND r.key_hash = NEW.key_hash))
BEGIN SELECT RAISE(ABORT, 'ARTIFACT_STATE_CONFLICT'); END;

CREATE TRIGGER artifact_upload_initial_authority AFTER INSERT ON artifact_uploads BEGIN
  INSERT INTO artifact_upload_authorizations
    (upload_id, generation, fellow_id, sponsor_id, credential_id, session_id, authorized_at)
  VALUES (NEW.upload_id, 0, NEW.fellow_id, NEW.sponsor_id, NEW.credential_id, NEW.session_id, NEW.created_at);
END;
CREATE TRIGGER artifact_upload_initial_authority_guard BEFORE INSERT ON artifact_upload_authorizations
WHEN NEW.generation = 0 AND NOT EXISTS (
  SELECT 1 FROM artifact_uploads u WHERE u.upload_id = NEW.upload_id
    AND u.fellow_id = NEW.fellow_id AND u.sponsor_id = NEW.sponsor_id
    AND u.credential_id = NEW.credential_id AND u.session_id = NEW.session_id
    AND u.created_at = NEW.authorized_at
) BEGIN SELECT RAISE(ABORT, 'ARTIFACT_AUTHORITY_CHANGED'); END;

CREATE TRIGGER artifact_upload_resume_state BEFORE INSERT ON artifact_upload_authorizations
WHEN NEW.generation > 0 AND NOT EXISTS (
  SELECT 1 FROM artifact_uploads u WHERE u.upload_id = NEW.upload_id
    AND u.state = 'presigned' AND u.expires_at > NEW.authorized_at
    AND u.updated_at <= NEW.authorized_at
    AND (u.lease_until IS NULL OR u.lease_until <= NEW.authorized_at)
    AND NEW.generation = 1 + (SELECT MAX(generation) FROM artifact_upload_authorizations
      WHERE upload_id = NEW.upload_id)
) BEGIN SELECT RAISE(ABORT, 'ARTIFACT_STATE_CONFLICT'); END;

CREATE TRIGGER artifact_upload_resume_authorized BEFORE INSERT ON artifact_upload_authorizations
WHEN NEW.generation > 0 AND NOT EXISTS (
  SELECT 1 FROM artifact_uploads u
  JOIN artifact_upload_write_authority a ON a.credential_id = NEW.credential_id
    AND a.session_id = NEW.session_id AND a.problem_id = u.problem_id
    AND a.fellow_id = u.fellow_id AND a.sponsor_id = u.sponsor_id
  WHERE u.upload_id = NEW.upload_id AND u.fellow_id = NEW.fellow_id AND u.sponsor_id = NEW.sponsor_id
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
    AND NOT EXISTS (SELECT 1 FROM private_draft_erasures erased WHERE erased.problem_id = u.problem_id)
) BEGIN SELECT RAISE(ABORT, 'ARTIFACT_AUTHORITY_CHANGED'); END;

-- A stale worker's expired lease is retired atomically with the new generation.
-- It can no longer finish, acknowledge bytes, quarantine, or clear a successor.
CREATE TRIGGER artifact_upload_resume_retire_lease AFTER INSERT ON artifact_upload_authorizations
WHEN NEW.generation > 0 BEGIN
  UPDATE artifact_uploads SET lease_token = NULL, lease_until = NULL, updated_at = NEW.authorized_at
    WHERE upload_id = NEW.upload_id;
END;
CREATE TRIGGER artifact_upload_authority_immutable_update BEFORE UPDATE ON artifact_upload_authorizations BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_AUTHORITY_IMMUTABLE');
END;
CREATE TRIGGER artifact_upload_authority_immutable_delete BEFORE DELETE ON artifact_upload_authorizations BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_AUTHORITY_IMMUTABLE');
END;

CREATE VIEW artifact_upload_effect_authority AS
SELECT u.upload_id, r.generation, a.*
FROM artifact_uploads u
JOIN artifact_upload_authorizations r ON r.upload_id = u.upload_id
  AND r.generation = (SELECT MAX(generation) FROM artifact_upload_authorizations WHERE upload_id = u.upload_id)
JOIN artifact_upload_write_authority a ON a.credential_id = r.credential_id AND a.session_id = r.session_id
  AND a.fellow_id = u.fellow_id AND a.sponsor_id = u.sponsor_id AND a.problem_id = u.problem_id
WHERE NOT EXISTS (SELECT 1 FROM private_draft_erasures erased WHERE erased.problem_id = u.problem_id);

DROP TRIGGER artifact_upload_authorized_verify;
CREATE TRIGGER artifact_upload_authorized_verify BEFORE UPDATE ON artifact_uploads
WHEN (NEW.state = 'verified' OR NEW.lease_token IS NOT NULL) AND NOT EXISTS (
  SELECT 1 FROM artifact_upload_effect_authority a WHERE a.upload_id = NEW.upload_id
    AND a.issued_at <= NEW.updated_at AND a.expires_at > NEW.updated_at
    AND a.opened_at <= strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at / 1000.0, 'unixepoch')
    AND a.idle_close_at > strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at / 1000.0, 'unixepoch')
    AND (json_extract(a.granted_resources_json, '$.fellowGrantExpiresAt') IS NULL
      OR json_extract(a.granted_resources_json, '$.fellowGrantExpiresAt') > NEW.updated_at)
    AND (json_extract(a.granted_resources_json, '$.eventBudget') IS NULL OR
      (SELECT COUNT(*) FROM events e WHERE e.writer_credential_id = a.credential_id)
        < json_extract(a.granted_resources_json, '$.eventBudget'))
    AND (json_extract(a.granted_resources_json, '$.artifactBudgetBytes') IS NULL OR
      (SELECT COALESCE(SUM(size_bytes), 0) FROM artifact_uploads WHERE fellow_id = a.fellow_id)
        <= json_extract(a.granted_resources_json, '$.artifactBudgetBytes'))
) BEGIN SELECT RAISE(ABORT, 'ARTIFACT_AUTHORITY_CHANGED'); END;

ALTER TABLE artifact_put_renewals ADD COLUMN authorization_generation INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(authorization_generation) = 'integer' AND authorization_generation BETWEEN 0 AND 96);
ALTER TABLE artifact_resumable_uploads ADD COLUMN authorization_generation INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(authorization_generation) = 'integer' AND authorization_generation BETWEEN 0 AND 96);
ALTER TABLE artifact_upload_parts ADD COLUMN authorization_generation INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(authorization_generation) = 'integer' AND authorization_generation BETWEEN 0 AND 96);
ALTER TABLE artifact_upload_parts ADD COLUMN acknowledged_credential_id TEXT REFERENCES fellow_tokens(credential_id);
ALTER TABLE artifact_upload_parts ADD COLUMN acknowledged_generation INTEGER
  CHECK (acknowledged_generation IS NULL OR
    (typeof(acknowledged_generation) = 'integer' AND acknowledged_generation BETWEEN 0 AND 96));

-- Preserve each part intent's author. A replacement credential may acknowledge
-- its pinned bytes, with separate attribution to the current authorization.
DROP TRIGGER artifact_part_immutable_update;
DROP TRIGGER artifact_part_acknowledged;
UPDATE artifact_upload_parts SET acknowledged_credential_id = credential_id, acknowledged_generation = 0
  WHERE acknowledged_at IS NOT NULL;
CREATE TRIGGER artifact_part_immutable_update BEFORE UPDATE ON artifact_upload_parts BEGIN
  SELECT CASE WHEN OLD.acknowledged_at IS NOT NULL OR NEW.acknowledged_at IS NULL
    OR NEW.acknowledged_credential_id IS NULL OR NEW.acknowledged_generation IS NULL
    OR NEW.upload_id IS NOT OLD.upload_id OR NEW.part_number IS NOT OLD.part_number
    OR NEW.credential_id IS NOT OLD.credential_id OR NEW.sha256 IS NOT OLD.sha256
    OR NEW.size_bytes IS NOT OLD.size_bytes OR NEW.created_at IS NOT OLD.created_at
    OR NEW.authorization_generation IS NOT OLD.authorization_generation
    THEN RAISE(ABORT, 'ARTIFACT_PART_IMMUTABLE') END;
END;

DROP TRIGGER artifact_put_renewal_authorized;
CREATE TRIGGER artifact_put_renewal_authorized BEFORE INSERT ON artifact_put_renewals
WHEN NOT EXISTS (
  SELECT 1 FROM artifact_upload_effect_authority a WHERE a.upload_id = NEW.upload_id
    AND a.credential_id = NEW.credential_id AND a.fellow_id = NEW.fellow_id AND a.sponsor_id = NEW.sponsor_id
    AND a.generation = NEW.authorization_generation
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
) BEGIN SELECT RAISE(ABORT, 'ARTIFACT_AUTHORITY_CHANGED'); END;

DROP TRIGGER artifact_resumable_authorized;
CREATE TRIGGER artifact_resumable_authorized BEFORE INSERT ON artifact_resumable_uploads
WHEN NOT EXISTS (
  SELECT 1 FROM artifact_uploads u JOIN artifact_upload_effect_authority a ON a.upload_id = u.upload_id
  WHERE u.upload_id = NEW.upload_id AND a.credential_id = NEW.credential_id AND a.generation = NEW.authorization_generation
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
) BEGIN SELECT RAISE(ABORT, 'ARTIFACT_AUTHORITY_CHANGED'); END;

DROP TRIGGER artifact_part_authorized;
CREATE TRIGGER artifact_part_authorized BEFORE INSERT ON artifact_upload_parts
WHEN NEW.acknowledged_at IS NOT NULL OR NEW.acknowledged_credential_id IS NOT NULL OR NEW.acknowledged_generation IS NOT NULL
  OR NOT EXISTS (
  SELECT 1 FROM artifact_uploads u JOIN artifact_upload_effect_authority a ON a.upload_id = u.upload_id
  WHERE u.upload_id = NEW.upload_id AND a.credential_id = NEW.credential_id AND a.generation = NEW.authorization_generation
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
) BEGIN SELECT RAISE(ABORT, 'ARTIFACT_AUTHORITY_CHANGED'); END;

CREATE TRIGGER artifact_part_acknowledged BEFORE UPDATE ON artifact_upload_parts
WHEN NOT EXISTS (
  SELECT 1 FROM artifact_uploads u JOIN artifact_upload_effect_authority a ON a.upload_id = u.upload_id
  WHERE u.upload_id = NEW.upload_id AND a.credential_id = NEW.acknowledged_credential_id
    AND a.generation = NEW.acknowledged_generation
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
) BEGIN SELECT RAISE(ABORT, 'ARTIFACT_AUTHORITY_CHANGED'); END;

-- Session skeletons referenced by immutable recovery receipts have the same
-- retention as original upload sessions. Scrub every session's private work
-- before retaining those skeletons; the FK must never block draft/account erasure.
DROP TRIGGER private_draft_erase_content;
CREATE TRIGGER private_draft_erase_content AFTER INSERT ON private_draft_erasures
BEGIN
  DELETE FROM workshop_revisions WHERE problem_id = NEW.problem_id;
  DELETE FROM workshop_objects WHERE problem_id = NEW.problem_id;
  DELETE FROM leases WHERE problem_id = NEW.problem_id;
  DELETE FROM problem_statement_versions WHERE problem_id = NEW.problem_id;
  DELETE FROM problem_memberships WHERE problem_id = NEW.problem_id;
  DELETE FROM problem_stewards WHERE problem_id = NEW.problem_id;
  DELETE FROM problem_follows WHERE problem_id = NEW.problem_id;
  DELETE FROM claims WHERE problem_id = NEW.problem_id;
  DELETE FROM krater_integrity_backfill WHERE problem_id = NEW.problem_id;
  DELETE FROM projection_health WHERE problem_id = NEW.problem_id;
  DELETE FROM herald_room_outbox WHERE problem_id = NEW.problem_id;
  UPDATE sponsor_directives
    SET body = CASE WHEN verb = 'unfocus' THEN NULL ELSE '[Private draft erased]' END
    WHERE problem_id = NEW.problem_id;
  UPDATE fellow_inbox_notices SET title = 'Private draft erased', detail = NULL,
    target_id = NULL, caused_by_event_id = NULL, impact_kind = NULL,
    acknowledged_at = COALESCE(acknowledged_at, created_at), expires_at = created_at
    WHERE problem_id = NEW.problem_id
      OR id IN (SELECT notice_id FROM sponsor_directives WHERE problem_id = NEW.problem_id);
  DELETE FROM fellow_inbox_notices WHERE problem_id = NEW.problem_id
    AND NOT EXISTS (SELECT 1 FROM sponsor_directives WHERE notice_id = fellow_inbox_notices.id);
  UPDATE screening_cases SET candidate_json = '{"erased":true}', contextual_input_json = NULL,
    state = CASE WHEN state = 'pending' THEN 'superseded' ELSE state END,
    decided_at = CASE WHEN state = 'pending' THEN NEW.erased_at ELSE decided_at END,
    decided_by = CASE WHEN state = 'pending' THEN NULL ELSE decided_by END,
    decision_reason = CASE WHEN state = 'pending' THEN NULL ELSE decision_reason END
    WHERE problem_id = NEW.problem_id;
  UPDATE sessions SET intent = NULL, handback = NULL, close_keep_json = NULL,
    close_discard_json = NULL, implicit_inflight = NULL,
    closed_at = COALESCE(closed_at, MAX(opened_at, NEW.erased_at))
    WHERE problem_id = NEW.problem_id;
  DELETE FROM sessions WHERE problem_id = NEW.problem_id
    AND NOT EXISTS (SELECT 1 FROM artifact_uploads WHERE session_id = sessions.session_id)
    AND NOT EXISTS (SELECT 1 FROM artifact_publication_retries WHERE session_id = sessions.session_id)
    AND NOT EXISTS (SELECT 1 FROM artifact_upload_authorizations WHERE session_id = sessions.session_id);
  UPDATE problems SET title = '', sponsor_id = NULL, created_by_fellow_id = NULL,
    unlisted = 1, current_statement_version = 1, areas = '[]',
    resolution_direction = NULL, resolution_summary = NULL,
    resolution_no_claim_boundary = NULL, famous_guardrail = NULL,
    canonical_problem_id = NULL, forked_from_problem_id = NULL, forked_from_cursor = NULL,
    writer_cap = NULL, admission_mode = 'archived-read-only', updated_at = NEW.erased_at
    WHERE id = NEW.problem_id;
  DELETE FROM problems WHERE id = NEW.problem_id
    AND NOT EXISTS (SELECT 1 FROM sponsor_directives WHERE problem_id = NEW.problem_id)
    AND NOT EXISTS (SELECT 1 FROM screening_cases WHERE problem_id = NEW.problem_id)
    AND NOT EXISTS (SELECT 1 FROM screening_refusals WHERE problem_id = NEW.problem_id)
    AND NOT EXISTS (SELECT 1 FROM artifact_uploads WHERE problem_id = NEW.problem_id)
    AND NOT EXISTS (SELECT 1 FROM sessions WHERE problem_id = NEW.problem_id)
    AND NOT EXISTS (SELECT 1 FROM reports WHERE problem_id = NEW.problem_id)
    AND NOT EXISTS (SELECT 1 FROM content_controls WHERE problem_id = NEW.problem_id)
    AND NOT EXISTS (SELECT 1 FROM problem_forks
      WHERE problem_id = NEW.problem_id OR parent_problem_id = NEW.problem_id);
END;
