PRAGMA foreign_keys = ON;

-- W3.7 sponsor lifecycle commands (asimposiumorg-9p4). Scientific ledger
-- events remain problem-scoped; these private sponsor events are the causal
-- log for credential and Fellow lifecycle projections.

-- The replay row is still written in the same D1 batch as the command event.
-- `request_digest NOT NULL` remains the conflict-abort mechanism: do not relax
-- it while widening the vocabulary.
CREATE TABLE enrollment_idempotency_with_lifecycle (
  scope TEXT NOT NULL CHECK (scope IN (
    'mint', 'claim', 'decision', 'poll', 'device-start',
    'credential-revoke', 'fellow-lifecycle', 'sponsor-panic'
  )),
  principal_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_ciphertext TEXT NOT NULL,
  response_initialization_vector TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, principal_scope, idempotency_key)
);

INSERT INTO enrollment_idempotency_with_lifecycle (
  scope, principal_scope, idempotency_key, request_digest,
  response_ciphertext, response_initialization_vector, expires_at
)
SELECT scope, principal_scope, idempotency_key, request_digest,
       response_ciphertext, response_initialization_vector, expires_at
  FROM enrollment_idempotency;

DROP TABLE enrollment_idempotency;
ALTER TABLE enrollment_idempotency_with_lifecycle RENAME TO enrollment_idempotency;

ALTER TABLE sponsors ADD COLUMN lifecycle_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sponsors ADD COLUMN lifecycle_lease_token TEXT;
ALTER TABLE sponsors ADD COLUMN lifecycle_lease_expires_at INTEGER;

