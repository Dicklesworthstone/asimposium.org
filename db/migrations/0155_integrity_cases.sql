-- Fable §9.1 / asimposiumorg-bum: restricted scientific-integrity investigation.
-- Case actions do not edit events, dispositions, content controls, or strikes.
-- Original publication and accountable principals remain pinned after transfer.

CREATE TABLE integrity_cases (
  case_id TEXT PRIMARY KEY CHECK (case_id GLOB 'IC-*' AND length(case_id) = 29),
  report_id TEXT NOT NULL UNIQUE REFERENCES reports(report_id),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  target_ref TEXT NOT NULL CHECK (length(target_ref) BETWEEN 1 AND 96),
  source_event_id TEXT NOT NULL REFERENCES events(id),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64 AND source_digest NOT GLOB '*[^a-f0-9]*'),
  source_seq INTEGER NOT NULL CHECK (source_seq >= 1),
  subject_sponsor_id TEXT NOT NULL,
  subject_fellow_id TEXT REFERENCES enrollment_fellows(fellow_id),
  reporter_sponsor_id TEXT NOT NULL,
  concern TEXT NOT NULL CHECK (concern IN (
    'fabricated-source', 'fabricated-verification', 'plagiarism',
    'declaration-mismatch', 'coordinated-manipulation'
  )),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 10 AND 4000),
  public_notice INTEGER NOT NULL CHECK (public_notice IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  appeals_used INTEGER NOT NULL DEFAULT 0 CHECK (appeals_used IN (0, 1)),
  opened_by TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  original_resolved_by TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN (
    'unsubstantiated', 'honest-error', 'inconclusive', 'confirmed'
  )),
  rationale TEXT CHECK (rationale IS NULL OR length(rationale) BETWEEN 10 AND 4000),
  correction_refs_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(correction_refs_json) AND json_type(correction_refs_json) = 'array'
      AND json_array_length(correction_refs_json) <= 8 AND length(correction_refs_json) <= 16000),
  CHECK (
    (state = 'open' AND resolved_at IS NULL AND resolved_by IS NULL
      AND outcome IS NULL AND rationale IS NULL AND json_array_length(correction_refs_json) = 0)
    OR
    (state = 'resolved' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL
      AND outcome IS NOT NULL AND rationale IS NOT NULL AND original_resolved_by IS NOT NULL)
  ),
  CHECK (appeals_used = 0 OR original_resolved_by IS NOT NULL)
);
CREATE INDEX integrity_cases_operator_history
  ON integrity_cases (opened_at DESC, case_id DESC);
CREATE INDEX integrity_cases_subject_history
  ON integrity_cases (subject_sponsor_id, opened_at DESC, case_id DESC);
CREATE INDEX integrity_cases_public_notices
  ON integrity_cases (problem_id, public_notice, case_id);

CREATE TABLE integrity_case_actions (
  action_id TEXT PRIMARY KEY CHECK (action_id GLOB 'IA-*' AND length(action_id) = 29),
  case_id TEXT NOT NULL REFERENCES integrity_cases(case_id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('opened', 'response', 'appealed', 'resolved')),
  actor_class TEXT NOT NULL CHECK (actor_class IN ('sponsor', 'operator')),
  actor_id TEXT NOT NULL,
  body_json TEXT NOT NULL CHECK (json_valid(body_json) AND json_type(body_json) = 'object'
    AND length(body_json) <= 64000),
  created_at TEXT NOT NULL,
  UNIQUE (case_id, revision),
  CHECK (
    (kind IN ('opened', 'resolved') AND actor_class = 'operator')
    OR (kind IN ('response', 'appealed') AND actor_class = 'sponsor')
  ),
  CHECK ((kind = 'opened') = (revision = 1))
);

-- This is a separate receipt namespace: generic moderation decisions cannot
-- replay an integrity action, or vice versa. Receipts never enter public faces.
CREATE TABLE integrity_command_receipts (
  actor_class TEXT NOT NULL CHECK (actor_class IN ('sponsor', 'operator')),
  actor_id TEXT NOT NULL,
  key_digest TEXT NOT NULL CHECK (length(key_digest) = 64 AND key_digest NOT GLOB '*[^a-f0-9]*'),
  operation TEXT NOT NULL CHECK (operation IN ('open', 'respond', 'resolve')),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^a-f0-9]*'),
  case_id TEXT NOT NULL REFERENCES integrity_cases(case_id),
  action_id TEXT NOT NULL REFERENCES integrity_case_actions(action_id),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json) AND json_type(receipt_json) = 'object'
    AND length(receipt_json) <= 8192),
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_class, actor_id, key_digest)
);

