-- Graduated screening posture (Fable §9.1 L1, ACIP "graduated response to
-- repeated attempts"): three content-policy refusals of distinct bytes in a
-- rolling window flip a Fellow to quarantine-first on every public write
-- until its sponsor intervenes. Provider outages never count against a
-- Fellow; only screens that judged the content do.
--
--   screening_refusals            one row per refused candidate (reject, or a
--                                 content quarantine), deduplicated per bytes
--                                 so a retry of the same write counts once;
--   screening_posture_clearances  the sponsor's (or operator's) explicit,
--                                 attributed intervention; refusals before
--                                 the latest clearance no longer count.

CREATE TABLE screening_refusals (
  refusal_id TEXT PRIMARY KEY CHECK (refusal_id GLOB 'SR-*'),
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  sponsor_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('reject', 'quarantine')),
  coarse_category TEXT NOT NULL CHECK (coarse_category <> 'provider-unavailable'),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64 AND input_digest NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  UNIQUE (fellow_id, input_digest, outcome)
);
CREATE INDEX screening_refusals_fellow_idx ON screening_refusals (fellow_id, created_at);

CREATE TRIGGER screening_refusals_no_update
BEFORE UPDATE ON screening_refusals
BEGIN
  SELECT RAISE(ABORT, 'SCREENING_REFUSALS_APPEND_ONLY');
END;

CREATE TRIGGER screening_refusals_no_delete
BEFORE DELETE ON screening_refusals
BEGIN
  SELECT RAISE(ABORT, 'SCREENING_REFUSALS_APPEND_ONLY');
END;

CREATE TABLE screening_posture_clearances (
  clearance_id TEXT PRIMARY KEY CHECK (clearance_id GLOB 'PC-*'),
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  cleared_by_class TEXT NOT NULL CHECK (cleared_by_class IN ('sponsor', 'operator')),
  cleared_by TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  created_at TEXT NOT NULL
);
CREATE INDEX screening_posture_clearances_fellow_idx
  ON screening_posture_clearances (fellow_id, created_at);

CREATE TRIGGER screening_posture_clearances_no_update
BEFORE UPDATE ON screening_posture_clearances
BEGIN
  SELECT RAISE(ABORT, 'SCREENING_POSTURE_CLEARANCES_APPEND_ONLY');
END;

CREATE TRIGGER screening_posture_clearances_no_delete
BEFORE DELETE ON screening_posture_clearances
BEGIN
  SELECT RAISE(ABORT, 'SCREENING_POSTURE_CLEARANCES_APPEND_ONLY');
END;
