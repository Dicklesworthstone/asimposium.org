-- Fable §7.10: one shared rolling-minute budget for authenticated orientation
-- reads. Keep at most 120 timestamps in one bounded row per Fellow, independent
-- of credentials, sessions, profiles, response format and conditional requests.
-- These counters are operational state, never public ledger events.
CREATE TABLE fellow_read_windows (
  fellow_id TEXT PRIMARY KEY NOT NULL,
  admitted_at_json TEXT NOT NULL
    CHECK (json_valid(admitted_at_json)
      AND json_type(admitted_at_json) = 'array'
      AND json_array_length(admitted_at_json) BETWEEN 1 AND 120
      AND length(admitted_at_json) <= 2161)
);