-- Only an exactly retained integrity report can start this track. A mismatch
-- cannot silently move an allegation to a new version, kind, author or sponsor.
CREATE TRIGGER integrity_case_source_admission
BEFORE INSERT ON integrity_cases
WHEN NEW.state <> 'open' OR NEW.revision <> 1 OR NEW.appeals_used <> 0
  OR NEW.original_resolved_by IS NOT NULL
  OR NEW.opened_by IN (NEW.subject_sponsor_id, NEW.reporter_sponsor_id)
  OR NOT EXISTS (
    SELECT 1 FROM reports r JOIN events e ON e.id = r.source_event_id
    WHERE r.report_id = NEW.report_id AND r.reason = 'integrity'
      AND r.status = 'pending' AND r.problem_id = NEW.problem_id
      AND r.reporter_sponsor_id = NEW.reporter_sponsor_id
      AND r.source_event_id = NEW.source_event_id AND r.source_digest = NEW.source_digest
      AND e.problem_id = NEW.problem_id AND e.payload_sha256 = NEW.source_digest
      AND e.seq = NEW.source_seq AND e.object_kind = r.target_kind
      AND e.actor_fellow_id IS NEW.subject_fellow_id
      AND e.actor_sponsor_id = NEW.subject_sponsor_id
      AND (
        (e.object_kind = 'claim' AND NEW.target_ref = e.object_id || '@' || e.object_version)
        OR (e.object_kind <> 'claim' AND NEW.target_ref = r.source_ref)
      )
  )
BEGIN SELECT RAISE(ABORT, 'INTEGRITY_CASE_SOURCE_UNAVAILABLE'); END;

CREATE TRIGGER integrity_case_header_immutable
BEFORE UPDATE ON integrity_cases
WHEN NEW.case_id IS NOT OLD.case_id OR NEW.report_id IS NOT OLD.report_id
  OR NEW.problem_id IS NOT OLD.problem_id OR NEW.target_ref IS NOT OLD.target_ref
  OR NEW.source_event_id IS NOT OLD.source_event_id OR NEW.source_digest IS NOT OLD.source_digest
  OR NEW.source_seq IS NOT OLD.source_seq OR NEW.subject_sponsor_id IS NOT OLD.subject_sponsor_id
  OR NEW.subject_fellow_id IS NOT OLD.subject_fellow_id
  OR NEW.reporter_sponsor_id IS NOT OLD.reporter_sponsor_id
  OR NEW.concern IS NOT OLD.concern OR NEW.summary IS NOT OLD.summary
  OR NEW.public_notice IS NOT OLD.public_notice OR NEW.opened_by IS NOT OLD.opened_by
  OR NEW.opened_at IS NOT OLD.opened_at
BEGIN SELECT RAISE(ABORT, 'INTEGRITY_CASE_HEADER_IMMUTABLE'); END;

-- Each transaction advances one revision, then appends that revision's action.
-- A second appeal and an in-place replacement of a decision are impossible.
CREATE TRIGGER integrity_case_transition_guard
BEFORE UPDATE ON integrity_cases
WHEN NEW.revision <> OLD.revision + 1
  OR NOT EXISTS (
    SELECT 1 FROM integrity_case_actions a
    WHERE a.case_id = OLD.case_id AND a.revision = OLD.revision
  )
  OR NOT (
    (OLD.state = 'open' AND NEW.state = 'open'
      AND NEW.appeals_used = OLD.appeals_used
      AND NEW.original_resolved_by IS OLD.original_resolved_by)
    OR
    (OLD.state = 'open' AND NEW.state = 'resolved'
      AND NEW.appeals_used = OLD.appeals_used
      AND NEW.resolved_by NOT IN (OLD.subject_sponsor_id, OLD.reporter_sponsor_id)
      AND (
        (OLD.original_resolved_by IS NULL AND NEW.original_resolved_by = NEW.resolved_by)
        OR
        (OLD.original_resolved_by IS NOT NULL
          AND NEW.original_resolved_by = OLD.original_resolved_by
          AND NEW.resolved_by <> OLD.original_resolved_by)
      ))
    OR
    (OLD.state = 'resolved' AND NEW.state = 'open'
      AND OLD.appeals_used = 0 AND NEW.appeals_used = 1
      AND NEW.original_resolved_by = OLD.original_resolved_by)
  )
BEGIN SELECT RAISE(ABORT, 'INTEGRITY_CASE_TRANSITION_INVALID'); END;

