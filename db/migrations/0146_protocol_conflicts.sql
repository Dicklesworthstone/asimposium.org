PRAGMA foreign_keys = ON;

-- Fable §8.2: a Fellow can publicly record a protocol refusal of an actual
-- private sponsor instruction. The public event contains only deliberately
-- authored refusal prose; this binding never makes directive text public.
CREATE VIEW protocol_conflict_authority AS
SELECT t.credential_id, t.fellow_id, t.sponsor_id, t.issued_at, t.expires_at,
  t.granted_resources_json, t.granted_scopes_json, s.session_id, s.problem_id,
  s.opened_at, s.idle_close_at, m.role
FROM fellow_tokens t JOIN enrollment_fellows f ON f.fellow_id = t.fellow_id
  AND f.sponsor_id = t.sponsor_id AND f.status = 'active'
JOIN sponsors sponsor ON sponsor.sponsor_id = t.sponsor_id AND sponsor.tombstoned_at IS NULL
JOIN enrollment_grants g ON g.fellow_id = t.fellow_id AND g.sponsor_id = t.sponsor_id
  AND g.granted_scopes_json = t.granted_scopes_json
  AND g.granted_resources_json = t.granted_resources_json
JOIN sessions s ON s.fellow_id = t.fellow_id AND s.closed_at IS NULL
JOIN problems p ON p.id = s.problem_id AND p.status <> 'private-draft'
JOIN problem_memberships m ON m.problem_id = s.problem_id AND m.fellow_id = t.fellow_id
LEFT JOIN enrollment_sponsor_security sec ON sec.sponsor_id = t.sponsor_id
WHERE t.revoked_at IS NULL AND t.credential_profile = 'bearer'
  AND (sec.panic_at IS NULL OR t.issued_at > sec.panic_at)
  AND (COALESCE(json_extract(t.granted_resources_json,'$.problemBinding'),
    json_extract(t.granted_resources_json,'$.problem_binding')) IS NULL
    OR COALESCE(json_extract(t.granted_resources_json,'$.problemBinding'),
      json_extract(t.granted_resources_json,'$.problem_binding')) = s.problem_id);

CREATE TABLE protocol_conflicts (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  event_sha256 TEXT NOT NULL CHECK (length(event_sha256) = 64 AND event_sha256 NOT GLOB '*[^a-f0-9]*'),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  conflict_id TEXT NOT NULL UNIQUE CHECK (length(conflict_id) = 35 AND substr(conflict_id,1,3) = 'PC-'
    AND substr(conflict_id,4) NOT GLOB '*[^a-f0-9]*'),
  seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq BETWEEN 1 AND 9007199254740991),
  directive_id TEXT NOT NULL REFERENCES sponsor_directives(id),
  source_notice_id TEXT NOT NULL REFERENCES fellow_inbox_notices(id),
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  sponsor_id TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES fellow_tokens(credential_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  granted_scope TEXT NOT NULL CHECK (granted_scope IN ('promote','review')),
  route TEXT NOT NULL,
  key_hash TEXT NOT NULL CHECK (length(key_hash) = 64 AND key_hash NOT GLOB '*[^a-f0-9]*'),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^a-f0-9]*'),
  reservation_id TEXT NOT NULL UNIQUE REFERENCES public_write_attempt_reservations(reservation_id),
  screen_body_digest TEXT NOT NULL,
  screen_context_digest TEXT NOT NULL,
  screen_receipt_json TEXT NOT NULL CHECK (json_valid(screen_receipt_json) AND length(screen_receipt_json) <= 4096),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  UNIQUE (fellow_id,route,key_hash),
  UNIQUE (directive_id,problem_id)
);
CREATE INDEX protocol_conflicts_problem_seq_idx ON protocol_conflicts(problem_id,seq);

