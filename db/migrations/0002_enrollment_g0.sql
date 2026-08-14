PRAGMA foreign_keys = ON;

-- S-1 / Propylon enrollment state. Every credential-shaped value is a
-- SHA-256 hash; plaintext join secrets, flow handles, and Fellow tokens have
-- no column in D1.
CREATE TABLE enrollment_records (
  enrollment_id TEXT PRIMARY KEY,
  sponsor_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  secret_expires_at INTEGER NOT NULL,
  requested_scopes_json TEXT NOT NULL CHECK (json_valid(requested_scopes_json)),
  requested_resources_json TEXT NOT NULL CHECK (json_valid(requested_resources_json)),
  invalidated INTEGER NOT NULL DEFAULT 0 CHECK (invalidated IN (0, 1)),
  secret_consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE enrollment_proposals (
  proposal_id TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL UNIQUE REFERENCES enrollment_records(enrollment_id),
  fellow_id TEXT NOT NULL UNIQUE,
  flow_handle_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  harness TEXT NOT NULL,
  reasoning_effort TEXT,
  tools_note TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'reduced', 'denied', 'expired')),
  granted_scopes_json TEXT CHECK (granted_scopes_json IS NULL OR json_valid(granted_scopes_json)),
  granted_resources_json TEXT CHECK (granted_resources_json IS NULL OR json_valid(granted_resources_json)),
  token_hash TEXT UNIQUE,
  token_issued_at INTEGER,
  poll_interval_seconds INTEGER NOT NULL CHECK (poll_interval_seconds BETWEEN 5 AND 30),
  last_poll_at INTEGER
);

-- A Fellow identity is reserved atomically with approve/reduce, before a
-- one-time device token is issued. This makes same-name approval races a D1
-- constraint rather than an application convention.
CREATE TABLE enrollment_fellows (
  fellow_id TEXT PRIMARY KEY,
  sponsor_id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  model TEXT NOT NULL,
  harness TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Approval writes this immutable grant binding in the same D1 batch that
-- reserves the Fellow name. A credential remains absent until the Fellow wins
-- the one-time device-token poll; approval itself never manufactures a token.
CREATE TABLE enrollment_grants (
  proposal_id TEXT PRIMARY KEY REFERENCES enrollment_proposals(proposal_id),
  fellow_id TEXT NOT NULL UNIQUE REFERENCES enrollment_fellows(fellow_id),
  sponsor_id TEXT NOT NULL,
  granted_scopes_json TEXT NOT NULL CHECK (json_valid(granted_scopes_json)),
  granted_resources_json TEXT NOT NULL CHECK (json_valid(granted_resources_json)),
  granted_at INTEGER NOT NULL
);

CREATE TABLE enrollment_credentials (
  credential_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES enrollment_proposals(proposal_id),
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  sponsor_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  granted_scopes_json TEXT NOT NULL CHECK (json_valid(granted_scopes_json)),
  granted_resources_json TEXT NOT NULL CHECK (json_valid(granted_resources_json)),
  issued_at INTEGER NOT NULL
);

CREATE TABLE enrollment_idempotency (
  scope TEXT NOT NULL CHECK (scope IN ('mint', 'claim', 'decision', 'poll')),
  principal_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_ciphertext TEXT NOT NULL,
  response_initialization_vector TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, principal_scope, idempotency_key)
);

CREATE INDEX enrollment_records_sponsor_idx ON enrollment_records (sponsor_id, secret_expires_at);
CREATE INDEX enrollment_proposals_status_idx ON enrollment_proposals (status, expires_at);
CREATE INDEX enrollment_grants_fellow_idx ON enrollment_grants (fellow_id);
CREATE INDEX enrollment_credentials_token_idx ON enrollment_credentials (token_hash);
