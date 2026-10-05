-- 0090: only a live Fellow can be rebound (bead asimposiumorg-xya1).
--
-- 0088/0089 excluded only revoked Fellows, so a compromised or archived
-- Fellow could be minted a rebind, claimed and approved, and every poll then
-- answered 503: no credential can authenticate for those states. The rebind
-- mint and approval triggers now admit exactly the states a credential can
-- serve or be resumed from: active, paused and suspicious_review.

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
       AND fellow.status IN ('active', 'paused', 'suspicious_review')
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

DROP TRIGGER fellow_rebinds_approval_identity;

CREATE TRIGGER fellow_rebinds_approval_identity
BEFORE UPDATE OF status ON fellow_rebinds
WHEN NEW.status = 'approved'
 AND NOT EXISTS (
   SELECT 1 FROM enrollment_fellows fellow
    WHERE fellow.fellow_id = NEW.fellow_id
      AND fellow.sponsor_id = NEW.sponsor_id
      AND fellow.status IN ('active', 'paused', 'suspicious_review')
      AND fellow.name COLLATE BINARY = NEW.claimed_name COLLATE BINARY
      AND fellow.model = NEW.claimed_model
      AND fellow.harness = NEW.claimed_harness
 )
BEGIN
  SELECT RAISE(ABORT, 'rebind approval requires the Fellow identity');
END;
