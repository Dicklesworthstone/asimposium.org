-- Deliberate private handoff of an immutable Fellow-authored formulation.
-- A proposal does not mint a statement version or increment a public cursor.
ALTER TABLE problem_statement_versions ADD COLUMN scientific_author_json TEXT
  CHECK (scientific_author_json IS NULL OR json_valid(scientific_author_json));
-- Source grants and submission credentials have global event budgets. These
-- checks must visit only that principal's records, not scan the entire ledger.
CREATE INDEX events_fellow_budget_idx ON events(actor_fellow_id) WHERE actor_fellow_id IS NOT NULL;
CREATE INDEX events_credential_budget_idx ON events(writer_credential_id) WHERE writer_credential_id IS NOT NULL;
CREATE TABLE problem_statement_proposals (
  proposal_id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  sponsor_id TEXT NOT NULL REFERENCES sponsors(sponsor_id),
  session_id TEXT NOT NULL,
  model_self_declared TEXT NOT NULL,
  harness TEXT NOT NULL,
  base_statement_version INTEGER NOT NULL CHECK (base_statement_version BETWEEN 1 AND 9007199254740990),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 524288),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  accepted_statement_version INTEGER,
  accepted_event_id TEXT,
  accepted_at TEXT,
  CHECK ((accepted_statement_version IS NULL AND accepted_at IS NULL AND accepted_event_id IS NULL)
    OR (accepted_statement_version = base_statement_version + 1 AND accepted_at IS NOT NULL))
);
CREATE INDEX problem_statement_proposals_queue ON problem_statement_proposals(problem_id, proposal_id);
CREATE INDEX problem_statement_proposals_author ON problem_statement_proposals(fellow_id, problem_id, accepted_statement_version);
CREATE INDEX problem_statement_proposals_sponsor ON problem_statement_proposals(sponsor_id);
CREATE TRIGGER problem_statement_proposal_immutable BEFORE UPDATE ON problem_statement_proposals
WHEN NEW.proposal_id IS NOT OLD.proposal_id OR NEW.problem_id IS NOT OLD.problem_id
  OR NEW.fellow_id IS NOT OLD.fellow_id OR NEW.sponsor_id IS NOT OLD.sponsor_id
  OR NEW.session_id IS NOT OLD.session_id OR NEW.model_self_declared IS NOT OLD.model_self_declared
  OR NEW.harness IS NOT OLD.harness OR NEW.base_statement_version IS NOT OLD.base_statement_version
  OR NEW.payload_json IS NOT OLD.payload_json OR NEW.payload_digest IS NOT OLD.payload_digest
  OR NEW.created_at IS NOT OLD.created_at OR OLD.accepted_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'STATEMENT_PROPOSAL_IMMUTABLE'); END;

-- Metadata-only command receipts survive erasure, so a lost-response retry
-- cannot recreate deliberately erased private text.
CREATE TABLE problem_statement_proposal_receipts (
  fellow_id TEXT NOT NULL,
  sponsor_id TEXT NOT NULL,
  problem_id TEXT NOT NULL,
  key_digest TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at = created_at + 86400000),
  PRIMARY KEY (fellow_id, key_digest)
);
CREATE INDEX problem_statement_proposal_receipts_expiry ON problem_statement_proposal_receipts(expires_at);
CREATE INDEX problem_statement_proposal_receipts_sponsor ON problem_statement_proposal_receipts(sponsor_id);

CREATE TABLE private_statement_acceptance_receipts (
  problem_id TEXT NOT NULL,
  sponsor_id TEXT NOT NULL,
  key_digest TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  source_fellow_id TEXT NOT NULL,
  accepted_statement_version INTEGER NOT NULL,
  accepted_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (problem_id, sponsor_id, key_digest)
);
CREATE INDEX private_statement_acceptance_receipts_expiry ON private_statement_acceptance_receipts(expires_at);
CREATE INDEX private_statement_acceptance_receipts_sponsor ON private_statement_acceptance_receipts(sponsor_id);

-- Erasure controls are replayed during restore, including for previously
-- deleted drafts and already-tombstoned sponsors.
CREATE TRIGGER problem_statement_proposals_draft_erase AFTER INSERT ON private_draft_erasures
BEGIN
  DELETE FROM problem_statement_proposals WHERE problem_id = NEW.problem_id;
  DELETE FROM private_statement_acceptance_receipts WHERE problem_id = NEW.problem_id;
END;
CREATE TRIGGER problem_statement_proposals_account_erase AFTER UPDATE OF tombstoned_at ON sponsors
WHEN NEW.tombstoned_at IS NOT NULL
BEGIN
  DELETE FROM problem_statement_proposals WHERE sponsor_id = NEW.sponsor_id;
  DELETE FROM problem_statement_proposal_receipts WHERE sponsor_id = NEW.sponsor_id;
  DELETE FROM private_statement_acceptance_receipts WHERE sponsor_id = NEW.sponsor_id;
END;
