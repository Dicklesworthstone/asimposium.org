PRAGMA foreign_keys = ON;

-- W3.7 sponsor enrollment-attempt budget (asimposiumorg-9p4). Fable
-- requires a per-day sponsor limit but does not choose a threshold. Launch
-- policy permits ten successful distinct starts in a rolling 24-hour window.
-- A join URL charges when its durable enrollment record is inserted. A device
-- flow cannot name a sponsor at start, so it charges only when approve/reduce
-- atomically creates the durable grant. Denials, lookups, claims, polls,
-- refusals, and exact idempotent replays create neither fact and are free.
--
-- Retained facts strictly newer than the window beginning count, including
-- future-dated facts. That makes the exact oldest boundary reusable without
-- allowing a regressed Worker clock to bypass the budget. Existing over-limit
-- history is preserved; only a new consuming insert is refused.

CREATE INDEX enrollment_records_sponsor_kind_created_idx
  ON enrollment_records (sponsor_id, kind, created_at);

-- Device attempts need their own time-indexed projection. Filtering the grant
-- table through proposal -> record after a sponsor/time scan would still read
-- an unbounded number of recent join-URL grants before finding device rows.
-- This table is derived from immutable grant evidence and is itself immutable.
CREATE TABLE sponsor_device_enrollment_attempts (
  proposal_id TEXT PRIMARY KEY NOT NULL,
  sponsor_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  FOREIGN KEY (proposal_id) REFERENCES enrollment_grants(proposal_id)
);

INSERT INTO sponsor_device_enrollment_attempts (proposal_id, sponsor_id, attempted_at)
SELECT grant_row.proposal_id, grant_row.sponsor_id, grant_row.granted_at
  FROM enrollment_grants grant_row
  JOIN enrollment_proposals proposal
    ON proposal.proposal_id = grant_row.proposal_id
  JOIN enrollment_records record
    ON record.enrollment_id = proposal.enrollment_id
 WHERE record.kind = 'device';

CREATE INDEX sponsor_device_enrollment_attempts_sponsor_time_idx
  ON sponsor_device_enrollment_attempts (sponsor_id, attempted_at);

CREATE TRIGGER sponsor_device_enrollment_attempts_insert_guard
BEFORE INSERT ON sponsor_device_enrollment_attempts
WHEN typeof(NEW.proposal_id) <> 'text'
  OR length(NEW.proposal_id) NOT BETWEEN 1 AND 160
  OR typeof(NEW.sponsor_id) <> 'text'
  OR length(NEW.sponsor_id) NOT BETWEEN 1 AND 160
  OR typeof(NEW.attempted_at) <> 'integer'
  OR NEW.attempted_at NOT BETWEEN 1 AND 9007199254740991
  OR NOT EXISTS (
    SELECT 1
      FROM enrollment_grants grant_row
      JOIN enrollment_proposals proposal
        ON proposal.proposal_id = grant_row.proposal_id
      JOIN enrollment_records record
        ON record.enrollment_id = proposal.enrollment_id
     WHERE grant_row.proposal_id = NEW.proposal_id
       AND grant_row.sponsor_id = NEW.sponsor_id
       AND grant_row.granted_at = NEW.attempted_at
       AND record.kind = 'device'
  )
BEGIN
  SELECT RAISE(ABORT, 'device enrollment attempt binding mismatch');
END;

CREATE TRIGGER sponsor_device_enrollment_attempts_duplicate_insert
BEFORE INSERT ON sponsor_device_enrollment_attempts
WHEN EXISTS (
  SELECT 1 FROM sponsor_device_enrollment_attempts
   WHERE proposal_id = NEW.proposal_id
)
BEGIN
  SELECT RAISE(ABORT, 'device enrollment attempt is immutable');
END;

CREATE TRIGGER sponsor_device_enrollment_attempts_immutable_update
BEFORE UPDATE ON sponsor_device_enrollment_attempts
BEGIN
  SELECT RAISE(ABORT, 'device enrollment attempt is immutable');
END;

CREATE TRIGGER sponsor_device_enrollment_attempts_immutable_delete
BEFORE DELETE ON sponsor_device_enrollment_attempts
BEGIN
  SELECT RAISE(ABORT, 'device enrollment attempt is immutable');
END;

CREATE TRIGGER enrollment_records_sponsor_rate_insert
AFTER INSERT ON enrollment_records
WHEN NEW.kind = 'join-url'
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(*)
      FROM (
        SELECT 1 AS occupied
          FROM enrollment_records existing
         WHERE existing.sponsor_id = NEW.sponsor_id
           AND existing.kind = 'join-url'
           AND existing.created_at > NEW.created_at - 86400000
        UNION ALL
        SELECT 1 AS occupied
          FROM sponsor_device_enrollment_attempts device_attempt
         WHERE device_attempt.sponsor_id = NEW.sponsor_id
           AND device_attempt.attempted_at > NEW.created_at - 86400000
        LIMIT 11
      ) bounded_attempts
  ) > 10 THEN RAISE(ABORT, 'sponsor enrollment rate reached')
  END;
END;

CREATE TRIGGER enrollment_grants_sponsor_rate_insert
AFTER INSERT ON enrollment_grants
WHEN EXISTS (
  SELECT 1
    FROM enrollment_proposals proposal
    JOIN enrollment_records record
      ON record.enrollment_id = proposal.enrollment_id
   WHERE proposal.proposal_id = NEW.proposal_id
     AND record.kind = 'device'
)
BEGIN
  INSERT INTO sponsor_device_enrollment_attempts (proposal_id, sponsor_id, attempted_at)
  VALUES (NEW.proposal_id, NEW.sponsor_id, NEW.granted_at);

  SELECT CASE WHEN (
    SELECT COUNT(*)
      FROM (
        SELECT 1 AS occupied
          FROM enrollment_records existing
         WHERE existing.sponsor_id = NEW.sponsor_id
           AND existing.kind = 'join-url'
           AND existing.created_at > NEW.granted_at - 86400000
        UNION ALL
        SELECT 1 AS occupied
          FROM sponsor_device_enrollment_attempts device_attempt
         WHERE device_attempt.sponsor_id = NEW.sponsor_id
           AND device_attempt.attempted_at > NEW.granted_at - 86400000
        LIMIT 11
      ) bounded_attempts
  ) > 10 THEN RAISE(ABORT, 'sponsor enrollment rate reached')
  END;
END;
