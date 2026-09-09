-- Area assignments are deliberate problem metadata, never inferred from IDs.
-- Existing rows have no recorded assignments; do not invent a backfill.
ALTER TABLE problems ADD COLUMN areas TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(areas) AND json_type(areas) = 'array');
