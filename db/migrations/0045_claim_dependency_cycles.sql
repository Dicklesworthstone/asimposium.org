-- P10: the commit must still reject a cycle after concurrent revision
-- preflights both observed an acyclic graph. UNION terminates even if legacy
-- data already contains a cycle. This guard does not rewrite historical rows.
CREATE TRIGGER claim_deps_cycle_before_insert
BEFORE INSERT ON claim_deps
WHEN EXISTS (
  WITH RECURSIVE reachable(claim_id) AS (
    SELECT NEW.depends_on_claim_id
    UNION
    SELECT d.depends_on_claim_id
    FROM claim_deps d JOIN reachable r ON d.claim_id = r.claim_id
    WHERE d.problem_id = NEW.problem_id
  )
  SELECT 1 FROM reachable WHERE claim_id = NEW.claim_id
)
BEGIN
  SELECT RAISE(ABORT, 'CLAIM_DEPENDENCY_CYCLE');
END;
