-- 0087: a transferred grant authorizes a fresh credential (bead asimposiumorg-dwml).
--
-- An accepted transfer (0077) moves the Fellow and its grant to the receiving
-- sponsor, sets the grant's granted_at to the acceptance instant and revokes
-- every credential. The original enrollment record stays with the sponsor who
-- approved it, so the durable-authority binding below (enrollment sponsor =
-- Fellow sponsor) could never hold again: no credential could be issued to a
-- transferred Fellow, by any path.
--
-- This recreates the trigger with one more authority: the grant was moved by
-- the accepted transfer that targets the Fellow's current sponsor and whose
-- resolved_at is exactly the grant's granted_at (the latest move). That
-- authority admits only a harness-migration credential (proposal_id NULL),
-- which is what a receiving sponsor's approved rebind issues. The original
-- enrollment's credentials stay dead: they are revoked at acceptance, and even
-- a transfer back to the original sponsor does not revive the enrollment
-- branch for them at authentication (the grant's granted_at then lies outside
-- the original proposal's window).
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
