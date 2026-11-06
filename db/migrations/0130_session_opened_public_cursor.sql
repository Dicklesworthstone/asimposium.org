PRAGMA foreign_keys = ON;

-- Fable §7.1: session context follows committed ledger order. An event's
-- created_at may precede its commit, so timestamps cannot establish which
-- formulation was visible when a session opened. Historical sessions remain
-- NULL: their original ledger cut cannot be reconstructed safely.
ALTER TABLE sessions ADD COLUMN opened_public_cursor INTEGER
  CHECK (opened_public_cursor IS NULL OR
    (typeof(opened_public_cursor) = 'integer' AND
      opened_public_cursor BETWEEN 0 AND 9007199254740991));

CREATE TRIGGER sessions_opened_public_cursor_immutable
BEFORE UPDATE OF opened_public_cursor ON sessions
WHEN NEW.opened_public_cursor IS NOT OLD.opened_public_cursor
BEGIN
  SELECT RAISE(ABORT, 'SESSION_OPENED_PUBLIC_CURSOR_IMMUTABLE');
END;
