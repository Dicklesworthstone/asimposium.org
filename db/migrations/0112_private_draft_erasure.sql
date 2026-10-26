-- asimposium:allow-destructive
-- Fable §10.5: erase never-published private content without discarding
-- immutable moderation evidence or resetting artifact byte budgets. The
-- journal is the authority; its erasure marker survives even a row deletion.
CREATE TABLE private_draft_erasures (
  problem_id TEXT PRIMARY KEY,
  control_id TEXT NOT NULL UNIQUE REFERENCES deletion_journal(control_id),
  erased_at TEXT NOT NULL
);

CREATE TRIGGER private_draft_erasure_guard BEFORE INSERT ON private_draft_erasures
WHEN NOT EXISTS (
  SELECT 1 FROM deletion_journal j LEFT JOIN problems p ON p.id = NEW.problem_id
  WHERE j.control_id = NEW.control_id
    AND j.action = 'delete-private-draft' AND j.target_type = 'problem'
    AND j.target_id = NEW.problem_id AND j.created_at = NEW.erased_at
    AND json_extract(j.record_json, '$.controlId') = j.control_id
    AND json_extract(j.record_json, '$.controlDigest') = j.control_digest
    AND json_extract(j.record_json, '$.action') = j.action
    AND json_extract(j.record_json, '$.targetType') = j.target_type
    AND json_extract(j.record_json, '$.targetId') = j.target_id
    AND json_extract(j.record_json, '$.issuedAt') = j.created_at
    AND json_type(j.record_json, '$.payload.sponsor_id') = 'text'
    AND length(json_extract(j.record_json, '$.payload.sponsor_id')) > 0
    AND (p.id IS NULL OR (p.status = 'private-draft' AND p.public_seq = 0
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.problem_id = p.id)
      AND json_extract(j.record_json, '$.payload.sponsor_id') = p.sponsor_id))
)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASURE_NOT_AUTHORIZED'); END;
CREATE TRIGGER private_draft_erasure_no_update BEFORE UPDATE ON private_draft_erasures
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASURE_IMMUTABLE'); END;
CREATE TRIGGER private_draft_erasure_no_delete BEFORE DELETE ON private_draft_erasures
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASURE_IMMUTABLE'); END;

-- Only the private body may change, to this one fixed tombstone, after the
-- exact problem's journaled erasure. Identity, digest and rate history stay.
DROP TRIGGER sponsor_directives_no_update;
CREATE TRIGGER sponsor_directives_no_update BEFORE UPDATE ON sponsor_directives
WHEN NOT (
  EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = OLD.problem_id)
  AND NEW.body IS CASE WHEN OLD.verb = 'unfocus' THEN NULL ELSE '[Private draft erased]' END
  AND NEW.id IS OLD.id AND NEW.sponsor_id IS OLD.sponsor_id
  AND NEW.fellow_id IS OLD.fellow_id AND NEW.problem_id IS OLD.problem_id
  AND NEW.verb IS OLD.verb AND NEW.notice_id IS OLD.notice_id
  AND NEW.idempotency_key IS OLD.idempotency_key
  AND NEW.request_digest IS OLD.request_digest AND NEW.created_at IS OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'SPONSOR_DIRECTIVE_IMMUTABLE'); END;

