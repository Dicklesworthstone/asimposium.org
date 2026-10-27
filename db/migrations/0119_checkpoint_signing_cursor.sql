-- Operational progress only: this cursor grants no ledger or signing authority.
-- Each signing key walks bounded problem pages independently. A monotonic CAS
-- revision prevents a delayed tick from rewinding a later tick, including
-- after the lexical problem cursor wraps to the beginning.
CREATE TABLE checkpoint_signing_cursors (
  key_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(key_id) BETWEEN 1 AND 64 AND key_id NOT GLOB '*[^A-Za-z0-9._-]*'),
  after_problem_id TEXT
    CHECK (after_problem_id IS NULL OR length(after_problem_id) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991)
);
