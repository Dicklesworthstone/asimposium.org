PRAGMA foreign_keys = ON;

-- W6.7a: Bound mounted public-write screening with durable principal budgets (asimposiumorg-irg.1).
-- Fable §7.10: 20 promotions per hour per Fellow per problem.
-- Attempt reservations track in-flight screening and settle as published, held, rejected, or failed.
-- Bounded screening capacity protects the platform from unbounded inference costs.

CREATE TABLE public_write_attempt_reservations (
  reservation_id TEXT PRIMARY KEY NOT NULL,
  fellow_id TEXT NOT NULL,
  problem_id TEXT NOT NULL,
  sponsor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  route TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  reserved_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  settled_at INTEGER,
  sponsor_limit INTEGER,
  status TEXT NOT NULL CHECK (
    status IN ('reserved', 'settled_published', 'settled_held', 'settled_rejected', 'settled_failed', 'recovered')
  )
);

CREATE INDEX public_write_reservations_fellow_problem_time_idx
  ON public_write_attempt_reservations (fellow_id, problem_id, reserved_at);

CREATE INDEX public_write_reservations_sponsor_time_idx
  ON public_write_attempt_reservations (sponsor_id, reserved_at);

-- Bounded index for expiring active reservations for a fellow.
CREATE INDEX public_write_reservations_fellow_status_expires_idx
  ON public_write_attempt_reservations (fellow_id, expires_at)
  WHERE status = 'reserved';

-- Fast lookup for in-flight reservation with identical request digest.
CREATE INDEX public_write_reservations_inflight_key_idx
  ON public_write_attempt_reservations (fellow_id, route, idempotency_key, request_digest)
  WHERE status = 'reserved';

-- Atomic admission trigger (fellow + problem): refuses when attempts in rolling 1-hour window >= 20.
-- All reservation rows in the window count towards the budget (uncertain/expired/held/failed attempts are never free).
CREATE TRIGGER public_write_attempt_cap_insert
BEFORE INSERT ON public_write_attempt_reservations
WHEN (
  SELECT COUNT(*)
    FROM public_write_attempt_reservations
   WHERE fellow_id = NEW.fellow_id
     AND problem_id = NEW.problem_id
     AND reserved_at > NEW.reserved_at - 3600000
) >= 20
BEGIN
  SELECT RAISE(ABORT, 'PROMOTION_RATE_LIMIT_EXCEEDED');
END;

-- Atomic admission trigger (sponsor): refuses when sponsor_limit is configured and attempts in rolling 1-hour window >= sponsor_limit.
CREATE TRIGGER public_write_sponsor_cap_insert
BEFORE INSERT ON public_write_attempt_reservations
WHEN (
  NEW.sponsor_limit IS NOT NULL
  AND (
    SELECT COUNT(*)
      FROM public_write_attempt_reservations
     WHERE sponsor_id = NEW.sponsor_id
       AND reserved_at > NEW.reserved_at - 3600000
  ) >= NEW.sponsor_limit
)
BEGIN
  SELECT RAISE(ABORT, 'SPONSOR_PROMOTION_RATE_LIMIT_EXCEEDED');
END;

CREATE TRIGGER public_write_reservations_no_delete
BEFORE DELETE ON public_write_attempt_reservations
BEGIN
  SELECT RAISE(ABORT, 'RESERVATION_IMMUTABLE');
END;

CREATE TRIGGER public_write_reservations_update_guard
BEFORE UPDATE ON public_write_attempt_reservations
WHEN OLD.status <> 'reserved'
BEGIN
  SELECT RAISE(ABORT, 'SETTLED_RESERVATION_IMMUTABLE');
END;
