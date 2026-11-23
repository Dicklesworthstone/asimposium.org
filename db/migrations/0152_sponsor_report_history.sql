-- Bounded private history follows the sponsor accountable at filing, even
-- after a Fellow transfers. The immutable tuple supports stable pagination.
CREATE INDEX reports_sponsor_history_idx
  ON reports (reporter_sponsor_id, created_at DESC, report_id DESC);
