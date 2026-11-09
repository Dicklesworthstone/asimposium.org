-- Reports control whole objects, but operator review must retain the exact
-- publication captured at filing. Existing reports cannot reconstruct a
-- version discarded by their original intake; leave those pins unknown.
ALTER TABLE reports ADD COLUMN source_event_id TEXT REFERENCES events(id);
ALTER TABLE reports ADD COLUMN source_digest TEXT;
ALTER TABLE reports ADD COLUMN source_ref TEXT;

-- Existing claim-author lookup is partial; all scientific target families
-- need an indexed publication history for admission and exact source capture.
CREATE INDEX IF NOT EXISTS events_problem_object_seq_idx ON events (problem_id, object_id, seq);

CREATE TRIGGER reports_source_pin_admission
BEFORE INSERT ON reports
WHEN (NEW.source_event_id IS NOT NULL OR NEW.source_digest IS NOT NULL OR NEW.source_ref IS NOT NULL)
  AND (
    NEW.source_event_id IS NULL OR NEW.source_digest IS NULL OR NEW.source_ref IS NULL
    OR length(NEW.source_digest) <> 64 OR NEW.source_digest GLOB '*[^a-f0-9]*'
    OR length(NEW.source_ref) NOT BETWEEN 1 AND 128
    OR NOT EXISTS (
      SELECT 1 FROM events e
      JOIN problems p ON p.id = e.problem_id
      JOIN event_content c ON c.event_id = e.id
      WHERE e.id = NEW.source_event_id AND e.payload_sha256 = NEW.source_digest
        AND e.problem_id = NEW.problem_id AND e.object_kind = NEW.target_kind
        AND p.status <> 'private-draft' AND e.seq BETWEEN 1 AND p.public_seq
        AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
        AND length(CAST(c.payload_json AS BLOB)) <= 524288
        AND NOT EXISTS (SELECT 1 FROM events other_kind
          WHERE other_kind.problem_id = e.problem_id AND other_kind.object_id = e.object_id
            AND other_kind.seq <= p.public_seq AND other_kind.object_kind <> e.object_kind
            AND NOT (e.object_kind = 'gap' AND other_kind.object_kind = 'proof_gap'
              AND other_kind.type IN ('lease.acquired', 'lease.released', 'lease.challenged')))
        AND ((NEW.target_ref = 'problem' AND e.object_id = NEW.problem_id AND NEW.source_ref = 'problem')
          OR (e.object_id = NEW.target_ref AND (NEW.source_ref = NEW.target_ref
            OR (e.object_kind = 'claim' AND NEW.source_ref = e.object_id || '@' || e.object_version))))
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'REPORT_SOURCE_UNAVAILABLE');
END;

CREATE TRIGGER reports_source_pin_immutable
BEFORE UPDATE ON reports
WHEN NEW.source_event_id IS NOT OLD.source_event_id
  OR NEW.source_digest IS NOT OLD.source_digest
  OR NEW.source_ref IS NOT OLD.source_ref
  OR NEW.problem_id IS NOT OLD.problem_id
  OR NEW.target_kind IS NOT OLD.target_kind
  OR NEW.target_ref IS NOT OLD.target_ref
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'REPORT_SOURCE_IMMUTABLE');
END;
