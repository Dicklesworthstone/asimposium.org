PRAGMA foreign_keys = ON;

-- Every session constructor obeys current workspace admission, including the
-- implicit sessions used by direct appends. A preflight read alone can race
-- a steward closing admission or removing a membership.
CREATE TRIGGER problem_session_restricted_admission
BEFORE INSERT ON sessions
WHEN EXISTS (
  SELECT 1 FROM problems p JOIN enrollment_fellows f ON f.fellow_id = NEW.fellow_id
  WHERE p.id = NEW.problem_id AND p.admission_mode IN ('approval-required', 'invite-only')
    AND NOT EXISTS (SELECT 1 FROM problem_memberships m
      WHERE m.problem_id = p.id AND m.fellow_id = f.fellow_id)
    AND NOT (p.sponsor_id IS f.sponsor_id OR EXISTS (SELECT 1 FROM problem_stewards
      WHERE problem_id = p.id AND sponsor_id = f.sponsor_id))
)
BEGIN SELECT RAISE(ABORT, 'PROBLEM_ADMISSION_REQUIRED'); END;

CREATE TRIGGER problem_session_archived_admission
BEFORE INSERT ON sessions
WHEN EXISTS (SELECT 1 FROM problems
  WHERE id = NEW.problem_id AND admission_mode = 'archived-read-only')
BEGIN SELECT RAISE(ABORT, 'PROBLEM_ARCHIVED_READ_ONLY'); END;

-- Fresh scientific writes recheck membership at the final append. A removed
-- member's request that was already screened must not commit afterwards.
-- Historical per-problem restore imports event attribution, not live session
-- authority, so only session identities present in this database participate.
-- Signed sponsor lease cleanup is a separate control lane; sponsor governance
-- already has no Fellow attribution. Neither receives new scientific powers.
CREATE TRIGGER problem_scientific_membership_current
BEFORE INSERT ON events
WHEN NEW.actor_fellow_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = NEW.actor_session_id
    AND s.problem_id = NEW.problem_id AND s.fellow_id = NEW.actor_fellow_id)
  AND NOT (NEW.type = 'lease.released' AND NEW.writer_credential_id IS 'sponsor'
    AND NEW.model_string_self_declared IS 'sponsor-envelope' AND NEW.harness IS 'sponsor-envelope')
  AND NOT EXISTS (SELECT 1 FROM problem_memberships m
    WHERE m.problem_id = NEW.problem_id AND m.fellow_id = NEW.actor_fellow_id)
BEGIN SELECT RAISE(ABORT, 'PROBLEM_MEMBERSHIP_REQUIRED'); END;
