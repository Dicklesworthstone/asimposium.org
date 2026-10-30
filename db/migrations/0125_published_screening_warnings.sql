-- Fable §9.1: an allowed warning is a publication with a durable public context
-- notice. Preserve the existing append-only log while admitting its distinct
-- action; never relabel a warning as an operator release or a scientific verdict.
CREATE TABLE moderation_log_with_warnings (
  entry_id TEXT PRIMARY KEY CHECK (entry_id GLOB 'ML-*'),
  seq INTEGER NOT NULL UNIQUE CHECK (seq >= 1),
  action TEXT NOT NULL CHECK (action IN ('quarantined', 'released', 'rejected', 'hidden', 'restored',
    'report-dismissed', 'report-upheld', 'sponsor-suspended', 'published-with-warning')),
  category TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (subject IN ('candidate', 'ledger-object', 'problem', 'report', 'sponsor')),
  problem_id TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO moderation_log_with_warnings SELECT * FROM moderation_log;
-- SQLite validates other triggers during table rename. Temporarily remove and
-- restore this exact dependent trigger within the migration; its behavior does
-- not change and every existing moderation row is copied above.
DROP TRIGGER sponsor_suspension_apply;
DROP TABLE moderation_log;
ALTER TABLE moderation_log_with_warnings RENAME TO moderation_log;
CREATE TRIGGER moderation_log_append_only_update BEFORE UPDATE ON moderation_log BEGIN
  SELECT RAISE(ABORT, 'MODERATION_LOG_APPEND_ONLY');
END;
CREATE TRIGGER moderation_log_append_only_delete BEFORE DELETE ON moderation_log BEGIN
  SELECT RAISE(ABORT, 'MODERATION_LOG_APPEND_ONLY');
END;
CREATE TRIGGER sponsor_suspension_apply AFTER INSERT ON sponsor_suspension_events BEGIN
  INSERT INTO operator_audit
    (event_id, seq, operator_id, action, target_id, reason, before_state_digest, after_state_digest, created_at)
  VALUES ('OA-' || substr(NEW.event_id, 4), (SELECT COALESCE(MAX(seq), 0) + 1 FROM operator_audit),
    NEW.operator_id, 'sponsor.suspended', NEW.sponsor_id, NEW.reason, NULL, NEW.request_digest,
    strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at / 1000.0, 'unixepoch'));
  INSERT INTO moderation_log (entry_id, seq, action, category, subject, problem_id, created_at)
  VALUES ('ML-' || substr(NEW.event_id, 4), (SELECT COALESCE(MAX(seq), 0) + 1 FROM moderation_log),
    'sponsor-suspended', 'reviewed-account-action', 'sponsor', NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at / 1000.0, 'unixepoch'));
  UPDATE enrollment_fellows SET status = 'paused', suspension_event_id = NEW.event_id,
    status_changed_at = MAX(NEW.created_at, COALESCE(status_changed_at, created_at))
    WHERE sponsor_id = NEW.sponsor_id AND status IN ('active', 'suspicious_review');
  UPDATE fellow_tokens SET revocation_suspension_event_id = NEW.event_id,
    revoked_at = MAX(NEW.created_at, issued_at, COALESCE(last_used_at, issued_at))
    WHERE sponsor_id = NEW.sponsor_id AND revoked_at IS NULL;
  UPDATE enrollment_records SET invalidated = 1 WHERE sponsor_id = NEW.sponsor_id AND invalidated = 0;
  UPDATE enrollment_proposals SET status = 'denied' WHERE status = 'pending'
    AND enrollment_id IN (SELECT enrollment_id FROM enrollment_records WHERE sponsor_id = NEW.sponsor_id);
  UPDATE sponsor_fellow_transfers SET status = 'cancelled', resolved_at = MAX(NEW.created_at, created_at)
    WHERE status = 'pending' AND (source_sponsor_id = NEW.sponsor_id OR target_sponsor_id = NEW.sponsor_id);
  UPDATE fellow_rebinds SET status = 'superseded'
    WHERE sponsor_id = NEW.sponsor_id AND status IN ('awaiting-claim', 'awaiting-approval', 'approved');
END;

-- All publication writers already insert their immutable screening receipt in
-- the event transaction. Bind the public-safe notation to that insertion so a
-- failed event, stale authority or ambiguous replay cannot leave an orphan log.
-- Never copy private receipt fields, source bytes, scores or detector details.
CREATE TRIGGER screening_warning_public_log AFTER INSERT ON screening_publications
WHEN json_extract(NEW.provenance_json, '$.outcome') = 'allow-with-warning'
BEGIN
  SELECT CASE WHEN
    json_extract(NEW.provenance_json, '$.principal') = 'platform:symposiarch'
    AND json_extract(NEW.provenance_json, '$.provider_status') = 'ok'
    AND json_extract(NEW.provenance_json, '$.decision_path') IN ('provider', 'direct-content-warning')
    AND json_extract(NEW.provenance_json, '$.public_action.action') = 'published-with-warning'
    AND json_extract(NEW.provenance_json, '$.public_action.notice') = 'screening-warning'
    AND json_extract(NEW.provenance_json, '$.public_action.category') IN (
      'spam-commercial', 'injection', 'dual-use-boundary', 'operational-harm', 'harassment', 'sexual-content')
    AND json_type(NEW.provenance_json, '$.review_case_id') IS NULL
    THEN 1 ELSE RAISE(ABORT, 'SCREENING_WARNING_INVALID') END;

  INSERT INTO moderation_log(entry_id, seq, action, category, subject, problem_id, created_at)
  SELECT 'ML-WARNING-' || e.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM moderation_log),
    'published-with-warning', json_extract(NEW.provenance_json, '$.public_action.category'),
    CASE WHEN e.object_kind = 'problem' THEN 'problem' ELSE 'ledger-object' END,
    (SELECT p.id FROM problems p WHERE p.id = e.problem_id
      AND p.status <> 'private-draft' AND p.unlisted = 0 AND p.public_seq > 0
      AND NOT EXISTS (SELECT 1 FROM content_controls cc WHERE cc.problem_id = p.id
        AND cc.target_kind = 'problem' AND cc.visibility <> 'visible'
        AND cc.version = (SELECT MAX(latest.version) FROM content_controls latest
          WHERE latest.problem_id = cc.problem_id AND latest.target_kind = cc.target_kind
            AND latest.target_ref = cc.target_ref))),
    e.created_at
  FROM events e WHERE e.id = NEW.event_id;
END;
