PRAGMA foreign_keys = ON;

-- W4 session protocol (Fable §7.2). A session is the unit of work: opened on
-- one problem by one Fellow, kept alive by heartbeat, idle-closed by the
-- server, closed with a handback that the next arrival's orient pack serves.
-- Session ids are server-minted; no client-supplied identifier is trusted.
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  intent TEXT CHECK (
    intent IS NULL
    OR intent IN ('prove', 'refute', 'review', 'sharpen-statement', 'explore')
  ),
  opened_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  idle_close_at TEXT NOT NULL,
  closed_at TEXT,
  handback TEXT CHECK (handback IS NULL OR length(handback) BETWEEN 1 AND 2000),
  close_keep_json TEXT CHECK (close_keep_json IS NULL OR json_valid(close_keep_json)),
  close_discard_json TEXT CHECK (close_discard_json IS NULL OR json_valid(close_discard_json)),
  CHECK (closed_at IS NULL OR closed_at >= opened_at)
);
-- One open session per Fellow per problem: a second open against the same
-- problem is SESSION_EXISTS (§7.7), not a second row. The partial index makes
-- the open-state lookup the indexed path instead of a scan.
CREATE UNIQUE INDEX sessions_one_open_per_fellow_problem
  ON sessions (fellow_id, problem_id)
  WHERE closed_at IS NULL;
CREATE INDEX sessions_problem_opened_idx ON sessions (problem_id, opened_at);

-- W4 workshop pushes (§7.4). Private to Fellow + sponsor; the per-(Fellow,
-- problem) workshop_seq is the workshop cursor and is deliberately separate
-- from the per-problem public seq — a workshop push never moves the public
-- cursor, and public readers never consult this table (Rule A2).
CREATE TABLE workshop_objects (
  workshop_id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  workshop_seq INTEGER NOT NULL CHECK (workshop_seq > 0),
  type TEXT NOT NULL CHECK (
    type IN ('note', 'draft', 'computation', 'dead-end', 'friction', 'artifact-ref')
  ),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body_md TEXT NOT NULL CHECK (length(body_md) BETWEEN 1 AND 65536),
  relates_to_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(relates_to_json)),
  -- §7.6: an intent-classifier escape hatch is recorded, never silent.
  force_note INTEGER NOT NULL DEFAULT 0 CHECK (force_note IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (problem_id, fellow_id, workshop_seq)
);
CREATE INDEX workshop_objects_sponsor_view_idx ON workshop_objects (problem_id, fellow_id, workshop_seq);

-- c52's allocation law: one singleton row; the write transaction increments
-- it exactly once per commit that changes an anonymous-visible projection.
-- Workshop pushes, rejected writes, and rolled-back writes never touch it.
CREATE TABLE public_cursor (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  cursor INTEGER NOT NULL CHECK (cursor >= 0)
);
INSERT INTO public_cursor (singleton, cursor) VALUES (1, 0);
