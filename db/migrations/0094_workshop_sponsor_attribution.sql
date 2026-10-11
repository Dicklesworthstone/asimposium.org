-- Sponsor workshop actions retain the Fellow's immutable scientific author and
-- session. The human who kept, discarded, or published a selected revision is
-- a separate acting principal, recorded in the private revision history.
ALTER TABLE workshop_revisions ADD COLUMN acting_sponsor_id TEXT DEFAULT NULL
  REFERENCES sponsors(sponsor_id);

-- The public event carries the acting sponsor and selected version, but never
-- exposes the private workshop ID. This private link preserves the full source.
ALTER TABLE workshop_revisions ADD COLUMN publication_event_id TEXT DEFAULT NULL
  REFERENCES events(id);
