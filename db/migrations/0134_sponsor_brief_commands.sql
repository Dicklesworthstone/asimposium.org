-- Private sponsor intent needs optimistic edits and recoverable command results.
-- No formulation text, raw replay keys, or signed-envelope material is retained
-- in receipts. The original response is reconstructed from a matching retry.
ALTER TABLE sponsor_problem_briefs ADD COLUMN version INTEGER NOT NULL DEFAULT 1
  CHECK (version BETWEEN 1 AND 9007199254740991);

CREATE TABLE sponsor_brief_command_receipts (
  sponsor_id TEXT NOT NULL REFERENCES sponsors(sponsor_id),
  key_digest TEXT NOT NULL CHECK (length(key_digest) = 64 AND key_digest NOT GLOB '*[^a-f0-9]*'),
  operation TEXT NOT NULL CHECK (operation IN ('save', 'withdraw')),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^a-f0-9]*'),
  brief_id TEXT NOT NULL CHECK (length(brief_id) BETWEEN 1 AND 128),
  brief_version INTEGER NOT NULL CHECK (brief_version BETWEEN 1 AND 9007199254740991),
  brief_created_at TEXT NOT NULL,
  brief_updated_at TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at = created_at + 86400000),
  PRIMARY KEY (sponsor_id, key_digest)
);

CREATE INDEX sponsor_brief_command_expiry_idx ON sponsor_brief_command_receipts(expires_at);
