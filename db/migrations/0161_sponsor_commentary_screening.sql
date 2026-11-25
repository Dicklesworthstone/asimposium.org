-- Sponsor-owned screening cases, appeals, and pre-provider attempt reservations
-- for the human commentary lane (Fable §7.7, §9.1, ADR-18; bead 0qrf).
--
-- Sponsors posting commentary may own zero enrolled Fellows, so sponsor-owned
-- cases bind directly to sponsors(sponsor_id) without requiring a Fellow row
-- while preserving the exact QC-*/AP-* immutability, erasure, and two-reviewer
-- separation invariants of screening_cases and screening_case_appeals.

CREATE TABLE sponsor_screening_cases (
  case_id TEXT PRIMARY KEY CHECK (case_id GLOB 'QC-*'),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  sponsor_id TEXT NOT NULL REFERENCES sponsors(sponsor_id),
  route TEXT NOT NULL CHECK (length(route) BETWEEN 1 AND 64),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64 AND input_digest NOT GLOB '*[^a-f0-9]*'),
  context_digest TEXT NOT NULL CHECK (length(context_digest) = 64 AND context_digest NOT GLOB '*[^a-f0-9]*'),
  candidate_json TEXT NOT NULL CHECK (json_valid(candidate_json) AND length(candidate_json) <= 140000),
  contextual_input_json TEXT CHECK (
    contextual_input_json IS NULL OR (json_valid(contextual_input_json) AND length(contextual_input_json) <= 1200000)
  ),
  coarse_category TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('quarantine', 'allow-with-warning', 'provider-unavailable')),
  decision_path TEXT NOT NULL,
  provider_status TEXT NOT NULL,
  model_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  configuration_digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'released', 'rejected', 'superseded')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decision_reason TEXT CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 10 AND 1000),
  CHECK ((state = 'pending') = (decided_at IS NULL)),
  CHECK (state NOT IN ('released', 'rejected') OR (decided_by IS NOT NULL AND decision_reason IS NOT NULL)),
  UNIQUE (sponsor_id, problem_id, input_digest)
);

CREATE INDEX sponsor_screening_cases_pending_idx
  ON sponsor_screening_cases (state, created_at, case_id);

CREATE INDEX sponsor_screening_cases_sponsor_idx
  ON sponsor_screening_cases (sponsor_id, created_at DESC, case_id DESC);

CREATE TRIGGER sponsor_screening_cases_binding_immutable
BEFORE UPDATE ON sponsor_screening_cases
WHEN (
  NEW.case_id IS NOT OLD.case_id
  OR NEW.problem_id IS NOT OLD.problem_id
  OR NEW.sponsor_id IS NOT OLD.sponsor_id
  OR NEW.route IS NOT OLD.route
  OR NEW.input_digest IS NOT OLD.input_digest
  OR NEW.context_digest IS NOT OLD.context_digest
  OR NEW.coarse_category IS NOT OLD.coarse_category
  OR NEW.outcome IS NOT OLD.outcome
  OR NEW.decision_path IS NOT OLD.decision_path
  OR NEW.provider_status IS NOT OLD.provider_status
  OR NEW.model_version IS NOT OLD.model_version
  OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.configuration_digest IS NOT OLD.configuration_digest
  OR NEW.created_at IS NOT OLD.created_at
  OR (NEW.candidate_json IS NOT OLD.candidate_json AND NOT (
    NEW.candidate_json = '{"erased":true}'
    AND (
      EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = OLD.problem_id)
      OR EXISTS (SELECT 1 FROM sponsors WHERE sponsor_id = OLD.sponsor_id AND tombstoned_at IS NOT NULL)
    )
  ))
  OR (NEW.contextual_input_json IS NOT OLD.contextual_input_json AND NOT (
    NEW.contextual_input_json IS NULL
    AND NEW.candidate_json = '{"erased":true}'
    AND (
      EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = OLD.problem_id)
      OR EXISTS (SELECT 1 FROM sponsors WHERE sponsor_id = OLD.sponsor_id AND tombstoned_at IS NOT NULL)
    )
  ))
  OR (OLD.state <> 'pending' AND (
    NEW.state IS NOT OLD.state
    OR NEW.decided_at IS NOT OLD.decided_at
    OR NEW.decided_by IS NOT OLD.decided_by
    OR NEW.decision_reason IS NOT OLD.decision_reason
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'SPONSOR_SCREENING_CASE_DECIDED_OR_BINDING_IMMUTABLE');
END;

CREATE TRIGGER sponsor_screening_cases_no_delete
BEFORE DELETE ON sponsor_screening_cases
BEGIN
  SELECT RAISE(ABORT, 'SPONSOR_SCREENING_CASE_NO_DELETE');
END;

CREATE TRIGGER erased_problem_sponsor_screening
BEFORE INSERT ON sponsor_screening_cases
WHEN EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = NEW.problem_id)
BEGIN
  SELECT RAISE(ABORT, 'PRIVATE_DRAFT_ERASED');
