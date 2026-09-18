-- Author withdrawal of an evidence/review input, not deletion of its history
-- or withdrawal of the target claim. Apply before the corresponding reader.
CREATE VIEW scientific_withdrawal_targets AS
SELECT e.problem_id, e.id AS source_event_id, e.payload_sha256 AS source_sha256,
  e.object_id AS target_object, 'review' AS target_kind, e.seq AS source_seq,
  e.actor_fellow_id AS fellow_id, c.payload_json,
  r.target_claim_id AS claim_id, r.target_version AS claim_version
FROM events e JOIN reviews r ON r.problem_id = e.problem_id AND r.source_event_id = e.id
  AND r.review_id = e.object_id AND r.source_seq = e.seq AND r.reviewer_fellow_id = e.actor_fellow_id
JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
JOIN problems p ON p.id = e.problem_id AND p.status <> 'private-draft' AND e.seq <= p.public_seq
WHERE e.type = 'review.created' AND e.object_kind = 'review' AND e.object_version = 1
  AND length(CAST(c.payload_json AS BLOB)) BETWEEN 1 AND 524288
UNION ALL
SELECT e.problem_id, e.id, e.payload_sha256, e.object_id, 'evidence', e.seq,
  e.actor_fellow_id, c.payload_json, x.bears_on_id, x.bears_on_version
FROM events e JOIN evidence x ON x.problem_id = e.problem_id AND x.source_event_id = e.id
  AND x.evidence_id = e.object_id AND x.source_seq = e.seq AND x.author_fellow_id = e.actor_fellow_id
  AND x.bears_on_kind = 'claim'
JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
JOIN problems p ON p.id = e.problem_id AND p.status <> 'private-draft' AND e.seq <= p.public_seq
WHERE e.type = 'evidence.created' AND e.object_kind = 'evidence' AND e.object_version = 1
  AND length(CAST(c.payload_json AS BLOB)) BETWEEN 1 AND 524288;

CREATE VIEW scientific_withdrawal_authority AS
SELECT t.credential_id, t.fellow_id, t.sponsor_id, t.issued_at, t.expires_at,
  t.granted_resources_json, t.granted_scopes_json, s.session_id, s.problem_id,
  s.opened_at, s.idle_close_at, m.role
FROM fellow_tokens t JOIN enrollment_fellows f ON f.fellow_id = t.fellow_id
  AND f.sponsor_id = t.sponsor_id AND f.status = 'active'
JOIN enrollment_grants g ON g.fellow_id = t.fellow_id AND g.sponsor_id = t.sponsor_id
  AND g.granted_scopes_json = t.granted_scopes_json AND g.granted_resources_json = t.granted_resources_json
JOIN sessions s ON s.fellow_id = t.fellow_id AND s.closed_at IS NULL
JOIN problems p ON p.id = s.problem_id AND p.status NOT IN ('private-draft','resolved','retired')
JOIN problem_memberships m ON m.problem_id = s.problem_id AND m.fellow_id = t.fellow_id
LEFT JOIN enrollment_sponsor_security sec ON sec.sponsor_id = t.sponsor_id
WHERE t.revoked_at IS NULL AND t.credential_profile = 'bearer'
  AND (sec.panic_at IS NULL OR t.issued_at > sec.panic_at)
  AND (json_extract(t.granted_resources_json,'$.problemBinding') IS NULL
    OR json_extract(t.granted_resources_json,'$.problemBinding') = s.problem_id);

CREATE TABLE scientific_withdrawals (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  event_sha256 TEXT NOT NULL CHECK (length(event_sha256) = 64 AND event_sha256 NOT GLOB '*[^a-f0-9]*'),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  retraction_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq BETWEEN 1 AND 9007199254740991),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('evidence','review')),
  target_object TEXT NOT NULL,
  source_event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^a-f0-9]*'),
  claim_id TEXT NOT NULL,
  claim_version INTEGER NOT NULL CHECK (typeof(claim_version) = 'integer' AND claim_version > 0),
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  sponsor_id TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES fellow_tokens(credential_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  route TEXT NOT NULL,
  key_hash TEXT NOT NULL CHECK (length(key_hash) = 64 AND key_hash NOT GLOB '*[^a-f0-9]*'),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^a-f0-9]*'),
  reservation_id TEXT NOT NULL UNIQUE REFERENCES public_write_attempt_reservations(reservation_id),
  screen_body_digest TEXT NOT NULL,
  screen_context_digest TEXT NOT NULL,
  screen_receipt_json TEXT NOT NULL CHECK (json_valid(screen_receipt_json) AND length(screen_receipt_json) <= 4096),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  UNIQUE (fellow_id,route,key_hash),
  UNIQUE (problem_id,retraction_id),
  FOREIGN KEY (problem_id,retraction_id) REFERENCES retractions(problem_id,retraction_id)
);
CREATE INDEX scientific_withdrawals_claim_idx ON scientific_withdrawals(problem_id,claim_id,seq);

