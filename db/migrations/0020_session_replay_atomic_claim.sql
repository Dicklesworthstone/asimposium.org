PRAGMA foreign_keys = ON;

-- A replay row is also the transaction-local ownership claim for its write.
-- Existing 0018 rows remain valid exact replays with a NULL token; every new
-- session write supplies a random token and conditions its side effects on the
-- exact row it inserted in the same D1 batch. A racing same-key writer sees the
-- winner's row but cannot execute the winner's side effects.
ALTER TABLE session_write_replays ADD COLUMN claim_token TEXT;

CREATE UNIQUE INDEX session_write_replays_claim_token_idx
  ON session_write_replays (claim_token)
  WHERE claim_token IS NOT NULL;
