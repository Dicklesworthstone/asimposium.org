-- asimposium:allow-destructive
-- Replaces two lifecycle guards without weakening their existing branches;
-- widens the moderation-log vocabulary with every existing row copied.
-- Fable §1 commitment 6 / §9.1: an explicit reviewed egregious case may
-- suspend one sponsor. Report counts alone never execute this command.
CREATE TABLE sponsor_suspension_events (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) = 29 AND substr(event_id, 1, 3) = 'SS-'
    AND substr(event_id, 4) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  sponsor_id TEXT NOT NULL UNIQUE REFERENCES sponsors(sponsor_id),
  operator_id TEXT NOT NULL CHECK (length(operator_id) BETWEEN 5 AND 64),
  reviewed_case_id TEXT NOT NULL REFERENCES screening_cases(case_id),
  basis TEXT NOT NULL CHECK (basis = 'egregious-reviewed-case'),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 10 AND 1000),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 1 AND 9007199254740991),
  step_up_authenticated_at INTEGER NOT NULL CHECK (typeof(step_up_authenticated_at) = 'integer'
    AND created_at / 1000 - step_up_authenticated_at BETWEEN 0 AND 900),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^a-f0-9]*'),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^a-f0-9]*'),
  paused_fellows INTEGER NOT NULL CHECK (typeof(paused_fellows) = 'integer' AND paused_fellows >= 0),
  revoked_credentials INTEGER NOT NULL CHECK (typeof(revoked_credentials) = 'integer' AND revoked_credentials >= 0),
  cancelled_enrollments INTEGER NOT NULL CHECK (typeof(cancelled_enrollments) = 'integer' AND cancelled_enrollments >= 0),
  cancelled_transfers INTEGER NOT NULL CHECK (typeof(cancelled_transfers) = 'integer' AND cancelled_transfers >= 0),
  UNIQUE (operator_id, sponsor_id, idempotency_key_hash)
);

-- The existing status/revocation pointers reference fellow_lifecycle_events.
-- Operator moderation has a distinct principal and event stream; never put an
-- SS id into those LEV foreign keys or manufacture a sponsor lifecycle event.
ALTER TABLE enrollment_fellows ADD COLUMN suspension_event_id TEXT REFERENCES sponsor_suspension_events(event_id);
ALTER TABLE fellow_tokens ADD COLUMN revocation_suspension_event_id TEXT REFERENCES sponsor_suspension_events(event_id);

CREATE TRIGGER fellow_suspension_evidence_insert BEFORE INSERT ON enrollment_fellows
WHEN NEW.suspension_event_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENSION_EVIDENCE_IMMUTABLE'); END;
CREATE TRIGGER credential_suspension_evidence_insert BEFORE INSERT ON fellow_tokens
WHEN NEW.revocation_suspension_event_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENSION_EVIDENCE_IMMUTABLE'); END;
CREATE TRIGGER fellow_suspension_evidence_update BEFORE UPDATE OF suspension_event_id ON enrollment_fellows
WHEN NEW.suspension_event_id IS NOT OLD.suspension_event_id AND NOT (
  OLD.suspension_event_id IS NULL AND OLD.status IN ('active', 'suspicious_review') AND NEW.status = 'paused'
  AND EXISTS (SELECT 1 FROM sponsor_suspension_events s WHERE s.event_id = NEW.suspension_event_id
    AND s.sponsor_id = NEW.sponsor_id
    AND NEW.status_changed_at = MAX(s.created_at, COALESCE(OLD.status_changed_at, OLD.created_at)))
)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENSION_EVIDENCE_IMMUTABLE'); END;
CREATE TRIGGER credential_suspension_evidence_update BEFORE UPDATE OF revocation_suspension_event_id ON fellow_tokens
WHEN NEW.revocation_suspension_event_id IS NOT OLD.revocation_suspension_event_id AND NOT (
  OLD.revocation_suspension_event_id IS NULL AND OLD.revoked_at IS NULL
  AND EXISTS (SELECT 1 FROM sponsor_suspension_events s WHERE s.event_id = NEW.revocation_suspension_event_id
    AND s.sponsor_id = NEW.sponsor_id
    AND NEW.revoked_at = MAX(s.created_at, NEW.issued_at, COALESCE(NEW.last_used_at, NEW.issued_at)))
)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENSION_EVIDENCE_IMMUTABLE'); END;

