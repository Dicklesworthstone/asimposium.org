-- 0086: claim relations cannot be deleted (bead asimposiumorg-jewg).
--
-- A claim relation is a ledger projection (Rule A6): the event log is the
-- truth and the row is rebuilt from it, never removed by hand. Every sibling
-- ledger table (conflicts, reviews, claim_deps, citations, proof_gaps,
-- syntheses, questions, retractions) already refuses DELETE; claim_relations
-- did not. No route deletes a relation, so this changes no behavior; it
-- closes the one table where an ad hoc delete would silently drop public
-- state and change the moves served from it.
CREATE TRIGGER claim_relations_immutable_delete
BEFORE DELETE ON claim_relations
BEGIN
  SELECT RAISE(ABORT, 'CLAIM_RELATION_IMMUTABLE');
END;