END;

CREATE TRIGGER sponsor_screening_cases_draft_erasure
AFTER INSERT ON private_draft_erasures
BEGIN
  UPDATE sponsor_screening_cases
     SET candidate_json = '{"erased":true}',
         contextual_input_json = NULL,
         state = CASE WHEN state = 'pending' THEN 'superseded' ELSE state END,
         decided_at = CASE WHEN state = 'pending' THEN NEW.erased_at ELSE decided_at END,
         decided_by = CASE WHEN state = 'pending' THEN NULL ELSE decided_by END,
         decision_reason = CASE WHEN state = 'pending' THEN 'Private draft erased before review.' ELSE decision_reason END
   WHERE problem_id = NEW.problem_id;
END;

CREATE TRIGGER sponsor_screening_cases_account_erasure
AFTER UPDATE OF tombstoned_at ON sponsors
WHEN NEW.tombstoned_at IS NOT NULL
BEGIN
  UPDATE sponsor_screening_cases
     SET candidate_json = '{"erased":true}',
         contextual_input_json = NULL,
         state = CASE WHEN state = 'pending' THEN 'superseded' ELSE state END,
         decided_at = CASE WHEN state = 'pending' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE decided_at END,
         decided_by = CASE WHEN state = 'pending' THEN NULL ELSE decided_by END,
         decision_reason = CASE WHEN state = 'pending' THEN 'Sponsor account erased before review.' ELSE decision_reason END
   WHERE sponsor_id = NEW.sponsor_id;
END;

CREATE TABLE sponsor_screening_case_appeals (
  appeal_id TEXT PRIMARY KEY CHECK (appeal_id GLOB 'AP-*'),
  case_id TEXT NOT NULL UNIQUE REFERENCES sponsor_screening_cases(case_id),
  sponsor_id TEXT NOT NULL REFERENCES sponsors(sponsor_id),
  statement TEXT NOT NULL CHECK (length(statement) BETWEEN 1 AND 2000),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  key_hash TEXT NOT NULL CHECK (length(key_hash) = 64),
  submitted_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'released', 'upheld')),
  decided_at TEXT,
  decided_by TEXT,
  decision_reason TEXT,
  decision_key_hash TEXT,
  decision_digest TEXT,
  audit_event_id TEXT UNIQUE,
  UNIQUE (sponsor_id, key_hash),
  CHECK (
    (state = 'pending' AND decided_at IS NULL AND decided_by IS NULL AND
      decision_reason IS NULL AND decision_key_hash IS NULL AND decision_digest IS NULL AND audit_event_id IS NULL)
    OR (state <> 'pending' AND decided_at IS NOT NULL AND decided_by IS NOT NULL AND
      decision_reason IS NOT NULL AND length(decision_reason) BETWEEN 20 AND 1000 AND
      decision_key_hash IS NOT NULL AND length(decision_key_hash) = 64 AND
      decision_digest IS NOT NULL AND length(decision_digest) = 64 AND audit_event_id IS NOT NULL)
  )
);

CREATE INDEX sponsor_screening_appeals_pending_idx
  ON sponsor_screening_case_appeals (state, submitted_at, appeal_id);

CREATE TRIGGER sponsor_screening_appeal_authorized_insert
BEFORE INSERT ON sponsor_screening_case_appeals
WHEN NEW.state <> 'pending' OR NOT EXISTS (
  SELECT 1 FROM sponsor_screening_cases c
    JOIN sponsors s ON s.sponsor_id = c.sponsor_id
   WHERE c.case_id = NEW.case_id
     AND c.state = 'rejected'
     AND c.sponsor_id = NEW.sponsor_id
     AND s.tombstoned_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM sponsor_suspension_events se WHERE se.sponsor_id = s.sponsor_id)
     AND NOT EXISTS (SELECT 1 FROM private_draft_erasures e WHERE e.problem_id = c.problem_id)
)
BEGIN
  SELECT RAISE(ABORT, 'APPEAL_CASE_UNAVAILABLE');
END;

