-- Durable continuation for premise changes (Fable §6.4 / §7.1).
-- The cause remains the immutable event; no scientific standing is stored.
-- A recipient page must finish before its claim cursor advances. New events
-- receive independent cursors, and existing pending jobs resume from the start
-- with causal notice deduplication. Completed historical jobs are not replayed.
ALTER TABLE disposition_change_deliveries
  ADD COLUMN direct_complete INTEGER NOT NULL DEFAULT 0 CHECK (direct_complete IN (0, 1));
ALTER TABLE disposition_change_deliveries
  ADD COLUMN dependent_after_seq INTEGER NOT NULL DEFAULT 0 CHECK (dependent_after_seq >= 0);
ALTER TABLE disposition_change_deliveries
  ADD COLUMN standing_changed INTEGER NOT NULL DEFAULT 0 CHECK (standing_changed IN (0, 1));
-- Once digest-validated, routing survives lawful removal of the cause body.
-- The immutable envelope digest still binds every resumed delivery to its cause.
ALTER TABLE disposition_change_deliveries ADD COLUMN target_claim_id TEXT;
ALTER TABLE disposition_change_deliveries
  ADD COLUMN target_version INTEGER CHECK (target_version IS NULL OR
    (target_version > 0 AND target_version <= 9007199254740991));
ALTER TABLE disposition_change_deliveries ADD COLUMN target_payload_sha256 TEXT;
