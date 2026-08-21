-- W2.7: workshop bodies over the CAS spill threshold live in the CAS, not the
-- index row (Fable §10: "bodies > 1 KB go to CAS with a 280-char extract in the
-- row"). One column makes that explicit: `cas_hash` is the content-addressed
-- digest of the spilled body (NULL when the body is inline). When cas_hash is
-- set, `body_md` carries the 280-character extract instead of the full body.
--
-- Access control stays on the index row: the CAS bytes are reached only through
-- the owning workshop row, and unlisted hashes are explicitly not secrets.

ALTER TABLE workshop_objects ADD COLUMN cas_hash TEXT DEFAULT NULL
  CHECK (cas_hash IS NULL OR cas_hash GLOB 'sha256:[0-9a-f]*');

-- Coherence: a spilled body (cas_hash set) carries the 280-char extract in
-- body_md, never the full body; an inline body (cas_hash NULL) is the whole
-- body and may be any length the base schema allows. Enforced by triggers since
-- a CHECK cannot express the conditional length.
CREATE TRIGGER workshop_objects_cas_spill_extract_insert
BEFORE INSERT ON workshop_objects
WHEN NEW.cas_hash IS NOT NULL AND length(NEW.body_md) > 280
BEGIN
  SELECT RAISE(ABORT, 'WORKSHOP_CAS_SPILL_EXTRACT_TOO_LONG');
END;

CREATE TRIGGER workshop_objects_cas_spill_extract_update
BEFORE UPDATE ON workshop_objects
WHEN NEW.cas_hash IS NOT NULL AND length(NEW.body_md) > 280
BEGIN
  SELECT RAISE(ABORT, 'WORKSHOP_CAS_SPILL_EXTRACT_TOO_LONG');
END;
