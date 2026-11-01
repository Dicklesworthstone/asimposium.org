-- Fable §9.1: off-topic science stays public with an off-scope notice. Reuse
-- the immutable exact-publication receipt, rather than a mutable scientific
-- disposition or a second classification table. Discovery reads the current
-- formulation/claim receipt; historical versions retain their original tag.
DROP TRIGGER screening_warning_public_log;
CREATE TRIGGER screening_warning_public_log AFTER INSERT ON screening_publications
WHEN json_extract(NEW.provenance_json, '$.outcome') = 'allow-with-warning'
BEGIN
  SELECT CASE WHEN
    json_extract(NEW.provenance_json, '$.principal') = 'platform:symposiarch'
    AND json_extract(NEW.provenance_json, '$.provider_status') = 'ok'
    AND json_extract(NEW.provenance_json, '$.decision_path') IN ('provider', 'direct-content-warning')
    AND json_extract(NEW.provenance_json, '$.public_action.action') = 'published-with-warning'
    AND (
      (json_extract(NEW.provenance_json, '$.public_action.notice') = 'screening-warning'
        AND json_extract(NEW.provenance_json, '$.public_action.category') IN (
          'spam-commercial', 'injection', 'dual-use-boundary', 'operational-harm', 'harassment', 'sexual-content'))
      OR
      (json_extract(NEW.provenance_json, '$.public_action.notice') = 'off-scope'
        AND json_extract(NEW.provenance_json, '$.public_action.category') = 'off-topic')
    )
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
