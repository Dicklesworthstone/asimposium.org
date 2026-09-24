-- 0079: Ed25519 signatures over integrity checkpoints (Fable §10 / ADR-23,
-- bead asimposiumorg-10lz).
--
-- integrity_checkpoints stays `unsigned-v0`: its digest proves the chain is
-- self-consistent. A row here adds authenticity: an Ed25519 signature, by the
-- key named in key_id, over the canonical message
--   asimposium.checkpoint.v1\n{problem_id}\n{checkpoint_seq}\n{root_chain_digest}\n{checkpoint_digest}
-- Signatures are append-only; a key rotation adds rows under the new key id.

CREATE TABLE checkpoint_signatures (
  problem_id TEXT NOT NULL,
  checkpoint_seq INTEGER NOT NULL CHECK (checkpoint_seq > 0),
  key_id TEXT NOT NULL CHECK (length(key_id) BETWEEN 1 AND 64),
  algorithm TEXT NOT NULL CHECK (algorithm = 'Ed25519'),
  signature TEXT NOT NULL CHECK (length(signature) = 128 AND signature NOT GLOB '*[^0-9a-f]*'),
  signed_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, checkpoint_seq, key_id),
  FOREIGN KEY (problem_id, checkpoint_seq)
    REFERENCES integrity_checkpoints(problem_id, checkpoint_seq)
);

CREATE TRIGGER checkpoint_signatures_immutable_before_update
BEFORE UPDATE ON checkpoint_signatures
BEGIN
  SELECT RAISE(ABORT, 'checkpoint signatures are append-only');
END;

CREATE TRIGGER checkpoint_signatures_immutable_before_delete
BEFORE DELETE ON checkpoint_signatures
BEGIN
  SELECT RAISE(ABORT, 'checkpoint signatures are append-only');
END;