-- Correction links are immutable publication pins. They are neither new
-- scientific records nor an operator-authored replacement for those records.
CREATE TRIGGER integrity_case_correction_pins
BEFORE UPDATE OF correction_refs_json ON integrity_cases
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.correction_refs_json) pin
  WHERE json_type(pin.value) IS NOT 'object'
    OR (SELECT COUNT(*) FROM json_each(pin.value)) <> 5
    OR NOT EXISTS (
      SELECT 1 FROM events e
      WHERE e.id = json_extract(pin.value, '$.event_id')
        AND e.problem_id = json_extract(pin.value, '$.problem_id')
        AND e.payload_sha256 = json_extract(pin.value, '$.payload_sha256')
        AND e.seq = json_extract(pin.value, '$.seq')
        AND (
          (e.object_kind = 'claim'
            AND json_extract(pin.value, '$.target_ref') = e.object_id || '@' || e.object_version)
          OR (e.object_kind <> 'claim'
            AND json_extract(pin.value, '$.target_ref') = e.object_id)
          OR (e.object_id = e.problem_id
            AND json_extract(pin.value, '$.target_ref') = 'problem')
        )
        AND e.actor_sponsor_id IS NOT NEW.resolved_by
    )
)
BEGIN SELECT RAISE(ABORT, 'INTEGRITY_CORRECTION_PIN_INVALID'); END;

CREATE TRIGGER integrity_case_action_admission
BEFORE INSERT ON integrity_case_actions
WHEN NEW.revision <> COALESCE((
    SELECT MAX(a.revision) FROM integrity_case_actions a WHERE a.case_id = NEW.case_id
  ), 0) + 1
  OR NOT EXISTS (
    SELECT 1 FROM integrity_cases c
    WHERE c.case_id = NEW.case_id AND c.revision = NEW.revision
      AND (
        (NEW.kind = 'opened' AND c.state = 'open' AND c.revision = 1
          AND c.opened_by = NEW.actor_id
          AND json_extract(NEW.body_json, '$.summary') = c.summary
          AND json_extract(NEW.body_json, '$.concern') = c.concern
          AND json_extract(NEW.body_json, '$.public_notice') = c.public_notice
          AND (SELECT COUNT(*) FROM json_each(NEW.body_json)) = 3)
        OR
        (NEW.kind = 'response' AND c.state = 'open'
          AND c.subject_sponsor_id = NEW.actor_id
          AND json_type(NEW.body_json, '$.response') = 'text'
          AND length(json_extract(NEW.body_json, '$.response')) BETWEEN 10 AND 8000
          AND (SELECT COUNT(*) FROM json_each(NEW.body_json)) = 1
          AND EXISTS (SELECT 1 FROM integrity_case_actions prior
            WHERE prior.case_id = c.case_id AND prior.revision = NEW.revision - 1
              AND prior.kind <> 'resolved'))
        OR
        (NEW.kind = 'appealed' AND c.state = 'open' AND c.appeals_used = 1
          AND c.subject_sponsor_id = NEW.actor_id
          AND json_type(NEW.body_json, '$.response') = 'text'
          AND length(json_extract(NEW.body_json, '$.response')) BETWEEN 10 AND 8000
          AND (SELECT COUNT(*) FROM json_each(NEW.body_json)) = 1
          AND EXISTS (SELECT 1 FROM integrity_case_actions prior
            WHERE prior.case_id = c.case_id AND prior.revision = NEW.revision - 1
              AND prior.kind = 'resolved')
          AND NOT EXISTS (SELECT 1 FROM integrity_case_actions a
            WHERE a.case_id = c.case_id AND a.kind = 'appealed'))
        OR
        (NEW.kind = 'resolved' AND c.state = 'resolved' AND c.resolved_by = NEW.actor_id
          AND json_extract(NEW.body_json, '$.outcome') = c.outcome
          AND json_extract(NEW.body_json, '$.rationale') = c.rationale
          AND json(json_extract(NEW.body_json, '$.corrections')) = json(c.correction_refs_json)
          AND (SELECT COUNT(*) FROM json_each(NEW.body_json)) = 3)
      )
  )
BEGIN SELECT RAISE(ABORT, 'INTEGRITY_CASE_ACTION_INVALID'); END;

CREATE TRIGGER integrity_case_no_delete BEFORE DELETE ON integrity_cases
BEGIN SELECT RAISE(ABORT, 'INTEGRITY_CASE_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER integrity_case_action_no_update BEFORE UPDATE ON integrity_case_actions
BEGIN SELECT RAISE(ABORT, 'INTEGRITY_CASE_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER integrity_case_action_no_delete BEFORE DELETE ON integrity_case_actions
BEGIN SELECT RAISE(ABORT, 'INTEGRITY_CASE_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER integrity_receipt_no_update BEFORE UPDATE ON integrity_command_receipts
BEGIN SELECT RAISE(ABORT, 'INTEGRITY_RECEIPT_IMMUTABLE'); END;
CREATE TRIGGER integrity_receipt_no_delete BEFORE DELETE ON integrity_command_receipts
BEGIN SELECT RAISE(ABORT, 'INTEGRITY_RECEIPT_IMMUTABLE'); END;
