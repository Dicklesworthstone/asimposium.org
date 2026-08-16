PRAGMA foreign_keys = ON;

-- W3.1/W3.7: a Fellow and its grant are meaningful only when a durable,
-- accountable sponsor row exists. Do not use 0013's cap default as a surrogate
-- for that row: it can limit an orphan but cannot make it lifecycle-operable.
--
-- Earlier Workers could settle an enrollment without first bootstrapping the
-- sponsor. Do not normalize that history by fabricating identities during this
-- upgrade; an operator must resolve it before the forward guard is installed.
--
-- A valid commit leaves only this singleton witness. Its one INSERT records
-- rule version 1 after proving the retained Fellow/grant history is attached
-- to sponsors; it never creates or changes a sponsor or historical authority.
-- If the CHECK rejects the witness, Wrangler/D1 migration rollback is the
-- residue boundary. This migration performs no cleanup.
CREATE TABLE sponsor_enrollment_bootstrap_migration_witness (
  singleton INTEGER NOT NULL UNIQUE
    CHECK (typeof(singleton) = 'integer' AND singleton = 1),
  rule_version INTEGER NOT NULL
    CHECK (typeof(rule_version) = 'integer' AND rule_version = 1),
  passed INTEGER NOT NULL
    CHECK (typeof(passed) = 'integer' AND passed = 1)
);

INSERT INTO sponsor_enrollment_bootstrap_migration_witness (singleton, rule_version, passed)
VALUES (
  1,
  1,
  CASE WHEN EXISTS (
    SELECT 1
      FROM enrollment_fellows fellow
     WHERE NOT EXISTS (
       SELECT 1 FROM sponsors sponsor WHERE sponsor.sponsor_id = fellow.sponsor_id
     )
  )
    OR EXISTS (
      SELECT 1
        FROM enrollment_grants grant_row
       WHERE NOT EXISTS (
         SELECT 1 FROM sponsors sponsor WHERE sponsor.sponsor_id = grant_row.sponsor_id
       )
    )
  THEN 0 ELSE 1 END
);

-- This is durable preflight evidence, not mutable application state. The
-- singleton UNIQUE/CHECK rejects a second witness; these guards preserve the
-- successful witness's recorded rule version and verdict.
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

-- The authenticated D1 decision batch inserts the sponsor row before this
-- transition. For an unbound device proposal the record binding and this
-- transition share that same batch, so a conflict rolls all three effects back.
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

-- Defense in depth for the two authority projections. A future write-path
-- refactor or maintenance statement cannot insert only an orphan Fellow/grant.
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

-- The row must stay present once it anchors any enrollment authority. This
-- also makes a raw DELETE fail before SQLite can leave Fellow/grant/record
-- projections pointing at an absent sponsor.
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

-- Sponsor id and creation time are accountability history, not mutable profile
-- fields. `last_seen_at`, lifecycle head/lease, and capacity remain available
-- to their existing guarded write paths.
CREATE TRIGGER sponsors_identity_history_immutable
BEFORE UPDATE OF sponsor_id, created_at ON sponsors
WHEN NEW.sponsor_id IS NOT OLD.sponsor_id OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'sponsor identity and creation history are immutable');
END;

-- SQLite's REPLACE is implemented as conflict deletion plus insertion, and
-- delete triggers alone are not a portable defense when recursive triggers are
-- disabled. Reject the duplicate INSERT before REPLACE can replace a sponsor
-- that already anchors enrollment authority. Normal re-bootstrap uses the
-- update-then-conditional-insert shape in D1EnrollmentStore instead.
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
