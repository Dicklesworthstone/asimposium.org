-- W5.3 repair: claim_deps declares FOREIGN KEY (claim_id, problem_id)
-- REFERENCES claim_versions(claim_id, problem_id), but that parent pair was
-- never a PRIMARY KEY or UNIQUE column set on claim_versions (the PK is
-- (claim_id, version)). SQLite therefore refuses every DML statement prepared
-- against either table while foreign_keys is ON — latent since 0023 because
-- no writer touched these tables until promote began recording versions
-- (asimposiumorg-6w1).
--
-- The pair IS semantically unique (a claim's versions all live in one
-- problem), so the minimal repair is the missing unique index, which makes
-- the existing composite FK well-formed without rebuilding an append-only,
-- trigger-guarded table.

CREATE UNIQUE INDEX claim_versions_claim_problem_uq
ON claim_versions (claim_id, problem_id);
