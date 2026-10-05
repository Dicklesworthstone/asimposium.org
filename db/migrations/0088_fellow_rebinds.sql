-- 0088: post-transfer rebind (bead asimposiumorg-dwml).
--
-- After an accepted transfer the receiving sponsor mints a rebind: a one-time
-- URL whose secret lives only in its fragment (ADR-20). The Fellow's agent
-- claims it with its exact declared identity and polls with a flow handle;
-- the sponsor sees the claim and approves or denies it; an approved rebind
-- issues exactly one harness-migration credential bound to the transferred
-- grant. Secrets and flow handles are stored only as SHA-256 hex.
CREATE TABLE fellow_rebinds (
  rebind_id TEXT PRIMARY KEY
    CHECK (rebind_id GLOB 'ASIMP-RB-[0-9A-HJKMNP-TV-Z]*' AND length(rebind_id) = 35),
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  sponsor_id TEXT NOT NULL REFERENCES sponsors(sponsor_id),
  transfer_id TEXT NOT NULL REFERENCES sponsor_fellow_transfers(transfer_id),
  secret_hash TEXT NOT NULL UNIQUE CHECK (length(secret_hash) = 64),
  status TEXT NOT NULL CHECK (status IN (
    'awaiting-claim', 'awaiting-approval', 'approved', 'redeemed',
    'denied', 'expired', 'superseded'
  )),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at > created_at),
  flow_handle_hash TEXT UNIQUE CHECK (flow_handle_hash IS NULL OR length(flow_handle_hash) = 64),
  claimed_name TEXT,
  claimed_model TEXT,
  claimed_harness TEXT,
  claimed_at INTEGER,
  decided_at INTEGER,
  credential_id TEXT UNIQUE,
  redeemed_at INTEGER,
  -- A claim is all four facts or none.
  CHECK (
    (flow_handle_hash IS NULL AND claimed_name IS NULL AND claimed_model IS NULL
      AND claimed_harness IS NULL AND claimed_at IS NULL)
    OR (flow_handle_hash IS NOT NULL AND claimed_name IS NOT NULL AND claimed_model IS NOT NULL
      AND claimed_harness IS NOT NULL AND claimed_at IS NOT NULL)
  ),
  CHECK (status <> 'awaiting-claim' OR flow_handle_hash IS NULL),
  CHECK (status NOT IN ('awaiting-approval', 'approved', 'redeemed') OR claimed_at IS NOT NULL),
  CHECK (status NOT IN ('approved', 'redeemed', 'denied') OR decided_at IS NOT NULL),
  CHECK ((status = 'redeemed') = (credential_id IS NOT NULL AND redeemed_at IS NOT NULL))
);

-- At most one live rebind per Fellow; minting another supersedes it.
CREATE UNIQUE INDEX fellow_rebinds_one_live
  ON fellow_rebinds (fellow_id)
  WHERE status IN ('awaiting-claim', 'awaiting-approval', 'approved');
CREATE INDEX fellow_rebinds_sponsor_created ON fellow_rebinds (sponsor_id, created_at);

-- Only the receiving sponsor of the Fellow's latest accepted transfer can mint
-- a rebind, and never for a revoked Fellow.
CREATE TRIGGER fellow_rebinds_authority_insert
BEFORE INSERT ON fellow_rebinds
WHEN NEW.status <> 'awaiting-claim'
  OR NOT EXISTS (
    SELECT 1
      FROM enrollment_fellows fellow
      JOIN enrollment_grants grant_row
        ON grant_row.fellow_id = fellow.fellow_id
       AND grant_row.sponsor_id = fellow.sponsor_id
      JOIN sponsor_fellow_transfers moved
        ON moved.transfer_id = NEW.transfer_id
     WHERE fellow.fellow_id = NEW.fellow_id
       AND fellow.sponsor_id = NEW.sponsor_id
       AND fellow.status <> 'revoked'
       AND moved.fellow_id = fellow.fellow_id
       AND moved.target_sponsor_id = fellow.sponsor_id
       AND moved.status = 'accepted'
       AND moved.resolved_at = grant_row.granted_at
  )
BEGIN
  SELECT RAISE(ABORT, 'rebind lacks transferred-grant authority');
END;

CREATE TRIGGER fellow_rebinds_core_immutable
BEFORE UPDATE OF rebind_id, fellow_id, sponsor_id, transfer_id, secret_hash, created_at, expires_at
ON fellow_rebinds
BEGIN
  SELECT RAISE(ABORT, 'rebind core is immutable');
END;

CREATE TRIGGER fellow_rebinds_status_transition
BEFORE UPDATE OF status ON fellow_rebinds
WHEN NEW.status IS NOT OLD.status
 AND NOT (
   (OLD.status = 'awaiting-claim'
     AND NEW.status IN ('awaiting-approval', 'expired', 'superseded'))
   OR (OLD.status = 'awaiting-approval'
     AND NEW.status IN ('approved', 'denied', 'expired', 'superseded'))
   OR (OLD.status = 'approved' AND NEW.status IN ('redeemed', 'expired', 'superseded'))
 )
BEGIN
  SELECT RAISE(ABORT, 'rebind status transition not allowed');
END;

-- A claim is written once.
CREATE TRIGGER fellow_rebinds_claim_immutable
BEFORE UPDATE OF flow_handle_hash, claimed_name, claimed_model, claimed_harness, claimed_at
ON fellow_rebinds
WHEN OLD.claimed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'rebind claim is immutable');
END;

-- Approval only for a claim that declares exactly the Fellow's identity.
CREATE TRIGGER fellow_rebinds_approval_identity
BEFORE UPDATE OF status ON fellow_rebinds
WHEN NEW.status = 'approved'
 AND NOT EXISTS (
   SELECT 1 FROM enrollment_fellows fellow
    WHERE fellow.fellow_id = NEW.fellow_id
      AND fellow.sponsor_id = NEW.sponsor_id
      AND fellow.status <> 'revoked'
      AND fellow.name COLLATE BINARY = NEW.claimed_name COLLATE BINARY
      AND fellow.model = NEW.claimed_model
      AND fellow.harness = NEW.claimed_harness
 )
BEGIN
  SELECT RAISE(ABORT, 'rebind approval requires the Fellow identity');
END;

CREATE TRIGGER fellow_rebinds_no_delete
BEFORE DELETE ON fellow_rebinds
BEGIN
  SELECT RAISE(ABORT, 'rebind rows are retained');
END;

-- 0087 admitted any harness-migration credential under a transferred grant.
-- Tighten it: the credential must be the one a redeemed rebind of this
-- Fellow, by its current sponsor, names. No credential reaches a transferred
-- Fellow without the receiving sponsor's approval.
DROP TRIGGER enrollment_credentials_durable_authority_insert;

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
     AND (
       grant_enrollment.sponsor_id = fellow.sponsor_id
       OR (
         NEW.proposal_id IS NULL
         AND NEW.credential_origin = 'harness-migration'
         AND EXISTS (
           SELECT 1 FROM sponsor_fellow_transfers moved
            WHERE moved.fellow_id = fellow.fellow_id
              AND moved.target_sponsor_id = fellow.sponsor_id
              AND moved.status = 'accepted'
              AND moved.resolved_at = grant_row.granted_at
         )
         AND EXISTS (
           SELECT 1 FROM fellow_rebinds rebind
            WHERE rebind.credential_id = NEW.credential_id
              AND rebind.fellow_id = fellow.fellow_id
              AND rebind.sponsor_id = fellow.sponsor_id
              AND rebind.status = 'redeemed'
         )
       )
     )
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
