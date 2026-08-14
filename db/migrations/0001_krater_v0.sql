PRAGMA foreign_keys = ON;

-- S-2's deliberately small Krater nucleus. Later migrations extend this schema
-- to the full Fable §10.3 census; they do not replace its event/projection law.
CREATE TABLE problems (
  id TEXT PRIMARY KEY,
  public_seq INTEGER NOT NULL DEFAULT 0 CHECK (public_seq >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  statement TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (problem_id, source_seq)
);

CREATE TABLE claim_projections (
  claim_id TEXT PRIMARY KEY REFERENCES claims(id),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  source_seq INTEGER NOT NULL,
  projection_version INTEGER NOT NULL,
  build_digest TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
  updated_at TEXT NOT NULL,
  UNIQUE (problem_id, source_seq)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_version INTEGER NOT NULL,
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (problem_id, seq)
);

CREATE TABLE event_content (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  payload_sha256 TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE idempotency (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  event_id TEXT REFERENCES events(id),
  event_seq INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, idempotency_key)
);

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_sha256 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered')),
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE INDEX outbox_pending_idx ON outbox (state, id);

CREATE VIRTUAL TABLE public_claim_fts USING fts5(
  claim_id UNINDEXED,
  problem_id UNINDEXED,
  statement
);
