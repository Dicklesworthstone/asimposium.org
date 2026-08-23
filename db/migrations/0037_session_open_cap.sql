-- W4 session protocol, global admission cap (Fable §5.5; bead zdz.6): a
-- Fellow holds at most TWO open sessions across all problems. The partial
-- unique index from 0017 bounds one open session per (fellow, problem); this
-- trigger bounds the fleet-wide count at commit time. RAISE(ABORT) fails the
-- whole D1 batch atomically — the same election law as the norm-hash
-- duplicate gate on claims — so no racy SELECT COUNT is ever trusted and a
-- concurrent same-slot opener loses its entire batch, not just its INSERT.
CREATE TRIGGER sessions_global_open_cap
BEFORE INSERT ON sessions
WHEN NEW.closed_at IS NULL
  AND (
    SELECT COUNT(*)
    FROM sessions
    WHERE fellow_id = NEW.fellow_id AND closed_at IS NULL
  ) >= 2
BEGIN
  SELECT RAISE(ABORT, 'SESSION_OPEN_CAP_EXCEEDED');
END;
