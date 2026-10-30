-- asimposium:allow-destructive
-- Fable §9.1: held artifact bytes enter the existing private human-review queue.
-- Review approval and fresh owner consent are separate immutable authorities.
-- Neither a hold nor an operator decision copies bytes into the public bucket.
CREATE TABLE artifact_publication_reviews (
  publication_id TEXT PRIMARY KEY REFERENCES artifact_publications(publication_id),
  case_id TEXT NOT NULL UNIQUE REFERENCES screening_cases(case_id),
  input_digest TEXT NOT NULL CHECK (length(input_digest)=64 AND input_digest NOT GLOB '*[^a-f0-9]*'),
  context_digest TEXT NOT NULL CHECK (length(context_digest)=64 AND context_digest NOT GLOB '*[^a-f0-9]*'),
  candidate_digest TEXT NOT NULL CHECK (length(candidate_digest)=64 AND candidate_digest NOT GLOB '*[^a-f0-9]*'),
  observation_json TEXT NOT NULL CHECK (json_valid(observation_json) AND length(observation_json)<=4096),
  created_at INTEGER NOT NULL CHECK (typeof(created_at)='integer' AND created_at>0)
);
CREATE TABLE artifact_publication_review_attempts (
  publication_id TEXT PRIMARY KEY REFERENCES artifact_publications(publication_id),
  attempts INTEGER NOT NULL CHECK (typeof(attempts)='integer' AND attempts BETWEEN 1 AND 1000000),
  next_attempt_at INTEGER NOT NULL CHECK (typeof(next_attempt_at)='integer' AND next_attempt_at>0)
);
CREATE TRIGGER artifact_publication_review_bound BEFORE INSERT ON artifact_publication_reviews
WHEN NOT EXISTS (
  SELECT 1 FROM artifact_publications b JOIN artifact_publication_jobs j USING(publication_id)
  JOIN screening_cases c ON c.case_id=NEW.case_id
  WHERE b.publication_id=NEW.publication_id AND j.state='held'
    AND j.failure_code IN ('screening-held','dependency-unavailable')
    AND j.last_screen_json IS NEW.observation_json AND j.screen_receipt_json IS NULL AND j.released_at IS NULL
    AND c.fellow_id=b.fellow_id AND c.sponsor_id=b.sponsor_id AND c.problem_id=b.problem_id
    AND c.route='artifact-publications' AND c.input_digest=NEW.input_digest AND c.context_digest=NEW.context_digest
    AND c.provider_status=json_extract(NEW.observation_json,'$.provider_status')
    AND c.model_version=json_extract(NEW.observation_json,'$.model_version')
    AND c.policy_version=json_extract(NEW.observation_json,'$.policy_version')
    AND c.configuration_digest=substr(json_extract(NEW.observation_json,'$.configuration_digest'),8)
    AND c.coarse_category=json_extract(NEW.observation_json,'$.coarse_category')
    AND c.contextual_input_json IS NULL AND json_extract(c.candidate_json,'$.kind')='artifact-publication'
    AND json_type(c.candidate_json,'$.statement')='text'
    AND length(CAST(json_extract(c.candidate_json,'$.statement') AS BLOB)) BETWEEN 1 AND 65536
    AND json_type(c.candidate_json,'$.falsifier')='null'
    AND json_extract(NEW.observation_json,'$.version')='artifact-publication-policy-v1'
    AND json_extract(NEW.observation_json,'$.publication_id')=b.publication_id
    AND json_extract(NEW.observation_json,'$.artifact_sha256')=b.sha256
    AND json_extract(NEW.observation_json,'$.screening_sha256')=b.screening_sha256
    AND json_extract(NEW.observation_json,'$.evidence_sha256')=b.evidence_sha256
    AND json_extract(NEW.observation_json,'$.context_digest')='sha256:' || NEW.context_digest
    AND json_extract(NEW.observation_json,'$.provider_status') IN ('ok','error','timeout')
    AND json_extract(NEW.observation_json,'$.decision') IN ('pass','allow-with-warning','quarantine','reject')
    AND (json_extract(NEW.observation_json,'$.provider_status')<>'ok'
      OR json_extract(NEW.observation_json,'$.decision')<>'pass')
) BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_REVIEW_REFUSED'); END;
CREATE TRIGGER artifact_publication_review_no_update BEFORE UPDATE ON artifact_publication_reviews
BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_REVIEW_IMMUTABLE'); END;
CREATE TRIGGER artifact_publication_review_no_delete BEFORE DELETE ON artifact_publication_reviews
BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_REVIEW_IMMUTABLE'); END;

