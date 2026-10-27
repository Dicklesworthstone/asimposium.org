-- Fable §9.1: a human can contest a reviewed rejection without rewriting it.
-- A release is a separate exact-case authority, not automatic publication.
CREATE TABLE screening_case_appeals (
  appeal_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL UNIQUE REFERENCES screening_cases(case_id),
  sponsor_id TEXT NOT NULL,
  statement TEXT NOT NULL CHECK (length(statement) BETWEEN 1 AND 2000),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  key_hash TEXT NOT NULL CHECK (length(key_hash) = 64),
  submitted_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','released','upheld')),
  decided_at TEXT,
  decided_by TEXT,
  decision_reason TEXT,
  decision_key_hash TEXT,
  decision_digest TEXT,
  audit_event_id TEXT UNIQUE,
  UNIQUE(sponsor_id, key_hash),
  CHECK ((state = 'pending' AND decided_at IS NULL AND decided_by IS NULL AND
    decision_reason IS NULL AND decision_key_hash IS NULL AND decision_digest IS NULL AND audit_event_id IS NULL)
    OR (state <> 'pending' AND decided_at IS NOT NULL AND decided_by IS NOT NULL AND
    decision_reason IS NOT NULL AND length(decision_reason) BETWEEN 20 AND 1000 AND
    decision_key_hash IS NOT NULL AND length(decision_key_hash) = 64 AND
    decision_digest IS NOT NULL AND length(decision_digest) = 64 AND audit_event_id IS NOT NULL))
);
CREATE INDEX screening_appeals_pending_idx ON screening_case_appeals(state, submitted_at, appeal_id);
CREATE TRIGGER screening_appeal_authorized_insert BEFORE INSERT ON screening_case_appeals
WHEN NEW.state <> 'pending' OR NOT EXISTS (
  SELECT 1 FROM screening_cases c JOIN enrollment_fellows f ON f.fellow_id = c.fellow_id
    JOIN sponsors s ON s.sponsor_id = f.sponsor_id
  WHERE c.case_id = NEW.case_id AND c.state = 'rejected'
    AND c.sponsor_id = NEW.sponsor_id AND f.sponsor_id = NEW.sponsor_id
    AND s.tombstoned_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM private_draft_erasures e WHERE e.problem_id = c.problem_id)
)
BEGIN SELECT RAISE(ABORT,'APPEAL_CASE_UNAVAILABLE'); END;
CREATE TRIGGER screening_appeal_immutable BEFORE UPDATE ON screening_case_appeals
WHEN NEW.appeal_id IS NOT OLD.appeal_id OR NEW.case_id IS NOT OLD.case_id
  OR NEW.sponsor_id IS NOT OLD.sponsor_id OR NEW.request_digest IS NOT OLD.request_digest
  OR NEW.key_hash IS NOT OLD.key_hash OR NEW.submitted_at IS NOT OLD.submitted_at
  OR (NEW.statement IS NOT OLD.statement AND NOT (
    NEW.statement = '[erased]' AND (EXISTS (SELECT 1 FROM sponsors s
      WHERE s.sponsor_id = OLD.sponsor_id AND s.tombstoned_at IS NOT NULL) OR EXISTS (
      SELECT 1 FROM private_draft_erasures e JOIN screening_cases c ON c.problem_id = e.problem_id
      WHERE c.case_id = OLD.case_id))))
  OR (OLD.state <> 'pending' AND (NEW.state IS NOT OLD.state OR NEW.decided_at IS NOT OLD.decided_at
    OR NEW.decided_by IS NOT OLD.decided_by OR NEW.decision_reason IS NOT OLD.decision_reason
    OR NEW.decision_key_hash IS NOT OLD.decision_key_hash OR NEW.decision_digest IS NOT OLD.decision_digest
    OR NEW.audit_event_id IS NOT OLD.audit_event_id))
BEGIN SELECT RAISE(ABORT,'APPEAL_RECORD_IMMUTABLE'); END;
CREATE TRIGGER screening_appeal_decision_authorized BEFORE UPDATE OF state ON screening_case_appeals
WHEN NEW.state <> OLD.state AND (NEW.state = 'pending' OR NOT EXISTS (
  SELECT 1 FROM screening_cases c JOIN enrollment_fellows f ON f.fellow_id = c.fellow_id
    JOIN sponsors s ON s.sponsor_id = f.sponsor_id
  WHERE c.case_id = NEW.case_id AND c.state = 'rejected'
    AND c.sponsor_id = NEW.sponsor_id AND f.sponsor_id = NEW.sponsor_id AND s.tombstoned_at IS NULL
    AND c.decided_by <> NEW.decided_by AND NEW.sponsor_id <> NEW.decided_by
    AND NOT EXISTS (SELECT 1 FROM private_draft_erasures e WHERE e.problem_id = c.problem_id)
))
BEGIN SELECT RAISE(ABORT,'APPEAL_REVIEW_AUTHORITY_CHANGED'); END;
CREATE TRIGGER screening_appeal_no_delete BEFORE DELETE ON screening_case_appeals
BEGIN SELECT RAISE(ABORT,'APPEAL_RECORD_IMMUTABLE'); END;
CREATE TRIGGER screening_appeal_draft_erasure AFTER INSERT ON private_draft_erasures
BEGIN UPDATE screening_case_appeals SET statement = '[erased]' WHERE case_id IN (
  SELECT case_id FROM screening_cases WHERE problem_id = NEW.problem_id); END;
CREATE TRIGGER screening_appeal_account_erasure AFTER UPDATE OF tombstoned_at ON sponsors
WHEN NEW.tombstoned_at IS NOT NULL
BEGIN UPDATE screening_case_appeals SET statement = '[erased]' WHERE sponsor_id = NEW.sponsor_id; END;
