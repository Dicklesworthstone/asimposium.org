PRAGMA foreign_keys = ON;

-- asimposium:allow-destructive
-- W3.7 operator Fellow-cap override (asimposiumorg-9p4).
--
-- 0013 deliberately provided only the stored cap and capacity guards. This
-- migration makes an append-only audit row the only authority for changing a
-- cap: the row compares the observed cap, advances one dedicated per-sponsor
-- sequence, and applies its exact transition in the same transaction. A later
-- raw sponsor UPDATE cannot borrow an old audit row because its sequence and
-- prior/new values must be the unique next transition from the current row.

-- 0012 rebuilt this table to add lifecycle command scopes. The operator command
-- also has a stable 24-hour replay receipt, so extend that closed vocabulary in
-- the same forward migration rather than letting its otherwise-atomic batch
-- fail its CHECK after the audit insert. The rebuild copies every existing row
-- before the old table is dropped; protected targets still reject it.
CREATE TABLE enrollment_idempotency_with_operator_fellow_cap (
  scope TEXT NOT NULL CHECK (scope IN (
    'mint', 'claim', 'decision', 'poll', 'device-start',
    'credential-revoke', 'fellow-lifecycle', 'sponsor-panic',
    'operator-fellow-cap'
  )),
  principal_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_ciphertext TEXT NOT NULL,
  response_initialization_vector TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, principal_scope, idempotency_key)
);

INSERT INTO enrollment_idempotency_with_operator_fellow_cap (
  scope, principal_scope, idempotency_key, request_digest,
  response_ciphertext, response_initialization_vector, expires_at
)
SELECT scope, principal_scope, idempotency_key, request_digest,
       response_ciphertext, response_initialization_vector, expires_at
  FROM enrollment_idempotency;

DROP TABLE enrollment_idempotency;
ALTER TABLE enrollment_idempotency_with_operator_fellow_cap RENAME TO enrollment_idempotency;

ALTER TABLE sponsors ADD COLUMN fellow_cap_seq INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(fellow_cap_seq) = 'integer' AND fellow_cap_seq BETWEEN 0 AND 9007199254740991);

-- A new sponsor begins at the public baseline. Without this trigger, a raw
-- INSERT could smuggle a 500/42 state past the audited transition path before
-- its first Fellow or operator command exists.
CREATE TRIGGER sponsors_fellow_cap_initial_state
BEFORE INSERT ON sponsors
WHEN NEW.active_fellow_limit IS NOT 5 OR NEW.fellow_cap_seq IS NOT 0
BEGIN
  SELECT RAISE(ABORT, 'new sponsor Fellow-cap state must be 5/0');
END;

