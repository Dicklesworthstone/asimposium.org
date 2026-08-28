-- ADR-24: every session records the protocol/policy version pair it opened
-- under. Later amendments never retroactively re-judge that work. Columns are
-- nullable so rows opened before this migration stay honest unknowns rather
-- than being back-filled with today's pair.

ALTER TABLE sessions ADD COLUMN protocol_version TEXT
  CHECK (protocol_version IS NULL OR (length(protocol_version) BETWEEN 1 AND 64));
ALTER TABLE sessions ADD COLUMN protocol_digest TEXT
  CHECK (
    protocol_digest IS NULL
    OR (length(protocol_digest) = 64 AND protocol_digest NOT GLOB '*[^0-9a-f]*')
  );
ALTER TABLE sessions ADD COLUMN policy_version TEXT
  CHECK (policy_version IS NULL OR (length(policy_version) BETWEEN 1 AND 64));
ALTER TABLE sessions ADD COLUMN policy_digest TEXT
  CHECK (
    policy_digest IS NULL
    OR (length(policy_digest) = 64 AND policy_digest NOT GLOB '*[^0-9a-f]*')
  );
ALTER TABLE sessions ADD COLUMN protocol_pair_digest TEXT
  CHECK (
    protocol_pair_digest IS NULL
    OR (length(protocol_pair_digest) = 64 AND protocol_pair_digest NOT GLOB '*[^0-9a-f]*')
  );