-- A model-only release is not human approval. Require the exact authenticated
-- operator audit, or a separately audited independent operator appeal.
CREATE VIEW artifact_publication_review_decisions AS
SELECT r.publication_id,r.case_id,r.input_digest,r.context_digest,r.candidate_digest,r.observation_json,
  c.candidate_json,c.contextual_input_json,c.state AS case_state,c.decided_at AS case_decided_at,
  c.decided_by AS case_decided_by,c.decision_reason AS case_decision_reason,
  'operator' AS decision_kind,NULL AS appeal_id,a.event_id AS audit_event_id,
  a.operator_id,a.created_at AS decided_at,a.reason AS decision_reason,
  a.after_state_digest,NULL AS appeal_decision_digest
FROM artifact_publication_reviews r JOIN screening_cases c ON c.case_id=r.case_id
JOIN operator_audit a ON a.target_id=c.case_id AND a.action='quarantine.release'
  AND a.operator_id=c.decided_by AND a.created_at=c.decided_at AND a.reason=c.decision_reason
WHERE c.state='released' AND c.route='artifact-publications'
  AND c.input_digest=r.input_digest AND c.context_digest=r.context_digest
UNION ALL
SELECT r.publication_id,r.case_id,r.input_digest,r.context_digest,r.candidate_digest,r.observation_json,
  c.candidate_json,c.contextual_input_json,c.state,c.decided_at,c.decided_by,c.decision_reason,
  'operator-appeal',p.appeal_id,a.event_id,a.operator_id,a.created_at,a.reason,
  a.after_state_digest,p.decision_digest
FROM artifact_publication_reviews r JOIN screening_cases c ON c.case_id=r.case_id
JOIN screening_case_appeals p ON p.case_id=c.case_id AND p.state='released'
  AND p.sponsor_id=c.sponsor_id AND p.decided_by<>c.decided_by AND p.decided_by<>p.sponsor_id
JOIN operator_audit a ON a.event_id=p.audit_event_id AND a.target_id=p.appeal_id
  AND a.action='screening-appeal.release' AND a.operator_id=p.decided_by
  AND a.created_at=p.decided_at AND a.reason=p.decision_reason
WHERE c.state='rejected' AND c.route='artifact-publications'
  AND c.input_digest=r.input_digest AND c.context_digest=r.context_digest;

