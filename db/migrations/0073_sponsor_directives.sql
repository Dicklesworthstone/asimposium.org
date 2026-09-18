-- Sponsor -> own Fellow directives are private instruction, not scientific ledger
-- content. Delivery and sponsor-visible acknowledgment share the existing inbox.
CREATE TABLE sponsor_directives (
  id TEXT PRIMARY KEY,
  sponsor_id TEXT NOT NULL,
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  problem_id TEXT REFERENCES problems(id),
  verb TEXT NOT NULL CHECK (verb IN ('focus','forbid','unfocus')),
  body TEXT CHECK (
    (verb = 'unfocus' AND body IS NULL) OR
    (verb IN ('focus','forbid') AND length(trim(body)) BETWEEN 1 AND 500)
  ),
  notice_id TEXT NOT NULL UNIQUE REFERENCES fellow_inbox_notices(id),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^a-f0-9]*'
  ),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  UNIQUE (sponsor_id, idempotency_key)
);
CREATE INDEX sponsor_directives_fellow_created_idx
  ON sponsor_directives(fellow_id, created_at DESC);

CREATE TRIGGER sponsor_directives_no_update
BEFORE UPDATE ON sponsor_directives BEGIN
  SELECT RAISE(ABORT, 'SPONSOR_DIRECTIVE_IMMUTABLE');
END;
CREATE TRIGGER sponsor_directives_no_delete
BEFORE DELETE ON sponsor_directives BEGIN
  SELECT RAISE(ABORT, 'SPONSOR_DIRECTIVE_IMMUTABLE');
END;
