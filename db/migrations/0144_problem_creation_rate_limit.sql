-- Fable §7.10: every newly proposed or forked problem consumes its creating
-- sponsor's shared rolling 24-hour allowance. These are quota counters, not
-- scientific events. No FK to problems: private erasure must not refund a slot.
CREATE TABLE problem_creation_admissions (
  problem_id TEXT PRIMARY KEY,
  sponsor_id TEXT NOT NULL CHECK(length(sponsor_id) > 0),
  created_at INTEGER NOT NULL CHECK(
    typeof(created_at) = 'integer' AND created_at >= 0
    AND created_at <= 9007199168340991
  )
);

CREATE INDEX problem_creation_admissions_sponsor_time
  ON problem_creation_admissions(sponsor_id, created_at, problem_id);

-- Account for surviving pre-limit creations and recently erased proposals.
-- Prefer immutable command/fork attribution over a subsequently moved owner;
-- old imports without either retain their only recorded sponsor attribution.
WITH historical_creations AS (
  SELECT p.id AS problem_id,
    COALESCE(r.sponsor_id, f.forked_by_sponsor_id, p.sponsor_id) AS sponsor_id,
    COALESCE(r.created_at,
      CASE
        -- Early records may carry canonical epoch milliseconds in a TEXT
        -- column. Accept only bounded digits, never a lossy numeric coercion.
        WHEN length(p.created_at) BETWEEN 1 AND 16
          AND p.created_at NOT GLOB '*[^0-9]*'
          AND CAST(p.created_at AS INTEGER) BETWEEN 0 AND 9007199168340991
        THEN CAST(p.created_at AS INTEGER)
        ELSE CAST(strftime('%s', p.created_at) AS INTEGER) * 1000
          + CAST(substr(strftime('%f', p.created_at), 4, 3) AS INTEGER)
      END) AS created_at
  FROM problems p
  LEFT JOIN problem_proposal_command_receipts r ON r.problem_id = p.id
  LEFT JOIN problem_forks f ON f.problem_id = p.id
)
INSERT OR IGNORE INTO problem_creation_admissions(problem_id, sponsor_id, created_at)
SELECT problem_id, sponsor_id, created_at FROM historical_creations
WHERE sponsor_id IS NOT NULL AND length(sponsor_id) > 0
  AND typeof(created_at) = 'integer'
  AND created_at BETWEEN 0 AND 9007199168340991;

INSERT OR IGNORE INTO problem_creation_admissions(problem_id, sponsor_id, created_at)
SELECT problem_id, sponsor_id, created_at FROM problem_proposal_command_receipts;

-- The trigger runs inside the same batch as creation, membership, statement,
-- optional brief adoption, and the replay receipt. A concurrent final-slot
-- loser rolls all of them back. Future timestamps stay charged on clock skew.
CREATE TRIGGER problem_creation_admissions_capacity
BEFORE INSERT ON problem_creation_admissions
WHEN (
  SELECT COUNT(*) FROM problem_creation_admissions
  WHERE sponsor_id = NEW.sponsor_id AND created_at > NEW.created_at - 86400000
) >= 2
BEGIN
  SELECT RAISE(ABORT, 'PROBLEM_CREATION_RATE_LIMITED');
END;
