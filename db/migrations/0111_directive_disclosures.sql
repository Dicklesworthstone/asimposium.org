-- Exact-result, sponsor-at-event disclosure. Declarations supplement evidence;
-- they cannot mint a scientific disposition. Private instructions remain private.
PRAGMA foreign_keys = ON;

CREATE TABLE directive_disclosure_records (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  claim_id TEXT NOT NULL,
  claim_version INTEGER NOT NULL CHECK (claim_version > 0),
  content_digest TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES events(id),
  sponsor_id TEXT NOT NULL REFERENCES sponsors(sponsor_id),
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  scope_id TEXT NOT NULL CHECK (length(scope_id) = 64),
  coverage_digest TEXT NOT NULL CHECK (length(coverage_digest) = 64),
  lineage_digest TEXT NOT NULL CHECK (length(lineage_digest) = 64),
  revision INTEGER NOT NULL CHECK (revision > 0),
  decision TEXT NOT NULL CHECK (decision IN ('no-undisclosed','disclose','withdraw')),
  seq INTEGER NOT NULL CHECK (seq > 0),
  idempotency_key_digest TEXT NOT NULL CHECK (length(idempotency_key_digest) = 64),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  public_payload_sha256 TEXT NOT NULL CHECK (length(public_payload_sha256) = 64),
  public_payload_json TEXT NOT NULL CHECK (json_valid(public_payload_json) AND length(CAST(public_payload_json AS BLOB)) <= 32768),
  recorded_at TEXT NOT NULL,
  UNIQUE (scope_id, revision),
  UNIQUE (sponsor_id, idempotency_key_digest),
  UNIQUE (problem_id, seq)
);
CREATE INDEX directive_disclosure_records_target_idx
  ON directive_disclosure_records(problem_id, claim_id, claim_version, scope_id, revision);

CREATE TRIGGER directive_disclosure_record_guard BEFORE INSERT ON directive_disclosure_records
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM events e JOIN event_content c ON c.event_id = e.id
    JOIN sponsors s ON s.sponsor_id = NEW.sponsor_id
    WHERE e.id = NEW.event_id AND e.problem_id = NEW.problem_id
      AND e.type = 'directive.disclosure-recorded' AND e.object_kind = 'directive-disclosure'
      AND e.object_id = NEW.event_id AND e.object_version = NEW.revision
      AND e.seq = NEW.seq AND e.actor_sponsor_id = NEW.sponsor_id
      AND e.actor_fellow_id IS NULL AND e.actor_session_id IS NULL
      AND e.payload_sha256 = NEW.public_payload_sha256
      AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
      AND c.payload_json = NEW.public_payload_json AND s.tombstoned_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM sponsor_suspension_events ban WHERE ban.sponsor_id = s.sponsor_id)
      AND json_extract(c.payload_json, '$.kind') = 'directive-disclosure'
      AND json_extract(c.payload_json, '$.target.problem_id') = NEW.problem_id
      AND json_extract(c.payload_json, '$.target.claim_id') = NEW.claim_id
      AND json_extract(c.payload_json, '$.target.version') = NEW.claim_version
      AND json_extract(c.payload_json, '$.target.content_digest') = NEW.content_digest
      AND json_extract(c.payload_json, '$.target.publication_event_id') = NEW.source_event_id
      AND json_extract(c.payload_json, '$.sponsor_id') = NEW.sponsor_id
      AND json_extract(c.payload_json, '$.fellow_id') = NEW.fellow_id
      AND json_extract(c.payload_json, '$.scope_id') = NEW.scope_id
      AND json_extract(c.payload_json, '$.coverage_digest') = NEW.coverage_digest
      AND json_extract(c.payload_json, '$.revision') = NEW.revision
      AND json_extract(c.payload_json, '$.decision') = NEW.decision
      AND e.created_at = NEW.recorded_at
  ) THEN RAISE(ABORT, 'DIRECTIVE_DISCLOSURE_EVENT_REQUIRED') END;
  SELECT CASE WHEN NEW.revision <> COALESCE((SELECT MAX(revision)
    FROM directive_disclosure_records WHERE scope_id = NEW.scope_id), 0) + 1
    THEN RAISE(ABORT, 'DIRECTIVE_DISCLOSURE_REVISION_CONFLICT') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM events e JOIN claim_versions v ON v.problem_id = e.problem_id
      AND v.claim_id = e.object_id AND v.version = e.object_version
    WHERE e.id = NEW.source_event_id AND e.problem_id = NEW.problem_id
      AND e.object_id = NEW.claim_id AND e.object_version = NEW.claim_version
      AND e.object_kind = 'claim' AND e.type IN ('claim.created','claim.revised')
      AND v.content_digest = NEW.content_digest
  ) THEN RAISE(ABORT, 'DIRECTIVE_DISCLOSURE_SOURCE_REQUIRED') END;
END;
CREATE TRIGGER directive_disclosure_record_no_update BEFORE UPDATE ON directive_disclosure_records
BEGIN SELECT RAISE(ABORT, 'DIRECTIVE_DISCLOSURE_IMMUTABLE'); END;
CREATE TRIGGER directive_disclosure_record_no_delete BEFORE DELETE ON directive_disclosure_records
BEGIN SELECT RAISE(ABORT, 'DIRECTIVE_DISCLOSURE_IMMUTABLE'); END;

