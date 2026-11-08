-- asimposium:allow-destructive
-- Replace only the existing trigger; private content follows its unchanged
-- journal-authorized scrub. A fork's public lineage is not private draft text.
-- Retain the empty, ownerless erased identity while problem_forks references
-- it, rather than failing its foreign key or deleting committed parent history.
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
    AND NOT EXISTS (SELECT 1 FROM content_controls WHERE problem_id = NEW.problem_id)
    -- A public parent's committed fork record keeps the child's stable identity.
    -- Its private content and authority have already been erased above.
    AND NOT EXISTS (SELECT 1 FROM problem_forks
      WHERE problem_id = NEW.problem_id OR parent_problem_id = NEW.problem_id);
END;
