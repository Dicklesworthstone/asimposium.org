-- Immutable empty-D1 bootstrap snapshot at the exact 0015 schema head.
--
-- This artifact is CREATE-only. It does not replay numbered migrations, insert
-- historical migration rows, or manufacture authority. The installer owns the
-- one durable bootstrap-lineage row, exact 0015 witness tuple (1, 1, 1), and
-- empty custom journal in its atomic empty-target transaction.

CREATE TABLE problems (
  id TEXT PRIMARY KEY,
  public_seq INTEGER NOT NULL DEFAULT 0 CHECK (public_seq >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, chain_digest TEXT);
CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  statement TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (problem_id, source_seq)
);
CREATE TABLE claim_projections (
  claim_id TEXT PRIMARY KEY REFERENCES claims(id),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  source_seq INTEGER NOT NULL,
  projection_version INTEGER NOT NULL,
  build_digest TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
  updated_at TEXT NOT NULL,
  UNIQUE (problem_id, source_seq)
);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_version INTEGER NOT NULL,
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL, row_digest TEXT, chain_digest TEXT,
  UNIQUE (problem_id, seq)
);
CREATE TABLE event_content (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  payload_sha256 TEXT NOT NULL,
  payload_json TEXT NOT NULL
, redacted_at TEXT, redaction_reason TEXT);
CREATE TABLE idempotency (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  event_id TEXT REFERENCES events(id),
  event_seq INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, idempotency_key)
);
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_sha256 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered')),
  created_at TEXT NOT NULL,
  delivered_at TEXT
, quarantine_code TEXT CHECK (
    quarantine_code IS NULL OR quarantine_code IN (
      'OUTBOX_EVENT_INVALID',
      'OUTBOX_KIND_INVALID',
      'OUTBOX_DEDUPE_INVALID',
      'OUTBOX_PAYLOAD_INVALID'
    )
), quarantined_at TEXT CHECK (
  (quarantined_at IS NULL AND quarantine_code IS NULL)
  OR (
    quarantined_at IS NOT NULL
    AND quarantine_code IS NOT NULL
    AND state = 'pending'
    AND delivered_at IS NULL
  )
));
CREATE INDEX outbox_pending_idx ON outbox (state, id);
CREATE VIRTUAL TABLE public_claim_fts USING fts5(
  claim_id UNINDEXED,
  problem_id UNINDEXED,
  statement
)
/* public_claim_fts(claim_id,problem_id,statement) */;
CREATE TABLE enrollment_records (
  enrollment_id TEXT PRIMARY KEY,
  sponsor_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  secret_expires_at INTEGER NOT NULL,
  requested_scopes_json TEXT NOT NULL CHECK (json_valid(requested_scopes_json)),
  requested_resources_json TEXT NOT NULL CHECK (json_valid(requested_resources_json)),
  invalidated INTEGER NOT NULL DEFAULT 0 CHECK (invalidated IN (0, 1)),
  secret_consumed_at INTEGER,
  created_at INTEGER NOT NULL
, kind TEXT NOT NULL DEFAULT 'join-url', device_expires_at INTEGER, device_mapping_reclaimed_at INTEGER);
CREATE TABLE enrollment_proposals (
  proposal_id TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL UNIQUE REFERENCES enrollment_records(enrollment_id),
  fellow_id TEXT NOT NULL UNIQUE,
  flow_handle_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  harness TEXT NOT NULL,
  reasoning_effort TEXT,
  tools_note TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'reduced', 'denied', 'expired')),
  granted_scopes_json TEXT CHECK (granted_scopes_json IS NULL OR json_valid(granted_scopes_json)),
  granted_resources_json TEXT CHECK (granted_resources_json IS NULL OR json_valid(granted_resources_json)),
  token_hash TEXT UNIQUE,
  token_issued_at INTEGER,
  poll_interval_seconds INTEGER NOT NULL CHECK (poll_interval_seconds BETWEEN 5 AND 30),
  last_poll_at INTEGER
);
CREATE TABLE enrollment_fellows (
  fellow_id TEXT PRIMARY KEY,
  sponsor_id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  model TEXT NOT NULL,
  harness TEXT NOT NULL,
  created_at INTEGER NOT NULL
, status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN (
    'pending', 'active', 'paused', 'revoked', 'archived', 'compromised',
    'suspicious_review'
  )), status_changed_at INTEGER, status_event_id TEXT
  REFERENCES fellow_lifecycle_events(event_id));
CREATE TABLE enrollment_grants (
  proposal_id TEXT PRIMARY KEY REFERENCES enrollment_proposals(proposal_id),
  fellow_id TEXT NOT NULL UNIQUE REFERENCES enrollment_fellows(fellow_id),
  sponsor_id TEXT NOT NULL,
  granted_scopes_json TEXT NOT NULL CHECK (json_valid(granted_scopes_json)),
  granted_resources_json TEXT NOT NULL CHECK (json_valid(granted_resources_json)),
  granted_at INTEGER NOT NULL
);
CREATE TABLE enrollment_credentials (
  credential_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES enrollment_proposals(proposal_id),
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  sponsor_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  granted_scopes_json TEXT NOT NULL CHECK (json_valid(granted_scopes_json)),
  granted_resources_json TEXT NOT NULL CHECK (json_valid(granted_resources_json)),
  issued_at INTEGER NOT NULL
);
CREATE INDEX enrollment_records_sponsor_idx ON enrollment_records (sponsor_id, secret_expires_at);
CREATE INDEX enrollment_proposals_status_idx ON enrollment_proposals (status, expires_at);
CREATE INDEX enrollment_grants_fellow_idx ON enrollment_grants (fellow_id);
CREATE INDEX enrollment_credentials_token_idx ON enrollment_credentials (token_hash);
CREATE TABLE auth_envelope_nonces (
  nonce_hash TEXT PRIMARY KEY
    CHECK (length(nonce_hash) = 64 AND nonce_hash NOT GLOB '*[^0-9a-f]*'),
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  CHECK (expires_at > claimed_at)
);
CREATE INDEX auth_envelope_nonces_expires_idx ON auth_envelope_nonces (expires_at);
CREATE TABLE krater_integrity_backfill (
  problem_id TEXT PRIMARY KEY REFERENCES problems(id),
  state TEXT NOT NULL CHECK (state IN ('required', 'complete')),
  legacy_event_count INTEGER NOT NULL CHECK (legacy_event_count >= 0),
  completed_at TEXT
);
CREATE TABLE integrity_checkpoints (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  checkpoint_seq INTEGER NOT NULL CHECK (checkpoint_seq > 0),
  root_chain_digest TEXT NOT NULL,
  checkpoint_digest TEXT NOT NULL,
  checkpoint_version INTEGER NOT NULL CHECK (checkpoint_version = 1),
  checkpoint_mode TEXT NOT NULL CHECK (checkpoint_mode = 'unsigned-v0'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, checkpoint_seq)
);
CREATE TRIGGER events_immutable_before_update
BEFORE UPDATE ON events
WHEN NEW.id IS NOT OLD.id
  OR NEW.problem_id IS NOT OLD.problem_id
  OR NEW.seq IS NOT OLD.seq
  OR NEW.type IS NOT OLD.type
  OR NEW.object_kind IS NOT OLD.object_kind
  OR NEW.object_id IS NOT OLD.object_id
  OR NEW.object_version IS NOT OLD.object_version
  OR NEW.payload_sha256 IS NOT OLD.payload_sha256
  OR NEW.created_at IS NOT OLD.created_at
  OR NOT (
    OLD.row_digest IS NULL
    AND OLD.chain_digest IS NULL
    AND NEW.row_digest IS NOT NULL
    AND NEW.chain_digest IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM krater_integrity_backfill b
      WHERE b.problem_id = OLD.problem_id AND b.state = 'required'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'KRATER_EVENT_ENVELOPE_IMMUTABLE');
END;
CREATE TRIGGER events_immutable_before_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'KRATER_EVENT_ENVELOPE_IMMUTABLE');
END;
CREATE TRIGGER event_content_lawful_redaction_only
BEFORE UPDATE ON event_content
WHEN NEW.event_id IS NOT OLD.event_id
  OR NEW.payload_sha256 IS NOT OLD.payload_sha256
  OR NEW.redacted_at IS NULL
  OR NEW.redaction_reason IS NULL
BEGIN
  SELECT RAISE(ABORT, 'KRATER_CONTENT_REDACTION_INVALID');
END;
CREATE TRIGGER events_chain_head_before_insert
BEFORE INSERT ON events
WHEN NEW.row_digest IS NULL
  OR NEW.chain_digest IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM problems
    WHERE id = NEW.problem_id
      AND public_seq = NEW.seq
      AND chain_digest = NEW.chain_digest
  )
  OR NOT EXISTS (
    SELECT 1 FROM krater_integrity_backfill
    WHERE problem_id = NEW.problem_id AND state = 'complete'
  )
BEGIN
  SELECT RAISE(ABORT, 'KRATER_CHAIN_HEAD_MISMATCH');
END;
CREATE INDEX events_undigested_idx
  ON events (problem_id, seq)
  WHERE row_digest IS NULL OR chain_digest IS NULL;
CREATE TABLE fellow_tokens (
  credential_id TEXT PRIMARY KEY,
  proposal_id TEXT REFERENCES enrollment_proposals(proposal_id),
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  sponsor_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  granted_scopes_json TEXT NOT NULL CHECK (json_valid(granted_scopes_json)),
  granted_resources_json TEXT NOT NULL CHECK (json_valid(granted_resources_json)),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  revoked_at INTEGER CHECK (
    revoked_at IS NULL
    OR (
      revoked_at >= issued_at
      AND (last_used_at IS NULL OR revoked_at >= last_used_at)
    )
  ),
  last_used_at INTEGER CHECK (
    last_used_at IS NULL OR (last_used_at >= issued_at AND last_used_at < expires_at)
  ),
  credential_profile TEXT NOT NULL DEFAULT 'bearer'
    CHECK (credential_profile IN ('bearer', 'dpop', 'http-message-signature')),
  credential_origin TEXT NOT NULL DEFAULT 'enrollment'
    CHECK (credential_origin IN ('enrollment', 'harness-migration')), revocation_event_id TEXT
  REFERENCES fellow_lifecycle_events(event_id),
  CHECK (
    (proposal_id IS NOT NULL AND credential_origin = 'enrollment')
    OR (proposal_id IS NULL AND credential_origin = 'harness-migration')
  )
);
CREATE UNIQUE INDEX enrollment_credentials_initial_proposal_idx
  ON fellow_tokens (proposal_id)
  WHERE proposal_id IS NOT NULL;
CREATE TRIGGER enrollment_credentials_legacy_frozen_insert
BEFORE INSERT ON enrollment_credentials
BEGIN
  SELECT RAISE(ABORT, 'legacy enrollment credential table is frozen');
END;
CREATE TRIGGER enrollment_credentials_legacy_frozen_update
BEFORE UPDATE ON enrollment_credentials
BEGIN
  SELECT RAISE(ABORT, 'legacy enrollment credential table is frozen');
END;
CREATE TRIGGER enrollment_credentials_legacy_frozen_delete
BEFORE DELETE ON enrollment_credentials
BEGIN
  SELECT RAISE(ABORT, 'legacy enrollment credential table is frozen');