-- Reviewed decisions (including a suspension's reviewed_case_id) remain
-- intact. Their private candidate/context may only become the erasure marker.
-- Pending cases are terminally superseded so they cannot later be released.
DROP TRIGGER screening_cases_binding_immutable;
CREATE TRIGGER screening_cases_binding_immutable BEFORE UPDATE ON screening_cases
WHEN (
  NEW.case_id IS NOT OLD.case_id OR NEW.problem_id IS NOT OLD.problem_id
  OR NEW.fellow_id IS NOT OLD.fellow_id OR NEW.sponsor_id IS NOT OLD.sponsor_id
  OR NEW.input_digest IS NOT OLD.input_digest OR NEW.context_digest IS NOT OLD.context_digest
  OR NEW.candidate_json IS NOT OLD.candidate_json OR NEW.created_at IS NOT OLD.created_at
  OR OLD.state <> 'pending'
) AND NOT (
  EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = OLD.problem_id)
  AND NEW.case_id IS OLD.case_id AND NEW.problem_id IS OLD.problem_id
  AND NEW.fellow_id IS OLD.fellow_id AND NEW.sponsor_id IS OLD.sponsor_id
  AND NEW.input_digest IS OLD.input_digest AND NEW.context_digest IS OLD.context_digest
  AND NEW.created_at IS OLD.created_at AND NEW.route IS OLD.route
  AND NEW.coarse_category IS OLD.coarse_category AND NEW.outcome IS OLD.outcome
  AND NEW.decision_path IS OLD.decision_path AND NEW.provider_status IS OLD.provider_status
  AND NEW.model_version IS OLD.model_version AND NEW.policy_version IS OLD.policy_version
  AND NEW.configuration_digest IS OLD.configuration_digest
  AND NEW.candidate_json = '{"erased":true}' AND NEW.contextual_input_json IS NULL
  AND (
    (OLD.state = 'pending' AND NEW.state = 'superseded'
      AND NEW.decided_at = (SELECT erased_at FROM private_draft_erasures WHERE problem_id = OLD.problem_id)
      AND NEW.decided_by IS NULL AND NEW.decision_reason IS NULL)
    OR (OLD.state <> 'pending' AND NEW.state IS OLD.state
      AND NEW.decided_at IS OLD.decided_at AND NEW.decided_by IS OLD.decided_by
      AND NEW.decision_reason IS OLD.decision_reason)
  )
)
BEGIN SELECT RAISE(ABORT, 'SCREENING_CASE_DECIDED_OR_BINDING_IMMUTABLE'); END;
DROP TRIGGER screening_case_context_immutable;
CREATE TRIGGER screening_case_context_immutable BEFORE UPDATE OF contextual_input_json ON screening_cases
WHEN NEW.contextual_input_json IS NOT OLD.contextual_input_json AND NOT (
  NEW.contextual_input_json IS NULL AND NEW.candidate_json = '{"erased":true}'
  AND EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = OLD.problem_id)
)
BEGIN SELECT RAISE(ABORT, 'SCREENING_CASE_CONTEXT_IMMUTABLE'); END;

-- Public statement history is still immutable. Private statements require
-- the same journaled erasure as every other private-content store.
DROP TRIGGER problem_statement_versions_immutable_delete;
CREATE TRIGGER problem_statement_versions_immutable_delete BEFORE DELETE ON problem_statement_versions
WHEN NOT EXISTS (
  SELECT 1 FROM private_draft_erasures erased JOIN problems p ON p.id = erased.problem_id
  WHERE p.id = OLD.problem_id AND p.status = 'private-draft' AND p.public_seq = 0
    AND NOT EXISTS (SELECT 1 FROM events WHERE problem_id = p.id)
)
BEGIN SELECT RAISE(ABORT, 'PROBLEM_STATEMENT_VERSION_IMMUTABLE'); END;

-- Suspension still blocks all work. Clearing a handback is permitted only
-- under the erasure marker; erased_problem_session_update additionally checks
-- that every other session change is exactly the terminal scrub below.
DROP TRIGGER suspended_sponsor_session_work;
CREATE TRIGGER suspended_sponsor_session_work BEFORE UPDATE OF last_heartbeat_at, handback ON sessions
WHEN (NEW.last_heartbeat_at IS NOT OLD.last_heartbeat_at OR NEW.handback IS NOT OLD.handback)
  AND EXISTS (SELECT 1 FROM enrollment_fellows f JOIN sponsor_suspension_events s ON s.sponsor_id = f.sponsor_id
    WHERE f.fellow_id = NEW.fellow_id)
  AND NOT (NEW.last_heartbeat_at IS OLD.last_heartbeat_at AND NEW.handback IS NULL
    AND NEW.problem_id IS OLD.problem_id
    AND EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = OLD.problem_id))
BEGIN SELECT RAISE(ABORT, 'SPONSOR_SUSPENDED'); END;

-- One insertion is the whole database-content erasure. If any unexpected
-- immutable dependency prevents it, the journal/marker/content all roll back.
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
    AND NOT EXISTS (SELECT 1 FROM artifact_publication_retries WHERE session_id = sessions.session_id);
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
    AND NOT EXISTS (SELECT 1 FROM content_controls WHERE problem_id = NEW.problem_id);
END;

