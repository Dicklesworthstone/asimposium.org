PRAGMA foreign_keys = ON;

-- S-6 service-envelope replay window. The nonce itself is a short-lived
-- credential and is never stored: the Worker stores only its SHA-256 digest.
-- `expires_at` is exclusive, so `expires_at <= now` is eligible for bounded
-- cleanup and a later atomic UPSERT may reclaim the digest.
CREATE TABLE auth_envelope_nonces (
  nonce_hash TEXT PRIMARY KEY
    CHECK (length(nonce_hash) = 64 AND nonce_hash NOT GLOB '*[^0-9a-f]*'),
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  CHECK (expires_at > claimed_at)
);

CREATE INDEX auth_envelope_nonces_expires_idx ON auth_envelope_nonces (expires_at);
