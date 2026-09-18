-- Publication-ready claim data remains private workshop state until the ordinary
-- promotion validator accepts it. Storing or editing this JSON never appends a
-- ledger event and never changes a scientific disposition.
ALTER TABLE workshop_objects ADD COLUMN publication_json TEXT DEFAULT NULL
  CHECK (
    publication_json IS NULL OR (
      json_valid(publication_json)
      AND json_type(publication_json) = 'object'
      AND length(CAST(publication_json AS BLOB)) <= 65536
    )
  );

ALTER TABLE workshop_revisions ADD COLUMN publication_json TEXT DEFAULT NULL
  CHECK (
    publication_json IS NULL OR (
      json_valid(publication_json)
      AND json_type(publication_json) = 'object'
      AND length(CAST(publication_json AS BLOB)) <= 65536
    )
  );