CREATE TABLE fellow_lifecycle_events (
  event_id TEXT PRIMARY KEY,
  sponsor_id TEXT NOT NULL REFERENCES sponsors(sponsor_id),
  sponsor_seq INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'credential-revoked', 'fellow-status-changed', 'sponsor-panic'
  )),
  fellow_id TEXT REFERENCES enrollment_fellows(fellow_id),
  credential_id TEXT REFERENCES fellow_tokens(credential_id),
  from_status TEXT,
  to_status TEXT,
  effective_at INTEGER NOT NULL,
  review_from INTEGER,
  request_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  UNIQUE (sponsor_id, sponsor_seq),
  CHECK (
    typeof(event_id) = 'text'
    AND length(event_id) = 30
    AND substr(event_id, 1, 4) = 'LEV-'
    AND substr(event_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  CHECK (
    typeof(sponsor_id) = 'text'
    AND length(sponsor_id) BETWEEN 5 AND 64
    AND substr(sponsor_id, 1, 4) = 'usr_'
    AND substr(sponsor_id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  CHECK (typeof(sponsor_seq) = 'integer' AND sponsor_seq BETWEEN 1 AND 9007199254740991),
  CHECK (typeof(effective_at) = 'integer' AND effective_at BETWEEN 1 AND 9007199254740991),
  CHECK (typeof(created_at) = 'integer' AND created_at = effective_at),
  CHECK (
    review_from IS NULL
    OR (typeof(review_from) = 'integer' AND review_from BETWEEN 1 AND effective_at)
  ),
  CHECK (
    typeof(request_id) = 'text'
    AND length(request_id) = 64
    AND request_id NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (action = 'credential-revoked'
      AND fellow_id IS NOT NULL AND credential_id IS NOT NULL
      AND from_status IS NULL AND to_status IS NULL AND review_from IS NULL)
    OR
    (action = 'fellow-status-changed'
      AND fellow_id IS NOT NULL AND credential_id IS NULL
      AND from_status IN (
        'pending', 'active', 'paused', 'revoked', 'archived',
        'compromised', 'suspicious_review'
      )
      AND to_status IN (
        'active', 'paused', 'revoked', 'archived',
        'compromised', 'suspicious_review'
      )
      AND from_status <> to_status
      AND ((to_status = 'compromised' AND review_from IS NOT NULL)
        OR (to_status <> 'compromised' AND review_from IS NULL)))
    OR
    (action = 'sponsor-panic'
      AND fellow_id IS NULL AND credential_id IS NULL
      AND from_status IS NULL AND to_status IS NULL AND review_from IS NULL)
  )
);

ALTER TABLE fellow_tokens ADD COLUMN revocation_event_id TEXT
  REFERENCES fellow_lifecycle_events(event_id);
ALTER TABLE enrollment_fellows ADD COLUMN status_changed_at INTEGER;
ALTER TABLE enrollment_fellows ADD COLUMN status_event_id TEXT
  REFERENCES fellow_lifecycle_events(event_id);
ALTER TABLE enrollment_sponsor_security ADD COLUMN panic_event_id TEXT
  REFERENCES fellow_lifecycle_events(event_id);

UPDATE enrollment_fellows SET status_changed_at = created_at;

-- Approval is the only constructor for a new Fellow. Later lifecycle states
-- must be derived from an appended event; accepting them on INSERT would let a
-- maintenance statement fabricate a paused or terminal projection with no
-- causal record.
CREATE TRIGGER enrollment_fellows_lifecycle_initial_insert
BEFORE INSERT ON enrollment_fellows
WHEN NEW.status <> 'active'
  OR NEW.status_event_id IS NOT NULL
  OR (NEW.status_changed_at IS NOT NULL AND NEW.status_changed_at <> NEW.created_at)
BEGIN
  SELECT RAISE(ABORT, 'Fellow lifecycle must begin active');
END;

-- The sponsor head is advanced only by the lifecycle-event apply trigger.
-- A nonzero value on construction would strand the next-event invariant.
CREATE TRIGGER sponsors_lifecycle_initial_insert
BEFORE INSERT ON sponsors
WHEN NEW.lifecycle_seq <> 0
  OR NEW.lifecycle_lease_token IS NOT NULL
  OR NEW.lifecycle_lease_expires_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'sponsor lifecycle head must begin at zero');
END;

-- One boundary invalidates an entire Fellow credential family without an
-- unbounded rewrite of historical token rows. Terminal status separately
-- refuses every authentication, including malformed future-issued rows.
CREATE TABLE enrollment_fellow_security (
  fellow_id TEXT PRIMARY KEY REFERENCES enrollment_fellows(fellow_id),
  sponsor_id TEXT NOT NULL,
  family_revoked_through INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('revoked', 'compromised')),
  event_id TEXT NOT NULL UNIQUE REFERENCES fellow_lifecycle_events(event_id),
  updated_at INTEGER NOT NULL,
  CHECK (typeof(family_revoked_through) = 'integer'
    AND family_revoked_through BETWEEN 1 AND 9007199254740991),
  CHECK (typeof(updated_at) = 'integer' AND updated_at = family_revoked_through)
);

-- W5 can join this durable window to attributed scientific events. W3.7 does
-- not fabricate a count before the scientific event envelope carries Fellow
-- attribution.
CREATE TABLE fellow_write_review_windows (
  fellow_id TEXT PRIMARY KEY REFERENCES enrollment_fellows(fellow_id),
  sponsor_id TEXT NOT NULL,
  review_from INTEGER NOT NULL,
  flagged_at INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE REFERENCES fellow_lifecycle_events(event_id),
  state TEXT NOT NULL CHECK (state = 'open'),
  CHECK (typeof(review_from) = 'integer' AND review_from BETWEEN 1 AND flagged_at),
  CHECK (typeof(flagged_at) = 'integer' AND flagged_at BETWEEN 1 AND 9007199254740991)
);

-- Retained sponsor panic evidence used a nonnegative timestamp contract. Keep
-- zero upgrade-compatible, but every new event time is strictly positive.
CREATE TABLE fellow_lifecycle_migration_guard (
  valid INTEGER NOT NULL CONSTRAINT fellow_lifecycle_migration_guard CHECK (valid = 1)
);

INSERT INTO fellow_lifecycle_migration_guard (valid)
SELECT 0
 WHERE EXISTS (
   SELECT 1 FROM enrollment_sponsor_security security
    WHERE typeof(security.sponsor_id) <> 'text'
       OR length(security.sponsor_id) NOT BETWEEN 5 AND 64
       OR substr(security.sponsor_id, 1, 4) <> 'usr_'
       OR substr(security.sponsor_id, 5) GLOB '*[^A-Za-z0-9_-]*'
       OR typeof(security.panic_at) <> 'integer'
       OR security.panic_at NOT BETWEEN 0 AND 9007199254740991
       OR typeof(security.updated_at) <> 'integer'
       OR security.updated_at NOT BETWEEN security.panic_at AND 9007199254740991
       OR security.panic_event_id IS NOT NULL
 );

DROP TABLE fellow_lifecycle_migration_guard;

-- The event statement is the command. It may append only when the next sponsor
-- sequence and the exact current projection state agree.
CREATE TRIGGER fellow_lifecycle_events_command_guard
BEFORE INSERT ON fellow_lifecycle_events
WHEN NOT EXISTS (
  SELECT 1 FROM sponsors sponsor
   WHERE sponsor.sponsor_id = NEW.sponsor_id
     AND sponsor.lifecycle_seq + 1 = NEW.sponsor_seq
     AND sponsor.lifecycle_lease_token = NEW.event_id
     AND sponsor.lifecycle_lease_expires_at IS NOT NULL
     AND NEW.created_at <= sponsor.lifecycle_lease_expires_at
)
OR NOT (
  (NEW.action = 'credential-revoked' AND EXISTS (
    SELECT 1 FROM fellow_tokens credential
     WHERE credential.credential_id = NEW.credential_id
       AND credential.fellow_id = NEW.fellow_id
       AND credential.sponsor_id = NEW.sponsor_id
       AND credential.revoked_at IS NULL
       AND NEW.effective_at >= credential.issued_at
  ))
  OR
  (NEW.action = 'fellow-status-changed' AND EXISTS (
    SELECT 1 FROM enrollment_fellows fellow
     WHERE fellow.fellow_id = NEW.fellow_id
       AND fellow.sponsor_id = NEW.sponsor_id
       AND fellow.status = NEW.from_status
       AND NEW.effective_at >= fellow.created_at
       AND (
         (fellow.status = 'pending' AND NEW.to_status = 'active')
         OR (fellow.status = 'active'
           AND NEW.to_status IN ('paused', 'revoked', 'compromised', 'suspicious_review'))
         OR (fellow.status = 'paused'
           AND NEW.to_status IN ('active', 'revoked', 'compromised', 'suspicious_review'))
         OR (fellow.status = 'suspicious_review'
           AND NEW.to_status IN ('active', 'paused', 'revoked', 'compromised'))
         OR (fellow.status IN ('revoked', 'compromised') AND NEW.to_status = 'archived')
       )
       AND (NEW.to_status <> 'compromised' OR NEW.review_from = MAX(
         fellow.created_at,
         COALESCE((
           SELECT MIN(credential.issued_at) FROM fellow_tokens credential
            WHERE credential.fellow_id = fellow.fellow_id
         ), fellow.created_at)
       ))
  ))
  OR
  (NEW.action = 'sponsor-panic'
    AND NEW.effective_at > COALESCE((
      SELECT security.panic_at FROM enrollment_sponsor_security security
       WHERE security.sponsor_id = NEW.sponsor_id
    ), -1))
)
BEGIN
  SELECT RAISE(ABORT, 'lifecycle command is not current');
END;

CREATE TRIGGER fellow_lifecycle_events_no_duplicate_insert
BEFORE INSERT ON fellow_lifecycle_events
WHEN EXISTS (
  SELECT 1 FROM fellow_lifecycle_events existing
   WHERE existing.event_id = NEW.event_id OR existing.request_id = NEW.request_id
)
BEGIN
  SELECT RAISE(ABORT, 'lifecycle event identity already exists');
END;

DROP TRIGGER enrollment_fellows_status_transition;
DROP TRIGGER enrollment_fellows_compromise_revokes_credentials;

CREATE TRIGGER enrollment_fellows_status_transition
BEFORE UPDATE OF status, status_changed_at, status_event_id ON enrollment_fellows
WHEN NEW.status IS NOT OLD.status
 AND NOT EXISTS (
   SELECT 1 FROM fellow_lifecycle_events event
     JOIN sponsors sponsor ON sponsor.sponsor_id = event.sponsor_id
    WHERE event.event_id = NEW.status_event_id
      AND event.action = 'fellow-status-changed'
      AND event.sponsor_id = NEW.sponsor_id
      AND event.sponsor_seq = sponsor.lifecycle_seq + 1
      AND event.fellow_id = NEW.fellow_id
      AND event.from_status = OLD.status
      AND event.to_status = NEW.status
      AND event.effective_at = NEW.status_changed_at
      AND NEW.status_changed_at >= COALESCE(OLD.status_changed_at, OLD.created_at)
 )
BEGIN
  SELECT RAISE(ABORT, 'fellow lifecycle transition lacks event');
END;

CREATE TRIGGER enrollment_fellows_status_evidence_immutable
BEFORE UPDATE OF status_changed_at, status_event_id ON enrollment_fellows
WHEN NEW.status IS OLD.status
 AND (NEW.status_changed_at IS NOT OLD.status_changed_at
   OR NEW.status_event_id IS NOT OLD.status_event_id)
BEGIN
  SELECT RAISE(ABORT, 'fellow lifecycle evidence is immutable');
END;

CREATE TRIGGER enrollment_credentials_revocation_event_update
BEFORE UPDATE OF revoked_at, revocation_event_id ON fellow_tokens
WHEN OLD.revoked_at IS NULL
 AND NOT EXISTS (
   SELECT 1 FROM fellow_lifecycle_events event
    WHERE event.event_id = NEW.revocation_event_id
      AND event.action = 'credential-revoked'
      AND event.sponsor_id = NEW.sponsor_id
      AND event.fellow_id = NEW.fellow_id
      AND event.credential_id = NEW.credential_id
      AND NEW.revoked_at = MAX(event.effective_at, NEW.issued_at, COALESCE(NEW.last_used_at, NEW.issued_at))
 )
BEGIN
  SELECT RAISE(ABORT, 'credential revocation lacks event');
END;

CREATE TRIGGER enrollment_credentials_revocation_event_immutable
BEFORE UPDATE OF revocation_event_id ON fellow_tokens
WHEN OLD.revoked_at IS NOT NULL
 AND NEW.revocation_event_id IS NOT OLD.revocation_event_id
BEGIN
  SELECT RAISE(ABORT, 'credential revocation evidence is immutable');
END;

CREATE TRIGGER enrollment_sponsor_security_schema_insert
BEFORE INSERT ON enrollment_sponsor_security
WHEN typeof(NEW.sponsor_id) <> 'text'
  OR length(NEW.sponsor_id) NOT BETWEEN 5 AND 64
  OR substr(NEW.sponsor_id, 1, 4) <> 'usr_'
  OR substr(NEW.sponsor_id, 5) GLOB '*[^A-Za-z0-9_-]*'
  OR typeof(NEW.panic_at) <> 'integer'
  OR NEW.panic_at NOT BETWEEN 1 AND 9007199254740991
  OR typeof(NEW.updated_at) <> 'integer'
  OR NEW.updated_at <> NEW.panic_at
  OR NOT EXISTS (
    SELECT 1 FROM fellow_lifecycle_events event
     WHERE event.event_id = NEW.panic_event_id
       AND event.action = 'sponsor-panic'
       AND event.sponsor_id = NEW.sponsor_id
       AND event.effective_at = NEW.panic_at
  )
BEGIN
  SELECT RAISE(ABORT, 'sponsor security evidence outside schema');
END;

CREATE TRIGGER enrollment_sponsor_security_schema_update
BEFORE UPDATE ON enrollment_sponsor_security
WHEN typeof(NEW.panic_at) <> 'integer'
  OR NEW.panic_at NOT BETWEEN 1 AND 9007199254740991
  OR typeof(NEW.updated_at) <> 'integer'
  OR NEW.updated_at <> NEW.panic_at
  OR NOT EXISTS (
    SELECT 1 FROM fellow_lifecycle_events event
     WHERE event.event_id = NEW.panic_event_id
       AND event.action = 'sponsor-panic'
       AND event.sponsor_id = NEW.sponsor_id
       AND event.effective_at = NEW.panic_at
  )
BEGIN
  SELECT RAISE(ABORT, 'sponsor security evidence outside schema');
END;

CREATE TRIGGER enrollment_fellow_security_immutable_update
BEFORE UPDATE ON enrollment_fellow_security
BEGIN
  SELECT RAISE(ABORT, 'Fellow family revocation is immutable');
END;

CREATE TRIGGER enrollment_fellow_security_causal_insert
BEFORE INSERT ON enrollment_fellow_security
WHEN EXISTS (
  SELECT 1 FROM enrollment_fellow_security existing
   WHERE existing.fellow_id = NEW.fellow_id OR existing.event_id = NEW.event_id
)
OR NOT EXISTS (
  SELECT 1
    FROM fellow_lifecycle_events event
    JOIN enrollment_fellows fellow ON fellow.fellow_id = event.fellow_id
   WHERE event.event_id = NEW.event_id
     AND event.action = 'fellow-status-changed'
     AND event.sponsor_id = NEW.sponsor_id
     AND event.fellow_id = NEW.fellow_id
     AND event.to_status = NEW.reason
     AND event.to_status IN ('revoked', 'compromised')
     AND event.effective_at = NEW.family_revoked_through
     AND NEW.updated_at = event.effective_at
     AND fellow.sponsor_id = NEW.sponsor_id
     AND fellow.status = event.from_status
)
BEGIN
  SELECT RAISE(ABORT, 'Fellow family revocation lacks event');
END;
CREATE TRIGGER enrollment_fellow_security_immutable_delete
BEFORE DELETE ON enrollment_fellow_security
BEGIN
  SELECT RAISE(ABORT, 'Fellow family revocation cannot be deleted');
END;
CREATE TRIGGER fellow_write_review_windows_immutable_update
BEFORE UPDATE ON fellow_write_review_windows
BEGIN
  SELECT RAISE(ABORT, 'Fellow review window is immutable');
END;
CREATE TRIGGER fellow_write_review_windows_causal_insert
BEFORE INSERT ON fellow_write_review_windows
WHEN EXISTS (
  SELECT 1 FROM fellow_write_review_windows existing
   WHERE existing.fellow_id = NEW.fellow_id OR existing.event_id = NEW.event_id
)
OR NOT EXISTS (
  SELECT 1
    FROM fellow_lifecycle_events event
    JOIN enrollment_fellows fellow ON fellow.fellow_id = event.fellow_id
   WHERE event.event_id = NEW.event_id
     AND event.action = 'fellow-status-changed'
     AND event.sponsor_id = NEW.sponsor_id
     AND event.fellow_id = NEW.fellow_id
     AND event.to_status = 'compromised'
     AND event.review_from = NEW.review_from
     AND event.effective_at = NEW.flagged_at
     AND NEW.state = 'open'
     AND fellow.sponsor_id = NEW.sponsor_id
     AND fellow.status = event.from_status
)
BEGIN
  SELECT RAISE(ABORT, 'Fellow review window lacks event');
END;
CREATE TRIGGER fellow_write_review_windows_immutable_delete
BEFORE DELETE ON fellow_write_review_windows
BEGIN
  SELECT RAISE(ABORT, 'Fellow review window cannot be deleted');
END;

CREATE TRIGGER fellow_lifecycle_events_apply
AFTER INSERT ON fellow_lifecycle_events
BEGIN
  UPDATE fellow_tokens
     SET revoked_at = MAX(NEW.effective_at, issued_at, COALESCE(last_used_at, issued_at)),
         revocation_event_id = NEW.event_id
   WHERE NEW.action = 'credential-revoked'
     AND credential_id = NEW.credential_id
     AND fellow_id = NEW.fellow_id
     AND sponsor_id = NEW.sponsor_id
     AND revoked_at IS NULL;

  INSERT INTO enrollment_fellow_security (
    fellow_id, sponsor_id, family_revoked_through, reason, event_id, updated_at
  )
  SELECT NEW.fellow_id, NEW.sponsor_id, NEW.effective_at, NEW.to_status,
         NEW.event_id, NEW.effective_at
   WHERE NEW.action = 'fellow-status-changed'
     AND NEW.to_status IN ('revoked', 'compromised');

  INSERT INTO fellow_write_review_windows (
    fellow_id, sponsor_id, review_from, flagged_at, event_id, state
  )
  SELECT NEW.fellow_id, NEW.sponsor_id, NEW.review_from, NEW.effective_at,
         NEW.event_id, 'open'
   WHERE NEW.action = 'fellow-status-changed'
     AND NEW.to_status = 'compromised';

  UPDATE enrollment_fellows
     SET status = NEW.to_status,
         status_changed_at = NEW.effective_at,
         status_event_id = NEW.event_id
   WHERE NEW.action = 'fellow-status-changed'
     AND fellow_id = NEW.fellow_id
     AND sponsor_id = NEW.sponsor_id
     AND status = NEW.from_status;

  UPDATE enrollment_sponsor_security
     SET panic_at = NEW.effective_at,
         updated_at = NEW.effective_at,
         panic_event_id = NEW.event_id
   WHERE NEW.action = 'sponsor-panic'
     AND sponsor_id = NEW.sponsor_id;

  INSERT INTO enrollment_sponsor_security (
    sponsor_id, panic_at, updated_at, panic_event_id
  )
  SELECT NEW.sponsor_id, NEW.effective_at, NEW.effective_at, NEW.event_id
   WHERE NEW.action = 'sponsor-panic'
     AND NOT EXISTS (
       SELECT 1 FROM enrollment_sponsor_security security
        WHERE security.sponsor_id = NEW.sponsor_id
     );

  UPDATE sponsors
     SET lifecycle_seq = NEW.sponsor_seq,
         lifecycle_lease_token = NULL,
         lifecycle_lease_expires_at = NULL
   WHERE sponsor_id = NEW.sponsor_id
     AND lifecycle_seq + 1 = NEW.sponsor_seq;
END;

CREATE TRIGGER sponsors_lifecycle_seq_event_bound
BEFORE UPDATE OF lifecycle_seq ON sponsors
WHEN NEW.lifecycle_seq IS NOT OLD.lifecycle_seq
 AND (NEW.lifecycle_seq <> OLD.lifecycle_seq + 1 OR NOT EXISTS (
  SELECT 1 FROM fellow_lifecycle_events event
   WHERE event.sponsor_id = NEW.sponsor_id
     AND event.sponsor_seq = NEW.lifecycle_seq
     AND event.event_id = OLD.lifecycle_lease_token
     AND NEW.lifecycle_lease_token IS NULL
     AND NEW.lifecycle_lease_expires_at IS NULL
))
BEGIN
  SELECT RAISE(ABORT, 'sponsor lifecycle head lacks event');
END;

CREATE TRIGGER sponsors_lifecycle_lease_schema
BEFORE UPDATE OF lifecycle_lease_token, lifecycle_lease_expires_at ON sponsors
WHEN NOT (
  (NEW.lifecycle_lease_token IS NULL AND NEW.lifecycle_lease_expires_at IS NULL)
  OR (
    typeof(NEW.lifecycle_lease_token) = 'text'
    AND length(NEW.lifecycle_lease_token) = 30
    AND substr(NEW.lifecycle_lease_token, 1, 4) = 'LEV-'
    AND substr(NEW.lifecycle_lease_token, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
    AND typeof(NEW.lifecycle_lease_expires_at) = 'integer'
    AND NEW.lifecycle_lease_expires_at BETWEEN 1 AND 9007199254740991
  )
)
BEGIN
  SELECT RAISE(ABORT, 'sponsor lifecycle lease outside schema');
END;

CREATE TRIGGER fellow_lifecycle_events_immutable_update
BEFORE UPDATE ON fellow_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'lifecycle event is immutable');
END;
CREATE TRIGGER fellow_lifecycle_events_immutable_delete
BEFORE DELETE ON fellow_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'lifecycle event cannot be deleted');
END;

