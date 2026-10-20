-- asimposium:allow-destructive
-- Replace derived publication authority only. Ledger bytes and previously
-- authorized public copies are unchanged. A current source must be the exact
-- evidence event and the exact historical claim version or hypothesis it cites.
DROP VIEW artifact_publication_evidence;
CREATE VIEW artifact_publication_evidence AS
WITH targets AS (
  SELECT e.*, 'claim' AS target_kind, e.object_version AS target_version
  FROM events e JOIN claim_versions v ON v.problem_id = e.problem_id
    AND v.claim_id = e.object_id AND v.version = e.object_version
    AND v.editor_fellow_id = e.actor_fellow_id
  WHERE e.object_kind = 'claim'
    AND ((e.type = 'claim.created' AND e.object_version = 1)
      OR (e.type = 'claim.revised' AND e.object_version > 1))
    AND NOT EXISTS (SELECT 1 FROM events other WHERE other.problem_id = e.problem_id
      AND other.object_kind = 'claim' AND other.object_id = e.object_id
      AND other.object_version = e.object_version AND other.id <> e.id
      AND other.type IN ('claim.created','claim.revised'))
  UNION ALL
  SELECT e.*, 'hypothesis' AS target_kind, NULL AS target_version
  FROM events e JOIN hypotheses h ON h.problem_id = e.problem_id
    AND h.hypothesis_id = e.object_id AND h.source_event_id = e.id
    AND h.source_seq = e.seq AND h.author_fellow_id = e.actor_fellow_id
  WHERE e.object_kind = 'hypothesis' AND e.type = 'hypothesis.created' AND e.object_version = 1
    AND NOT EXISTS (SELECT 1 FROM events other WHERE other.problem_id = e.problem_id
      AND other.object_kind = 'hypothesis' AND other.object_id = e.object_id
      AND other.object_version = 1 AND other.id <> e.id AND other.type = 'hypothesis.created')
)
SELECT v.problem_id, v.evidence_id, e.id AS evidence_event_id,
  e.payload_sha256 AS evidence_sha256, c.payload_json AS evidence_json,
  e.actor_fellow_id AS fellow_id, e.actor_sponsor_id AS sponsor_id,
  t.target_kind, t.object_id AS target_id, t.target_version,
  t.id AS target_event_id, t.payload_sha256 AS target_sha256, tc.payload_json AS target_json
FROM evidence v JOIN events e ON e.id = v.source_event_id AND e.seq = v.source_seq
  AND e.problem_id = v.problem_id AND e.object_id = v.evidence_id
  AND e.object_kind = 'evidence' AND e.type = 'evidence.created' AND e.object_version = 1
  AND e.actor_fellow_id = v.author_fellow_id
JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
JOIN problems p ON p.id = e.problem_id AND p.status <> 'private-draft' AND e.seq <= p.public_seq
JOIN targets t ON t.problem_id = v.problem_id AND t.target_kind = v.bears_on_kind
  AND t.object_id = v.bears_on_id AND t.target_version IS v.bears_on_version
  AND t.seq >= 1 AND t.seq < e.seq
JOIN event_content tc ON tc.event_id = t.id AND tc.payload_sha256 = t.payload_sha256 AND tc.redacted_at IS NULL
WHERE length(CAST(c.payload_json AS BLOB)) BETWEEN 1 AND 524288
  AND length(CAST(tc.payload_json AS BLOB)) BETWEEN 1 AND 524288
  AND json_extract(CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END,'$.bears_on_kind') = v.bears_on_kind
  AND json_extract(CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END,'$.bears_on_id') = v.bears_on_id
  AND json_extract(CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END,'$.bears_on_version') IS v.bears_on_version
  AND NOT EXISTS (SELECT 1 FROM events other WHERE other.problem_id = e.problem_id
    AND other.object_kind = 'evidence' AND other.object_id = e.object_id
    AND other.object_version = 1 AND other.id <> e.id AND other.type = 'evidence.created')
  AND NOT EXISTS (SELECT 1 FROM scientific_withdrawals w WHERE w.source_event_id = e.id)
  -- Each target has an independent latest control. Restoring an object does
  -- not restore an independently hidden version, event, or whole problem.
  AND NOT EXISTS (SELECT 1 FROM content_controls cc WHERE cc.problem_id = e.problem_id
    AND cc.target_ref IN ('problem',e.object_id,e.object_id || '@' || e.object_version,'#' || e.seq,
      t.object_id,t.object_id || '@' || t.object_version,'#' || t.seq)
    AND cc.visibility = 'hidden' AND cc.version = (
      SELECT MAX(latest.version) FROM content_controls latest
      WHERE latest.problem_id = cc.problem_id AND latest.target_ref = cc.target_ref));

