-- W5.3 (asimposiumorg-6w1): the P11 norm-hash gate becomes one indexed lookup
-- that is simultaneously its own atomic guard.
--
-- norm_hash is the split/policy.ts normHash of the claim statement (NFKC,
-- lowercase, whitespace-collapsed, math spans tokenized, SHA-256). It is
-- computed by the promoting route and committed inside writeClaim's single
-- batch, so two concurrent promotions of the same normalized statement can no
-- longer both pass a read-side gate: the second INSERT violates
-- claims_problem_norm_hash_idx and the whole batch aborts.
--
-- Scope horizon: Fable section 6.3 scopes the collision to an OPEN claim on
-- the problem. Today no durable non-open state exists for claims — retractions
-- and withdrawals are W5.8d writers that do not exist yet — so every persisted
-- row is reachable-state open and a full unique index is exactly the open-only
-- guard. When the first non-open state becomes writable, its migration MUST
-- convert this to a partial unique index over that predicate (for example
-- WHERE retracted_at IS NULL) in the same change that introduces the state.
--
-- Pre-existing rows keep NULL here; SQLite UNIQUE treats NULLs as distinct,
-- and pre-launch data is re-promotable by construction. New writes always
-- populate the column.

ALTER TABLE claims ADD COLUMN norm_hash TEXT;

CREATE UNIQUE INDEX claims_problem_norm_hash_idx ON claims (problem_id, norm_hash);