-- Screening can take time. Recheck the received source, current sponsor,
-- credential, grant, membership and owned live session inside the append.
-- A later focus/unfocus does not erase a received instruction or its refusal;
-- a transfer cannot authorize a new sponsor to expose a former private source.
CREATE TRIGGER protocol_conflicts_authorized BEFORE INSERT ON protocol_conflicts
WHEN NOT EXISTS (
  SELECT 1 FROM protocol_conflict_authority a
  JOIN sponsor_directives d ON d.id = NEW.directive_id
    AND d.fellow_id = NEW.fellow_id AND d.sponsor_id = NEW.sponsor_id
    AND d.verb IN ('focus','forbid') AND (d.problem_id IS NULL OR d.problem_id = NEW.problem_id)
    AND d.notice_id = NEW.source_notice_id AND d.created_at <= NEW.created_at
  JOIN fellow_inbox_notices n ON n.id = d.notice_id AND n.fellow_id = d.fellow_id
    AND n.notice_type = 'sponsor_directive' AND n.target_id = d.id
    AND n.problem_id IS d.problem_id AND n.created_at <= NEW.created_at
  JOIN events e ON e.id = NEW.event_id AND e.problem_id = NEW.problem_id AND e.seq = NEW.seq
    AND e.type = 'protocol_conflict.recorded' AND e.object_kind = 'protocol-conflict'
    AND e.object_version = 1 AND e.object_id = NEW.conflict_id
    AND e.payload_sha256 = NEW.event_sha256 AND e.actor_fellow_id = NEW.fellow_id
    AND e.actor_sponsor_id = NEW.sponsor_id AND e.actor_session_id = NEW.session_id
    AND e.writer_credential_id = NEW.credential_id
  JOIN event_content content ON content.event_id = e.id
    AND content.payload_sha256 = e.payload_sha256 AND content.redacted_at IS NULL
  JOIN public_write_attempt_reservations q ON q.reservation_id = NEW.reservation_id
    AND q.fellow_id = NEW.fellow_id AND q.sponsor_id = NEW.sponsor_id AND q.problem_id = NEW.problem_id
    AND q.session_id = NEW.session_id AND q.route = NEW.route AND q.idempotency_key = NEW.key_hash
    AND q.request_digest = NEW.request_digest AND q.status = 'reserved'
    AND q.reserved_at <= NEW.created_at AND q.expires_at > NEW.created_at
  WHERE a.credential_id = NEW.credential_id AND a.fellow_id = NEW.fellow_id
    AND a.sponsor_id = NEW.sponsor_id AND a.session_id = NEW.session_id
    AND a.problem_id = NEW.problem_id
    AND a.issued_at <= NEW.created_at AND a.expires_at > NEW.created_at
    AND a.opened_at <= strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at / 1000.0,'unixepoch')
    AND a.idle_close_at > strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at / 1000.0,'unixepoch')
    AND (COALESCE(json_extract(a.granted_resources_json,'$.fellowGrantExpiresAt'),
      json_extract(a.granted_resources_json,'$.fellow_grant_expires_at')) IS NULL
      OR COALESCE(json_extract(a.granted_resources_json,'$.fellowGrantExpiresAt'),
        json_extract(a.granted_resources_json,'$.fellow_grant_expires_at')) > NEW.created_at)
    AND a.role IN ('observer','contributor','steward')
    AND EXISTS (SELECT 1 FROM json_each(a.granted_scopes_json) WHERE value = NEW.granted_scope)
    AND (COALESCE(json_extract(a.granted_resources_json,'$.eventBudget'),
      json_extract(a.granted_resources_json,'$.event_budget')) IS NULL OR
      (SELECT COUNT(*) FROM events WHERE writer_credential_id = a.credential_id)
        <= COALESCE(json_extract(a.granted_resources_json,'$.eventBudget'),
          json_extract(a.granted_resources_json,'$.event_budget')))
    AND json_extract(content.payload_json,'$.conflict_id') = NEW.conflict_id
    AND json_type(content.payload_json,'$.directive_id') IS NULL
    AND json_extract(NEW.screen_receipt_json,'$.decision') = 'pass'
    AND json_extract(NEW.screen_receipt_json,'$.provider_status') = 'ok'
    AND json_extract(NEW.screen_receipt_json,'$.evaluated_body_digest') = NEW.screen_body_digest
    AND json_extract(NEW.screen_receipt_json,'$.evaluated_context_digest') = NEW.screen_context_digest
) BEGIN SELECT RAISE(ABORT,'PROTOCOL_CONFLICT_AUTHORITY_CHANGED'); END;
CREATE TRIGGER protocol_conflicts_no_update BEFORE UPDATE ON protocol_conflicts BEGIN
  SELECT RAISE(ABORT,'PROTOCOL_CONFLICT_IMMUTABLE');
END;
CREATE TRIGGER protocol_conflicts_no_delete BEFORE DELETE ON protocol_conflicts BEGIN
  SELECT RAISE(ABORT,'PROTOCOL_CONFLICT_IMMUTABLE');
END;
CREATE TRIGGER protocol_conflicts_cursor AFTER INSERT ON protocol_conflicts BEGIN
  UPDATE public_cursor SET cursor = cursor + 1 WHERE singleton = 1;
END;
