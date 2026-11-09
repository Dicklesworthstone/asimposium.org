-- Fable §7.1 / §14.3: a lost moderation response must be recoverable without
-- applying a second decision. Receipts commit with their immutable audit row.
-- Only hashes and the public-safe success shape are retained here; private
-- review reasons and held content remain in their existing restricted stores.
CREATE TABLE operator_command_receipts (
  operator_id TEXT NOT NULL CHECK (length(operator_id) BETWEEN 1 AND 128),
  key_digest TEXT NOT NULL CHECK (length(key_digest) = 64 AND key_digest NOT GLOB '*[^a-f0-9]*'),
  operation TEXT NOT NULL CHECK (operation IN ('quarantine', 'report', 'content-control')),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^a-f0-9]*'),
  audit_event_id TEXT NOT NULL UNIQUE REFERENCES operator_audit(event_id),
  receipt_json TEXT NOT NULL CHECK (length(receipt_json) <= 4096 AND json_valid(receipt_json)
    AND json_extract(receipt_json, '$.ok') IS 1
    AND json_extract(receipt_json, '$.audit_event_id') IS audit_event_id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (operator_id, key_digest)
);

CREATE TRIGGER operator_command_receipt_audit_guard
BEFORE INSERT ON operator_command_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM operator_audit audit WHERE audit.event_id = NEW.audit_event_id
    AND audit.operator_id = NEW.operator_id AND audit.created_at = NEW.created_at
    AND ((NEW.operation = 'quarantine' AND audit.action IN ('quarantine.release', 'quarantine.confirm_rejection'))
      OR (NEW.operation = 'report' AND audit.action IN ('report.dismiss', 'report.uphold'))
      OR (NEW.operation = 'content-control' AND audit.action IN ('content.hide', 'content.restore')))
)
BEGIN
  SELECT RAISE(ABORT, 'OPERATOR_COMMAND_AUDIT_MISMATCH');
END;

CREATE TRIGGER operator_command_receipts_append_only_update
BEFORE UPDATE ON operator_command_receipts
BEGIN
  SELECT RAISE(ABORT, 'OPERATOR_COMMAND_RECEIPT_APPEND_ONLY');
END;
CREATE TRIGGER operator_command_receipts_append_only_delete
BEFORE DELETE ON operator_command_receipts
BEGIN
  SELECT RAISE(ABORT, 'OPERATOR_COMMAND_RECEIPT_APPEND_ONLY');
END;