-- A sponsor panic invalidates authorization granted before the boundary, not
-- merely bearer rows issued before it. Delayed polling cannot mint a new token
-- from a pre-panic approval.
CREATE TRIGGER enrollment_credentials_post_panic_grant_insert
BEFORE INSERT ON fellow_tokens
WHEN EXISTS (
  SELECT 1
    FROM enrollment_grants grant_row
    JOIN enrollment_sponsor_security security
      ON security.sponsor_id = grant_row.sponsor_id
   WHERE grant_row.fellow_id = NEW.fellow_id
     AND grant_row.sponsor_id = NEW.sponsor_id
     AND grant_row.granted_at <= security.panic_at
)
BEGIN
  SELECT RAISE(ABORT, 'credential grant predates sponsor panic boundary');
END;

-- Approval writes the grant after the proposal transition in one batch. If a
-- sponsor panic linearized first, the whole stale approval batch must roll back
-- instead of manufacturing an approved Fellow whose token can never be issued.
CREATE TRIGGER enrollment_grants_post_panic_insert
BEFORE INSERT ON enrollment_grants
WHEN EXISTS (
  SELECT 1 FROM enrollment_sponsor_security security
   WHERE security.sponsor_id = NEW.sponsor_id
     AND NEW.granted_at <= security.panic_at
)
BEGIN
  SELECT RAISE(ABORT, 'Fellow grant does not follow sponsor panic boundary');
END;

CREATE INDEX fellow_lifecycle_events_sponsor_time_idx
  ON fellow_lifecycle_events (sponsor_id, effective_at DESC, event_id);
CREATE INDEX fellow_lifecycle_events_fellow_time_idx
  ON fellow_lifecycle_events (fellow_id, effective_at DESC, event_id)
  WHERE fellow_id IS NOT NULL;
CREATE INDEX enrollment_fellow_security_sponsor_idx
  ON enrollment_fellow_security (sponsor_id, family_revoked_through, fellow_id);