-- Observers can publish their own evidence and its reproducibility bytes.
-- The same promote + upload-artifacts scopes, owner, grant, session, quota,
-- and exact source checks continue to apply at the atomic write boundary.
DROP TRIGGER artifact_publications_authorized;
CREATE TRIGGER artifact_publications_authorized BEFORE INSERT ON artifact_publications
WHEN NOT EXISTS (
  SELECT 1 FROM artifact_uploads u
  JOIN artifact_upload_write_authority a ON a.credential_id = NEW.credential_id
    AND a.fellow_id = NEW.fellow_id AND a.sponsor_id = NEW.sponsor_id
    AND a.session_id = NEW.session_id AND a.problem_id = NEW.problem_id
  JOIN fellow_tokens t ON t.credential_id = a.credential_id
  JOIN problem_memberships m ON m.problem_id = a.problem_id AND m.fellow_id = a.fellow_id
    AND m.role IN ('observer','contributor','steward')
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
    AND (json_extract(a.granted_resources_json,'$.eventBudget') IS NULL OR
      (SELECT COUNT(*) FROM events used WHERE used.writer_credential_id = a.credential_id)
        <= json_extract(a.granted_resources_json,'$.eventBudget'))
) BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_AUTHORITY_CHANGED'); END;

-- Direct SQL also refuses a new release whose publication event is hidden.
-- The Worker additionally hashes and compares all three exact source bodies
-- in the release CAS; a matching digest column alone never authorizes bytes.
DROP TRIGGER artifact_publication_release_guard;
CREATE TRIGGER artifact_publication_release_guard BEFORE UPDATE ON artifact_publication_jobs
WHEN OLD.state = 'queued' AND NEW.state = 'release-authorized' AND (
  OLD.lease_token IS NULL OR OLD.lease_token IS NOT NEW.lease_token OR OLD.lease_until <= NEW.updated_at
  OR NEW.released_at IS NOT NEW.updated_at OR NOT EXISTS (
    SELECT 1 FROM artifact_publications b
    JOIN artifact_publication_evidence v ON v.evidence_event_id = b.evidence_event_id
      AND v.evidence_sha256 = b.evidence_sha256 AND v.problem_id = b.problem_id
      AND v.evidence_id = b.evidence_id AND v.fellow_id = b.fellow_id AND v.sponsor_id = b.sponsor_id
    JOIN events e ON e.id = b.event_id AND e.payload_sha256 = b.event_sha256
      AND e.problem_id = b.problem_id AND e.object_id = b.publication_id
      AND e.object_kind = 'artifact' AND e.type = 'artifact.publication-requested' AND e.object_version = 1
    JOIN problems p ON p.id = e.problem_id AND e.seq <= p.public_seq AND p.status <> 'private-draft'
    JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
    WHERE b.publication_id = NEW.publication_id
      AND NOT EXISTS (SELECT 1 FROM content_controls cc WHERE cc.problem_id = e.problem_id
        AND cc.target_ref IN ('problem',e.object_id,e.object_id || '@' || e.object_version,'#' || e.seq)
        AND cc.visibility = 'hidden' AND cc.version = (
          SELECT MAX(latest.version) FROM content_controls latest
          WHERE latest.problem_id = cc.problem_id AND latest.target_ref = cc.target_ref))
      AND json_extract(NEW.screen_receipt_json,'$.version') = 'artifact-publication-policy-v1'
      AND json_extract(NEW.screen_receipt_json,'$.publication_id') = b.publication_id
      AND json_extract(NEW.screen_receipt_json,'$.artifact_sha256') = b.sha256
      AND json_extract(NEW.screen_receipt_json,'$.screening_sha256') = b.screening_sha256
      AND json_extract(NEW.screen_receipt_json,'$.evidence_sha256') = b.evidence_sha256
      AND json_extract(NEW.screen_receipt_json,'$.provider_status') = 'ok'
      AND json_extract(NEW.screen_receipt_json,'$.decision') = 'pass'
  )) BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_RELEASE_REFUSED'); END;
