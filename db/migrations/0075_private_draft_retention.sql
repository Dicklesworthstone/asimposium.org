-- W2.8 / Fable §10.2: Private draft hard-deletion retention policy.
-- Never-published private drafts are hard-deletable on an authenticated sponsor request.
-- Published problem statements and statements with committed public ledger events
-- remain strictly immutable and non-deletable.
DROP TRIGGER IF EXISTS problem_statement_versions_immutable_delete;

CREATE TRIGGER problem_statement_versions_immutable_delete
BEFORE DELETE ON problem_statement_versions
WHEN (SELECT status FROM problems WHERE id = OLD.problem_id) != 'private-draft'
  OR (SELECT public_seq FROM problems WHERE id = OLD.problem_id) > 0
BEGIN
  SELECT RAISE(ABORT, 'PROBLEM_STATEMENT_VERSION_IMMUTABLE');
END;
