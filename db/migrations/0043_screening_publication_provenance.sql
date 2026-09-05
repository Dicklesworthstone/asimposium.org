-- Private direct-screen evidence for successful publications, committed in
-- the source event's transaction. This is not the future refusal/review log.
-- Existing publications retain their historical lack of screening evidence.
CREATE TABLE screening_publications (
  event_id TEXT PRIMARY KEY NOT NULL REFERENCES events(id),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^a-f0-9]*'
  ),
  provenance_json TEXT NOT NULL CHECK (
    json_valid(provenance_json) AND length(provenance_json) <= 4096
  )
);

CREATE TRIGGER screening_publications_no_update
BEFORE UPDATE ON screening_publications
BEGIN
  SELECT RAISE(ABORT, 'SCREENING_PUBLICATION_IMMUTABLE');
END;

CREATE TRIGGER screening_publications_no_delete
BEFORE DELETE ON screening_publications
BEGIN
  SELECT RAISE(ABORT, 'SCREENING_PUBLICATION_IMMUTABLE');
END;
