-- asimposium:allow-destructive
-- Reviewed (asimposiumorg-6bsc): replaces triggers (drop, then create their successors).
-- 0089: a rebind is bound to the transfer it was minted for (beads
-- asimposiumorg-hmda, asimposiumorg-x223, asimposiumorg-6prt; follow-ups
-- to dwml found by its independent verification).
--
-- hmda: an approved rebind that was not yet redeemed survived a later
-- transfer; after B->A->B its poll still issued a working token. Accepting a
-- transfer now supersedes every live rebind of the Fellow, and a credential
-- needs a redeemed rebind of the transfer that moved the current grant.
--
-- x223: after A->B->A the original-enrollment branch of the credential
-- trigger admitted a directly inserted harness-migration credential, because
-- the enrollment's sponsor was again the Fellow's sponsor (and a transfer
-- back within a day even sits inside the proposal's window). That branch now
-- also refuses a grant whose granted_at is an accepted transfer's
-- resolved_at, as authenticateCredential does.
--
-- 6prt: a receiving sponsor's panic after accepting a transfer leaves the
-- transferred grant before the panic boundary, so no credential can ever be
-- issued on it. Minting a rebind for it is refused at insert.

CREATE TRIGGER sponsor_fellow_transfers_accept_supersedes_rebinds
AFTER UPDATE OF status ON sponsor_fellow_transfers
WHEN NEW.status = 'accepted' AND OLD.status IS NOT 'accepted'
BEGIN
  UPDATE fellow_rebinds SET status = 'superseded'
   WHERE fellow_id = NEW.fellow_id
     AND status IN ('awaiting-claim', 'awaiting-approval', 'approved');
END;

DROP TRIGGER fellow_rebinds_authority_insert;

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
       AND grant_row.granted_at > COALESCE((
         SELECT panic_at FROM enrollment_sponsor_security
          WHERE sponsor_id = fellow.sponsor_id
       ), -1)
  )
BEGIN
  SELECT RAISE(ABORT, 'rebind lacks transferred-grant authority');
END;

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
       (
         grant_enrollment.sponsor_id = fellow.sponsor_id
         AND grant_row.granted_at >= grant_proposal.created_at
         AND grant_row.granted_at < grant_proposal.expires_at
         -- A grant an accepted transfer set (granted_at = its acceptance)
         -- is never the original enrollment's, even back with that sponsor.
         AND NOT EXISTS (
           SELECT 1 FROM sponsor_fellow_transfers moved
            WHERE moved.fellow_id = fellow.fellow_id
              AND moved.status = 'accepted'
              AND moved.resolved_at = grant_row.granted_at
         )
       )
       OR (
         NEW.proposal_id IS NULL
         AND NEW.credential_origin = 'harness-migration'
         AND EXISTS (
           SELECT 1
             FROM sponsor_fellow_transfers moved
             JOIN fellow_rebinds rebind
               ON rebind.transfer_id = moved.transfer_id
            WHERE moved.fellow_id = fellow.fellow_id
              AND moved.target_sponsor_id = fellow.sponsor_id
              AND moved.status = 'accepted'
              AND moved.resolved_at = grant_row.granted_at
              AND rebind.credential_id = NEW.credential_id
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