CREATE TABLE sponsor_fellow_cap_audit_events (
  audit_event_id TEXT PRIMARY KEY,
  sponsor_id TEXT NOT NULL REFERENCES sponsors(sponsor_id),
  operator_id TEXT NOT NULL,
  sponsor_seq INTEGER NOT NULL,
  previous_active_fellow_limit INTEGER NOT NULL,
  active_fellow_limit INTEGER NOT NULL,
  reason TEXT NOT NULL,
  step_up_authenticated_at INTEGER NOT NULL,
  signer_kid TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  UNIQUE (sponsor_id, sponsor_seq),
  CHECK (
    typeof(audit_event_id) = 'text'
    AND instr(audit_event_id, char(0)) = 0
    AND length(CAST(audit_event_id AS BLOB)) = 30
    AND substr(audit_event_id, 1, 4) = 'OFC-'
    AND substr(audit_event_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  CHECK (typeof(sponsor_seq) = 'integer' AND sponsor_seq BETWEEN 1 AND 9007199254740991),
  CHECK (
    typeof(sponsor_id) = 'text'
    AND instr(sponsor_id, char(0)) = 0
    AND length(CAST(sponsor_id AS BLOB)) BETWEEN 5 AND 64
    AND substr(sponsor_id, 1, 4) = 'usr_'
    AND substr(sponsor_id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  CHECK (
    typeof(operator_id) = 'text'
    AND instr(operator_id, char(0)) = 0
    AND length(CAST(operator_id AS BLOB)) BETWEEN 5 AND 64
    AND substr(operator_id, 1, 4) = 'usr_'
    AND substr(operator_id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  CHECK (
    typeof(previous_active_fellow_limit) = 'integer'
    AND previous_active_fellow_limit BETWEEN 5 AND 500
  ),
  CHECK (
    typeof(active_fellow_limit) = 'integer'
    AND active_fellow_limit BETWEEN 5 AND 500
    AND active_fellow_limit <> previous_active_fellow_limit
  ),
  -- SQLite length() counts Unicode code points. The contract uses the same
  -- metric and rejects exactly the same ECMAScript-whitespace boundaries;
  -- keep raw-SQL audit receipts normalized rather than silently trimming them.
  CHECK (
    typeof(reason) = 'text'
    AND instr(reason, char(0)) = 0
    AND length(reason) BETWEEN 10 AND 1000
    AND substr(reason, 1, 1) NOT IN (
      char(9), char(10), char(11), char(12), char(13), char(32), char(160),
      char(5760), char(8192), char(8193), char(8194), char(8195), char(8196),
      char(8197), char(8198), char(8199), char(8200), char(8201), char(8202),
      char(8232), char(8233), char(8239), char(8287), char(12288), char(65279)
    )
    AND substr(reason, -1, 1) NOT IN (
      char(9), char(10), char(11), char(12), char(13), char(32), char(160),
      char(5760), char(8192), char(8193), char(8194), char(8195), char(8196),
      char(8197), char(8198), char(8199), char(8200), char(8201), char(8202),
      char(8232), char(8233), char(8239), char(8287), char(12288), char(65279)
    )
  ),
  CHECK (
    typeof(step_up_authenticated_at) = 'integer'
    AND step_up_authenticated_at BETWEEN 0 AND 9007199254740991
  ),
  CHECK (
    typeof(signer_kid) = 'text'
    AND instr(signer_kid, char(0)) = 0
    AND length(CAST(signer_kid AS BLOB)) BETWEEN 1 AND 64
    AND signer_kid NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  CHECK (
    typeof(request_id) = 'text'
    AND instr(request_id, char(0)) = 0
    AND length(CAST(request_id AS BLOB)) = 64
    AND request_id NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 1 AND 9007199254740991)
);

CREATE INDEX sponsor_fellow_cap_audit_events_sponsor_created_idx
  ON sponsor_fellow_cap_audit_events (sponsor_id, created_at DESC, audit_event_id ASC);

-- Operator history is causal rather than wall-clock ordered: identical audit
-- timestamps cannot make a keyset continuation skip or duplicate a receipt.
CREATE INDEX sponsor_fellow_cap_audit_events_sponsor_seq_idx
  ON sponsor_fellow_cap_audit_events (sponsor_id, sponsor_seq DESC);

-- The event itself is the compare-and-set: an insert may name only the current
-- cap and the immediate next per-sponsor sequence. This runs before the event
-- exists, while the AFTER trigger below can then see the now-durable event.
CREATE TRIGGER sponsor_fellow_cap_audit_validate
BEFORE INSERT ON sponsor_fellow_cap_audit_events
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM sponsors sponsor
     WHERE sponsor.sponsor_id = NEW.sponsor_id
       AND sponsor.active_fellow_limit = NEW.previous_active_fellow_limit
       AND sponsor.fellow_cap_seq + 1 = NEW.sponsor_seq
  ) THEN RAISE(ABORT, 'operator Fellow-cap audit is stale') END;
END;

-- Guard both columns, including a raw sequence-only or cap-only update. The
-- exact audit row must be the next state transition from OLD to NEW; an old row
-- is therefore never reusable as a permit. The audit INSERT below is lawful
-- because its AFTER trigger observes that exact just-inserted row.
CREATE TRIGGER sponsors_fellow_cap_transition_requires_audit
BEFORE UPDATE OF active_fellow_limit, fellow_cap_seq ON sponsors
WHEN NEW.active_fellow_limit = OLD.active_fellow_limit
  OR NEW.fellow_cap_seq <> OLD.fellow_cap_seq + 1
  OR NOT EXISTS (
    SELECT 1 FROM sponsor_fellow_cap_audit_events event
     WHERE event.sponsor_id = NEW.sponsor_id
       AND event.sponsor_seq = NEW.fellow_cap_seq
       AND event.previous_active_fellow_limit = OLD.active_fellow_limit
       AND event.active_fellow_limit = NEW.active_fellow_limit
  )
BEGIN
  SELECT RAISE(ABORT, 'Fellow-cap transition requires immutable operator audit');
END;

CREATE TRIGGER sponsor_fellow_cap_audit_apply
AFTER INSERT ON sponsor_fellow_cap_audit_events
BEGIN
  UPDATE sponsors
     SET active_fellow_limit = NEW.active_fellow_limit,
         fellow_cap_seq = NEW.sponsor_seq
   WHERE sponsor_id = NEW.sponsor_id
     AND active_fellow_limit = NEW.previous_active_fellow_limit
     AND fellow_cap_seq + 1 = NEW.sponsor_seq;
END;

CREATE TRIGGER sponsor_fellow_cap_audit_events_immutable_update
BEFORE UPDATE ON sponsor_fellow_cap_audit_events
BEGIN
  SELECT RAISE(ABORT, 'operator Fellow-cap audit events are immutable');
END;

CREATE TRIGGER sponsor_fellow_cap_audit_events_immutable_delete
BEFORE DELETE ON sponsor_fellow_cap_audit_events
BEGIN
  SELECT RAISE(ABORT, 'operator Fellow-cap audit events cannot be deleted');
END;
