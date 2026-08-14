PRAGMA foreign_keys = ON;

-- S-2's deliberately small Krater nucleus. Later migrations extend this schema
-- to the full Fable §10.3 census; they do not replace its event/projection law.
CREATE TABLE problems (
  id TEXT PRIMARY KEY,
  public_seq INTEGER NOT NULL DEFAULT 0 CHECK (public_seq >= 0),
  chain_digest TEXT NOT NULL,
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
  row_digest TEXT NOT NULL,
  chain_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (problem_id, seq)
);

CREATE TABLE event_content (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  payload_sha256 TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  redacted_at TEXT,
  redaction_reason TEXT
);

-- Event envelopes are permanent facts. Content may later be replaced with a
-- public-safe tombstone, but the original digest and envelope stay available
-- for audit and chain verification.
CREATE TRIGGER events_immutable_before_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'KRATER_EVENT_ENVELOPE_IMMUTABLE');
END;

CREATE TRIGGER events_immutable_before_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'KRATER_EVENT_ENVELOPE_IMMUTABLE');
END;

CREATE TRIGGER event_content_lawful_redaction_only
BEFORE UPDATE ON event_content
WHEN NEW.event_id != OLD.event_id
  OR NEW.payload_sha256 != OLD.payload_sha256
  OR NEW.redacted_at IS NULL
  OR NEW.redaction_reason IS NULL
BEGIN
  SELECT RAISE(ABORT, 'KRATER_CONTENT_REDACTION_INVALID');
END;

-- A write may insert an event only after it has moved the corresponding
-- problem head to the event's sequence and chain digest. This turns a stale
-- application-computed predecessor digest into a transaction abort, not a
-- partial write, so the caller can retry from the durable head.
CREATE TRIGGER events_chain_head_before_insert
BEFORE INSERT ON events
WHEN NOT EXISTS (
  SELECT 1 FROM problems
  WHERE id = NEW.problem_id
    AND public_seq = NEW.seq
    AND chain_digest = NEW.chain_digest
)
BEGIN
  SELECT RAISE(ABORT, 'KRATER_CHAIN_HEAD_MISMATCH');
END;

CREATE TABLE integrity_checkpoints (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  checkpoint_seq INTEGER NOT NULL CHECK (checkpoint_seq > 0),
  root_chain_digest TEXT NOT NULL,
  checkpoint_digest TEXT NOT NULL,
  checkpoint_version INTEGER NOT NULL CHECK (checkpoint_version = 1),
  created_at TEXT NOT NULL,
  signer_key_id TEXT,
  signature TEXT,
  PRIMARY KEY (problem_id, checkpoint_seq),
  CHECK (
    (signer_key_id IS NULL AND signature IS NULL)
    OR (signer_key_id IS NOT NULL AND signature IS NOT NULL)
  )
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
