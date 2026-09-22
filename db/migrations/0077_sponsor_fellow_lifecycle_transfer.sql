PRAGMA foreign_keys = ON;

-- W3.8 Sponsor/Fellow lifecycle: bilateral transfer, account export and deletion.
--
-- Rules:
-- 1. A Fellow always has exactly one living accountable sponsor.
-- 2. A Fellow cannot transfer itself (Rule A2/A3).
-- 3. Both outgoing and receiving sponsors must confirm via step-up auth.
-- 4. Atomic activation rebinds sponsor_id, revokes pre-transfer credentials,
--    pauses Fellow, and preserves historical event attribution.
-- 5. Sponsor account deletion tombstones the handle, revokes all Fellows/tokens,
--    purges never-published private drafts, and preserves licensed public event history.

CREATE TABLE sponsor_fellow_transfers (
  transfer_id TEXT PRIMARY KEY,
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  source_sponsor_id TEXT NOT NULL REFERENCES sponsors(sponsor_id),
  target_sponsor_id TEXT NOT NULL REFERENCES sponsors(sponsor_id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled', 'expired')),
  directive_attestation TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (directive_attestation IN ('no_directives', 'attested_no_material_influence', 'disclosed', 'unresolved')),
  transfer_manifest_json TEXT NOT NULL CHECK (json_valid(transfer_manifest_json)),
  request_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER,
  CHECK (
    typeof(transfer_id) = 'text'
    AND length(transfer_id) = 30
    AND substr(transfer_id, 1, 4) = 'TRF-'
    AND substr(transfer_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  CHECK (source_sponsor_id <> target_sponsor_id),
  CHECK (expires_at > created_at),
  CHECK (resolved_at IS NULL OR resolved_at >= created_at)
);

CREATE UNIQUE INDEX sponsor_fellow_transfers_pending_unique_idx
  ON sponsor_fellow_transfers (fellow_id)
  WHERE status = 'pending';

CREATE INDEX sponsor_fellow_transfers_target_idx
  ON sponsor_fellow_transfers (target_sponsor_id, status, created_at);

CREATE INDEX sponsor_fellow_transfers_source_idx
  ON sponsor_fellow_transfers (source_sponsor_id, status, created_at);

CREATE INDEX sponsor_fellow_transfers_fellow_idx
  ON sponsor_fellow_transfers (fellow_id, created_at);

ALTER TABLE sponsors ADD COLUMN tombstoned_at INTEGER DEFAULT NULL;

-- ── Trigger Updates for Transfer and Deletion Guards ─────────────────────────

-- 1. enrollment_fellows identity immutability:
DROP TRIGGER enrollment_fellows_identity_immutable;

CREATE TRIGGER enrollment_fellows_core_identity_immutable
BEFORE UPDATE OF fellow_id, name, model, harness, created_at
ON enrollment_fellows
BEGIN
  SELECT RAISE(ABORT, 'Fellow identity is immutable');
END;

CREATE TRIGGER enrollment_fellows_sponsor_transfer_guard
BEFORE UPDATE OF sponsor_id ON enrollment_fellows
WHEN NEW.sponsor_id IS NOT OLD.sponsor_id
 AND NOT EXISTS (
   SELECT 1 FROM sponsor_fellow_transfers t
    WHERE t.fellow_id = NEW.fellow_id
      AND t.source_sponsor_id = OLD.sponsor_id
      AND t.target_sponsor_id = NEW.sponsor_id
      AND t.status = 'accepted'
      AND t.resolved_at IS NOT NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'Fellow sponsorship transfer lacks accepted transfer record');
END;

-- 2. enrollment_grants immutability and transfer:
DROP TRIGGER enrollment_grants_immutable_update;

CREATE TRIGGER enrollment_grants_core_immutable_update
BEFORE UPDATE OF proposal_id, fellow_id, granted_scopes_json, granted_resources_json
ON enrollment_grants
BEGIN
  SELECT RAISE(ABORT, 'enrollment grant is immutable');
END;

CREATE TRIGGER enrollment_grants_sponsor_transfer_guard
BEFORE UPDATE OF sponsor_id, granted_at ON enrollment_grants
WHEN NEW.sponsor_id IS NOT OLD.sponsor_id
 AND NOT EXISTS (
   SELECT 1 FROM sponsor_fellow_transfers t
    WHERE t.fellow_id = NEW.fellow_id
      AND t.source_sponsor_id = OLD.sponsor_id
      AND t.target_sponsor_id = NEW.sponsor_id
      AND t.status = 'accepted'
      AND t.resolved_at IS NOT NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'enrollment grant sponsor transfer lacks accepted transfer record');
END;

-- 3. enrollment_fellows status transitions:
DROP TRIGGER enrollment_fellows_status_transition;

CREATE TRIGGER enrollment_fellows_status_transition
BEFORE UPDATE OF status, status_changed_at, status_event_id ON enrollment_fellows
WHEN NEW.status IS NOT OLD.status
 AND NOT (
   EXISTS (
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
   OR (
     NEW.status = 'paused'
     AND EXISTS (
       SELECT 1 FROM sponsor_fellow_transfers t
        WHERE t.fellow_id = NEW.fellow_id
          AND t.target_sponsor_id = NEW.sponsor_id
          AND t.status = 'accepted'
          AND t.resolved_at = NEW.status_changed_at
     )
   )
   OR (
     NEW.status = 'revoked'
     AND EXISTS (
       SELECT 1 FROM sponsors s
        WHERE s.sponsor_id = NEW.sponsor_id
          AND s.tombstoned_at IS NOT NULL
          AND NEW.status_changed_at >= s.tombstoned_at
     )
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'fellow lifecycle transition lacks event');
END;

-- 4. fellow_tokens credential revocation guards:
DROP TRIGGER enrollment_credentials_revocation_event_update;

CREATE TRIGGER enrollment_credentials_revocation_event_update
BEFORE UPDATE OF revoked_at, revocation_event_id ON fellow_tokens
WHEN OLD.revoked_at IS NULL
 AND NOT (
   EXISTS (
     SELECT 1 FROM fellow_lifecycle_events event
      WHERE event.event_id = NEW.revocation_event_id
        AND event.action = 'credential-revoked'
        AND event.sponsor_id = NEW.sponsor_id
        AND event.fellow_id = NEW.fellow_id
        AND event.credential_id = NEW.credential_id
        AND NEW.revoked_at = MAX(event.effective_at, NEW.issued_at, COALESCE(NEW.last_used_at, NEW.issued_at))
   )
   OR EXISTS (
     SELECT 1 FROM sponsor_fellow_transfers t
      WHERE t.fellow_id = NEW.fellow_id
        AND t.status = 'accepted'
        AND t.resolved_at IS NOT NULL
        AND NEW.revoked_at >= t.resolved_at
   )
   OR EXISTS (
     SELECT 1 FROM sponsors s
      WHERE s.sponsor_id = NEW.sponsor_id
        AND s.tombstoned_at IS NOT NULL
        AND NEW.revoked_at >= s.tombstoned_at
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'credential revocation lacks event');
END;

-- 5. Expand enrollment_idempotency scope for transfer and delete:
CREATE TABLE enrollment_idempotency_with_transfer (
  scope TEXT NOT NULL CHECK (scope IN (
    'mint', 'claim', 'decision', 'poll', 'device-start',
    'credential-revoke', 'fellow-lifecycle', 'sponsor-panic',
    'operator-fellow-cap', 'fellow-transfer', 'sponsor-delete'
  )),
  principal_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_ciphertext TEXT NOT NULL,
  response_initialization_vector TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, principal_scope, idempotency_key)
);

INSERT INTO enrollment_idempotency_with_transfer (
  scope, principal_scope, idempotency_key, request_digest,
  response_ciphertext, response_initialization_vector, expires_at
)
SELECT scope, principal_scope, idempotency_key, request_digest,
       response_ciphertext, response_initialization_vector, expires_at
  FROM enrollment_idempotency;

DROP TABLE enrollment_idempotency;
ALTER TABLE enrollment_idempotency_with_transfer RENAME TO enrollment_idempotency;
