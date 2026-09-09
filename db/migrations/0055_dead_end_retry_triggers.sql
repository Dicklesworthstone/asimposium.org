-- asimposium:allow-destructive
-- Migration 0055: dead_end_fired_triggers
-- Tracks fired structured retry_when triggers on dead ends (Fable §6.1, §9.4).
-- Once fired, a trigger stays fired (PRIMARY KEY ensures exactly-once firing).

CREATE TABLE dead_end_fired_triggers (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  dead_end_id TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  event_id TEXT,
  reason TEXT NOT NULL,
  fired_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, dead_end_id)
);

CREATE INDEX dead_end_fired_triggers_problem_idx ON dead_end_fired_triggers (problem_id, fired_at);
