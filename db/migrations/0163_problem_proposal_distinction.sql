-- A duplicate override belongs to the exact proposed formulation. Legacy
-- versions and replacement formulations have no recorded rationale.
ALTER TABLE problem_statement_versions ADD COLUMN distinct_because TEXT
  CHECK (distinct_because IS NULL OR length(distinct_because) BETWEEN 1 AND 2048);
