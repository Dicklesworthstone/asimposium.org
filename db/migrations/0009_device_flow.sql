PRAGMA foreign_keys = ON;

-- W3.5 (asimposiumorg-xdy): the proposal-carrying device-code path.
--
-- enrollment_records gains a kind. Device enrollments carry sponsor_id = ''
-- until a sponsor's decision binds them; the first decider wins. Join-URL
-- enrollments keep their mint-time sponsor, so the decision path's ownership
-- check is unchanged for them.

ALTER TABLE enrollment_records ADD COLUMN kind TEXT NOT NULL DEFAULT 'join-url';

-- The device_code itself is the proposal's flow_handle (one credential, one
-- poll law); this table maps only the human-typed user_code to its flow.
CREATE TABLE device_codes (
  enrollment_id TEXT PRIMARY KEY REFERENCES enrollment_records(enrollment_id),
  user_code_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Brute-force protection for user_code entry: failed lookups are recorded
-- per sponsor and five failures inside the lockout window refuse further
-- attempts until it lapses.
CREATE TABLE device_lookup_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sponsor_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0, 1))
);
CREATE INDEX device_lookup_attempts_sponsor_time
  ON device_lookup_attempts (sponsor_id, attempted_at);
