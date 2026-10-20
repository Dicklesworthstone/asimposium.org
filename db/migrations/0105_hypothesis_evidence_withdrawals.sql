-- asimposium:allow-destructive
-- W5.6 / P6 / P9: the author can correct evidence about an unversioned
-- hypothesis through the existing scientific-withdrawal transaction.
-- The migration runner executes this file atomically. Stage every legacy row,
-- recreate the same logical table, and restore all rows before installing its
-- guards. No event, source body, replay identity, reservation, or cursor changes.
-- Do not rename the old table: SQLite would retarget the dependent artifact
-- publication view and hypothesis-kill admission trigger to that renamed table.
-- Their definitions and references remain untouched by this same-name rebuild.
CREATE TABLE scientific_withdrawals_0105_backup AS SELECT * FROM scientific_withdrawals;
DROP TABLE scientific_withdrawals;

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
  claim_id TEXT,
  claim_version INTEGER CHECK (claim_version IS NULL OR (typeof(claim_version) = 'integer' AND claim_version > 0)),
  hypothesis_id TEXT CHECK (hypothesis_id IS NULL OR (
    substr(hypothesis_id, 1, 2) = 'H-' AND length(hypothesis_id) BETWEEN 3 AND 80 AND (
      substr(hypothesis_id, 3) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*' OR (
        length(hypothesis_id) = 66 AND substr(hypothesis_id, 3) NOT GLOB '*[^0-9a-f]*'
      )
    )
  )),
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
  CHECK (
    (hypothesis_id IS NULL AND claim_id IS NOT NULL AND claim_version IS NOT NULL) OR
    (target_kind = 'evidence' AND hypothesis_id IS NOT NULL AND claim_id IS NULL AND claim_version IS NULL)
  ),
  UNIQUE (fellow_id,route,key_hash),
  UNIQUE (problem_id,retraction_id),
  FOREIGN KEY (problem_id,retraction_id) REFERENCES retractions(problem_id,retraction_id)
);

INSERT INTO scientific_withdrawals (
  event_id, event_sha256, problem_id, retraction_id, seq, target_kind, target_object,
  source_event_id, source_sha256, claim_id, claim_version, hypothesis_id,
  fellow_id, sponsor_id, credential_id, session_id, route, key_hash, request_digest,
  reservation_id, screen_body_digest, screen_context_digest, screen_receipt_json, created_at
) SELECT
  event_id, event_sha256, problem_id, retraction_id, seq, target_kind, target_object,
  source_event_id, source_sha256, claim_id, claim_version, NULL,
  fellow_id, sponsor_id, credential_id, session_id, route, key_hash, request_digest,
  reservation_id, screen_body_digest, screen_context_digest, screen_receipt_json, created_at
FROM scientific_withdrawals_0105_backup;
DROP TABLE scientific_withdrawals_0105_backup;
CREATE INDEX scientific_withdrawals_claim_idx ON scientific_withdrawals(problem_id,claim_id,seq);

-- Projections locate an exact author-attributed source. Its available body and
-- digest remain cryptographically checked by the shared withdrawal writer.
-- A recorded elimination does not bar correction of the underlying evidence;
-- correcting it also does not delete or reverse that historical elimination.
DROP VIEW scientific_withdrawal_targets;
CREATE VIEW scientific_withdrawal_targets AS
SELECT e.problem_id, e.id AS source_event_id, e.payload_sha256 AS source_sha256,
  e.object_id AS target_object, 'review' AS target_kind, e.seq AS source_seq,
  e.actor_fellow_id AS fellow_id, c.payload_json,
  r.target_claim_id AS claim_id, r.target_version AS claim_version, NULL AS hypothesis_id
FROM events e JOIN reviews r ON r.problem_id = e.problem_id AND r.source_event_id = e.id
  AND r.review_id = e.object_id AND r.source_seq = e.seq AND r.reviewer_fellow_id = e.actor_fellow_id
JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
JOIN problems p ON p.id = e.problem_id AND p.status <> 'private-draft' AND e.seq <= p.public_seq
WHERE e.type = 'review.created' AND e.object_kind = 'review' AND e.object_version = 1
  AND length(CAST(c.payload_json AS BLOB)) BETWEEN 1 AND 524288
  AND NOT EXISTS (
    SELECT 1 FROM content_controls cc
    WHERE cc.problem_id = e.problem_id AND cc.visibility = 'hidden'
      AND cc.target_ref IN ('problem', e.object_id, e.object_id || '@1', '#' || e.seq)
      AND cc.version = (SELECT MAX(latest.version) FROM content_controls latest
        WHERE latest.problem_id = cc.problem_id AND latest.target_ref = cc.target_ref)
  )
UNION ALL
SELECT e.problem_id, e.id, e.payload_sha256, e.object_id, 'evidence', e.seq,
  e.actor_fellow_id, c.payload_json,
  CASE WHEN x.bears_on_kind = 'claim' THEN x.bears_on_id END,
  CASE WHEN x.bears_on_kind = 'claim' THEN x.bears_on_version END,
  CASE WHEN x.bears_on_kind = 'hypothesis' THEN x.bears_on_id END
