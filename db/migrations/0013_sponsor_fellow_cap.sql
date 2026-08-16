PRAGMA foreign_keys = ON;

-- W3.7 sponsor attention cap (asimposiumorg-9p4). `active` Fellows and
-- Fellows in `suspicious_review` both retain live account access, so both
-- consume capacity. Paused and terminal Fellows remain durable history but do
-- not consume an active slot. The operator may raise (or later lower) a
-- sponsor's stored limit, but never below five or below the sponsor's current
-- active count. The 500 ceiling prevents an override from exceeding the
-- current single-response inventory bound by itself. Historical paused and
-- terminal Fellows still require a separately paginated inventory surface.

-- Older Workers did not enforce the five-Fellow default. Do not silently
-- pause or terminalize retained Fellows: those are lifecycle changes that
-- require causal sponsor/operator events. An over-cap sponsor is therefore
-- grandfathered only for its already-live identities. The triggers below
-- refuse every new approval/resume until its live count falls below the
-- stored limit. Per-sponsor raises require a future operator-only command;
-- this migration creates storage, not that authorization surface.

ALTER TABLE sponsors ADD COLUMN active_fellow_limit INTEGER NOT NULL DEFAULT 5
  CHECK (
    typeof(active_fellow_limit) = 'integer'
    AND active_fellow_limit BETWEEN 5 AND 500
  );

CREATE TRIGGER enrollment_fellows_active_cap_insert
BEFORE INSERT ON enrollment_fellows
WHEN NEW.status IN ('active', 'suspicious_review')
 AND (
   SELECT COUNT(*)
     FROM enrollment_fellows existing
    WHERE existing.sponsor_id = NEW.sponsor_id
      AND existing.status IN ('active', 'suspicious_review')
 ) >= COALESCE((
   SELECT sponsor.active_fellow_limit
     FROM sponsors sponsor
    WHERE sponsor.sponsor_id = NEW.sponsor_id
 ), 5)
BEGIN
  SELECT RAISE(ABORT, 'active Fellow cap reached');
END;

CREATE TRIGGER enrollment_fellows_active_cap_transition
BEFORE UPDATE OF status ON enrollment_fellows
WHEN OLD.status NOT IN ('active', 'suspicious_review')
 AND NEW.status IN ('active', 'suspicious_review')
 AND (
   SELECT COUNT(*)
     FROM enrollment_fellows existing
    WHERE existing.sponsor_id = NEW.sponsor_id
      AND existing.status IN ('active', 'suspicious_review')
 ) >= COALESCE((
   SELECT sponsor.active_fellow_limit
     FROM sponsors sponsor
    WHERE sponsor.sponsor_id = NEW.sponsor_id
 ), 5)
BEGIN
  SELECT RAISE(ABORT, 'active Fellow cap reached');
END;

CREATE TRIGGER sponsors_active_fellow_limit_guard
BEFORE UPDATE OF active_fellow_limit ON sponsors
WHEN NEW.active_fellow_limit < (
  SELECT COUNT(*)
    FROM enrollment_fellows fellow
   WHERE fellow.sponsor_id = NEW.sponsor_id
     AND fellow.status IN ('active', 'suspicious_review')
)
BEGIN
  SELECT RAISE(ABORT, 'active Fellow limit is below current use');
END;