-- The bounded projection names authoritative coverage requirements. Its source
-- JSON is private: it contains only source pins and accountability metadata,
-- never the text of a private directive. Public standing sees only its status.
CREATE TABLE directive_disclosure_targets (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  claim_id TEXT NOT NULL,
  claim_version INTEGER NOT NULL CHECK (claim_version > 0),
  content_digest TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES events(id),
  lineage_digest TEXT NOT NULL CHECK (length(lineage_digest) = 64),
  lineage_json TEXT NOT NULL CHECK (json_valid(lineage_json) AND length(CAST(lineage_json AS BLOB)) <= 524288),
  scope_requirements_json TEXT NOT NULL CHECK (json_valid(scope_requirements_json)
    AND json_type(scope_requirements_json) = 'array'
    AND json_array_length(scope_requirements_json) BETWEEN 1 AND 64),
  invalidated INTEGER NOT NULL DEFAULT 0 CHECK (invalidated IN (0,1)),
  last_event_id TEXT NOT NULL REFERENCES directive_disclosure_records(event_id),
  last_event_seq INTEGER NOT NULL CHECK (last_event_seq > 0),
  PRIMARY KEY (problem_id, claim_id, claim_version)
);
CREATE TRIGGER directive_disclosure_target_insert_guard BEFORE INSERT ON directive_disclosure_targets
WHEN NOT EXISTS (SELECT 1 FROM directive_disclosure_records r WHERE r.event_id = NEW.last_event_id
  AND r.problem_id = NEW.problem_id AND r.claim_id = NEW.claim_id AND r.claim_version = NEW.claim_version
  AND r.content_digest = NEW.content_digest AND r.source_event_id = NEW.source_event_id
  AND r.lineage_digest = NEW.lineage_digest AND r.seq = NEW.last_event_seq)
BEGIN SELECT RAISE(ABORT, 'DIRECTIVE_DISCLOSURE_PROJECTION_UNGROUNDED'); END;
CREATE TRIGGER directive_disclosure_target_update_guard BEFORE UPDATE ON directive_disclosure_targets
WHEN NEW.problem_id <> OLD.problem_id OR NEW.claim_id <> OLD.claim_id OR NEW.claim_version <> OLD.claim_version
  OR NEW.content_digest <> OLD.content_digest OR NEW.source_event_id <> OLD.source_event_id
  OR NOT (
    (NEW.last_event_id = OLD.last_event_id AND NEW.last_event_seq = OLD.last_event_seq
      AND NEW.lineage_digest = OLD.lineage_digest AND NEW.lineage_json = OLD.lineage_json
      AND NEW.scope_requirements_json = OLD.scope_requirements_json AND NEW.invalidated = 1)
    OR (NEW.last_event_seq > OLD.last_event_seq AND EXISTS (
      SELECT 1 FROM directive_disclosure_records r WHERE r.event_id = NEW.last_event_id
        AND r.problem_id = NEW.problem_id AND r.claim_id = NEW.claim_id AND r.claim_version = NEW.claim_version
        AND r.content_digest = NEW.content_digest AND r.source_event_id = NEW.source_event_id
        AND r.lineage_digest = NEW.lineage_digest AND r.seq = NEW.last_event_seq
    ))
  )
BEGIN SELECT RAISE(ABORT, 'DIRECTIVE_DISCLOSURE_PROJECTION_UNGROUNDED'); END;
CREATE TRIGGER directive_disclosure_target_no_delete BEFORE DELETE ON directive_disclosure_targets
BEGIN SELECT RAISE(ABORT, 'DIRECTIVE_DISCLOSURE_PROJECTION_RETAINED'); END;

CREATE TRIGGER directive_disclosure_new_steering AFTER INSERT ON sponsor_directives
BEGIN
  UPDATE directive_disclosure_targets SET invalidated = 1
  WHERE (NEW.problem_id IS NULL OR problem_id = NEW.problem_id)
    AND EXISTS (SELECT 1 FROM json_each(lineage_json, '$.fellows') f
      WHERE json_extract(f.value, '$.fellow_id') = NEW.fellow_id);
END;
CREATE TRIGGER directive_disclosure_transfer AFTER UPDATE OF status ON sponsor_fellow_transfers
WHEN OLD.status <> 'accepted' AND NEW.status = 'accepted'
BEGIN
  UPDATE directive_disclosure_targets SET invalidated = 1
  WHERE EXISTS (SELECT 1 FROM json_each(lineage_json, '$.fellows') f
    WHERE json_extract(f.value, '$.fellow_id') = NEW.fellow_id);
END;
CREATE TRIGGER directive_disclosure_transfer_insert AFTER INSERT ON sponsor_fellow_transfers
WHEN NEW.status = 'accepted'
BEGIN
  UPDATE directive_disclosure_targets SET invalidated = 1
  WHERE EXISTS (SELECT 1 FROM json_each(lineage_json, '$.fellows') f
    WHERE json_extract(f.value, '$.fellow_id') = NEW.fellow_id);
END;
CREATE TRIGGER directive_disclosure_sponsor_change AFTER UPDATE OF sponsor_id ON enrollment_fellows
WHEN NEW.sponsor_id <> OLD.sponsor_id
BEGIN
  UPDATE directive_disclosure_targets SET invalidated = 1
  WHERE EXISTS (SELECT 1 FROM json_each(lineage_json, '$.fellows') f
    WHERE json_extract(f.value, '$.fellow_id') = NEW.fellow_id);
END;
CREATE TRIGGER directive_disclosure_claim_change AFTER UPDATE OF source_seq, statement_version, statement_drift ON claims
WHEN NEW.source_seq IS NOT OLD.source_seq OR NEW.statement_version IS NOT OLD.statement_version
  OR NEW.statement_drift IS NOT OLD.statement_drift
BEGIN
  UPDATE directive_disclosure_targets SET invalidated = 1
  WHERE problem_id = NEW.problem_id AND claim_id = NEW.id;
END;