END;
CREATE TRIGGER enrollment_credentials_identity_insert
BEFORE INSERT ON fellow_tokens
WHEN NOT EXISTS (
  SELECT 1
    FROM enrollment_fellows AS fellow
    JOIN enrollment_grants AS grant_row
      ON grant_row.fellow_id = fellow.fellow_id
     AND grant_row.sponsor_id = fellow.sponsor_id
    LEFT JOIN enrollment_proposals AS proposal
      ON proposal.proposal_id = NEW.proposal_id
    LEFT JOIN enrollment_records AS enrollment
      ON enrollment.enrollment_id = proposal.enrollment_id
   WHERE fellow.fellow_id = NEW.fellow_id
     AND fellow.sponsor_id = NEW.sponsor_id
     AND grant_row.granted_scopes_json = NEW.granted_scopes_json
     AND grant_row.granted_resources_json = NEW.granted_resources_json
     AND (
       (NEW.proposal_id IS NULL AND NEW.credential_origin = 'harness-migration')
       OR (
         NEW.proposal_id IS NOT NULL
         AND NEW.credential_origin = 'enrollment'
         AND grant_row.proposal_id = NEW.proposal_id
         AND proposal.fellow_id = NEW.fellow_id
         AND enrollment.sponsor_id = NEW.sponsor_id
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'credential authority binding mismatch');
END;
CREATE TRIGGER enrollment_grants_immutable_update
BEFORE UPDATE ON enrollment_grants
BEGIN
  SELECT RAISE(ABORT, 'enrollment grant is immutable');
END;
CREATE TRIGGER enrollment_grants_immutable_delete
BEFORE DELETE ON enrollment_grants
BEGIN
  SELECT RAISE(ABORT, 'enrollment grant cannot be deleted');
END;
CREATE TRIGGER enrollment_grants_no_duplicate_insert
BEFORE INSERT ON enrollment_grants
WHEN EXISTS (
  SELECT 1 FROM enrollment_grants
   WHERE proposal_id = NEW.proposal_id OR fellow_id = NEW.fellow_id
)
BEGIN
  SELECT RAISE(ABORT, 'enrollment grant already exists');
END;
CREATE TABLE enrollment_sponsor_security (
  sponsor_id TEXT PRIMARY KEY,
  panic_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, panic_event_id TEXT
  REFERENCES fellow_lifecycle_events(event_id),
  CHECK (panic_at >= 0),
  CHECK (updated_at >= panic_at)
);
CREATE TRIGGER enrollment_sponsor_security_monotonic
BEFORE UPDATE ON enrollment_sponsor_security
WHEN NEW.sponsor_id <> OLD.sponsor_id
  OR NEW.panic_at < OLD.panic_at
  OR NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'sponsor panic boundary is monotonic');
END;
CREATE TRIGGER enrollment_sponsor_security_no_duplicate_insert
BEFORE INSERT ON enrollment_sponsor_security
WHEN EXISTS (
  SELECT 1 FROM enrollment_sponsor_security WHERE sponsor_id = NEW.sponsor_id
)
BEGIN
  SELECT RAISE(ABORT, 'sponsor panic boundary already exists');
END;
CREATE TRIGGER enrollment_sponsor_security_no_delete
BEFORE DELETE ON enrollment_sponsor_security
BEGIN
  SELECT RAISE(ABORT, 'sponsor panic boundary cannot be deleted');
END;
CREATE TRIGGER enrollment_credentials_no_duplicate_insert
BEFORE INSERT ON fellow_tokens
WHEN EXISTS (
  SELECT 1
    FROM fellow_tokens AS existing
   WHERE existing.credential_id = NEW.credential_id
      OR existing.token_hash = NEW.token_hash
      OR (NEW.proposal_id IS NOT NULL AND existing.proposal_id = NEW.proposal_id)
)
BEGIN
  SELECT RAISE(ABORT, 'credential identity already exists');
END;
CREATE TRIGGER enrollment_credentials_authority_immutable
BEFORE UPDATE OF
  credential_id, proposal_id, fellow_id, sponsor_id, token_hash,
  granted_scopes_json, granted_resources_json, issued_at, expires_at,
  credential_profile, credential_origin
ON fellow_tokens
BEGIN
  SELECT RAISE(ABORT, 'credential authority is immutable');
END;
CREATE TRIGGER enrollment_credentials_revocation_monotonic
BEFORE UPDATE OF revoked_at ON fellow_tokens
WHEN OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'credential revocation is monotonic');
END;
CREATE TRIGGER enrollment_credentials_last_used_monotonic
BEFORE UPDATE OF last_used_at ON fellow_tokens
WHEN OLD.last_used_at IS NOT NULL
 AND (NEW.last_used_at IS NULL OR NEW.last_used_at < OLD.last_used_at)
BEGIN
  SELECT RAISE(ABORT, 'credential last-used time is monotonic');
END;
CREATE TRIGGER enrollment_credentials_no_delete
BEFORE DELETE ON fellow_tokens
BEGIN
  SELECT RAISE(ABORT, 'credential history cannot be deleted');
END;
CREATE TRIGGER enrollment_credentials_post_panic_insert
BEFORE INSERT ON fellow_tokens
WHEN NEW.issued_at <= COALESCE((
  SELECT panic_at FROM enrollment_sponsor_security WHERE sponsor_id = NEW.sponsor_id
), -1)
BEGIN
  SELECT RAISE(ABORT, 'credential predates sponsor panic boundary');
END;
CREATE INDEX enrollment_fellows_sponsor_status_idx
  ON enrollment_fellows (sponsor_id, status, created_at);
CREATE INDEX enrollment_credentials_fellow_lifecycle_idx
  ON fellow_tokens (fellow_id, revoked_at, expires_at, issued_at);
CREATE INDEX enrollment_credentials_sponsor_lifecycle_idx
  ON fellow_tokens (sponsor_id, revoked_at, expires_at, issued_at);
CREATE INDEX outbox_drainable_idx
  ON outbox (state, quarantined_at, id)
  WHERE state = 'pending' AND quarantined_at IS NULL;
CREATE TABLE sponsors (
  sponsor_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
, lifecycle_seq INTEGER NOT NULL DEFAULT 0, lifecycle_lease_token TEXT, lifecycle_lease_expires_at INTEGER, active_fellow_limit INTEGER NOT NULL DEFAULT 5
  CHECK (
    typeof(active_fellow_limit) = 'integer'
    AND active_fellow_limit BETWEEN 5 AND 500
  ));
CREATE TABLE device_codes (
  enrollment_id TEXT PRIMARY KEY REFERENCES enrollment_records(enrollment_id),
  user_code_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE device_lookup_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sponsor_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0, 1))
);
CREATE INDEX device_lookup_attempts_sponsor_time
  ON device_lookup_attempts (sponsor_id, attempted_at);
CREATE INDEX device_lookup_attempts_time
  ON device_lookup_attempts (attempted_at, id);
CREATE INDEX device_codes_expiry
  ON device_codes (expires_at, enrollment_id);
CREATE TABLE device_start_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_bucket TEXT NOT NULL
    CHECK (length(client_bucket) = 64 AND client_bucket NOT GLOB '*[^0-9a-f]*'),
  attempted_at INTEGER NOT NULL
);
CREATE INDEX device_start_attempts_bucket_time
  ON device_start_attempts (client_bucket, attempted_at);
CREATE TRIGGER enrollment_records_device_shape_insert
BEFORE INSERT ON enrollment_records
BEGIN
  SELECT CASE
    WHEN NEW.kind = 'device'
      AND (
        NEW.device_expires_at IS NULL
        OR NEW.device_expires_at <= NEW.created_at
        OR (
          NEW.device_mapping_reclaimed_at IS NOT NULL
          AND NEW.device_mapping_reclaimed_at < NEW.device_expires_at
        )
      )
      THEN RAISE(ABORT, 'DEVICE_RECORD_EXPIRY_INVALID')
    WHEN NEW.kind = 'join-url'
      AND (NEW.device_expires_at IS NOT NULL OR NEW.device_mapping_reclaimed_at IS NOT NULL)
      THEN RAISE(ABORT, 'JOIN_RECORD_DEVICE_EXPIRY_FORBIDDEN')
    WHEN NEW.kind NOT IN ('join-url', 'device')
      THEN RAISE(ABORT, 'ENROLLMENT_KIND_INVALID')
  END;
END;
CREATE TRIGGER enrollment_records_device_shape_update
BEFORE UPDATE OF kind, created_at, device_expires_at, device_mapping_reclaimed_at
ON enrollment_records
BEGIN
  SELECT CASE
    WHEN NEW.kind IS NOT OLD.kind
      THEN RAISE(ABORT, 'ENROLLMENT_KIND_IMMUTABLE')
    WHEN OLD.kind = 'device' AND NEW.created_at IS NOT OLD.created_at
      THEN RAISE(ABORT, 'DEVICE_RECORD_CREATED_AT_IMMUTABLE')
    WHEN NEW.device_expires_at IS NOT OLD.device_expires_at
      THEN RAISE(ABORT, 'DEVICE_RECORD_EXPIRY_IMMUTABLE')
    WHEN OLD.device_mapping_reclaimed_at IS NOT NULL
      AND NEW.device_mapping_reclaimed_at IS NOT OLD.device_mapping_reclaimed_at
      THEN RAISE(ABORT, 'DEVICE_MAPPING_RECLAMATION_IMMUTABLE')
    WHEN NEW.kind = 'device'
      AND (
        NEW.device_expires_at IS NULL
        OR NEW.device_expires_at <= NEW.created_at
        OR (
          NEW.device_mapping_reclaimed_at IS NOT NULL
          AND NEW.device_mapping_reclaimed_at < NEW.device_expires_at
        )
      )
      THEN RAISE(ABORT, 'DEVICE_RECORD_EXPIRY_INVALID')
    WHEN NEW.kind = 'join-url'
      AND (NEW.device_expires_at IS NOT NULL OR NEW.device_mapping_reclaimed_at IS NOT NULL)
      THEN RAISE(ABORT, 'JOIN_RECORD_DEVICE_EXPIRY_FORBIDDEN')
    WHEN NEW.kind NOT IN ('join-url', 'device')
      THEN RAISE(ABORT, 'ENROLLMENT_KIND_INVALID')
  END;
END;
CREATE TRIGGER enrollment_proposals_device_identity_update
BEFORE UPDATE OF enrollment_id, created_at, expires_at ON enrollment_proposals
WHEN EXISTS (
  SELECT 1 FROM enrollment_records
   WHERE enrollment_id IN (OLD.enrollment_id, NEW.enrollment_id) AND kind = 'device'
)
BEGIN
  SELECT CASE
    WHEN NEW.enrollment_id IS NOT OLD.enrollment_id
      THEN RAISE(ABORT, 'DEVICE_PROPOSAL_ENROLLMENT_IMMUTABLE')
    WHEN NEW.created_at IS NOT OLD.created_at
      THEN RAISE(ABORT, 'DEVICE_PROPOSAL_CREATED_AT_IMMUTABLE')
    WHEN NEW.expires_at IS NOT OLD.expires_at
      THEN RAISE(ABORT, 'DEVICE_PROPOSAL_EXPIRY_IMMUTABLE')
  END;
END;
CREATE TRIGGER device_codes_shape_insert
BEFORE INSERT ON device_codes
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM enrollment_records e
      JOIN enrollment_proposals p ON p.enrollment_id = e.enrollment_id
     WHERE e.enrollment_id = NEW.enrollment_id
       AND e.kind = 'device'
       AND e.device_mapping_reclaimed_at IS NULL
       AND e.device_expires_at = NEW.expires_at
       AND NEW.created_at = e.created_at
       AND NEW.expires_at > NEW.created_at
       AND NEW.expires_at <= p.expires_at
       AND length(NEW.user_code_hash) = 64
       AND NEW.user_code_hash NOT GLOB '*[^0-9a-f]*'
  ) THEN RAISE(ABORT, 'DEVICE_CODE_SHAPE_INVALID') END;
END;
CREATE TRIGGER device_codes_immutable
BEFORE UPDATE ON device_codes
BEGIN
  SELECT RAISE(ABORT, 'DEVICE_CODE_IMMUTABLE');