-- A retained identity is forever private, empty and ownerless. It cannot be
-- reused even after an otherwise unreferenced problem row is removed.
CREATE TRIGGER erased_problem_no_insert BEFORE INSERT ON problems
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_no_update BEFORE UPDATE ON problems
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id IN (OLD.id, NEW.id))
  AND NOT (
    OLD.sponsor_id IS NOT NULL AND NEW.id IS OLD.id
    AND NEW.status = 'private-draft' AND NEW.public_seq = 0 AND NEW.unlisted = 1
    AND NEW.title = '' AND NEW.sponsor_id IS NULL AND NEW.created_by_fellow_id IS NULL
    AND NEW.current_statement_version = 1 AND NEW.areas = '[]'
    AND NEW.resolution_direction IS NULL AND NEW.resolution_summary IS NULL
    AND NEW.resolution_no_claim_boundary IS NULL AND NEW.famous_guardrail IS NULL
    AND NEW.canonical_problem_id IS NULL AND NEW.forked_from_problem_id IS NULL
    AND NEW.forked_from_cursor IS NULL AND NEW.writer_cap IS NULL
    AND NEW.created_at IS OLD.created_at AND NEW.chain_digest IS OLD.chain_digest
    AND NEW.chain_version IS OLD.chain_version AND NEW.admission_mode = 'archived-read-only'
    AND NEW.updated_at = (SELECT erased_at FROM private_draft_erasures WHERE problem_id = OLD.id)
  )
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;

CREATE TRIGGER erased_problem_event BEFORE INSERT ON events
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_statement BEFORE INSERT ON problem_statement_versions
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_session BEFORE INSERT ON sessions
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_session_update BEFORE UPDATE ON sessions
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id IN (OLD.problem_id, NEW.problem_id))
  AND NOT (
    NEW.session_id IS OLD.session_id AND NEW.problem_id IS OLD.problem_id
    AND NEW.fellow_id IS OLD.fellow_id AND NEW.opened_at IS OLD.opened_at
    AND NEW.last_heartbeat_at IS OLD.last_heartbeat_at AND NEW.idle_close_at IS OLD.idle_close_at
    AND NEW.intent IS NULL AND NEW.handback IS NULL AND NEW.close_keep_json IS NULL
    AND NEW.close_discard_json IS NULL AND NEW.implicit_inflight IS NULL
    AND NEW.closed_at IS COALESCE(OLD.closed_at, MAX(OLD.opened_at,
      (SELECT erased_at FROM private_draft_erasures WHERE problem_id = OLD.problem_id)))
  )
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_workshop BEFORE INSERT ON workshop_objects
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_workshop_update BEFORE UPDATE ON workshop_objects
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_workshop_revision BEFORE INSERT ON workshop_revisions
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_membership BEFORE INSERT ON problem_memberships
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_membership_update BEFORE UPDATE ON problem_memberships
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_steward BEFORE INSERT ON problem_stewards
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_steward_update BEFORE UPDATE ON problem_stewards
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_lease BEFORE INSERT ON leases
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_lease_update BEFORE UPDATE ON leases
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_directive BEFORE INSERT ON sponsor_directives
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_screening BEFORE INSERT ON screening_cases
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_upload BEFORE INSERT ON artifact_uploads
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_upload_update BEFORE UPDATE ON artifact_uploads
WHEN NEW.state NOT IN ('expired', 'quarantined')
  AND EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_follow BEFORE INSERT ON problem_follows
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_follow_update BEFORE UPDATE ON problem_follows
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_notice BEFORE INSERT ON fellow_inbox_notices
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_notice_update BEFORE UPDATE ON fellow_inbox_notices
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id IN (OLD.problem_id, NEW.problem_id))
  AND NOT (
    NEW.id IS OLD.id AND NEW.fellow_id IS OLD.fellow_id AND NEW.problem_id IS OLD.problem_id
    AND NEW.notice_type IS OLD.notice_type AND NEW.seq IS OLD.seq AND NEW.created_at IS OLD.created_at
    AND NEW.title = 'Private draft erased' AND NEW.detail IS NULL AND NEW.target_id IS NULL
    AND NEW.caused_by_event_id IS NULL AND NEW.impact_kind IS NULL
    AND NEW.acknowledged_at IS NOT NULL AND NEW.expires_at IS OLD.created_at
  )
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_workshop_revision_update BEFORE UPDATE ON workshop_revisions
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
CREATE TRIGGER erased_problem_claim BEFORE INSERT ON claims
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED'); END;
