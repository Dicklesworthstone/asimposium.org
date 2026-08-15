PRAGMA foreign_keys = ON;

-- A Fellow's posture is checked on every credential authentication. Existing
-- approved Fellows become active; no bearer can select a weaker default.
ALTER TABLE enrollment_fellows ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN (
    'pending', 'active', 'paused', 'revoked', 'archived', 'compromised',
    'suspicious_review'
  ));

-- The G0 enrollment_credentials table made proposal_id NOT NULL UNIQUE, which
-- correctly limited the one-time enrollment poll but accidentally made the
-- Fable max-three token policy impossible. Expand non-destructively into the
-- canonical Fable `fellow_tokens` table; freeze the legacy rows after copying
-- so production's forward-only policy never requires a rename or drop.
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
    CHECK (credential_origin IN ('enrollment', 'harness-migration')),
  CHECK (
    (proposal_id IS NOT NULL AND credential_origin = 'enrollment')
    OR (proposal_id IS NULL AND credential_origin = 'harness-migration')
  )
);

INSERT INTO fellow_tokens (
  credential_id, proposal_id, fellow_id, sponsor_id, token_hash,
  granted_scopes_json, granted_resources_json, issued_at, expires_at,
  revoked_at, last_used_at, credential_profile, credential_origin
)
SELECT credential_id, proposal_id, fellow_id, sponsor_id, token_hash,
       granted_scopes_json, granted_resources_json, issued_at,
       issued_at + 31536000000, NULL, NULL, 'bearer', 'enrollment'
  FROM enrollment_credentials;

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

-- SQLite foreign keys prove that each referenced row exists, but the original
-- schema did not prove that the three identity columns describe the same
-- enrollment. Authentication independently rechecks the binding on every use;
-- this trigger prevents any new cross-identity splice after the lossless legacy
-- copy. NULL proposal origins remain reserved for harness-migration tokens.
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

-- The approval-time grant is the authority copied into every credential. The
-- G0 schema described it as immutable but did not enforce that claim. Without
-- these guards, a later direct UPDATE or REPLACE can expand a Fellow's scopes
-- and then mint a matching migration credential that passes the binding check.
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

-- The latest sponsor panic instant invalidates every credential issued at or
-- before it. Keeping the boundary separate from bearer rows makes an all-token
-- stop one atomic write instead of a best-effort row scan.
CREATE TABLE enrollment_sponsor_security (
  sponsor_id TEXT PRIMARY KEY,
  panic_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (panic_at >= 0),
  CHECK (updated_at >= panic_at)
);

-- A later write may advance a panic boundary, never resurrect token families by
-- moving it backward. `updated_at` is monotonic too so console evidence cannot
-- be rewritten to an earlier observation instant.
CREATE TRIGGER enrollment_sponsor_security_monotonic
BEFORE UPDATE ON enrollment_sponsor_security
WHEN NEW.sponsor_id <> OLD.sponsor_id
  OR NEW.panic_at < OLD.panic_at
  OR NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'sponsor panic boundary is monotonic');
END;

-- REPLACE is a DELETE followed by an INSERT in SQLite. Refuse both halves so a
-- convenience write cannot erase or lower the last panic boundary. Advancing a
-- boundary is deliberately an UPDATE guarded by the monotonic trigger above.
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

-- A SQLite REPLACE can otherwise sidestep UPDATE immutability by resolving a
-- unique conflict as delete-plus-insert. Detect every credential uniqueness
-- key before conflict resolution and require rotations to use a fresh row.
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

-- A credential is an immutable authority grant with two monotonic hygiene
-- fields. Rotation or harness migration inserts another credential; it never
-- rewrites the origin, principal, authority, lifetime, or proof profile of one
-- that may already have appeared in an audit trail.
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

-- Future harness migration may mint more than one credential for a Fellow,
-- but no path can cross the three-active-token boundary even under concurrent
-- inserts. Expired, individually revoked, and pre-panic rows do not consume a
-- slot. A credential cannot be minted on the panic boundary itself.
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
       AND existing.issued_at > COALESCE(security.panic_at, -1)
  ) >= 3
BEGIN
  SELECT RAISE(ABORT, 'active credential cap reached');
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
