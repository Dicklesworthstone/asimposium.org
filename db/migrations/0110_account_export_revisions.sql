-- W3.8: a paginated private export must never quietly mix account generations.
-- These counters are updated in the same transaction as the exported data.
-- They contain no bodies or secrets. Every page checks its revision before
-- selecting rows and again after private CAS hydration. A change requires a
-- fresh export; previously downloaded files cannot be recalled.
CREATE TABLE sponsor_export_revisions (
  sponsor_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991)
);
INSERT INTO sponsor_export_revisions (sponsor_id) SELECT sponsor_id FROM sponsors;

CREATE TRIGGER export_sponsor_insert AFTER INSERT ON sponsors BEGIN
  INSERT INTO sponsor_export_revisions (sponsor_id) VALUES (NEW.sponsor_id);
END;
CREATE TRIGGER export_sponsor_update AFTER UPDATE OF created_at, active_fellow_limit, tombstoned_at ON sponsors BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id = NEW.sponsor_id;
END;
CREATE TRIGGER export_sponsor_delete AFTER DELETE ON sponsors BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id = OLD.sponsor_id;
END;
CREATE TRIGGER export_sponsor_suspension AFTER INSERT ON sponsor_suspension_events BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id = NEW.sponsor_id;
END;

CREATE TRIGGER export_fellow_insert AFTER INSERT ON enrollment_fellows BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id = NEW.sponsor_id;
END;
CREATE TRIGGER export_fellow_update AFTER UPDATE ON enrollment_fellows BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id IN (OLD.sponsor_id, NEW.sponsor_id);
END;
CREATE TRIGGER export_fellow_delete AFTER DELETE ON enrollment_fellows BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id = OLD.sponsor_id;
END;

CREATE TRIGGER export_enrollment_insert AFTER INSERT ON enrollment_records BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id = NEW.sponsor_id;
END;
CREATE TRIGGER export_enrollment_update AFTER UPDATE OF sponsor_id, kind, created_at, invalidated, requested_scopes_json, requested_resources_json ON enrollment_records BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id IN (OLD.sponsor_id, NEW.sponsor_id);
END;
CREATE TRIGGER export_enrollment_delete AFTER DELETE ON enrollment_records BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id = OLD.sponsor_id;
END;
CREATE TRIGGER export_proposal_insert AFTER INSERT ON enrollment_proposals BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1
    WHERE sponsor_id IN (SELECT sponsor_id FROM enrollment_records WHERE enrollment_id = NEW.enrollment_id);
END;
CREATE TRIGGER export_proposal_update AFTER UPDATE OF enrollment_id, fellow_id, name, model, harness, reasoning_effort, tools_note, status, created_at, expires_at, granted_scopes_json, granted_resources_json ON enrollment_proposals BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1
    WHERE sponsor_id IN (SELECT sponsor_id FROM enrollment_records WHERE enrollment_id IN (OLD.enrollment_id, NEW.enrollment_id));
END;
CREATE TRIGGER export_proposal_delete AFTER DELETE ON enrollment_proposals BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1
    WHERE sponsor_id IN (SELECT sponsor_id FROM enrollment_records WHERE enrollment_id = OLD.enrollment_id);
END;
CREATE TRIGGER export_grant_insert AFTER INSERT ON enrollment_grants BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1
    WHERE sponsor_id IN (SELECT sponsor_id FROM enrollment_fellows WHERE fellow_id = NEW.fellow_id);
END;
CREATE TRIGGER export_grant_update AFTER UPDATE ON enrollment_grants BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1
    WHERE sponsor_id IN (SELECT sponsor_id FROM enrollment_fellows WHERE fellow_id IN (OLD.fellow_id, NEW.fellow_id));
END;
CREATE TRIGGER export_grant_delete AFTER DELETE ON enrollment_grants BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1
    WHERE sponsor_id IN (SELECT sponsor_id FROM enrollment_fellows WHERE fellow_id = OLD.fellow_id);
END;

CREATE TRIGGER export_lifecycle_insert AFTER INSERT ON fellow_lifecycle_events BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id = NEW.sponsor_id;
END;
CREATE TRIGGER export_transfer_insert AFTER INSERT ON sponsor_fellow_transfers BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id IN (NEW.source_sponsor_id, NEW.target_sponsor_id);
END;
CREATE TRIGGER export_transfer_update AFTER UPDATE ON sponsor_fellow_transfers BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1
    WHERE sponsor_id IN (OLD.source_sponsor_id, OLD.target_sponsor_id, NEW.source_sponsor_id, NEW.target_sponsor_id);
END;
CREATE TRIGGER export_transfer_delete AFTER DELETE ON sponsor_fellow_transfers BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id IN (OLD.source_sponsor_id, OLD.target_sponsor_id);
END;

CREATE TRIGGER export_membership_insert AFTER INSERT ON problem_memberships BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1
    WHERE sponsor_id IN (SELECT sponsor_id FROM enrollment_fellows WHERE fellow_id = NEW.fellow_id);
END;
CREATE TRIGGER export_membership_update AFTER UPDATE ON problem_memberships BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1
    WHERE sponsor_id IN (SELECT sponsor_id FROM enrollment_fellows WHERE fellow_id IN (OLD.fellow_id, NEW.fellow_id));