CREATE TRIGGER sponsor_suspension_current_guard
BEFORE INSERT ON sponsor_suspension_events
WHEN EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = NEW.sponsor_id OR event_id = NEW.event_id)
  OR NOT EXISTS (SELECT 1 FROM sponsors WHERE sponsor_id = NEW.sponsor_id AND tombstoned_at IS NULL)
  OR NOT EXISTS (SELECT 1 FROM screening_cases WHERE case_id = NEW.reviewed_case_id
    AND sponsor_id = NEW.sponsor_id AND state = 'rejected' AND decided_by IS NOT NULL
    AND decided_at <= strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at / 1000.0, 'unixepoch'))
  OR NEW.paused_fellows <> (SELECT COUNT(*) FROM enrollment_fellows
    WHERE sponsor_id = NEW.sponsor_id AND status IN ('active', 'suspicious_review'))
  OR NEW.revoked_credentials <> (SELECT COUNT(*) FROM fellow_tokens
    WHERE sponsor_id = NEW.sponsor_id AND revoked_at IS NULL)
  OR NEW.cancelled_enrollments <> (SELECT COUNT(*) FROM enrollment_records e
    WHERE e.sponsor_id = NEW.sponsor_id AND e.invalidated = 0 AND e.secret_expires_at > NEW.created_at
      AND NOT EXISTS (SELECT 1 FROM enrollment_proposals p WHERE p.enrollment_id = e.enrollment_id AND p.status <> 'pending'))
  OR NEW.cancelled_transfers <> (SELECT COUNT(*) FROM sponsor_fellow_transfers
    WHERE (source_sponsor_id = NEW.sponsor_id OR target_sponsor_id = NEW.sponsor_id) AND status = 'pending')
BEGIN
  SELECT RAISE(ABORT, 'SPONSOR_SUSPENSION_NOT_CURRENT');
END;
CREATE TRIGGER sponsor_suspension_immutable_update BEFORE UPDATE ON sponsor_suspension_events BEGIN
  SELECT RAISE(ABORT, 'SPONSOR_SUSPENSION_IMMUTABLE');
END;
CREATE TRIGGER sponsor_suspension_immutable_delete BEFORE DELETE ON sponsor_suspension_events BEGIN
  SELECT RAISE(ABORT, 'SPONSOR_SUSPENSION_IMMUTABLE');
END;

DROP TRIGGER enrollment_fellows_status_transition;
CREATE TRIGGER enrollment_fellows_status_transition
BEFORE UPDATE OF status, status_changed_at, status_event_id ON enrollment_fellows
WHEN NEW.status IS NOT OLD.status AND NOT (
  EXISTS (
    SELECT 1 FROM fellow_lifecycle_events event JOIN sponsors sponsor ON sponsor.sponsor_id = event.sponsor_id
    WHERE event.event_id = NEW.status_event_id AND event.action = 'fellow-status-changed'
      AND event.sponsor_id = NEW.sponsor_id AND event.sponsor_seq = sponsor.lifecycle_seq + 1
      AND event.fellow_id = NEW.fellow_id AND event.from_status = OLD.status AND event.to_status = NEW.status
      AND event.effective_at = NEW.status_changed_at
      AND NEW.status_changed_at >= COALESCE(OLD.status_changed_at, OLD.created_at)
  ) OR (
    NEW.status = 'paused' AND EXISTS (SELECT 1 FROM sponsor_fellow_transfers t
      WHERE t.fellow_id = NEW.fellow_id AND t.target_sponsor_id = NEW.sponsor_id
        AND t.status = 'accepted' AND t.resolved_at = NEW.status_changed_at)
  ) OR (
    NEW.status = 'revoked' AND EXISTS (SELECT 1 FROM sponsors s
      WHERE s.sponsor_id = NEW.sponsor_id AND s.tombstoned_at IS NOT NULL
        AND NEW.status_changed_at >= s.tombstoned_at)
  ) OR (
    OLD.status IN ('active', 'suspicious_review') AND NEW.status = 'paused'
    AND EXISTS (SELECT 1 FROM sponsor_suspension_events s WHERE s.sponsor_id = NEW.sponsor_id
      AND s.event_id = NEW.suspension_event_id AND NEW.status_event_id IS OLD.status_event_id
      AND NEW.status_changed_at = MAX(s.created_at, COALESCE(OLD.status_changed_at, OLD.created_at)))
  )
)
BEGIN SELECT RAISE(ABORT, 'fellow lifecycle transition lacks event'); END;