CREATE TRIGGER sponsor_screening_appeal_immutable
BEFORE UPDATE ON sponsor_screening_case_appeals
WHEN NEW.appeal_id IS NOT OLD.appeal_id
  OR NEW.case_id IS NOT OLD.case_id
  OR NEW.sponsor_id IS NOT OLD.sponsor_id
  OR NEW.request_digest IS NOT OLD.request_digest
  OR NEW.key_hash IS NOT OLD.key_hash
  OR NEW.submitted_at IS NOT OLD.submitted_at
  OR (NEW.statement IS NOT OLD.statement AND NOT (
    NEW.statement = '[erased]' AND (
      EXISTS (SELECT 1 FROM sponsors s WHERE s.sponsor_id = OLD.sponsor_id AND s.tombstoned_at IS NOT NULL)
      OR EXISTS (
        SELECT 1 FROM private_draft_erasures e
          JOIN sponsor_screening_cases c ON c.problem_id = e.problem_id
         WHERE c.case_id = OLD.case_id
      )
    )
  ))
  OR (OLD.state <> 'pending' AND (
    NEW.state IS NOT OLD.state
    OR NEW.decided_at IS NOT OLD.decided_at
    OR NEW.decided_by IS NOT OLD.decided_by
    OR NEW.decision_reason IS NOT OLD.decision_reason
    OR NEW.decision_key_hash IS NOT OLD.decision_key_hash
    OR NEW.decision_digest IS NOT OLD.decision_digest
    OR NEW.audit_event_id IS NOT OLD.audit_event_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'APPEAL_RECORD_IMMUTABLE');
END;

CREATE TRIGGER sponsor_screening_appeal_decision_authorized
BEFORE UPDATE OF state ON sponsor_screening_case_appeals
WHEN NEW.state <> OLD.state AND (NEW.state = 'pending' OR NOT EXISTS (
  SELECT 1 FROM sponsor_screening_cases c
    JOIN sponsors s ON s.sponsor_id = c.sponsor_id
   WHERE c.case_id = NEW.case_id
     AND c.state = 'rejected'
     AND c.sponsor_id = NEW.sponsor_id
     AND s.tombstoned_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM sponsor_suspension_events se WHERE se.sponsor_id = s.sponsor_id)
     AND c.decided_by <> NEW.decided_by
     AND NEW.sponsor_id <> NEW.decided_by
     AND NOT EXISTS (SELECT 1 FROM private_draft_erasures e WHERE e.problem_id = c.problem_id)
))
BEGIN
  SELECT RAISE(ABORT, 'APPEAL_REVIEW_AUTHORITY_CHANGED');
END;

CREATE TRIGGER sponsor_screening_appeal_no_delete
BEFORE DELETE ON sponsor_screening_case_appeals
BEGIN
  SELECT RAISE(ABORT, 'APPEAL_RECORD_IMMUTABLE');
END;

CREATE TRIGGER sponsor_screening_appeal_draft_erasure
AFTER INSERT ON private_draft_erasures
BEGIN
  UPDATE sponsor_screening_case_appeals
     SET statement = '[erased]'
   WHERE case_id IN (SELECT case_id FROM sponsor_screening_cases WHERE problem_id = NEW.problem_id);
END;

CREATE TRIGGER sponsor_screening_appeal_account_erasure
AFTER UPDATE OF tombstoned_at ON sponsors
WHEN NEW.tombstoned_at IS NOT NULL
BEGIN
  UPDATE sponsor_screening_case_appeals
     SET statement = '[erased]'
   WHERE sponsor_id = NEW.sponsor_id;
END;

-- Pre-provider attempt reservation for sponsor commentary writes so held,
-- rejected, or concurrent attempts consume budget BEFORE paid Workers AI calls
-- and carry sealed replay metadata for non-committed screening outcomes.
CREATE TABLE sponsor_commentary_attempt_reservations (
  reservation_id TEXT PRIMARY KEY NOT NULL,
  sponsor_id TEXT NOT NULL,
  problem_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^a-f0-9]*'
  ),
  reserved_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  settled_at INTEGER,
  status TEXT NOT NULL CHECK (
    status IN ('reserved', 'settled_published', 'settled_held', 'settled_rejected', 'settled_failed', 'recovered')
  ),
  case_id TEXT,
  event_id TEXT
);

CREATE INDEX sponsor_commentary_reservations_sponsor_time_idx
  ON sponsor_commentary_attempt_reservations (sponsor_id, reserved_at);

CREATE INDEX sponsor_commentary_reservations_replay_idx
  ON sponsor_commentary_attempt_reservations (sponsor_id, problem_id, idempotency_key, reserved_at DESC);

CREATE UNIQUE INDEX sponsor_commentary_reservations_inflight_idx
  ON sponsor_commentary_attempt_reservations (sponsor_id, problem_id, idempotency_key)
  WHERE status = 'reserved';

CREATE TRIGGER sponsor_commentary_attempt_cap_insert
BEFORE INSERT ON sponsor_commentary_attempt_reservations
WHEN (
  SELECT COUNT(*)
    FROM sponsor_commentary_attempt_reservations
   WHERE sponsor_id = NEW.sponsor_id
     AND reserved_at > NEW.reserved_at - 60000
) >= 20
BEGIN
  SELECT RAISE(ABORT, 'COMMENTARY_RATE_LIMIT_EXCEEDED');
END;

CREATE TRIGGER sponsor_commentary_reservations_no_delete
BEFORE DELETE ON sponsor_commentary_attempt_reservations
BEGIN
  SELECT RAISE(ABORT, 'RESERVATION_IMMUTABLE');
END;

CREATE TRIGGER sponsor_commentary_reservations_update_guard
BEFORE UPDATE ON sponsor_commentary_attempt_reservations
WHEN OLD.status <> 'reserved'
BEGIN
  SELECT RAISE(ABORT, 'SETTLED_RESERVATION_IMMUTABLE');
END;