END;
CREATE TRIGGER enrollment_records_evidence_schema_insert
BEFORE INSERT ON enrollment_records
WHEN typeof(NEW.enrollment_id) <> 'text'
  OR instr(NEW.enrollment_id, char(0)) > 0
  OR length(NEW.enrollment_id) NOT BETWEEN 19 AND 41
  OR substr(NEW.enrollment_id, 1, 9) <> 'ASIMP-EN-'
  OR substr(NEW.enrollment_id, 10) GLOB '*[^A-HJKMNP-TV-Z0-9]*'
  OR typeof(NEW.sponsor_id) <> 'text'
  OR instr(NEW.sponsor_id, char(0)) > 0
  OR (NEW.kind = 'join-url' AND length(NEW.sponsor_id) = 0)
  OR (
    length(NEW.sponsor_id) > 0
    AND (
      length(NEW.sponsor_id) NOT BETWEEN 5 AND 64
      OR substr(NEW.sponsor_id, 1, 4) <> 'usr_'
      OR substr(NEW.sponsor_id, 5) GLOB '*[^A-Za-z0-9_-]*'
    )
  )
  OR typeof(NEW.secret_hash) <> 'text'
  OR instr(NEW.secret_hash, char(0)) > 0
  OR length(NEW.secret_hash) <> 64
  OR NEW.secret_hash GLOB '*[^0-9a-f]*'
  OR typeof(NEW.created_at) <> 'integer'
  OR NEW.created_at NOT BETWEEN 1 AND 9007199254740991
  OR typeof(NEW.secret_expires_at) <> 'integer'
  OR NEW.secret_expires_at NOT BETWEEN 1 AND 9007199254740991
  OR (
    NEW.kind = 'join-url'
    AND NEW.secret_expires_at NOT BETWEEN NEW.created_at + 1 AND NEW.created_at + 1800000
  )
  OR (NEW.kind = 'device' AND NEW.secret_expires_at <> NEW.created_at)
  OR typeof(NEW.invalidated) <> 'integer'
  OR NEW.invalidated NOT IN (0, 1)
  OR (
    NEW.secret_consumed_at IS NOT NULL
    AND (
      typeof(NEW.secret_consumed_at) <> 'integer'
      OR NEW.secret_consumed_at NOT BETWEEN NEW.created_at AND NEW.secret_expires_at - 1
    )
  )
  OR (
    NEW.device_expires_at IS NOT NULL
    AND (
      typeof(NEW.device_expires_at) <> 'integer'
      OR NEW.device_expires_at <> NEW.created_at + 1800000
    )
  )
  OR (
    NEW.device_mapping_reclaimed_at IS NOT NULL
    AND (
      typeof(NEW.device_mapping_reclaimed_at) <> 'integer'
      OR NEW.device_mapping_reclaimed_at NOT BETWEEN NEW.device_expires_at
                                                 AND 9007199254740991
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'enrollment record evidence schema invalid');
END;
CREATE TRIGGER enrollment_records_authority_schema_insert
BEFORE INSERT ON enrollment_records
WHEN typeof(NEW.requested_scopes_json) <> 'text'
  OR typeof(NEW.requested_resources_json) <> 'text'
  OR json_type(NEW.requested_scopes_json) <> 'array'
  OR json_array_length(NEW.requested_scopes_json) NOT BETWEEN 1 AND 4
  OR EXISTS (
    SELECT 1
      FROM json_each(NEW.requested_scopes_json) scope
     WHERE scope.type <> 'text'
        OR scope.value NOT IN (
          'promote', 'review', 'propose-problems', 'upload-artifacts'
        )
  )
  OR (
    SELECT COUNT(*) FROM json_each(NEW.requested_scopes_json)
  ) <> (
    SELECT COUNT(DISTINCT scope.value)
      FROM json_each(NEW.requested_scopes_json) scope
  )
  OR json_type(NEW.requested_resources_json) <> 'object'
  OR EXISTS (
    SELECT 1
      FROM json_each(NEW.requested_resources_json) resource
     WHERE resource.key NOT IN (
       'problemBinding', 'firstDirective', 'eventBudget',
       'artifactBudgetBytes', 'fellowGrantExpiresAt'
     )
  )
  OR (
    SELECT COUNT(*) FROM json_each(NEW.requested_resources_json)
  ) <> (
    SELECT COUNT(DISTINCT resource.key)
      FROM json_each(NEW.requested_resources_json) resource
  )
  OR (
    json_type(NEW.requested_resources_json, '$.problemBinding') IS NOT NULL
    AND (
      json_type(NEW.requested_resources_json, '$.problemBinding') <> 'text'
      OR instr(json_extract(
        NEW.requested_resources_json,
        '$.problemBinding'
      ), char(0)) > 0
      OR length(json_extract(
        NEW.requested_resources_json,
        '$.problemBinding'
      )) NOT BETWEEN 6 AND 28
      OR substr(json_extract(
        NEW.requested_resources_json,
        '$.problemBinding'
      ), 1, 2) <> 'P-'
      OR substr(json_extract(
        NEW.requested_resources_json,
        '$.problemBinding'
      ), 3) GLOB '*[^A-Z0-9]*'
    )
  )
  OR (
    json_type(NEW.requested_resources_json, '$.firstDirective') IS NOT NULL
    AND (
      json_type(NEW.requested_resources_json, '$.firstDirective') <> 'text'
      OR instr(json_extract(
        NEW.requested_resources_json,
        '$.firstDirective'
      ), char(0)) > 0
      OR length(trim(
        json_extract(NEW.requested_resources_json, '$.firstDirective'),
        char(9) || char(10) || char(11) || char(12) || char(13)
          || char(32) || char(160) || char(5760)
          || char(8192) || char(8193) || char(8194) || char(8195)
          || char(8196) || char(8197) || char(8198) || char(8199)
          || char(8200) || char(8201) || char(8202)
          || char(8232) || char(8233) || char(8239)
          || char(8287) || char(12288) || char(65279)
      )) = 0
      OR (
        WITH RECURSIVE directive_units(rest, units) AS (
          SELECT trim(
            json_extract(NEW.requested_resources_json, '$.firstDirective'),
            char(9) || char(10) || char(11) || char(12) || char(13)
              || char(32) || char(160) || char(5760)
              || char(8192) || char(8193) || char(8194) || char(8195)
              || char(8196) || char(8197) || char(8198) || char(8199)
              || char(8200) || char(8201) || char(8202)
              || char(8232) || char(8233) || char(8239)
              || char(8287) || char(12288) || char(65279)
          ), 0
          UNION ALL
          SELECT substr(rest, 2),
                 units + CASE
                   WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
                   ELSE 1
                 END
            FROM directive_units
           WHERE rest <> ''
        )
        SELECT units FROM directive_units WHERE rest = ''
      ) > 2000
    )
  )
  OR (
    json_type(NEW.requested_resources_json, '$.eventBudget') IS NOT NULL
    AND (
      json_type(NEW.requested_resources_json, '$.eventBudget') <> 'integer'
      OR json_extract(
        NEW.requested_resources_json,
        '$.eventBudget'
      ) NOT BETWEEN 1 AND 10000
    )
  )
  OR (
    json_type(NEW.requested_resources_json, '$.artifactBudgetBytes') IS NOT NULL
    AND (
      json_type(NEW.requested_resources_json, '$.artifactBudgetBytes') <> 'integer'
      OR json_extract(
        NEW.requested_resources_json,
        '$.artifactBudgetBytes'
      ) NOT BETWEEN 0 AND 1073741824
    )
  )
  OR (
    json_type(NEW.requested_resources_json, '$.fellowGrantExpiresAt') IS NOT NULL
    AND (
      json_type(NEW.requested_resources_json, '$.fellowGrantExpiresAt') <> 'integer'
      OR json_extract(
        NEW.requested_resources_json,
        '$.fellowGrantExpiresAt'
      ) NOT BETWEEN 1 AND 9007199254740991
      OR json_extract(
        NEW.requested_resources_json,
        '$.fellowGrantExpiresAt'
      ) NOT BETWEEN NEW.created_at + 1 AND NEW.created_at + 31536000000
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'enrollment record authority schema invalid');
END;
CREATE TRIGGER enrollment_records_state_schema_update
BEFORE UPDATE OF sponsor_id, invalidated, secret_consumed_at ON enrollment_records
WHEN typeof(NEW.sponsor_id) <> 'text'
  OR instr(NEW.sponsor_id, char(0)) > 0
  OR (NEW.kind = 'join-url' AND length(NEW.sponsor_id) = 0)
  OR (
    length(NEW.sponsor_id) > 0
    AND (
      length(NEW.sponsor_id) NOT BETWEEN 5 AND 64
      OR substr(NEW.sponsor_id, 1, 4) <> 'usr_'
      OR substr(NEW.sponsor_id, 5) GLOB '*[^A-Za-z0-9_-]*'
    )
  )
  OR typeof(NEW.invalidated) <> 'integer'
  OR NEW.invalidated NOT IN (0, 1)
  OR (
    NEW.secret_consumed_at IS NOT NULL
    AND (
      typeof(NEW.secret_consumed_at) <> 'integer'
      OR NEW.secret_consumed_at NOT BETWEEN NEW.created_at AND NEW.secret_expires_at - 1
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'enrollment record state schema invalid');
END;
CREATE TRIGGER enrollment_records_state_transition
BEFORE UPDATE OF sponsor_id, invalidated, secret_consumed_at ON enrollment_records
WHEN (OLD.invalidated = 1 AND NEW.invalidated <> 1)
  OR (OLD.secret_consumed_at IS NOT NULL AND NEW.secret_consumed_at IS NOT OLD.secret_consumed_at)
  OR (
    NEW.sponsor_id IS NOT OLD.sponsor_id
    AND NOT (OLD.kind = 'device' AND OLD.sponsor_id = '' AND length(NEW.sponsor_id) > 0)
  )
BEGIN
  SELECT RAISE(ABORT, 'enrollment record state transition invalid');
END;
CREATE TRIGGER enrollment_records_authority_immutable
BEFORE UPDATE OF
  enrollment_id, secret_hash, secret_expires_at, requested_scopes_json,
  requested_resources_json, created_at
ON enrollment_records
BEGIN
  SELECT RAISE(ABORT, 'enrollment record authority is immutable');
END;
CREATE TRIGGER enrollment_records_no_duplicate_id_insert
BEFORE INSERT ON enrollment_records
WHEN EXISTS (
  SELECT 1 FROM enrollment_records existing
   WHERE existing.enrollment_id = NEW.enrollment_id
)
BEGIN
  SELECT RAISE(ABORT, 'enrollment record already exists');
END;
CREATE TRIGGER enrollment_records_no_delete
BEFORE DELETE ON enrollment_records
BEGIN
  SELECT RAISE(ABORT, 'enrollment record deletion forbidden');
END;
CREATE TRIGGER enrollment_proposals_evidence_schema_insert
BEFORE INSERT ON enrollment_proposals
WHEN NEW.proposal_id IS NULL
  OR typeof(NEW.proposal_id) <> 'text'
  OR instr(NEW.proposal_id, char(0)) > 0
  OR (
    WITH RECURSIVE proposal_id_units(rest, units) AS (
      SELECT NEW.proposal_id, 0
      UNION ALL
      SELECT substr(rest, 2),
             units + CASE
               WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
               ELSE 1
             END
        FROM proposal_id_units
       WHERE rest <> ''
    )
    SELECT units FROM proposal_id_units WHERE rest = ''
  ) NOT BETWEEN 1 AND 80
  OR typeof(NEW.enrollment_id) <> 'text'
  OR instr(NEW.enrollment_id, char(0)) > 0
  OR typeof(NEW.fellow_id) <> 'text'
  OR instr(NEW.fellow_id, char(0)) > 0
  OR (
    WITH RECURSIVE fellow_id_units(rest, units) AS (
      SELECT NEW.fellow_id, 0
      UNION ALL
      SELECT substr(rest, 2),
             units + CASE
               WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
               ELSE 1
             END
        FROM fellow_id_units
       WHERE rest <> ''
    )
    SELECT units FROM fellow_id_units WHERE rest = ''
  ) NOT BETWEEN 1 AND 80
  OR typeof(NEW.flow_handle_hash) <> 'text'
  OR instr(NEW.flow_handle_hash, char(0)) > 0
  OR length(NEW.flow_handle_hash) NOT BETWEEN 1 AND 160
  OR typeof(NEW.name) <> 'text'
  OR instr(NEW.name, char(0)) > 0
  OR length(NEW.name) NOT BETWEEN 3 AND 32
  OR NEW.name NOT GLOB '[a-z]*'
  OR NEW.name GLOB '*[^a-z0-9-]*'
  OR typeof(NEW.model) <> 'text'
  OR instr(NEW.model, char(0)) > 0
  OR length(trim(
    NEW.model,
    char(9) || char(10) || char(11) || char(12) || char(13)
      || char(32) || char(160) || char(5760)
      || char(8192) || char(8193) || char(8194) || char(8195)
      || char(8196) || char(8197) || char(8198) || char(8199)
      || char(8200) || char(8201) || char(8202)
      || char(8232) || char(8233) || char(8239)
      || char(8287) || char(12288) || char(65279)
  )) = 0
  OR (
    WITH RECURSIVE model_units(rest, units) AS (
      SELECT NEW.model, 0
      UNION ALL
      SELECT substr(rest, 2),
             units + CASE
               WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
               ELSE 1
             END
        FROM model_units
       WHERE rest <> ''
    )
    SELECT units FROM model_units WHERE rest = ''
  ) > 160
  OR typeof(NEW.harness) <> 'text'
  OR instr(NEW.harness, char(0)) > 0
  OR length(trim(
    NEW.harness,
    char(9) || char(10) || char(11) || char(12) || char(13)
      || char(32) || char(160) || char(5760)
      || char(8192) || char(8193) || char(8194) || char(8195)
      || char(8196) || char(8197) || char(8198) || char(8199)
      || char(8200) || char(8201) || char(8202)
      || char(8232) || char(8233) || char(8239)
      || char(8287) || char(12288) || char(65279)
  )) = 0
  OR (
    WITH RECURSIVE harness_units(rest, units) AS (
      SELECT NEW.harness, 0
      UNION ALL
      SELECT substr(rest, 2),
             units + CASE
               WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
               ELSE 1
             END
        FROM harness_units
       WHERE rest <> ''
    )
    SELECT units FROM harness_units WHERE rest = ''
  ) > 160
  OR (
    NEW.reasoning_effort IS NOT NULL
    AND (
      typeof(NEW.reasoning_effort) <> 'text'
      OR instr(NEW.reasoning_effort, char(0)) > 0
      OR (
        WITH RECURSIVE reasoning_units(rest, units) AS (
          SELECT NEW.reasoning_effort, 0
          UNION ALL
          SELECT substr(rest, 2),
                 units + CASE
                   WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
                   ELSE 1
                 END
            FROM reasoning_units
           WHERE rest <> ''
        )
        SELECT units FROM reasoning_units WHERE rest = ''
      ) NOT BETWEEN 1 AND 80
    )
  )
  OR (
    NEW.tools_note IS NOT NULL
    AND (
      typeof(NEW.tools_note) <> 'text'
      OR instr(NEW.tools_note, char(0)) > 0
      OR (
        WITH RECURSIVE tools_units(rest, units) AS (
          SELECT NEW.tools_note, 0
          UNION ALL
          SELECT substr(rest, 2),
                 units + CASE
                   WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
                   ELSE 1
                 END
            FROM tools_units
           WHERE rest <> ''
        )
        SELECT units FROM tools_units WHERE rest = ''
      ) NOT BETWEEN 1 AND 1000
    )
  )
  OR typeof(NEW.created_at) <> 'integer'
  OR NEW.created_at NOT BETWEEN 1 AND 9007199254740991
  OR typeof(NEW.expires_at) <> 'integer'
  OR NEW.expires_at NOT BETWEEN 1 AND 9007199254740991
  OR NEW.expires_at <> NEW.created_at + 86400000
  OR typeof(NEW.poll_interval_seconds) <> 'integer'
  OR NEW.poll_interval_seconds NOT BETWEEN 5 AND 30
  OR (
    NEW.last_poll_at IS NOT NULL
    AND (
      typeof(NEW.last_poll_at) <> 'integer'
      OR NEW.last_poll_at NOT BETWEEN NEW.created_at AND 9007199254740991
    )
  )
  OR (
    NEW.token_issued_at IS NOT NULL
    AND (
      typeof(NEW.token_issued_at) <> 'integer'
      OR NEW.token_issued_at NOT BETWEEN NEW.created_at AND 9007199254740991
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'proposal evidence schema invalid');
END;
CREATE TRIGGER enrollment_proposals_state_schema_insert
BEFORE INSERT ON enrollment_proposals
WHEN NEW.status <> 'pending'
  OR NEW.granted_scopes_json IS NOT NULL
  OR NEW.granted_resources_json IS NOT NULL
  OR NEW.token_hash IS NOT NULL
  OR NEW.token_issued_at IS NOT NULL
  OR NEW.last_poll_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'proposal must begin pending');
END;
CREATE TRIGGER enrollment_proposals_evidence_schema_update
BEFORE UPDATE OF poll_interval_seconds, last_poll_at, token_issued_at
ON enrollment_proposals
WHEN typeof(NEW.poll_interval_seconds) <> 'integer'
  OR NEW.poll_interval_seconds NOT BETWEEN 5 AND 30
  OR (
    NEW.last_poll_at IS NOT NULL
    AND (
      typeof(NEW.last_poll_at) <> 'integer'
      OR NEW.last_poll_at NOT BETWEEN NEW.created_at AND 9007199254740991
    )
  )
  OR (
    NEW.token_issued_at IS NOT NULL
    AND (
      typeof(NEW.token_issued_at) <> 'integer'
      OR NEW.token_issued_at NOT BETWEEN NEW.created_at AND 9007199254740991
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'proposal evidence schema invalid');
END;
CREATE TRIGGER enrollment_proposals_deadline_immutable
BEFORE UPDATE OF created_at, expires_at ON enrollment_proposals
BEGIN
  SELECT RAISE(ABORT, 'proposal timing is immutable');
END;
CREATE TRIGGER enrollment_proposals_identity_immutable
BEFORE UPDATE OF
  proposal_id, enrollment_id, fellow_id, flow_handle_hash, name, model,
  harness, reasoning_effort, tools_note
ON enrollment_proposals
BEGIN
  SELECT RAISE(ABORT, 'proposal identity is immutable');
END;
CREATE TRIGGER enrollment_proposals_state_transition
BEFORE UPDATE OF
  status, granted_scopes_json, granted_resources_json, token_hash, token_issued_at
ON enrollment_proposals
WHEN (
    OLD.status = 'pending'
    AND NEW.status NOT IN ('pending', 'approved', 'reduced', 'denied', 'expired')
  )
  OR (
    OLD.status IN ('approved', 'reduced')
    AND NEW.status NOT IN (OLD.status, 'expired')
  )
  OR (OLD.status IN ('denied', 'expired') AND NEW.status <> OLD.status)
  OR (
    OLD.granted_scopes_json IS NOT NULL
    AND (
      OLD.granted_scopes_json IS NOT NEW.granted_scopes_json
      OR OLD.granted_resources_json IS NOT NEW.granted_resources_json
    )
  )
  OR (
    OLD.granted_scopes_json IS NULL
    AND NEW.granted_scopes_json IS NOT NULL
    AND NOT (OLD.status = 'pending' AND NEW.status IN ('approved', 'reduced'))
  )
  OR (NEW.granted_scopes_json IS NULL) <> (NEW.granted_resources_json IS NULL)
  OR (
    OLD.token_hash IS NOT NULL
    AND (
      OLD.token_hash IS NOT NEW.token_hash
      OR OLD.token_issued_at IS NOT NEW.token_issued_at
    )
  )
  OR (NEW.token_hash IS NULL) <> (NEW.token_issued_at IS NULL)
  OR (NEW.token_hash IS NOT NULL AND NEW.status NOT IN ('approved', 'reduced'))
  OR (
    NEW.status IN ('pending', 'denied')
    AND (
      NEW.granted_scopes_json IS NOT NULL
      OR NEW.granted_resources_json IS NOT NULL
      OR NEW.token_hash IS NOT NULL
      OR NEW.token_issued_at IS NOT NULL
    )
  )
  OR (
    NEW.status IN ('approved', 'reduced')
    AND (NEW.granted_scopes_json IS NULL OR NEW.granted_resources_json IS NULL)
  )
  OR (
    NEW.status = 'expired'
    AND (
      NEW.token_hash IS NOT NULL
      OR NEW.token_issued_at IS NOT NULL
      OR (NEW.granted_scopes_json IS NULL) <> (NEW.granted_resources_json IS NULL)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'proposal state transition invalid');
END;
CREATE TRIGGER enrollment_proposals_no_duplicate_identity_insert
BEFORE INSERT ON enrollment_proposals
WHEN EXISTS (
  SELECT 1 FROM enrollment_proposals existing
   WHERE existing.proposal_id = NEW.proposal_id
      OR existing.enrollment_id = NEW.enrollment_id
      OR existing.fellow_id = NEW.fellow_id
      OR existing.flow_handle_hash = NEW.flow_handle_hash
      OR (
        NEW.token_hash IS NOT NULL
        AND existing.token_hash = NEW.token_hash
      )
)
BEGIN
  SELECT RAISE(ABORT, 'enrollment proposal already exists');
END;
CREATE TRIGGER enrollment_proposals_no_delete
BEFORE DELETE ON enrollment_proposals
BEGIN
  SELECT RAISE(ABORT, 'enrollment proposal deletion forbidden');
END;
CREATE TRIGGER enrollment_fellows_identity_schema_insert
BEFORE INSERT ON enrollment_fellows
WHEN NEW.fellow_id IS NULL
  OR typeof(NEW.fellow_id) <> 'text'
  OR typeof(NEW.sponsor_id) <> 'text'
  OR typeof(NEW.name) <> 'text'
  OR typeof(NEW.model) <> 'text'
  OR typeof(NEW.harness) <> 'text'
  OR instr(NEW.fellow_id, char(0)) > 0
  OR instr(NEW.sponsor_id, char(0)) > 0
  OR (
    WITH RECURSIVE fellow_id_units(rest, units) AS (
      SELECT NEW.fellow_id, 0
      UNION ALL
      SELECT substr(rest, 2),
             units + CASE
               WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
               ELSE 1
             END
        FROM fellow_id_units
       WHERE rest <> ''
    )
    SELECT units FROM fellow_id_units WHERE rest = ''
  ) NOT BETWEEN 1 AND 80
  OR (
    WITH RECURSIVE sponsor_id_units(rest, units) AS (
      SELECT NEW.sponsor_id, 0
      UNION ALL
      SELECT substr(rest, 2),
             units + CASE
               WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
               ELSE 1
             END
        FROM sponsor_id_units
       WHERE rest <> ''
    )
    SELECT units FROM sponsor_id_units WHERE rest = ''
  ) NOT BETWEEN 1 AND 160
  OR instr(NEW.name, char(0)) > 0
  OR length(NEW.name) NOT BETWEEN 3 AND 32
  OR NEW.name NOT GLOB '[a-z]*'
  OR NEW.name GLOB '*[^a-z0-9-]*'
  OR instr(NEW.model, char(0)) > 0
  OR length(trim(
    NEW.model,
    char(9) || char(10) || char(11) || char(12) || char(13)
      || char(32) || char(160) || char(5760)
      || char(8192) || char(8193) || char(8194) || char(8195)
      || char(8196) || char(8197) || char(8198) || char(8199)
      || char(8200) || char(8201) || char(8202)
      || char(8232) || char(8233) || char(8239)
      || char(8287) || char(12288) || char(65279)
  )) = 0
  OR (
    WITH RECURSIVE model_units(rest, units) AS (
      SELECT NEW.model, 0
      UNION ALL
      SELECT substr(rest, 2),
             units + CASE
               WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
               ELSE 1
             END
        FROM model_units
       WHERE rest <> ''
    )
    SELECT units FROM model_units WHERE rest = ''
  ) > 160
  OR instr(NEW.harness, char(0)) > 0
  OR length(trim(
    NEW.harness,
    char(9) || char(10) || char(11) || char(12) || char(13)
      || char(32) || char(160) || char(5760)
      || char(8192) || char(8193) || char(8194) || char(8195)
      || char(8196) || char(8197) || char(8198) || char(8199)
      || char(8200) || char(8201) || char(8202)
      || char(8232) || char(8233) || char(8239)
      || char(8287) || char(12288) || char(65279)
  )) = 0
  OR (
    WITH RECURSIVE harness_units(rest, units) AS (
      SELECT NEW.harness, 0
      UNION ALL
      SELECT substr(rest, 2),
             units + CASE
               WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
               ELSE 1
             END
        FROM harness_units
       WHERE rest <> ''
    )
    SELECT units FROM harness_units WHERE rest = ''
  ) > 160
BEGIN
  SELECT RAISE(ABORT, 'Fellow identity schema invalid');
END;
CREATE TRIGGER enrollment_fellows_identity_immutable
BEFORE UPDATE OF fellow_id, sponsor_id, name, model, harness, created_at
ON enrollment_fellows
BEGIN
  SELECT RAISE(ABORT, 'Fellow identity is immutable');
END;
CREATE TRIGGER enrollment_fellows_no_duplicate_id_insert
BEFORE INSERT ON enrollment_fellows
WHEN EXISTS (
  SELECT 1
    FROM enrollment_fellows existing
   WHERE existing.fellow_id = NEW.fellow_id
)
BEGIN
  SELECT RAISE(ABORT, 'Fellow identity already exists');
END;
CREATE TRIGGER enrollment_fellows_no_duplicate_name_insert
BEFORE INSERT ON enrollment_fellows
WHEN NOT EXISTS (
  SELECT 1
    FROM enrollment_fellows existing
   WHERE existing.fellow_id = NEW.fellow_id
)
 AND EXISTS (
  SELECT 1
    FROM enrollment_fellows existing
   WHERE existing.name = NEW.name COLLATE NOCASE
)
BEGIN
  SELECT RAISE(ABORT, 'Fellow name already exists');
END;
CREATE TRIGGER enrollment_fellows_no_delete
BEFORE DELETE ON enrollment_fellows
BEGIN
  SELECT RAISE(ABORT, 'Fellow identity cannot be deleted');
END;
CREATE TRIGGER enrollment_grants_evidence_schema_insert
BEFORE INSERT ON enrollment_grants
WHEN typeof(NEW.granted_at) <> 'integer'
  OR NEW.granted_at NOT BETWEEN 1 AND 9007199254740991
BEGIN
  SELECT RAISE(ABORT, 'enrollment grant evidence schema invalid');
END;
CREATE TRIGGER enrollment_grants_authority_schema_insert
BEFORE INSERT ON enrollment_grants
WHEN typeof(NEW.granted_scopes_json) <> 'text'
  OR typeof(NEW.granted_resources_json) <> 'text'
  OR json_type(NEW.granted_scopes_json) <> 'array'
  OR json_array_length(NEW.granted_scopes_json) NOT BETWEEN 1 AND 4
  OR EXISTS (
    SELECT 1
      FROM json_each(NEW.granted_scopes_json) scope
     WHERE scope.type <> 'text'
        OR scope.value NOT IN (
          'promote', 'review', 'propose-problems', 'upload-artifacts'
        )
  )
  OR (
    SELECT COUNT(*) FROM json_each(NEW.granted_scopes_json)
  ) <> (
    SELECT COUNT(DISTINCT scope.value)
      FROM json_each(NEW.granted_scopes_json) scope
  )
  OR json_type(NEW.granted_resources_json) <> 'object'
  OR EXISTS (
    SELECT 1
      FROM json_each(NEW.granted_resources_json) resource
     WHERE resource.key NOT IN (
       'problemBinding', 'firstDirective', 'eventBudget',
       'artifactBudgetBytes', 'fellowGrantExpiresAt'
     )
  )
  OR (
    SELECT COUNT(*) FROM json_each(NEW.granted_resources_json)
  ) <> (
    SELECT COUNT(DISTINCT resource.key)
      FROM json_each(NEW.granted_resources_json) resource
  )
  OR (
    json_type(NEW.granted_resources_json, '$.problemBinding') IS NOT NULL
    AND (
      json_type(NEW.granted_resources_json, '$.problemBinding') <> 'text'
      OR instr(json_extract(
        NEW.granted_resources_json,
        '$.problemBinding'
      ), char(0)) > 0
      OR length(json_extract(
        NEW.granted_resources_json,
        '$.problemBinding'
      )) NOT BETWEEN 6 AND 28
      OR substr(json_extract(
        NEW.granted_resources_json,
        '$.problemBinding'
      ), 1, 2) <> 'P-'
      OR substr(json_extract(
        NEW.granted_resources_json,
        '$.problemBinding'
      ), 3) GLOB '*[^A-Z0-9]*'
    )
  )
  OR (
    json_type(NEW.granted_resources_json, '$.firstDirective') IS NOT NULL
    AND (
      json_type(NEW.granted_resources_json, '$.firstDirective') <> 'text'
      OR instr(json_extract(
        NEW.granted_resources_json,
        '$.firstDirective'
      ), char(0)) > 0
      OR length(trim(
        json_extract(NEW.granted_resources_json, '$.firstDirective'),
        char(9) || char(10) || char(11) || char(12) || char(13)
          || char(32) || char(160) || char(5760)
          || char(8192) || char(8193) || char(8194) || char(8195)
          || char(8196) || char(8197) || char(8198) || char(8199)
          || char(8200) || char(8201) || char(8202)
          || char(8232) || char(8233) || char(8239)
          || char(8287) || char(12288) || char(65279)
      )) = 0
      OR (
        WITH RECURSIVE directive_units(rest, units) AS (
          SELECT trim(
            json_extract(NEW.granted_resources_json, '$.firstDirective'),
            char(9) || char(10) || char(11) || char(12) || char(13)
              || char(32) || char(160) || char(5760)
              || char(8192) || char(8193) || char(8194) || char(8195)
              || char(8196) || char(8197) || char(8198) || char(8199)
              || char(8200) || char(8201) || char(8202)
              || char(8232) || char(8233) || char(8239)
              || char(8287) || char(12288) || char(65279)
          ), 0
          UNION ALL
          SELECT substr(rest, 2),
                 units + CASE
                   WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
                   ELSE 1
                 END
            FROM directive_units
           WHERE rest <> ''
        )
        SELECT units FROM directive_units WHERE rest = ''
      ) > 2000
    )
  )
  OR (
    json_type(NEW.granted_resources_json, '$.eventBudget') IS NOT NULL
    AND (
      json_type(NEW.granted_resources_json, '$.eventBudget') <> 'integer'
      OR json_extract(NEW.granted_resources_json, '$.eventBudget') NOT BETWEEN 1 AND 10000
    )
  )
  OR (
    json_type(NEW.granted_resources_json, '$.artifactBudgetBytes') IS NOT NULL
    AND (
      json_type(NEW.granted_resources_json, '$.artifactBudgetBytes') <> 'integer'
      OR json_extract(
        NEW.granted_resources_json,
        '$.artifactBudgetBytes'
      ) NOT BETWEEN 0 AND 1073741824
    )
  )
  OR (
    json_type(NEW.granted_resources_json, '$.fellowGrantExpiresAt') IS NOT NULL
    AND (
      json_type(NEW.granted_resources_json, '$.fellowGrantExpiresAt') <> 'integer'
      OR json_extract(
        NEW.granted_resources_json,
        '$.fellowGrantExpiresAt'
      ) NOT BETWEEN 1 AND 9007199254740991
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'enrollment grant authority schema invalid');
END;
CREATE TRIGGER enrollment_grants_approval_binding_insert
BEFORE INSERT ON enrollment_grants
WHEN NOT EXISTS (
  SELECT 1 FROM enrollment_grants
   WHERE proposal_id = NEW.proposal_id OR fellow_id = NEW.fellow_id
)
 AND NOT EXISTS (
  SELECT 1
    FROM enrollment_proposals proposal
    JOIN enrollment_records enrollment
      ON enrollment.enrollment_id = proposal.enrollment_id
    JOIN enrollment_fellows fellow
      ON fellow.fellow_id = NEW.fellow_id
     AND fellow.sponsor_id = NEW.sponsor_id
   WHERE proposal.proposal_id = NEW.proposal_id
     AND proposal.fellow_id = NEW.fellow_id
     AND enrollment.sponsor_id = NEW.sponsor_id
     AND fellow.name COLLATE BINARY = proposal.name COLLATE BINARY
     AND fellow.model = proposal.model
     AND fellow.harness = proposal.harness
     AND proposal.status IN ('approved', 'reduced')
     AND proposal.token_hash IS NULL
     AND proposal.token_issued_at IS NULL
     AND NEW.granted_at >= proposal.created_at
     AND NEW.granted_at < proposal.expires_at
     AND proposal.granted_scopes_json = NEW.granted_scopes_json
     AND proposal.granted_resources_json = NEW.granted_resources_json
     AND NOT EXISTS (
       SELECT 1
         FROM json_each(NEW.granted_scopes_json) granted_scope
        WHERE NOT EXISTS (
          SELECT 1
            FROM json_each(enrollment.requested_scopes_json) requested_scope
           WHERE requested_scope.value = granted_scope.value
        )
     )
     AND NOT EXISTS (
       SELECT 1
         FROM json_each(NEW.granted_resources_json) granted_resource
        WHERE (
          granted_resource.key IN ('problemBinding', 'firstDirective')
          AND (
            json_type(
              enrollment.requested_resources_json,
              '$.' || granted_resource.key
            ) IS NULL
            OR json_extract(
              enrollment.requested_resources_json,
              '$.' || granted_resource.key
            ) IS NOT granted_resource.value
          )
        )
           OR (
             granted_resource.key IN (
               'eventBudget', 'artifactBudgetBytes', 'fellowGrantExpiresAt'
             )
             AND json_type(
               enrollment.requested_resources_json,
               '$.' || granted_resource.key
             ) IS NOT NULL
             AND granted_resource.value > json_extract(
               enrollment.requested_resources_json,
               '$.' || granted_resource.key
             )
           )
     )
     AND NOT EXISTS (
       SELECT 1
         FROM json_each(enrollment.requested_resources_json) requested_resource
        WHERE requested_resource.key IN (
          'eventBudget', 'artifactBudgetBytes', 'fellowGrantExpiresAt'
        )
          AND json_type(
            NEW.granted_resources_json,
            '$.' || requested_resource.key
          ) IS NULL
     )
     AND (
       proposal.status <> 'reduced'
       OR json_array_length(NEW.granted_scopes_json)
            < json_array_length(enrollment.requested_scopes_json)
       OR EXISTS (
         SELECT 1
           FROM json_each(enrollment.requested_resources_json) requested_resource
          WHERE requested_resource.key IN ('problemBinding', 'firstDirective')
            AND json_type(
              NEW.granted_resources_json,
              '$.' || requested_resource.key
            ) IS NULL
       )
       OR EXISTS (
         SELECT 1
           FROM json_each(enrollment.requested_resources_json) requested_resource
          WHERE requested_resource.key IN (
            'eventBudget', 'artifactBudgetBytes', 'fellowGrantExpiresAt'
          )
            AND json_extract(
              NEW.granted_resources_json,
              '$.' || requested_resource.key
            ) < requested_resource.value
       )
       OR EXISTS (
         SELECT 1
           FROM json_each(NEW.granted_resources_json) granted_resource
          WHERE granted_resource.key IN (
            'eventBudget', 'artifactBudgetBytes', 'fellowGrantExpiresAt'
          )
            AND json_type(
              enrollment.requested_resources_json,
              '$.' || granted_resource.key
            ) IS NULL
       )
     )
     AND (
       proposal.status <> 'approved'
       OR (
         json_array_length(NEW.granted_scopes_json)
           = json_array_length(enrollment.requested_scopes_json)
         AND (
           SELECT COUNT(*) FROM json_each(NEW.granted_resources_json)
         ) = (
           SELECT COUNT(*) FROM json_each(enrollment.requested_resources_json)
         )
         AND NOT EXISTS (
           SELECT 1
             FROM json_each(NEW.granted_resources_json) granted_resource
            WHERE json_type(
              enrollment.requested_resources_json,
              '$.' || granted_resource.key
            ) IS NOT granted_resource.type
               OR json_extract(
                 enrollment.requested_resources_json,
                 '$.' || granted_resource.key
               ) IS NOT granted_resource.value
         )
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'enrollment grant approval binding mismatch');
END;
CREATE TRIGGER enrollment_credentials_durable_authority_insert
BEFORE INSERT ON fellow_tokens
WHEN NOT EXISTS (
  SELECT 1 FROM fellow_tokens existing
   WHERE existing.credential_id = NEW.credential_id
      OR existing.token_hash = NEW.token_hash
      OR (NEW.proposal_id IS NOT NULL AND existing.proposal_id = NEW.proposal_id)
)
 AND NOT EXISTS (
  SELECT 1
    FROM enrollment_fellows fellow
    JOIN enrollment_grants grant_row
      ON grant_row.fellow_id = fellow.fellow_id
     AND grant_row.sponsor_id = fellow.sponsor_id
    JOIN enrollment_proposals grant_proposal
      ON grant_proposal.proposal_id = grant_row.proposal_id
    JOIN enrollment_records grant_enrollment
      ON grant_enrollment.enrollment_id = grant_proposal.enrollment_id
   WHERE fellow.fellow_id = NEW.fellow_id
     AND fellow.sponsor_id = NEW.sponsor_id
     AND grant_proposal.fellow_id = fellow.fellow_id
     AND grant_enrollment.sponsor_id = fellow.sponsor_id
     AND fellow.name COLLATE BINARY = grant_proposal.name COLLATE BINARY
     AND fellow.model = grant_proposal.model
     AND fellow.harness = grant_proposal.harness
     AND grant_proposal.status IN ('approved', 'reduced')
     AND grant_proposal.granted_scopes_json = grant_row.granted_scopes_json
     AND grant_proposal.granted_resources_json = grant_row.granted_resources_json
     AND grant_row.granted_scopes_json = NEW.granted_scopes_json
     AND grant_row.granted_resources_json = NEW.granted_resources_json
     AND NEW.issued_at >= grant_row.granted_at
     AND (
       (NEW.proposal_id IS NULL AND NEW.credential_origin = 'harness-migration')
       OR (
         NEW.proposal_id = grant_proposal.proposal_id
         AND NEW.credential_origin = 'enrollment'
         AND grant_proposal.token_hash = NEW.token_hash
         AND grant_proposal.token_issued_at = NEW.issued_at
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'credential durable authority mismatch');
END;
CREATE TRIGGER enrollment_credentials_output_schema_insert
BEFORE INSERT ON fellow_tokens
WHEN NEW.credential_id IS NULL
  OR typeof(NEW.credential_id) <> 'text'
  OR instr(NEW.credential_id, char(0)) > 0
  OR (
    WITH RECURSIVE credential_id_units(rest, units) AS (
      SELECT NEW.credential_id, 0
      UNION ALL
      SELECT substr(rest, 2),
             units + CASE
               WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
               ELSE 1
             END
        FROM credential_id_units
       WHERE rest <> ''
    )
    SELECT units FROM credential_id_units WHERE rest = ''
  ) NOT BETWEEN 1 AND 160
  OR typeof(NEW.issued_at) <> 'integer'
  OR NEW.issued_at NOT BETWEEN 0 AND 9007199254740991
  OR typeof(NEW.expires_at) <> 'integer'
  OR NEW.expires_at NOT BETWEEN 1 AND 9007199254740991
  OR NEW.expires_at > NEW.issued_at + 31536000000
  OR (
    NEW.last_used_at IS NOT NULL
    AND (
      typeof(NEW.last_used_at) <> 'integer'
      OR NEW.last_used_at NOT BETWEEN 0 AND 9007199254740991
    )
  )
  OR (
    NEW.revoked_at IS NOT NULL
    AND (
      typeof(NEW.revoked_at) <> 'integer'
      OR NEW.revoked_at NOT BETWEEN 0 AND 9007199254740991
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'credential output schema invalid');
END;
CREATE TRIGGER enrollment_credentials_last_used_schema_update
BEFORE UPDATE OF last_used_at ON fellow_tokens
WHEN NEW.last_used_at IS NOT NULL
 AND (
   typeof(NEW.last_used_at) <> 'integer'
   OR NEW.last_used_at NOT BETWEEN 0 AND 9007199254740991
 )
BEGIN
  SELECT RAISE(ABORT, 'credential last-used evidence schema invalid');
END;
CREATE TRIGGER enrollment_credentials_revoked_schema_update
BEFORE UPDATE OF revoked_at ON fellow_tokens
WHEN NEW.revoked_at IS NOT NULL
 AND (
   typeof(NEW.revoked_at) <> 'integer'
   OR NEW.revoked_at NOT BETWEEN 0 AND 9007199254740991
 )
BEGIN
  SELECT RAISE(ABORT, 'credential revocation evidence schema invalid');
END;
CREATE TRIGGER enrollment_grants_resource_expiry_insert
BEFORE INSERT ON enrollment_grants
WHEN json_type(NEW.granted_resources_json, '$.fellowGrantExpiresAt') IS NOT NULL
 AND (
   json_type(NEW.granted_resources_json, '$.fellowGrantExpiresAt') <> 'integer'
   OR json_extract(NEW.granted_resources_json, '$.fellowGrantExpiresAt') <= NEW.granted_at
 )
BEGIN
  SELECT RAISE(ABORT, 'fellow grant expiry invalid');
END;
CREATE TRIGGER enrollment_credentials_resource_expiry_insert
BEFORE INSERT ON fellow_tokens
WHEN json_type(NEW.granted_resources_json, '$.fellowGrantExpiresAt') IS NOT NULL
 AND (
   json_type(NEW.granted_resources_json, '$.fellowGrantExpiresAt') <> 'integer'
   OR json_extract(NEW.granted_resources_json, '$.fellowGrantExpiresAt') <= NEW.issued_at
 )
BEGIN
  SELECT RAISE(ABORT, 'credential Fellow grant is not live');
END;
CREATE TRIGGER enrollment_credentials_terminal_fellow_insert
BEFORE INSERT ON fellow_tokens
WHEN NEW.revoked_at IS NULL
 AND EXISTS (
   SELECT 1
     FROM enrollment_fellows fellow
    WHERE fellow.fellow_id = NEW.fellow_id
      AND fellow.status IN ('revoked', 'archived', 'compromised')
 )
BEGIN
  SELECT RAISE(ABORT, 'terminal Fellow cannot receive live credential');
END;
CREATE TRIGGER enrollment_credentials_issuance_monotonic
BEFORE INSERT ON fellow_tokens
WHEN EXISTS (
  SELECT 1
    FROM fellow_tokens existing
   WHERE existing.fellow_id = NEW.fellow_id
     AND existing.issued_at > NEW.issued_at
)
BEGIN
  SELECT RAISE(ABORT, 'credential issuance cannot move backward');
END;
CREATE TRIGGER enrollment_credentials_active_cap
BEFORE INSERT ON fellow_tokens
WHEN NEW.revoked_at IS NULL
  AND NEW.expires_at > NEW.issued_at
  AND NEW.issued_at > COALESCE((
    SELECT panic_at FROM enrollment_sponsor_security WHERE sponsor_id = NEW.sponsor_id
  ), -1)
  AND (
    SELECT COUNT(*)
      FROM fellow_tokens AS existing
      LEFT JOIN enrollment_sponsor_security AS security
        ON security.sponsor_id = existing.sponsor_id
     WHERE existing.fellow_id = NEW.fellow_id
       AND existing.revoked_at IS NULL
       AND existing.issued_at <= NEW.issued_at
       AND existing.expires_at > NEW.issued_at
       AND (
         json_type(existing.granted_resources_json, '$.fellowGrantExpiresAt') IS NULL
         OR json_extract(existing.granted_resources_json, '$.fellowGrantExpiresAt') > NEW.issued_at
       )
       AND existing.issued_at > COALESCE(security.panic_at, -1)
  ) >= 3
BEGIN
  SELECT RAISE(ABORT, 'active credential cap reached');
END;
CREATE INDEX enrollment_credentials_sponsor_fellow_lifecycle_idx
  ON fellow_tokens (sponsor_id, fellow_id, revoked_at, expires_at, issued_at);
CREATE INDEX enrollment_credentials_fellow_issued_idx
  ON fellow_tokens (fellow_id, issued_at DESC);
CREATE INDEX enrollment_grants_sponsor_page_idx
  ON enrollment_grants (sponsor_id, granted_at DESC, fellow_id);
CREATE TABLE "enrollment_idempotency" (
  scope TEXT NOT NULL CHECK (scope IN (
    'mint', 'claim', 'decision', 'poll', 'device-start',
    'credential-revoke', 'fellow-lifecycle', 'sponsor-panic'
  )),
  principal_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_ciphertext TEXT NOT NULL,
  response_initialization_vector TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, principal_scope, idempotency_key)
);
CREATE TABLE fellow_lifecycle_events (
  event_id TEXT PRIMARY KEY,
  sponsor_id TEXT NOT NULL REFERENCES sponsors(sponsor_id),
  sponsor_seq INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'credential-revoked', 'fellow-status-changed', 'sponsor-panic'
  )),
  fellow_id TEXT REFERENCES enrollment_fellows(fellow_id),
  credential_id TEXT REFERENCES fellow_tokens(credential_id),
  from_status TEXT,
  to_status TEXT,
  effective_at INTEGER NOT NULL,
  review_from INTEGER,
  request_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  UNIQUE (sponsor_id, sponsor_seq),
  CHECK (
    typeof(event_id) = 'text'
    AND length(event_id) = 30
    AND substr(event_id, 1, 4) = 'LEV-'
    AND substr(event_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  CHECK (
    typeof(sponsor_id) = 'text'
    AND length(sponsor_id) BETWEEN 5 AND 64
    AND substr(sponsor_id, 1, 4) = 'usr_'
    AND substr(sponsor_id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  CHECK (typeof(sponsor_seq) = 'integer' AND sponsor_seq BETWEEN 1 AND 9007199254740991),
  CHECK (typeof(effective_at) = 'integer' AND effective_at BETWEEN 1 AND 9007199254740991),
  CHECK (typeof(created_at) = 'integer' AND created_at = effective_at),
  CHECK (
    review_from IS NULL
    OR (typeof(review_from) = 'integer' AND review_from BETWEEN 1 AND effective_at)
  ),
  CHECK (
    typeof(request_id) = 'text'
    AND length(request_id) = 64
    AND request_id NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (action = 'credential-revoked'
      AND fellow_id IS NOT NULL AND credential_id IS NOT NULL
      AND from_status IS NULL AND to_status IS NULL AND review_from IS NULL)
    OR
    (action = 'fellow-status-changed'
      AND fellow_id IS NOT NULL AND credential_id IS NULL
      AND from_status IN (
        'pending', 'active', 'paused', 'revoked', 'archived',
        'compromised', 'suspicious_review'
      )
      AND to_status IN (
        'active', 'paused', 'revoked', 'archived',
        'compromised', 'suspicious_review'
      )
      AND from_status <> to_status
      AND ((to_status = 'compromised' AND review_from IS NOT NULL)
        OR (to_status <> 'compromised' AND review_from IS NULL)))
    OR
    (action = 'sponsor-panic'
      AND fellow_id IS NULL AND credential_id IS NULL
      AND from_status IS NULL AND to_status IS NULL AND review_from IS NULL)
  )
);
CREATE TRIGGER enrollment_fellows_lifecycle_initial_insert
BEFORE INSERT ON enrollment_fellows
WHEN NEW.status <> 'active'
  OR NEW.status_event_id IS NOT NULL
  OR (NEW.status_changed_at IS NOT NULL AND NEW.status_changed_at <> NEW.created_at)
BEGIN
  SELECT RAISE(ABORT, 'Fellow lifecycle must begin active');
END;
CREATE TRIGGER sponsors_lifecycle_initial_insert
BEFORE INSERT ON sponsors
WHEN NEW.lifecycle_seq <> 0
  OR NEW.lifecycle_lease_token IS NOT NULL
  OR NEW.lifecycle_lease_expires_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'sponsor lifecycle head must begin at zero');
END;
CREATE TABLE enrollment_fellow_security (
  fellow_id TEXT PRIMARY KEY REFERENCES enrollment_fellows(fellow_id),
  sponsor_id TEXT NOT NULL,
  family_revoked_through INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('revoked', 'compromised')),
  event_id TEXT NOT NULL UNIQUE REFERENCES fellow_lifecycle_events(event_id),
  updated_at INTEGER NOT NULL,
  CHECK (typeof(family_revoked_through) = 'integer'
    AND family_revoked_through BETWEEN 1 AND 9007199254740991),
  CHECK (typeof(updated_at) = 'integer' AND updated_at = family_revoked_through)
);
CREATE TABLE fellow_write_review_windows (
  fellow_id TEXT PRIMARY KEY REFERENCES enrollment_fellows(fellow_id),
  sponsor_id TEXT NOT NULL,
  review_from INTEGER NOT NULL,
  flagged_at INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE REFERENCES fellow_lifecycle_events(event_id),
  state TEXT NOT NULL CHECK (state = 'open'),
  CHECK (typeof(review_from) = 'integer' AND review_from BETWEEN 1 AND flagged_at),
  CHECK (typeof(flagged_at) = 'integer' AND flagged_at BETWEEN 1 AND 9007199254740991)
);
CREATE TRIGGER fellow_lifecycle_events_command_guard
BEFORE INSERT ON fellow_lifecycle_events
WHEN NOT EXISTS (
  SELECT 1 FROM sponsors sponsor
   WHERE sponsor.sponsor_id = NEW.sponsor_id
     AND sponsor.lifecycle_seq + 1 = NEW.sponsor_seq
     AND sponsor.lifecycle_lease_token = NEW.event_id
     AND sponsor.lifecycle_lease_expires_at IS NOT NULL
)
OR NOT (
  (NEW.action = 'credential-revoked' AND EXISTS (
    SELECT 1 FROM fellow_tokens credential
     WHERE credential.credential_id = NEW.credential_id
       AND credential.fellow_id = NEW.fellow_id
       AND credential.sponsor_id = NEW.sponsor_id
       AND credential.revoked_at IS NULL
       AND NEW.effective_at >= credential.issued_at
  ))
  OR
  (NEW.action = 'fellow-status-changed' AND EXISTS (
    SELECT 1 FROM enrollment_fellows fellow
     WHERE fellow.fellow_id = NEW.fellow_id
       AND fellow.sponsor_id = NEW.sponsor_id
       AND fellow.status = NEW.from_status
       AND NEW.effective_at >= fellow.created_at
       AND (
         (fellow.status = 'pending' AND NEW.to_status = 'active')
         OR (fellow.status = 'active'
           AND NEW.to_status IN ('paused', 'revoked', 'compromised', 'suspicious_review'))
         OR (fellow.status = 'paused'
           AND NEW.to_status IN ('active', 'revoked', 'compromised', 'suspicious_review'))
         OR (fellow.status = 'suspicious_review'
           AND NEW.to_status IN ('active', 'paused', 'revoked', 'compromised'))
         OR (fellow.status IN ('revoked', 'compromised') AND NEW.to_status = 'archived')
       )
       AND (NEW.to_status <> 'compromised' OR NEW.review_from = MAX(
         fellow.created_at,
         COALESCE((
           SELECT MIN(credential.issued_at) FROM fellow_tokens credential
            WHERE credential.fellow_id = fellow.fellow_id
         ), fellow.created_at)
       ))
  ))
  OR
  (NEW.action = 'sponsor-panic'
    AND NEW.effective_at > COALESCE((
      SELECT security.panic_at FROM enrollment_sponsor_security security
       WHERE security.sponsor_id = NEW.sponsor_id
    ), -1))
)
BEGIN
  SELECT RAISE(ABORT, 'lifecycle command is not current');
END;
CREATE TRIGGER fellow_lifecycle_events_no_duplicate_insert
BEFORE INSERT ON fellow_lifecycle_events
WHEN EXISTS (
  SELECT 1 FROM fellow_lifecycle_events existing
   WHERE existing.event_id = NEW.event_id OR existing.request_id = NEW.request_id
)
BEGIN
  SELECT RAISE(ABORT, 'lifecycle event identity already exists');
END;
CREATE TRIGGER enrollment_fellows_status_transition
BEFORE UPDATE OF status, status_changed_at, status_event_id ON enrollment_fellows
WHEN NEW.status IS NOT OLD.status
 AND NOT EXISTS (
   SELECT 1 FROM fellow_lifecycle_events event
     JOIN sponsors sponsor ON sponsor.sponsor_id = event.sponsor_id
    WHERE event.event_id = NEW.status_event_id
      AND event.action = 'fellow-status-changed'
      AND event.sponsor_id = NEW.sponsor_id
      AND event.sponsor_seq = sponsor.lifecycle_seq + 1
      AND event.fellow_id = NEW.fellow_id
      AND event.from_status = OLD.status
      AND event.to_status = NEW.status
      AND event.effective_at = NEW.status_changed_at
      AND NEW.status_changed_at >= COALESCE(OLD.status_changed_at, OLD.created_at)
 )
BEGIN
  SELECT RAISE(ABORT, 'fellow lifecycle transition lacks event');
END;
CREATE TRIGGER enrollment_fellows_status_evidence_immutable
BEFORE UPDATE OF status_changed_at, status_event_id ON enrollment_fellows
WHEN NEW.status IS OLD.status
 AND (NEW.status_changed_at IS NOT OLD.status_changed_at
   OR NEW.status_event_id IS NOT OLD.status_event_id)
BEGIN
  SELECT RAISE(ABORT, 'fellow lifecycle evidence is immutable');
END;
CREATE TRIGGER enrollment_credentials_revocation_event_update
BEFORE UPDATE OF revoked_at, revocation_event_id ON fellow_tokens
WHEN OLD.revoked_at IS NULL
 AND NOT EXISTS (
   SELECT 1 FROM fellow_lifecycle_events event
    WHERE event.event_id = NEW.revocation_event_id
      AND event.action = 'credential-revoked'
      AND event.sponsor_id = NEW.sponsor_id
      AND event.fellow_id = NEW.fellow_id
      AND event.credential_id = NEW.credential_id
      AND NEW.revoked_at = MAX(event.effective_at, NEW.issued_at, COALESCE(NEW.last_used_at, NEW.issued_at))
 )
BEGIN
  SELECT RAISE(ABORT, 'credential revocation lacks event');
END;
CREATE TRIGGER enrollment_credentials_revocation_event_immutable
BEFORE UPDATE OF revocation_event_id ON fellow_tokens
WHEN OLD.revoked_at IS NOT NULL
 AND NEW.revocation_event_id IS NOT OLD.revocation_event_id
BEGIN
  SELECT RAISE(ABORT, 'credential revocation evidence is immutable');
END;
CREATE TRIGGER enrollment_sponsor_security_schema_insert
BEFORE INSERT ON enrollment_sponsor_security
WHEN typeof(NEW.sponsor_id) <> 'text'
  OR length(NEW.sponsor_id) NOT BETWEEN 5 AND 64
  OR substr(NEW.sponsor_id, 1, 4) <> 'usr_'
  OR substr(NEW.sponsor_id, 5) GLOB '*[^A-Za-z0-9_-]*'
  OR typeof(NEW.panic_at) <> 'integer'
  OR NEW.panic_at NOT BETWEEN 1 AND 9007199254740991
  OR typeof(NEW.updated_at) <> 'integer'
  OR NEW.updated_at <> NEW.panic_at
  OR NOT EXISTS (
    SELECT 1 FROM fellow_lifecycle_events event
     WHERE event.event_id = NEW.panic_event_id
       AND event.action = 'sponsor-panic'
       AND event.sponsor_id = NEW.sponsor_id
       AND event.effective_at = NEW.panic_at
  )
BEGIN
  SELECT RAISE(ABORT, 'sponsor security evidence outside schema');
END;
CREATE TRIGGER enrollment_sponsor_security_schema_update
BEFORE UPDATE ON enrollment_sponsor_security
WHEN typeof(NEW.panic_at) <> 'integer'
  OR NEW.panic_at NOT BETWEEN 1 AND 9007199254740991
  OR typeof(NEW.updated_at) <> 'integer'
  OR NEW.updated_at <> NEW.panic_at
  OR NOT EXISTS (
    SELECT 1 FROM fellow_lifecycle_events event
     WHERE event.event_id = NEW.panic_event_id
       AND event.action = 'sponsor-panic'
       AND event.sponsor_id = NEW.sponsor_id
       AND event.effective_at = NEW.panic_at
  )
BEGIN
  SELECT RAISE(ABORT, 'sponsor security evidence outside schema');
END;
CREATE TRIGGER enrollment_fellow_security_immutable_update
BEFORE UPDATE ON enrollment_fellow_security
BEGIN
  SELECT RAISE(ABORT, 'Fellow family revocation is immutable');
END;
CREATE TRIGGER enrollment_fellow_security_causal_insert
BEFORE INSERT ON enrollment_fellow_security
WHEN EXISTS (
  SELECT 1 FROM enrollment_fellow_security existing
   WHERE existing.fellow_id = NEW.fellow_id OR existing.event_id = NEW.event_id
)
OR NOT EXISTS (
  SELECT 1
    FROM fellow_lifecycle_events event
    JOIN enrollment_fellows fellow ON fellow.fellow_id = event.fellow_id
   WHERE event.event_id = NEW.event_id
     AND event.action = 'fellow-status-changed'
     AND event.sponsor_id = NEW.sponsor_id
     AND event.fellow_id = NEW.fellow_id
     AND event.to_status = NEW.reason
     AND event.to_status IN ('revoked', 'compromised')
     AND event.effective_at = NEW.family_revoked_through
     AND NEW.updated_at = event.effective_at
     AND fellow.sponsor_id = NEW.sponsor_id
     AND fellow.status = event.from_status
)
BEGIN
  SELECT RAISE(ABORT, 'Fellow family revocation lacks event');
END;
CREATE TRIGGER enrollment_fellow_security_immutable_delete
BEFORE DELETE ON enrollment_fellow_security
BEGIN
  SELECT RAISE(ABORT, 'Fellow family revocation cannot be deleted');
END;
CREATE TRIGGER fellow_write_review_windows_immutable_update
BEFORE UPDATE ON fellow_write_review_windows
BEGIN
  SELECT RAISE(ABORT, 'Fellow review window is immutable');
END;
CREATE TRIGGER fellow_write_review_windows_causal_insert
BEFORE INSERT ON fellow_write_review_windows
WHEN EXISTS (
  SELECT 1 FROM fellow_write_review_windows existing
   WHERE existing.fellow_id = NEW.fellow_id OR existing.event_id = NEW.event_id
)
OR NOT EXISTS (
  SELECT 1
    FROM fellow_lifecycle_events event
    JOIN enrollment_fellows fellow ON fellow.fellow_id = event.fellow_id
   WHERE event.event_id = NEW.event_id
     AND event.action = 'fellow-status-changed'
     AND event.sponsor_id = NEW.sponsor_id
     AND event.fellow_id = NEW.fellow_id
     AND event.to_status = 'compromised'
     AND event.review_from = NEW.review_from
     AND event.effective_at = NEW.flagged_at
     AND NEW.state = 'open'
     AND fellow.sponsor_id = NEW.sponsor_id
     AND fellow.status = event.from_status
)
BEGIN
  SELECT RAISE(ABORT, 'Fellow review window lacks event');
END;
CREATE TRIGGER fellow_write_review_windows_immutable_delete
BEFORE DELETE ON fellow_write_review_windows
BEGIN
  SELECT RAISE(ABORT, 'Fellow review window cannot be deleted');
END;
CREATE TRIGGER fellow_lifecycle_events_apply
AFTER INSERT ON fellow_lifecycle_events
BEGIN
  UPDATE fellow_tokens
     SET revoked_at = MAX(NEW.effective_at, issued_at, COALESCE(last_used_at, issued_at)),
         revocation_event_id = NEW.event_id
   WHERE NEW.action = 'credential-revoked'
     AND credential_id = NEW.credential_id
     AND fellow_id = NEW.fellow_id
     AND sponsor_id = NEW.sponsor_id
     AND revoked_at IS NULL;

  INSERT INTO enrollment_fellow_security (
    fellow_id, sponsor_id, family_revoked_through, reason, event_id, updated_at
  )
  SELECT NEW.fellow_id, NEW.sponsor_id, NEW.effective_at, NEW.to_status,
         NEW.event_id, NEW.effective_at
   WHERE NEW.action = 'fellow-status-changed'
     AND NEW.to_status IN ('revoked', 'compromised');

  INSERT INTO fellow_write_review_windows (
    fellow_id, sponsor_id, review_from, flagged_at, event_id, state
  )
  SELECT NEW.fellow_id, NEW.sponsor_id, NEW.review_from, NEW.effective_at,
         NEW.event_id, 'open'
   WHERE NEW.action = 'fellow-status-changed'
     AND NEW.to_status = 'compromised';

  UPDATE enrollment_fellows
     SET status = NEW.to_status,
         status_changed_at = NEW.effective_at,
         status_event_id = NEW.event_id
   WHERE NEW.action = 'fellow-status-changed'
     AND fellow_id = NEW.fellow_id
     AND sponsor_id = NEW.sponsor_id
     AND status = NEW.from_status;

  UPDATE enrollment_sponsor_security
     SET panic_at = NEW.effective_at,
         updated_at = NEW.effective_at,
         panic_event_id = NEW.event_id
   WHERE NEW.action = 'sponsor-panic'
     AND sponsor_id = NEW.sponsor_id;

  INSERT INTO enrollment_sponsor_security (
    sponsor_id, panic_at, updated_at, panic_event_id
  )
  SELECT NEW.sponsor_id, NEW.effective_at, NEW.effective_at, NEW.event_id
   WHERE NEW.action = 'sponsor-panic'
     AND NOT EXISTS (
       SELECT 1 FROM enrollment_sponsor_security security
        WHERE security.sponsor_id = NEW.sponsor_id
     );

  UPDATE sponsors
     SET lifecycle_seq = NEW.sponsor_seq,
         lifecycle_lease_token = NULL,
         lifecycle_lease_expires_at = NULL
   WHERE sponsor_id = NEW.sponsor_id
     AND lifecycle_seq + 1 = NEW.sponsor_seq
     AND lifecycle_lease_token = NEW.event_id;
END;
CREATE TRIGGER sponsors_lifecycle_seq_event_bound
BEFORE UPDATE OF lifecycle_seq ON sponsors
WHEN NEW.lifecycle_seq IS NOT OLD.lifecycle_seq
 AND (NEW.lifecycle_seq <> OLD.lifecycle_seq + 1 OR NOT EXISTS (
  SELECT 1 FROM fellow_lifecycle_events event
   WHERE event.sponsor_id = NEW.sponsor_id
     AND event.sponsor_seq = NEW.lifecycle_seq
     AND event.event_id = OLD.lifecycle_lease_token
     AND NEW.lifecycle_lease_token IS NULL
     AND NEW.lifecycle_lease_expires_at IS NULL
))
BEGIN
  SELECT RAISE(ABORT, 'sponsor lifecycle head lacks event');
END;
CREATE TRIGGER sponsors_lifecycle_lease_schema
BEFORE UPDATE OF lifecycle_lease_token, lifecycle_lease_expires_at ON sponsors
WHEN NOT (
  (NEW.lifecycle_lease_token IS NULL AND NEW.lifecycle_lease_expires_at IS NULL)
  OR (
    typeof(NEW.lifecycle_lease_token) = 'text'
    AND length(NEW.lifecycle_lease_token) = 30
    AND substr(NEW.lifecycle_lease_token, 1, 4) = 'LEV-'
    AND substr(NEW.lifecycle_lease_token, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
    AND typeof(NEW.lifecycle_lease_expires_at) = 'integer'
    AND NEW.lifecycle_lease_expires_at BETWEEN 1 AND 9007199254740991
  )
)
BEGIN
  SELECT RAISE(ABORT, 'sponsor lifecycle lease outside schema');
END;
CREATE TRIGGER fellow_lifecycle_events_immutable_update
BEFORE UPDATE ON fellow_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'lifecycle event is immutable');
END;
CREATE TRIGGER fellow_lifecycle_events_immutable_delete
BEFORE DELETE ON fellow_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'lifecycle event cannot be deleted');
END;
CREATE TRIGGER enrollment_credentials_post_panic_grant_insert
BEFORE INSERT ON fellow_tokens
WHEN EXISTS (
  SELECT 1
    FROM enrollment_grants grant_row
    JOIN enrollment_sponsor_security security
      ON security.sponsor_id = grant_row.sponsor_id
   WHERE grant_row.fellow_id = NEW.fellow_id
     AND grant_row.sponsor_id = NEW.sponsor_id
     AND grant_row.granted_at <= security.panic_at
)
BEGIN
  SELECT RAISE(ABORT, 'credential grant predates sponsor panic boundary');
END;
CREATE TRIGGER enrollment_grants_post_panic_insert
BEFORE INSERT ON enrollment_grants
WHEN EXISTS (
  SELECT 1 FROM enrollment_sponsor_security security
   WHERE security.sponsor_id = NEW.sponsor_id
     AND NEW.granted_at <= security.panic_at
)
BEGIN
  SELECT RAISE(ABORT, 'Fellow grant does not follow sponsor panic boundary');
END;
CREATE INDEX fellow_lifecycle_events_sponsor_time_idx
  ON fellow_lifecycle_events (sponsor_id, effective_at DESC, event_id);
CREATE INDEX fellow_lifecycle_events_fellow_time_idx
  ON fellow_lifecycle_events (fellow_id, effective_at DESC, event_id)
  WHERE fellow_id IS NOT NULL;
CREATE INDEX enrollment_fellow_security_sponsor_idx
  ON enrollment_fellow_security (sponsor_id, family_revoked_through, fellow_id);
CREATE TRIGGER enrollment_fellows_active_cap_insert
BEFORE INSERT ON enrollment_fellows
WHEN NEW.status IN ('active', 'suspicious_review')
 AND (
   SELECT COUNT(*)
     FROM enrollment_fellows existing
    WHERE existing.sponsor_id = NEW.sponsor_id
      AND existing.status IN ('active', 'suspicious_review')
 ) >= COALESCE((
   SELECT sponsor.active_fellow_limit
     FROM sponsors sponsor
    WHERE sponsor.sponsor_id = NEW.sponsor_id
 ), 5)
BEGIN
  SELECT RAISE(ABORT, 'active Fellow cap reached');
END;
CREATE TRIGGER enrollment_fellows_active_cap_transition
BEFORE UPDATE OF status ON enrollment_fellows
WHEN OLD.status NOT IN ('active', 'suspicious_review')
 AND NEW.status IN ('active', 'suspicious_review')
 AND (
   SELECT COUNT(*)
     FROM enrollment_fellows existing
    WHERE existing.sponsor_id = NEW.sponsor_id
      AND existing.status IN ('active', 'suspicious_review')
 ) >= COALESCE((
   SELECT sponsor.active_fellow_limit
     FROM sponsors sponsor
    WHERE sponsor.sponsor_id = NEW.sponsor_id
 ), 5)
BEGIN
  SELECT RAISE(ABORT, 'active Fellow cap reached');
END;
CREATE TRIGGER sponsors_active_fellow_limit_guard
BEFORE UPDATE OF active_fellow_limit ON sponsors
WHEN NEW.active_fellow_limit < (
  SELECT COUNT(*)
    FROM enrollment_fellows fellow
   WHERE fellow.sponsor_id = NEW.sponsor_id
     AND fellow.status IN ('active', 'suspicious_review')
)
BEGIN
  SELECT RAISE(ABORT, 'active Fellow limit is below current use');
END;
CREATE INDEX enrollment_records_sponsor_kind_created_idx
  ON enrollment_records (sponsor_id, kind, created_at);
CREATE TABLE sponsor_device_enrollment_attempts (
  proposal_id TEXT PRIMARY KEY NOT NULL,
  sponsor_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  FOREIGN KEY (proposal_id) REFERENCES enrollment_grants(proposal_id)
);
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
CREATE TABLE sponsor_enrollment_bootstrap_migration_witness (
  singleton INTEGER NOT NULL UNIQUE
    CHECK (typeof(singleton) = 'integer' AND singleton = 1),
  rule_version INTEGER NOT NULL
    CHECK (typeof(rule_version) = 'integer' AND rule_version = 1),
  passed INTEGER NOT NULL
    CHECK (typeof(passed) = 'integer' AND passed = 1)
);
CREATE TRIGGER sponsor_enrollment_bootstrap_migration_witness_immutable_update
BEFORE UPDATE ON sponsor_enrollment_bootstrap_migration_witness
BEGIN
  SELECT RAISE(ABORT, 'sponsor enrollment bootstrap witness is immutable');
END;
CREATE TRIGGER sponsor_enrollment_bootstrap_migration_witness_immutable_delete
BEFORE DELETE ON sponsor_enrollment_bootstrap_migration_witness
BEGIN
  SELECT RAISE(ABORT, 'sponsor enrollment bootstrap witness cannot be deleted');
END;
CREATE TRIGGER enrollment_proposals_sponsor_bootstrap_decision
BEFORE UPDATE OF status ON enrollment_proposals
WHEN OLD.status = 'pending'
 AND NEW.status IN ('approved', 'reduced', 'denied')
 AND NOT EXISTS (
   SELECT 1
     FROM enrollment_records record
     JOIN sponsors sponsor ON sponsor.sponsor_id = record.sponsor_id
    WHERE record.enrollment_id = NEW.enrollment_id
 )
BEGIN
  SELECT RAISE(ABORT, 'sponsor bootstrap required before enrollment decision');
END;
CREATE TRIGGER enrollment_fellows_sponsor_bootstrap_insert
BEFORE INSERT ON enrollment_fellows
WHEN NOT EXISTS (
  SELECT 1 FROM sponsors sponsor WHERE sponsor.sponsor_id = NEW.sponsor_id
)
BEGIN
  SELECT RAISE(ABORT, 'sponsor bootstrap required before enrollment decision');
END;
CREATE TRIGGER enrollment_grants_sponsor_bootstrap_insert
BEFORE INSERT ON enrollment_grants
WHEN NOT EXISTS (
  SELECT 1 FROM sponsors sponsor WHERE sponsor.sponsor_id = NEW.sponsor_id
)
BEGIN
  SELECT RAISE(ABORT, 'sponsor bootstrap required before enrollment decision');
END;
CREATE TRIGGER sponsors_enrollment_authority_delete
BEFORE DELETE ON sponsors
WHEN EXISTS (
  SELECT 1 FROM enrollment_records record WHERE record.sponsor_id = OLD.sponsor_id
)
 OR EXISTS (
  SELECT 1 FROM enrollment_fellows fellow WHERE fellow.sponsor_id = OLD.sponsor_id
)
 OR EXISTS (
  SELECT 1 FROM enrollment_grants grant_row WHERE grant_row.sponsor_id = OLD.sponsor_id
)
BEGIN
  SELECT RAISE(ABORT, 'sponsor enrollment authority cannot be deleted');
END;
CREATE TRIGGER sponsors_identity_history_immutable
BEFORE UPDATE OF sponsor_id, created_at ON sponsors
WHEN NEW.sponsor_id IS NOT OLD.sponsor_id OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'sponsor identity and creation history are immutable');
END;
CREATE TRIGGER sponsors_enrollment_authority_duplicate_insert
BEFORE INSERT ON sponsors
WHEN EXISTS (
  SELECT 1 FROM sponsors existing WHERE existing.sponsor_id = NEW.sponsor_id
)
 AND (
   EXISTS (
     SELECT 1 FROM enrollment_records record WHERE record.sponsor_id = NEW.sponsor_id
   )
   OR EXISTS (
     SELECT 1 FROM enrollment_fellows fellow WHERE fellow.sponsor_id = NEW.sponsor_id
   )
   OR EXISTS (
     SELECT 1 FROM enrollment_grants grant_row WHERE grant_row.sponsor_id = NEW.sponsor_id
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'sponsor enrollment authority cannot be replaced');
END;
