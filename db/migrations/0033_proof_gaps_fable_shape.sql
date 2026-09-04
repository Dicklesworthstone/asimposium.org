-- asimposium:allow-destructive
-- W5.5 (asimposiumorg-zlm): refit proof_gaps to the Fable §6.1 shape and give
-- problems a per-problem gap counter.
--
-- 0027 shipped this table DDL-only with zero wire writers, in a shape missing
-- the two load-bearing fields: the exact claim-version pin (in_claim@ver — a
-- silent strengthening must not retroactively discharge an obligation) and
-- Fable's three-state lifecycle (open / closed-by / withdrawn; 0027 only had
-- open/closed). The table is provably unwritten (no code referenced it), so
-- the refit copies any rows verbatim, mapping 'closed' to 'closed-by', and
-- leaves legacy target columns NULL rather than inventing pins for them.

CREATE TABLE proof_gaps_refitted (
  gap_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  -- The exact missing step. "It follows" is not an obligation.
  obligation TEXT NOT NULL CHECK (length(obligation) BETWEEN 1 AND 2000),
  -- What closing this gap would establish.
  closes_what TEXT NOT NULL CHECK (length(closes_what) BETWEEN 1 AND 1000),
  -- The exact-version pin: which published statement owes this step.
  target_claim_id TEXT,
  target_version INTEGER CHECK (target_version IS NULL OR target_version > 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed-by', 'withdrawn')),
  -- For closed-by: the claim or evidence ref that discharges the obligation.
  closed_by TEXT,
  author_fellow_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  PRIMARY KEY (problem_id, gap_id)
);

INSERT INTO proof_gaps_refitted (
  gap_id, problem_id, obligation, closes_what, target_claim_id, target_version,
  status, closed_by, author_fellow_id, created_at, closed_at
)
SELECT
  gap_id, problem_id, statement, closes_what, NULL, NULL,
  CASE WHEN status = 'closed' THEN 'closed-by' ELSE status END,
  closed_by_evidence_id, author_fellow_id, created_at, closed_at
FROM proof_gaps;

DROP TABLE proof_gaps;
ALTER TABLE proof_gaps_refitted RENAME TO proof_gaps;

CREATE TRIGGER proof_gaps_immutable_delete
BEFORE DELETE ON proof_gaps
BEGIN
  SELECT RAISE(ABORT, 'PROOF_GAP_IMMUTABLE');
END;

CREATE TRIGGER proof_gaps_immutable_update
BEFORE UPDATE OF gap_id, problem_id, obligation, closes_what, target_claim_id,
  target_version, author_fellow_id, created_at ON proof_gaps
BEGIN
  SELECT RAISE(ABORT, 'PROOF_GAP_IMMUTABLE');
END;

-- Per-problem gap numbering (G-n is problem-scoped, like every public id).
