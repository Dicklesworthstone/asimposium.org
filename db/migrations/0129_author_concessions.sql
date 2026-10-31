-- A concession is exact-version negative knowledge, distinct from withdrawal.
-- This immutable index preserves that distinction after payload redaction.
-- Scientific standing still requires the digest-verified public source bytes.
CREATE TABLE claim_concessions (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  event_sha256 TEXT NOT NULL CHECK(length(event_sha256) = 64 AND event_sha256 NOT GLOB '*[^a-f0-9]*'),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  claim_id TEXT NOT NULL,
  claim_version INTEGER NOT NULL CHECK(typeof(claim_version) = 'integer' AND claim_version BETWEEN 1 AND 9007199254740991),
  claim_event_id TEXT NOT NULL REFERENCES events(id),
  evidence_event_id TEXT NOT NULL REFERENCES events(id),
  UNIQUE(problem_id, claim_id, claim_version)
);
CREATE TRIGGER claim_concessions_source BEFORE INSERT ON claim_concessions
WHEN NOT EXISTS (
  SELECT 1 FROM events e
  JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
  JOIN retractions r ON r.problem_id = e.problem_id AND r.retraction_id = e.object_id
    AND r.seq = e.seq AND r.author_fellow_id = e.actor_fellow_id
    AND r.target_object = NEW.claim_id || '@' || NEW.claim_version
  JOIN events claim ON claim.id = NEW.claim_event_id AND claim.problem_id = e.problem_id
    AND claim.object_kind = 'claim' AND claim.type IN ('claim.created','claim.revised')
    AND claim.object_id = NEW.claim_id AND claim.object_version = NEW.claim_version
    AND claim.seq < e.seq AND claim.actor_fellow_id = e.actor_fellow_id
  JOIN events author ON author.problem_id = e.problem_id AND author.object_id = NEW.claim_id
    AND author.object_kind = 'claim' AND author.type = 'claim.created' AND author.object_version = 1
    AND author.actor_fellow_id = e.actor_fellow_id
  JOIN events evidence ON evidence.id = NEW.evidence_event_id AND evidence.problem_id = e.problem_id
    AND evidence.object_kind = 'evidence' AND evidence.type = 'evidence.created'
    AND evidence.object_version = 1 AND evidence.seq < e.seq AND claim.seq < evidence.seq
  JOIN claim_versions v ON v.problem_id = e.problem_id AND v.claim_id = NEW.claim_id AND v.version = NEW.claim_version
  WHERE e.id = NEW.event_id AND e.payload_sha256 = NEW.event_sha256
    AND e.problem_id = NEW.problem_id AND e.type = 'object.retracted'
    AND e.object_kind = 'retraction' AND e.object_version = 1
    AND json_extract(c.payload_json,'$.target_object') = r.target_object
    AND json_extract(c.payload_json,'$.concession.target_version') = NEW.claim_version
    AND json_extract(c.payload_json,'$.concession.target_digest') = v.content_digest
    AND json_extract(c.payload_json,'$.concession.claim_source.event_id') = claim.id
    AND json_extract(c.payload_json,'$.concession.claim_source.digest') = 'sha256:' || claim.payload_sha256
    AND json_extract(c.payload_json,'$.concession.claim_source.fellow_id') = claim.actor_fellow_id
    AND json_extract(c.payload_json,'$.concession.claim_source.sponsor_id') = claim.actor_sponsor_id
    AND json_extract(c.payload_json,'$.concession.evidence.evidence_id') = evidence.object_id
    AND json_extract(c.payload_json,'$.concession.evidence.digest') = 'sha256:' || evidence.payload_sha256
    AND json_extract(c.payload_json,'$.concession.evidence_source.event_id') = evidence.id
    AND json_extract(c.payload_json,'$.concession.evidence_source.digest') = 'sha256:' || evidence.payload_sha256
    AND json_extract(c.payload_json,'$.concession.evidence_source.fellow_id') = evidence.actor_fellow_id
    AND json_extract(c.payload_json,'$.concession.evidence_source.sponsor_id') = evidence.actor_sponsor_id
    AND NOT EXISTS (SELECT 1 FROM events newer WHERE newer.problem_id = NEW.problem_id
      AND newer.object_kind = 'claim' AND newer.type IN ('claim.created','claim.revised')
      AND newer.object_id = NEW.claim_id AND newer.object_version > NEW.claim_version AND newer.seq < e.seq)
    AND NOT EXISTS (SELECT 1 FROM retractions prior WHERE prior.problem_id = NEW.problem_id
      AND prior.seq < e.seq AND prior.target_object IN (NEW.claim_id, r.target_object))
) BEGIN SELECT RAISE(ABORT,'SCIENTIFIC_REFERENCE_CHANGED'); END;
CREATE TRIGGER claim_concessions_no_update BEFORE UPDATE ON claim_concessions
BEGIN SELECT RAISE(ABORT,'CLAIM_CONCESSION_IMMUTABLE'); END;
CREATE TRIGGER claim_concessions_no_delete BEFORE DELETE ON claim_concessions
BEGIN SELECT RAISE(ABORT,'CLAIM_CONCESSION_IMMUTABLE'); END;
