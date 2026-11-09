-- Private creation and brief adoption share one atomic command receipt.
-- Retain only digests and identity metadata, never private formulation prose.
-- The Fellow-scoped key survives credential rotation. Keep the problem id after
-- draft erasure so a late retry cannot recreate erased private work.
CREATE TABLE problem_proposal_command_receipts (
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  sponsor_id TEXT NOT NULL REFERENCES sponsors(sponsor_id),
  key_digest TEXT NOT NULL CHECK (length(key_digest) = 64 AND key_digest NOT GLOB '*[^a-f0-9]*'),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^a-f0-9]*'),
  problem_id TEXT NOT NULL,
  problem_created_at TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at = created_at + 86400000),
  PRIMARY KEY (fellow_id, key_digest)
);
CREATE INDEX problem_proposal_command_expiry_idx ON problem_proposal_command_receipts(expires_at);
CREATE INDEX problem_proposal_command_sponsor_idx ON problem_proposal_command_receipts(sponsor_id);
