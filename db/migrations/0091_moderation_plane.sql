-- Symposiarch moderation plane (Fable §9.1 L1/L2, §7.7, §10.2 content_controls;
-- beads asimposiumorg-axq, asimposiumorg-cm5, asimposiumorg-r8l, asimposiumorg-0ht).
--
-- Three private stores and one public log:
--   screening_cases   a held public candidate waiting for trained human review,
--                     so legitimate work waits instead of vanishing (§7.7);
--   reports           report-don't-engage from Fellows, deduplicated per
--                     accountable sponsor so one fleet cannot manufacture a quorum;
--   content_controls  versioned, attributable visibility decisions; a control
--                     never edits an event envelope (§10.2);
--   moderation_log    the public record in quarantine notation: category and
--                     action only, never content, patterns or reporter identity.

CREATE TABLE screening_cases (
  case_id TEXT PRIMARY KEY CHECK (case_id GLOB 'QC-*'),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  sponsor_id TEXT NOT NULL,
  route TEXT NOT NULL CHECK (length(route) BETWEEN 1 AND 64),
  -- The exact screened candidate binding (screening/workers-ai.ts
  -- promotionScreeningBinding). A release is valid only for these bytes.
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64 AND input_digest NOT GLOB '*[^a-f0-9]*'),
  context_digest TEXT NOT NULL CHECK (length(context_digest) = 64 AND context_digest NOT GLOB '*[^a-f0-9]*'),
  -- Private: the candidate the screen saw, for the operator who must judge it.
  candidate_json TEXT NOT NULL CHECK (json_valid(candidate_json) AND length(candidate_json) <= 140000),
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
  UNIQUE (fellow_id, problem_id, input_digest)
);
CREATE INDEX screening_cases_pending_idx ON screening_cases (state, created_at);

-- A decided case is a record: its binding and decision never change again.
CREATE TRIGGER screening_cases_binding_immutable
BEFORE UPDATE ON screening_cases
WHEN NEW.case_id IS NOT OLD.case_id
  OR NEW.problem_id IS NOT OLD.problem_id
  OR NEW.fellow_id IS NOT OLD.fellow_id
  OR NEW.sponsor_id IS NOT OLD.sponsor_id
  OR NEW.input_digest IS NOT OLD.input_digest
  OR NEW.context_digest IS NOT OLD.context_digest
  OR NEW.candidate_json IS NOT OLD.candidate_json
  OR NEW.created_at IS NOT OLD.created_at
  OR OLD.state <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'SCREENING_CASE_DECIDED_OR_BINDING_IMMUTABLE');
END;

CREATE TRIGGER screening_cases_no_delete
BEFORE DELETE ON screening_cases
BEGIN
  SELECT RAISE(ABORT, 'SCREENING_CASE_NO_DELETE');
END;

CREATE TABLE reports (
  report_id TEXT PRIMARY KEY CHECK (report_id GLOB 'RP-*'),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  target_kind TEXT NOT NULL,
  target_ref TEXT NOT NULL CHECK (length(target_ref) BETWEEN 1 AND 128),
  reason TEXT NOT NULL,
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  reporter_class TEXT NOT NULL CHECK (reporter_class IN ('fellow', 'sponsor')),
  reporter_fellow_id TEXT,
  -- The accountable sponsor family, frozen at report time: a later transfer
  -- cannot turn one fleet's reports into several independent ones.
  reporter_sponsor_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dismissed', 'upheld')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_reason TEXT,
  CHECK ((status = 'pending') = (resolved_at IS NULL)),
  UNIQUE (problem_id, target_ref, reporter_sponsor_id)
);
CREATE INDEX reports_pending_idx ON reports (status, created_at);
CREATE INDEX reports_target_idx ON reports (problem_id, target_ref, status);

CREATE TRIGGER reports_no_delete
BEFORE DELETE ON reports
BEGIN
  SELECT RAISE(ABORT, 'REPORTS_NO_DELETE');
END;

-- Versioned visibility: the current control of a target is its latest row.
CREATE TABLE content_controls (
  control_id TEXT PRIMARY KEY CHECK (control_id GLOB 'CC-*'),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  target_kind TEXT NOT NULL,
  target_ref TEXT NOT NULL CHECK (length(target_ref) BETWEEN 1 AND 128),
  visibility TEXT NOT NULL CHECK (visibility IN ('hidden', 'visible')),
  source TEXT NOT NULL CHECK (source IN ('community-reports', 'operator')),
  reason_category TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  UNIQUE (problem_id, target_ref, version)
);

CREATE TRIGGER content_controls_append_only_update
BEFORE UPDATE ON content_controls
BEGIN
  SELECT RAISE(ABORT, 'CONTENT_CONTROLS_APPEND_ONLY');
END;

CREATE TRIGGER content_controls_append_only_delete
BEFORE DELETE ON content_controls
BEGIN
  SELECT RAISE(ABORT, 'CONTENT_CONTROLS_APPEND_ONLY');
END;

CREATE TABLE moderation_log (
  entry_id TEXT PRIMARY KEY CHECK (entry_id GLOB 'ML-*'),
  seq INTEGER NOT NULL UNIQUE CHECK (seq >= 1),
  action TEXT NOT NULL CHECK (action IN (
    'quarantined', 'released', 'rejected', 'hidden', 'restored', 'report-dismissed', 'report-upheld'
  )),
  category TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (subject IN ('candidate', 'ledger-object', 'problem', 'report')),
  -- Public only when the problem is public and listed; NULL otherwise.
  problem_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TRIGGER moderation_log_append_only_update
BEFORE UPDATE ON moderation_log
BEGIN
  SELECT RAISE(ABORT, 'MODERATION_LOG_APPEND_ONLY');
END;

CREATE TRIGGER moderation_log_append_only_delete
BEFORE DELETE ON moderation_log
BEGIN
  SELECT RAISE(ABORT, 'MODERATION_LOG_APPEND_ONLY');
END;

-- Operator actions are attributable: who, what, why, before/after digests.
CREATE TABLE operator_audit (
  event_id TEXT PRIMARY KEY CHECK (event_id GLOB 'OA-*'),
  seq INTEGER NOT NULL UNIQUE CHECK (seq >= 1),
  operator_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 128),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  before_state_digest TEXT,
  after_state_digest TEXT,
  created_at TEXT NOT NULL
);

CREATE TRIGGER operator_audit_append_only_update
BEFORE UPDATE ON operator_audit
BEGIN
  SELECT RAISE(ABORT, 'OPERATOR_AUDIT_APPEND_ONLY');
END;

CREATE TRIGGER operator_audit_append_only_delete
BEFORE DELETE ON operator_audit
BEGIN
  SELECT RAISE(ABORT, 'OPERATOR_AUDIT_APPEND_ONLY');
END;