FROM events e JOIN evidence x ON x.problem_id = e.problem_id AND x.source_event_id = e.id
  AND x.evidence_id = e.object_id AND x.source_seq = e.seq AND x.author_fellow_id = e.actor_fellow_id
  AND ((x.bears_on_kind = 'claim' AND x.bears_on_version IS NOT NULL) OR
    (x.bears_on_kind = 'hypothesis' AND x.bears_on_version IS NULL))
JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
JOIN problems p ON p.id = e.problem_id AND p.status <> 'private-draft' AND e.seq <= p.public_seq
WHERE e.type = 'evidence.created' AND e.object_kind = 'evidence' AND e.object_version = 1
  AND length(CAST(c.payload_json AS BLOB)) BETWEEN 1 AND 524288
  AND NOT EXISTS (
    SELECT 1 FROM content_controls cc
    WHERE cc.problem_id = e.problem_id AND cc.visibility = 'hidden'
      AND cc.target_ref IN ('problem', e.object_id, e.object_id || '@1', '#' || e.seq)
      AND cc.version = (SELECT MAX(latest.version) FROM content_controls latest
        WHERE latest.problem_id = cc.problem_id AND latest.target_ref = cc.target_ref)
  )
  AND (x.bears_on_kind = 'claim' OR EXISTS (
    -- The canonical H creation anchors its event control. A killed but still
    -- readable hypothesis keeps this source; an unavailable target does not
    -- authorize a new public correction that would disclose its affinity.
    SELECT 1 FROM hypotheses h
    JOIN events he ON he.id = h.source_event_id AND he.problem_id = h.problem_id
      AND he.seq = h.source_seq AND he.object_id = h.hypothesis_id AND he.object_version = 1
      AND he.type = 'hypothesis.created' AND he.object_kind = 'hypothesis'
      AND he.actor_fellow_id = h.author_fellow_id AND he.seq < e.seq
    JOIN event_content hc ON hc.event_id = he.id AND hc.payload_sha256 = he.payload_sha256
      AND hc.redacted_at IS NULL AND length(CAST(hc.payload_json AS BLOB)) BETWEEN 1 AND 524288
    WHERE h.problem_id = x.problem_id AND h.hypothesis_id = x.bears_on_id
      AND NOT EXISTS (
        SELECT 1 FROM content_controls cc
        WHERE cc.problem_id = he.problem_id AND cc.visibility = 'hidden'
          AND cc.target_ref IN (he.object_id, he.object_id || '@1', '#' || he.seq)
          AND cc.version = (SELECT MAX(latest.version) FROM content_controls latest
            WHERE latest.problem_id = cc.problem_id AND latest.target_ref = cc.target_ref)
      )
  ));

-- Preserve the original commit-time authority, source, quota, screening and
-- immutable-event witnesses. Affinity must match exactly, including NULLs.
-- Evidence authors have the same observer/contributor/steward permission as
-- evidence creation; this never grants an observer claim-promotion authority.
CREATE TRIGGER scientific_withdrawals_authorized BEFORE INSERT ON scientific_withdrawals
WHEN NOT EXISTS (
  SELECT 1 FROM scientific_withdrawal_authority a
  JOIN scientific_withdrawal_targets source ON source.source_event_id = NEW.source_event_id
    AND source.source_sha256 = NEW.source_sha256 AND source.target_kind = NEW.target_kind
    AND source.target_object = NEW.target_object AND source.problem_id = NEW.problem_id
    AND source.claim_id IS NEW.claim_id AND source.claim_version IS NEW.claim_version
    AND source.hypothesis_id IS NEW.hypothesis_id
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
      OR (NEW.target_kind = 'evidence' AND a.role IN ('observer','contributor','steward')
      AND EXISTS (SELECT 1 FROM json_each(a.granted_scopes_json) WHERE value = 'promote')))
    AND (json_extract(a.granted_resources_json,'$.eventBudget') IS NULL OR
      (SELECT COUNT(*) FROM events WHERE writer_credential_id = a.credential_id)
        <= json_extract(a.granted_resources_json,'$.eventBudget'))
    AND json_extract(content.payload_json,'$.retraction_id') = NEW.retraction_id
    AND json_extract(content.payload_json,'$.target_object') = NEW.target_object
    AND json_extract(content.payload_json,'$.target_event_id') = NEW.source_event_id
    AND json_extract(content.payload_json,'$.target_digest') = 'sha256:' || NEW.source_sha256
    AND json_extract(content.payload_json,'$.target_kind') = NEW.target_kind
    AND json_extract(content.payload_json,'$.claim_id') IS NEW.claim_id
    AND json_extract(content.payload_json,'$.claim_version') IS NEW.claim_version
    AND json_extract(content.payload_json,'$.hypothesis_id') IS NEW.hypothesis_id
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