DROP TRIGGER enrollment_credentials_revocation_event_update;
CREATE TRIGGER enrollment_credentials_revocation_event_update
BEFORE UPDATE OF revoked_at, revocation_event_id ON fellow_tokens
WHEN OLD.revoked_at IS NULL AND NOT (
  EXISTS (SELECT 1 FROM fellow_lifecycle_events event
    WHERE event.event_id = NEW.revocation_event_id AND event.action = 'credential-revoked'
      AND event.sponsor_id = NEW.sponsor_id AND event.fellow_id = NEW.fellow_id
      AND event.credential_id = NEW.credential_id
      AND NEW.revoked_at = MAX(event.effective_at, NEW.issued_at, COALESCE(NEW.last_used_at, NEW.issued_at)))
  OR EXISTS (SELECT 1 FROM sponsor_fellow_transfers t
    WHERE t.fellow_id = NEW.fellow_id AND t.status = 'accepted'
      AND t.resolved_at IS NOT NULL AND NEW.revoked_at >= t.resolved_at)
  OR EXISTS (SELECT 1 FROM sponsors s WHERE s.sponsor_id = NEW.sponsor_id
    AND s.tombstoned_at IS NOT NULL AND NEW.revoked_at >= s.tombstoned_at)
  OR EXISTS (SELECT 1 FROM sponsor_suspension_events s
    WHERE s.sponsor_id = NEW.sponsor_id AND s.event_id = NEW.revocation_suspension_event_id
      AND NEW.revocation_event_id IS OLD.revocation_event_id
      AND NEW.revoked_at = MAX(s.created_at, NEW.issued_at, COALESCE(NEW.last_used_at, NEW.issued_at)))
)
BEGIN SELECT RAISE(ABORT, 'credential revocation lacks event'); END;

