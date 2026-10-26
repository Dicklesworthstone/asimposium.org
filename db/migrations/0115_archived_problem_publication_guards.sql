PRAGMA foreign_keys = ON;

-- Fable section 6.8: archiving is effective for sessions that were already
-- open, including a request screened before the admission mode changed.
-- Every scientific writer reaches this envelope insert in its transaction;
-- a refusal rolls back its cursor, projections, outbox and replay settlement.
-- Sponsor governance has no Fellow attribution and must remain available so
-- a current steward can reopen the workspace. Existing receipts are untouched.
CREATE TRIGGER archived_problem_scientific_event
BEFORE INSERT ON events
WHEN NEW.actor_fellow_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM problems
  WHERE id = NEW.problem_id AND admission_mode = 'archived-read-only'
)
BEGIN
  SELECT RAISE(ABORT, 'PROBLEM_ARCHIVED_READ_ONLY');
END;

-- Refuse a new scientific screening reservation before paid inference. The
-- reserved namespace below is constructed only by signed sponsor governance;
-- it is not a client-selected session or a borrowed scientific authorship.
-- A reservation admitted before archival still meets the final event guard.
CREATE TRIGGER archived_problem_scientific_attempt
BEFORE INSERT ON public_write_attempt_reservations
WHEN NOT (
  NEW.route LIKE 'problem-%'
  AND NEW.session_id = 'problem-governance:' || NEW.problem_id
) AND EXISTS (
  SELECT 1 FROM problems
  WHERE id = NEW.problem_id AND admission_mode = 'archived-read-only'
)
BEGIN
  SELECT RAISE(ABORT, 'PROBLEM_ARCHIVED_READ_ONLY');
END;
