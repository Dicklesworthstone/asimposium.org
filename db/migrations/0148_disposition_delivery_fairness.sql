-- Fair retry and dependent-fanout scheduling (Fable §7.1, asimposiumorg-1e7).
-- The delivery cursor and original enqueue time remain unchanged. Pending
-- causes are selected by their last attempted turn so one unavailable source
-- or a large dependency tree cannot permanently occupy the first batch.
-- Keep the original enqueue index for historical/operational readers.
CREATE INDEX disposition_change_deliveries_fair_pending_idx
  ON disposition_change_deliveries (updated_at, event_id) WHERE state = 'pending';
