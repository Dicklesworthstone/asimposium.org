-- Fable §7.10: workshop admission is 60 attempts/minute/Fellow, shared by
-- creates, revisions and every session. Reserve before a private R2 write.
-- Retain at most 60 rows per Fellow; each admission removes only expired
-- counters in the same atomic D1 batch. These are counters, not ledger events.
-- Completed 24h receipts remain in session_write_replays; this short-lived
-- key also prevents simultaneous copies from buying the same R2 work twice.
CREATE TABLE workshop_write_attempts (
  fellow_id TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL CHECK(length(idempotency_key_hash) = 64),
  request_digest TEXT NOT NULL,
  admitted_at INTEGER NOT NULL CHECK(admitted_at > 0),
  PRIMARY KEY (fellow_id, idempotency_key_hash)
);

CREATE INDEX workshop_write_attempts_fellow_time
  ON workshop_write_attempts (fellow_id, admitted_at);

CREATE TRIGGER workshop_write_attempts_capacity
BEFORE INSERT ON workshop_write_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM workshop_write_attempts
  WHERE fellow_id = NEW.fellow_id AND idempotency_key_hash = NEW.idempotency_key_hash
) AND (
  SELECT COUNT(*) FROM workshop_write_attempts WHERE fellow_id = NEW.fellow_id
) >= 60
BEGIN
  SELECT RAISE(ABORT, 'WORKSHOP_RATE_LIMITED');
END;
