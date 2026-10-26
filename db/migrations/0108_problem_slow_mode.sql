-- Fable §9.1 / asimposiumorg-cm5: temporary problem publication limits.
-- The latest immutable control is the authority. Expiry needs no cron, and
-- controls never erase attempts or alter already-admitted publications.
CREATE TABLE problem_slow_mode_events (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) = 29 AND substr(event_id, 1, 3) = 'SM-'
    AND substr(event_id, 4) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('operator', 'sponsor')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK (action IN ('set', 'clear')),
  limit_per_hour INTEGER CHECK (limit_per_hour IS NULL OR (typeof(limit_per_hour) = 'integer' AND limit_per_hour BETWEEN 1 AND 19)),
  expires_at INTEGER CHECK (expires_at IS NULL OR typeof(expires_at) = 'integer'),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 10 AND 1000),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 1 AND 9007199168340991),
  step_up_authenticated_at INTEGER NOT NULL CHECK (typeof(step_up_authenticated_at) = 'integer'
    AND created_at / 1000 - step_up_authenticated_at BETWEEN 0 AND 900),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^a-f0-9]*'),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^a-f0-9]*'),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  UNIQUE (problem_id, revision),
  UNIQUE (problem_id, actor_kind, actor_id, idempotency_key_hash),
  CHECK ((action = 'set' AND limit_per_hour IS NOT NULL AND expires_at IS NOT NULL AND expires_at > created_at
           AND expires_at <= created_at + 86400000)
      OR (action = 'clear' AND limit_per_hour IS NULL AND expires_at IS NULL))
);

CREATE VIEW problem_slow_mode_current AS
SELECT control.* FROM problem_slow_mode_events control
WHERE control.revision = (
  SELECT MAX(latest.revision) FROM problem_slow_mode_events latest
  WHERE latest.problem_id = control.problem_id
);

CREATE TRIGGER problem_slow_mode_current_guard
BEFORE INSERT ON problem_slow_mode_events
WHEN NEW.revision <> COALESCE((SELECT MAX(revision) FROM problem_slow_mode_events
                               WHERE problem_id = NEW.problem_id), 0) + 1
  OR NEW.created_at < COALESCE((SELECT MAX(created_at) FROM problem_slow_mode_events
                                WHERE problem_id = NEW.problem_id), 0)
  OR NOT EXISTS (SELECT 1 FROM problems WHERE id = NEW.problem_id
                   AND status <> 'private-draft' AND public_seq > 0)
  OR (NEW.actor_kind = 'sponsor' AND NOT EXISTS (
    SELECT 1 FROM sponsors sponsor JOIN problems p ON p.id = NEW.problem_id
    WHERE sponsor.sponsor_id = NEW.actor_id AND sponsor.tombstoned_at IS NULL
      AND EXISTS (
        SELECT 1 FROM problem_stewards steward
        WHERE steward.problem_id = p.id AND steward.sponsor_id = sponsor.sponsor_id
      )
  ))
BEGIN
  SELECT RAISE(ABORT, 'SLOW_MODE_CONTROL_NOT_CURRENT');
END;

CREATE TRIGGER problem_slow_mode_append_only_update
BEFORE UPDATE ON problem_slow_mode_events
BEGIN
  SELECT RAISE(ABORT, 'SLOW_MODE_APPEND_ONLY');
END;
CREATE TRIGGER problem_slow_mode_append_only_delete
BEFORE DELETE ON problem_slow_mode_events
BEGIN
  SELECT RAISE(ABORT, 'SLOW_MODE_APPEND_ONLY');
END;

-- Operator history and the control commit together; sponsor controls are
-- attributed in the same immutable per-problem history, never as operators.
CREATE TRIGGER problem_slow_mode_operator_audit
AFTER INSERT ON problem_slow_mode_events
WHEN NEW.actor_kind = 'operator'
BEGIN
  INSERT INTO operator_audit (
    event_id, seq, operator_id, action, target_id, reason,
    before_state_digest, after_state_digest, created_at
  ) VALUES (
    'OA-' || substr(NEW.event_id, 4),
    (SELECT COALESCE(MAX(seq), 0) + 1 FROM operator_audit),
    NEW.actor_id, 'problem.slow-mode.' || NEW.action, NEW.problem_id, NEW.reason,
    NULL, NEW.request_digest, strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at / 1000.0, 'unixepoch')
  );
END;

-- Additive to the existing unconditional 20/hour ceiling. The effective cap
-- is read inside the reservation INSERT, so a policy change or concurrent
-- admission cannot win a preflight race. Every attempt counts, including
-- held/rejected/failed/recovered attempts and all members of a batch.
CREATE TRIGGER public_write_slow_mode_cap_insert
BEFORE INSERT ON public_write_attempt_reservations
WHEN EXISTS (
  SELECT 1 FROM problem_slow_mode_current control
  WHERE control.problem_id = NEW.problem_id AND control.action = 'set'
    AND control.expires_at > NEW.reserved_at
    AND (SELECT COUNT(*) FROM public_write_attempt_reservations attempt
         WHERE attempt.fellow_id = NEW.fellow_id AND attempt.problem_id = NEW.problem_id
           AND attempt.reserved_at > NEW.reserved_at - 3600000) >= control.limit_per_hour
)
BEGIN
  SELECT RAISE(ABORT, 'PROMOTION_RATE_LIMIT_EXCEEDED');
END;
