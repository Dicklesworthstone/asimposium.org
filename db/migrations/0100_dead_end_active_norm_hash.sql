-- P6/P11: there is at most one active normalized dead-end route per problem.
-- Superseded history is retained. The writer retires a predecessor before
-- inserting its replacement inside the same Krater transaction, so this
-- invariant also closes concurrent duplicate admissions that both passed
-- their earlier advisory read.
CREATE UNIQUE INDEX dead_ends_active_norm_hash_unique
  ON dead_ends (problem_id, norm_hash)
  WHERE norm_hash IS NOT NULL AND superseded_by IS NULL;