-- The complete write rolls back if authority or source changes while screening.
-- Review authors need review authority; evidence authors need promotion authority.
CREATE TRIGGER scientific_withdrawals_authorized BEFORE INSERT ON scientific_withdrawals
WHEN NOT EXISTS (
  SELECT 1 FROM scientific_withdrawal_authority a
  JOIN scientific_withdrawal_targets source ON source.source_event_id = NEW.source_event_id
    AND source.source_sha256 = NEW.source_sha256 AND source.target_kind = NEW.target_kind
    AND source.target_object = NEW.target_object AND source.problem_id = NEW.problem_id
    AND source.claim_id = NEW.claim_id AND source.claim_version = NEW.claim_version
    AND source.fellow_id = NEW.fellow_id AND source.source_seq < NEW.seq
  JOIN events e ON e.id = NEW.event_id AND e.problem_id = NEW.problem_id AND e.seq = NEW.seq
    AND e.type = 'object.retracted' AND e.object_kind = 'retraction' AND e.object_version = 1
    AND e.object_id = NEW.retraction_id AND e.payload_sha256 = NEW.event_sha256
    AND e.actor_fellow_id = NEW.fellow_id AND e.actor_sponsor_id = NEW.sponsor_id
    AND e.actor_session_id = NEW.session_id AND e.writer_credential_id = NEW.credential_id
  JOIN event_content content ON content.event_id = e.id AND content.payload_sha256 = e.payload_sha256
    AND content.redacted_at IS NULL
  JOIN retractions r ON r.problem_id = e.problem_id AND r.retraction_id = e.object_id
    AND r.seq = e.seq AND r.target_object = NEW.target_object AND r.author_fellow_id = NEW.fellow_id
    AND r.retraction_kind = 'self-corrected' AND r.reason = json_extract(content.payload_json,'$.reason')
  JOIN public_write_attempt_reservations q ON q.reservation_id = NEW.reservation_id
    AND q.fellow_id = NEW.fellow_id AND q.sponsor_id = NEW.sponsor_id AND q.problem_id = NEW.problem_id
    AND q.session_id = NEW.session_id AND q.route = NEW.route AND q.idempotency_key = NEW.key_hash
    AND q.request_digest = NEW.request_digest AND q.status = 'reserved'
    AND q.reserved_at <= NEW.created_at AND q.expires_at > NEW.created_at
  WHERE a.credential_id = NEW.credential_id AND a.fellow_id = NEW.fellow_id AND a.sponsor_id = NEW.sponsor_id
    AND a.session_id = NEW.session_id AND a.problem_id = NEW.problem_id
    AND a.issued_at <= NEW.created_at AND a.expires_at > NEW.created_at
    AND a.opened_at <= strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at / 1000.0,'unixepoch')
    AND a.idle_close_at > strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at / 1000.0,'unixepoch')
    AND (json_extract(a.granted_resources_json,'$.fellowGrantExpiresAt') IS NULL
      OR json_extract(a.granted_resources_json,'$.fellowGrantExpiresAt') > NEW.created_at)
    AND ((NEW.target_kind = 'review' AND a.role IN ('observer','contributor','steward')
      AND EXISTS (SELECT 1 FROM json_each(a.granted_scopes_json) WHERE value = 'review'))
      OR (NEW.target_kind = 'evidence' AND a.role IN ('contributor','steward')
      AND EXISTS (SELECT 1 FROM json_each(a.granted_scopes_json) WHERE value = 'promote')))
    AND (json_extract(a.granted_resources_json,'$.eventBudget') IS NULL OR
      (SELECT COUNT(*) FROM events WHERE writer_credential_id = a.credential_id)
        <= json_extract(a.granted_resources_json,'$.eventBudget'))
    AND json_extract(content.payload_json,'$.target_event_id') = NEW.source_event_id
    AND json_extract(content.payload_json,'$.target_digest') = 'sha256:' || NEW.source_sha256
    AND json_extract(content.payload_json,'$.target_kind') = NEW.target_kind
    AND json_extract(content.payload_json,'$.claim_id') = NEW.claim_id
    AND json_extract(content.payload_json,'$.claim_version') = NEW.claim_version
    AND json_extract(NEW.screen_receipt_json,'$.decision') = 'pass'
    AND json_extract(NEW.screen_receipt_json,'$.provider_status') = 'ok'
    AND json_extract(NEW.screen_receipt_json,'$.evaluated_body_digest') = NEW.screen_body_digest
    AND json_extract(NEW.screen_receipt_json,'$.evaluated_context_digest') = NEW.screen_context_digest
) BEGIN SELECT RAISE(ABORT,'SCIENTIFIC_WITHDRAWAL_AUTHORITY_CHANGED'); END;
CREATE TRIGGER scientific_withdrawals_no_update BEFORE UPDATE ON scientific_withdrawals BEGIN
  SELECT RAISE(ABORT,'SCIENTIFIC_WITHDRAWAL_IMMUTABLE');
END;
CREATE TRIGGER scientific_withdrawals_no_delete BEFORE DELETE ON scientific_withdrawals BEGIN
  SELECT RAISE(ABORT,'SCIENTIFIC_WITHDRAWAL_IMMUTABLE');
END;
CREATE TRIGGER scientific_withdrawals_cursor AFTER INSERT ON scientific_withdrawals BEGIN
  UPDATE public_cursor SET cursor = cursor + 1 WHERE singleton = 1;
END;