CREATE TABLE moderation_log_with_suspension (
  entry_id TEXT PRIMARY KEY CHECK (entry_id GLOB 'ML-*'),
  seq INTEGER NOT NULL UNIQUE CHECK (seq >= 1),
  action TEXT NOT NULL CHECK (action IN ('quarantined', 'released', 'rejected', 'hidden', 'restored',
    'report-dismissed', 'report-upheld', 'sponsor-suspended')),
  category TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (subject IN ('candidate', 'ledger-object', 'problem', 'report', 'sponsor')),
  problem_id TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO moderation_log_with_suspension SELECT * FROM moderation_log;
DROP TABLE moderation_log;
ALTER TABLE moderation_log_with_suspension RENAME TO moderation_log;
CREATE TRIGGER moderation_log_append_only_update BEFORE UPDATE ON moderation_log BEGIN
  SELECT RAISE(ABORT, 'MODERATION_LOG_APPEND_ONLY');
END;
CREATE TRIGGER moderation_log_append_only_delete BEFORE DELETE ON moderation_log BEGIN
  SELECT RAISE(ABORT, 'MODERATION_LOG_APPEND_ONLY');
END;

-- The suspension, consequences, private audit and public-safe notation are one
-- statement. A failed write at any point rolls every consequence back.
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

-- Admission checks live in D1 as well as HTTP. A request authenticated before
-- the suspension cannot commit after it or mint a fresh credential around it.
CREATE TRIGGER suspended_sponsor_enrollment_insert BEFORE INSERT ON enrollment_records
WHEN EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = NEW.sponsor_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_enrollment_bind BEFORE UPDATE OF sponsor_id ON enrollment_records
WHEN EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = NEW.sponsor_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_proposal_insert BEFORE INSERT ON enrollment_proposals
WHEN EXISTS (SELECT 1 FROM enrollment_records e JOIN sponsor_suspension_events s ON s.sponsor_id = e.sponsor_id
  WHERE e.enrollment_id = NEW.enrollment_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_proposal_approve BEFORE UPDATE OF status, token_hash ON enrollment_proposals
WHEN NEW.status IN ('approved', 'reduced') AND EXISTS (
  SELECT 1 FROM enrollment_records e JOIN sponsor_suspension_events s ON s.sponsor_id = e.sponsor_id
  WHERE e.enrollment_id = NEW.enrollment_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_fellow_insert BEFORE INSERT ON enrollment_fellows
WHEN EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = NEW.sponsor_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_fellow_resume BEFORE UPDATE OF sponsor_id, status ON enrollment_fellows
WHEN (NEW.status IN ('active', 'suspicious_review') AND EXISTS (
    SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = NEW.sponsor_id))
  OR (NEW.sponsor_id IS NOT OLD.sponsor_id AND EXISTS (
    SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id IN (OLD.sponsor_id, NEW.sponsor_id)))
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_grant_insert BEFORE INSERT ON enrollment_grants
WHEN EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = NEW.sponsor_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_grant_rebind BEFORE UPDATE OF sponsor_id, granted_at ON enrollment_grants
WHEN EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id IN (NEW.sponsor_id, OLD.sponsor_id))
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_credential_insert BEFORE INSERT ON fellow_tokens
WHEN EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = NEW.sponsor_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_transfer_insert BEFORE INSERT ON sponsor_fellow_transfers
WHEN EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id IN (NEW.source_sponsor_id, NEW.target_sponsor_id))
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_transfer_accept BEFORE UPDATE OF status ON sponsor_fellow_transfers
WHEN NEW.status = 'accepted' AND EXISTS (
  SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id IN (NEW.source_sponsor_id, NEW.target_sponsor_id))
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_rebind_insert BEFORE INSERT ON fellow_rebinds
WHEN EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = NEW.sponsor_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_rebind_redeem BEFORE UPDATE OF status ON fellow_rebinds
WHEN NEW.status IN ('awaiting-approval', 'approved', 'redeemed') AND EXISTS (
  SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = NEW.sponsor_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;

CREATE TRIGGER suspended_sponsor_ledger_write BEFORE INSERT ON events
WHEN EXISTS (SELECT 1 FROM sponsor_suspension_events s WHERE s.sponsor_id = NEW.actor_sponsor_id)
  OR EXISTS (SELECT 1 FROM enrollment_fellows f JOIN sponsor_suspension_events s ON s.sponsor_id = f.sponsor_id
    WHERE f.fellow_id = NEW.actor_fellow_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_attempt BEFORE INSERT ON public_write_attempt_reservations
WHEN EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = NEW.sponsor_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_session_open BEFORE INSERT ON sessions
WHEN EXISTS (SELECT 1 FROM enrollment_fellows f JOIN sponsor_suspension_events s ON s.sponsor_id = f.sponsor_id
  WHERE f.fellow_id = NEW.fellow_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_session_work BEFORE UPDATE OF last_heartbeat_at, handback ON sessions
WHEN (NEW.last_heartbeat_at IS NOT OLD.last_heartbeat_at OR NEW.handback IS NOT OLD.handback)
  AND EXISTS (SELECT 1 FROM enrollment_fellows f JOIN sponsor_suspension_events s ON s.sponsor_id = f.sponsor_id
    WHERE f.fellow_id = NEW.fellow_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_workshop_create BEFORE INSERT ON workshop_objects
WHEN EXISTS (SELECT 1 FROM enrollment_fellows f JOIN sponsor_suspension_events s ON s.sponsor_id = f.sponsor_id
  WHERE f.fellow_id = NEW.fellow_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_workshop_revise BEFORE UPDATE ON workshop_objects
WHEN EXISTS (SELECT 1 FROM enrollment_fellows f JOIN sponsor_suspension_events s ON s.sponsor_id = f.sponsor_id
  WHERE f.fellow_id = NEW.fellow_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_workshop_version BEFORE INSERT ON workshop_revisions
WHEN EXISTS (SELECT 1 FROM enrollment_fellows f JOIN sponsor_suspension_events s ON s.sponsor_id = f.sponsor_id
  WHERE f.fellow_id = NEW.fellow_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_problem_draft BEFORE INSERT ON problems
WHEN EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = NEW.sponsor_id)
  OR EXISTS (SELECT 1 FROM enrollment_fellows f JOIN sponsor_suspension_events s ON s.sponsor_id = f.sponsor_id
    WHERE f.fellow_id = NEW.created_by_fellow_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_brief_create BEFORE INSERT ON sponsor_problem_briefs
WHEN EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = NEW.sponsor_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_brief_update BEFORE UPDATE ON sponsor_problem_briefs
WHEN EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = NEW.sponsor_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_directive BEFORE INSERT ON sponsor_directives
WHEN EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = NEW.sponsor_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_report BEFORE INSERT ON reports
WHEN EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = NEW.reporter_sponsor_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_slow_mode BEFORE INSERT ON problem_slow_mode_events
WHEN NEW.actor_kind = 'sponsor' AND EXISTS (
  SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = NEW.actor_id)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
CREATE TRIGGER suspended_sponsor_posture_clear BEFORE INSERT ON screening_posture_clearances
WHEN NEW.cleared_by_class = 'sponsor' AND EXISTS (
  SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = NEW.cleared_by)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;
