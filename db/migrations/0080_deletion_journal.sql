-- 0080: persisted deletion journal (Fable §10 W2.8 deletion-safe restore,
-- beads asimposiumorg-p4b / asimposiumorg-10lz).
--
-- Every private-data deletion appends one retention-control record here IN
-- THE SAME D1 BATCH as the deletion, so a committed deletion always has its
-- journal row. A point-in-time restore rolls this table back together with
-- the data, so the cron also publishes the whole journal, Ed25519-signed, to
-- the private R2 bucket under journal/deletion/v1/. Restore fetches the newest
-- signed copy, verifies it, and reapplies every control before cutover.
--
-- record_json is the exact RetentionControlRecord JSON (control_digest covers
-- action, control_id, issued_at, payload, target_id and target_type).
-- Rows are append-only.

CREATE TABLE deletion_journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  control_id TEXT NOT NULL UNIQUE CHECK (control_id GLOB 'RC-*'),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
  target_type TEXT NOT NULL CHECK (length(target_type) BETWEEN 1 AND 64),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 128),
  control_digest TEXT NOT NULL CHECK (length(control_digest) = 64 AND control_digest NOT GLOB '*[^0-9a-f]*'),
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  created_at TEXT NOT NULL
);

CREATE TRIGGER deletion_journal_immutable_before_update
BEFORE UPDATE ON deletion_journal
BEGIN
  SELECT RAISE(ABORT, 'deletion journal is append-only');
END;

CREATE TRIGGER deletion_journal_immutable_before_delete
BEFORE DELETE ON deletion_journal
BEGIN
  SELECT RAISE(ABORT, 'deletion journal is append-only');
END;