CREATE TABLE artifact_publication_review_releases (
  retry_id TEXT PRIMARY KEY CHECK (length(retry_id)=36 AND substr(retry_id,1,4)='APR-'
    AND substr(retry_id,5) NOT GLOB '*[^a-f0-9]*'),
  publication_id TEXT NOT NULL UNIQUE REFERENCES artifact_publications(publication_id),
  retry_generation INTEGER NOT NULL CHECK (typeof(retry_generation)='integer' AND retry_generation BETWEEN 0 AND 8),
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  sponsor_id TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES fellow_tokens(credential_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  key_hash TEXT NOT NULL CHECK (length(key_hash)=64 AND key_hash NOT GLOB '*[^a-f0-9]*'),
  request_digest TEXT NOT NULL CHECK (length(request_digest)=64 AND request_digest NOT GLOB '*[^a-f0-9]*'),
  created_at INTEGER NOT NULL CHECK (typeof(created_at)='integer' AND created_at>0),
  held_at INTEGER NOT NULL CHECK (typeof(held_at)='integer' AND held_at>0 AND held_at<=created_at),
  prior_attempts INTEGER NOT NULL CHECK (typeof(prior_attempts)='integer' AND prior_attempts BETWEEN 0 AND 1000000),
  prior_screen_attempts INTEGER NOT NULL CHECK (typeof(prior_screen_attempts)='integer' AND prior_screen_attempts BETWEEN 0 AND 3),
  prior_last_screen_json TEXT NOT NULL CHECK (json_valid(prior_last_screen_json) AND length(prior_last_screen_json)<=4096),
  target_event_id TEXT NOT NULL REFERENCES events(id),
  target_sha256 TEXT NOT NULL CHECK (length(target_sha256)=64 AND target_sha256 NOT GLOB '*[^a-f0-9]*'),
  case_id TEXT NOT NULL REFERENCES screening_cases(case_id),
  decision_kind TEXT NOT NULL CHECK (decision_kind IN ('operator','operator-appeal')),
  audit_event_id TEXT NOT NULL REFERENCES operator_audit(event_id),
  decision_digest TEXT NOT NULL CHECK (length(decision_digest)=64 AND decision_digest NOT GLOB '*[^a-f0-9]*'),
  release_receipt_json TEXT NOT NULL CHECK (json_valid(release_receipt_json) AND length(release_receipt_json)<=4096),
  UNIQUE(fellow_id,key_hash)
);
CREATE TRIGGER artifact_publication_review_key_unique BEFORE INSERT ON artifact_publication_review_releases
WHEN EXISTS (SELECT 1 FROM artifact_publication_retries r WHERE r.fellow_id=NEW.fellow_id AND r.key_hash=NEW.key_hash)
BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_RETRY_REFUSED'); END;
CREATE TRIGGER artifact_publication_retry_review_key_unique BEFORE INSERT ON artifact_publication_retries
WHEN EXISTS (SELECT 1 FROM artifact_publication_review_releases r WHERE r.fellow_id=NEW.fellow_id AND r.key_hash=NEW.key_hash)
BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_RETRY_REFUSED'); END;
CREATE TRIGGER artifact_publication_review_authorized BEFORE INSERT ON artifact_publication_review_releases
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
    AND j.state = 'held' AND j.failure_code IN ('screening-held','dependency-unavailable')
    AND NEW.retry_generation = j.retry_generation
    AND j.updated_at = NEW.held_at AND j.attempts = NEW.prior_attempts
    AND j.screen_attempts = NEW.prior_screen_attempts AND j.last_screen_json IS NEW.prior_last_screen_json
    AND j.released_at IS NULL AND j.screen_receipt_json IS NULL AND j.published_at IS NULL
    AND j.delivery_cursor IS NULL AND j.lease_token IS NULL AND j.lease_until IS NULL
    AND EXISTS (SELECT 1 FROM artifact_publication_review_decisions d
      JOIN screening_cases sc ON sc.case_id=d.case_id
      JOIN enrollment_fellows f ON f.fellow_id=sc.fellow_id AND f.sponsor_id=sc.sponsor_id
      JOIN sponsors sp ON sp.sponsor_id=f.sponsor_id AND sp.tombstoned_at IS NULL
      WHERE d.publication_id=b.publication_id AND d.case_id=NEW.case_id
        AND d.decision_kind=NEW.decision_kind AND d.audit_event_id=NEW.audit_event_id
        AND d.observation_json IS NEW.prior_last_screen_json AND sc.fellow_id=b.fellow_id
        AND sc.sponsor_id=b.sponsor_id AND sc.problem_id=b.problem_id
        AND sc.contextual_input_json IS NULL
        AND json_extract(sc.candidate_json,'$.kind')='artifact-publication'
        AND length(CAST(json_extract(sc.candidate_json,'$.statement') AS BLOB)) BETWEEN 1 AND 65536
        AND NOT EXISTS (SELECT 1 FROM private_draft_erasures er WHERE er.problem_id=b.problem_id)
        AND json_extract(NEW.release_receipt_json,'$.version')='artifact-publication-operator-review-v1'
        AND json_extract(NEW.release_receipt_json,'$.publication_id')=b.publication_id
        AND json_extract(NEW.release_receipt_json,'$.artifact_sha256')=b.sha256
        AND json_extract(NEW.release_receipt_json,'$.screening_sha256')=b.screening_sha256
        AND json_extract(NEW.release_receipt_json,'$.evidence_sha256')=b.evidence_sha256
        AND json_extract(NEW.release_receipt_json,'$.context_digest')='sha256:' || d.context_digest
        AND json_extract(NEW.release_receipt_json,'$.case_id')=NEW.case_id
        AND json_extract(NEW.release_receipt_json,'$.input_digest')='sha256:' || d.input_digest
        AND json_extract(NEW.release_receipt_json,'$.candidate_digest')='sha256:' || d.candidate_digest
        AND json_extract(NEW.release_receipt_json,'$.decision_kind')=d.decision_kind
        AND json_extract(NEW.release_receipt_json,'$.audit_event_id')=d.audit_event_id
        AND json_extract(NEW.release_receipt_json,'$.decision_digest')='sha256:' || NEW.decision_digest
        AND json_extract(NEW.release_receipt_json,'$.consent_retry_id')=NEW.retry_id
        AND json_extract(NEW.release_receipt_json,'$.consented_at')=NEW.created_at)
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
  OR (OLD.state = 'held' AND NOT (
    (NEW.state='queued' AND NEW.retry_generation=OLD.retry_generation+1
      AND NEW.attempts IS OLD.attempts AND NEW.screen_attempts IS OLD.screen_attempts
      AND NEW.last_screen_json IS OLD.last_screen_json AND NEW.failure_code IS NULL
      AND NEW.lease_token IS NULL AND NEW.lease_until IS NULL
      AND NEW.released_at IS NULL AND NEW.screen_receipt_json IS NULL
      AND NEW.published_at IS NULL AND NEW.delivery_cursor IS NULL
      AND EXISTS (SELECT 1 FROM artifact_publication_retries r WHERE r.publication_id=OLD.publication_id
        AND r.retry_generation=NEW.retry_generation AND r.held_at=OLD.updated_at
        AND r.created_at=NEW.updated_at AND r.created_at=NEW.next_attempt_at
        AND r.prior_attempts=OLD.attempts AND r.prior_screen_attempts=OLD.screen_attempts
        AND r.prior_last_screen_json IS OLD.last_screen_json))
    OR (NEW.state='release-authorized' AND NEW.retry_generation IS OLD.retry_generation
      AND NEW.attempts IS OLD.attempts AND NEW.screen_attempts IS OLD.screen_attempts
      AND NEW.last_screen_json IS OLD.last_screen_json AND NEW.failure_code IS NULL
      AND NEW.lease_token IS NULL AND NEW.lease_until IS NULL
      AND NEW.released_at IS NEW.updated_at AND NEW.published_at IS NULL AND NEW.delivery_cursor IS NULL
      AND EXISTS (SELECT 1 FROM artifact_publication_review_releases r
        WHERE r.publication_id=OLD.publication_id AND r.retry_generation=OLD.retry_generation
          AND r.held_at=OLD.updated_at AND r.created_at=NEW.updated_at AND r.created_at=NEW.next_attempt_at
          AND r.prior_attempts=OLD.attempts AND r.prior_screen_attempts=OLD.screen_attempts
          AND r.prior_last_screen_json IS OLD.last_screen_json AND r.release_receipt_json IS NEW.screen_receipt_json))
  ))
BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_STATE_CONFLICT'); END;

CREATE TRIGGER artifact_publication_review_release AFTER INSERT ON artifact_publication_review_releases BEGIN
  UPDATE artifact_publication_jobs SET state='release-authorized',updated_at=NEW.created_at,
    next_attempt_at=NEW.created_at,released_at=NEW.created_at,screen_receipt_json=NEW.release_receipt_json,failure_code=NULL
  WHERE publication_id=NEW.publication_id AND state='held' AND retry_generation=NEW.retry_generation
    AND updated_at=NEW.held_at;
  SELECT CASE WHEN changes()=1 THEN 1 ELSE RAISE(ABORT,'ARTIFACT_PUBLICATION_RETRY_REFUSED') END;
END;
CREATE TRIGGER artifact_publication_review_release_no_update BEFORE UPDATE ON artifact_publication_review_releases
BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_REVIEW_IMMUTABLE'); END;
CREATE TRIGGER artifact_publication_review_release_no_delete BEFORE DELETE ON artifact_publication_review_releases
BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_REVIEW_IMMUTABLE'); END;