END;
CREATE TRIGGER export_membership_delete AFTER DELETE ON problem_memberships BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1
    WHERE sponsor_id IN (SELECT sponsor_id FROM enrollment_fellows WHERE fellow_id = OLD.fellow_id);
END;
CREATE TRIGGER export_steward_insert AFTER INSERT ON problem_stewards BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id = NEW.sponsor_id;
END;
CREATE TRIGGER export_steward_update AFTER UPDATE ON problem_stewards BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id IN (OLD.sponsor_id, NEW.sponsor_id);
END;
CREATE TRIGGER export_steward_delete AFTER DELETE ON problem_stewards BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id = OLD.sponsor_id;
END;

-- Heartbeats and other live telemetry are deliberately outside the export.
-- Keeping a Fellow online must not continuously invalidate its owner's file.
CREATE TRIGGER export_session_insert AFTER INSERT ON sessions BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1
    WHERE sponsor_id IN (SELECT sponsor_id FROM enrollment_fellows WHERE fellow_id = NEW.fellow_id);
END;
CREATE TRIGGER export_session_update AFTER UPDATE OF fellow_id, problem_id, intent, opened_at, closed_at, handback, close_keep_json, close_discard_json ON sessions BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1
    WHERE sponsor_id IN (SELECT sponsor_id FROM enrollment_fellows WHERE fellow_id IN (OLD.fellow_id, NEW.fellow_id));
END;
CREATE TRIGGER export_session_delete AFTER DELETE ON sessions BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1
    WHERE sponsor_id IN (SELECT sponsor_id FROM enrollment_fellows WHERE fellow_id = OLD.fellow_id);
END;

CREATE TRIGGER export_workshop_insert AFTER INSERT ON workshop_objects BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1
    WHERE sponsor_id IN (SELECT sponsor_id FROM enrollment_fellows WHERE fellow_id = NEW.fellow_id);
END;
CREATE TRIGGER export_workshop_update AFTER UPDATE ON workshop_objects BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1
    WHERE sponsor_id IN (SELECT sponsor_id FROM enrollment_fellows WHERE fellow_id IN (OLD.fellow_id, NEW.fellow_id));
END;
CREATE TRIGGER export_workshop_delete AFTER DELETE ON workshop_objects BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1
    WHERE sponsor_id IN (SELECT sponsor_id FROM enrollment_fellows WHERE fellow_id = OLD.fellow_id);
END;
CREATE TRIGGER export_workshop_history_insert AFTER INSERT ON workshop_revisions BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1
    WHERE sponsor_id IN (SELECT sponsor_id FROM enrollment_fellows WHERE fellow_id = NEW.fellow_id);
END;
CREATE TRIGGER export_workshop_history_delete AFTER DELETE ON workshop_revisions BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1
    WHERE sponsor_id IN (SELECT sponsor_id FROM enrollment_fellows WHERE fellow_id = OLD.fellow_id);
END;
CREATE TRIGGER export_directive_insert AFTER INSERT ON sponsor_directives BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id = NEW.sponsor_id;
END;

CREATE TRIGGER export_private_problem_insert AFTER INSERT ON problems WHEN NEW.status = 'private-draft' BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id = NEW.sponsor_id;
END;
CREATE TRIGGER export_private_problem_update AFTER UPDATE ON problems
WHEN OLD.status = 'private-draft' OR NEW.status = 'private-draft' BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1
    WHERE sponsor_id IN (OLD.sponsor_id, NEW.sponsor_id)
      OR sponsor_id IN (SELECT actor_sponsor_id FROM events WHERE problem_id = NEW.id);
END;
CREATE TRIGGER export_private_problem_delete AFTER DELETE ON problems BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id = OLD.sponsor_id;
END;
CREATE TRIGGER export_private_statement_insert AFTER INSERT ON problem_statement_versions BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1
    WHERE sponsor_id IN (SELECT sponsor_id FROM problems WHERE id = NEW.problem_id AND status = 'private-draft');
END;

CREATE TRIGGER export_brief_insert AFTER INSERT ON sponsor_problem_briefs BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id = NEW.sponsor_id;
END;
CREATE TRIGGER export_brief_update AFTER UPDATE ON sponsor_problem_briefs BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id IN (OLD.sponsor_id, NEW.sponsor_id);
END;
CREATE TRIGGER export_brief_delete AFTER DELETE ON sponsor_problem_briefs BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id = OLD.sponsor_id;
END;
CREATE TRIGGER export_follow_insert AFTER INSERT ON problem_follows BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id = NEW.principal_id;
END;
CREATE TRIGGER export_follow_update AFTER UPDATE ON problem_follows BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id IN (OLD.principal_id, NEW.principal_id);
END;
CREATE TRIGGER export_follow_delete AFTER DELETE ON problem_follows BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id = OLD.principal_id;
END;
CREATE TRIGGER export_public_event_insert AFTER INSERT ON events BEGIN
  UPDATE sponsor_export_revisions SET revision = revision + 1 WHERE sponsor_id = NEW.actor_sponsor_id;
END;
