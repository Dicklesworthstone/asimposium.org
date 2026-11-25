-- OPS.7 Minimal transactional email via D1 outbox (bead asimposiumorg-d5x).
--
-- Strict boundary: ONLY four email classes are allowed by the schema itself:
--   1. enrollment_approval  (away-sponsor pending Fellow approval notice)
--   2. security_alert       (credential/panic/suspension alert; transactional)
--   3. moderation_notice    (quarantine/takedown/appeal decision; transactional)
--   4. opt_in_digest        (explicit opt-in periodic digest; honors immediate unsubscribe)
--
-- Never stores raw enrollment fragments, Fellow bearer tokens, authorization codes,
-- private workshop bodies, raw scientific bodies, or policy-detector rules.

CREATE TABLE IF NOT EXISTS email_preferences (
  sponsor_id TEXT PRIMARY KEY,
  notification_email TEXT CHECK (
    notification_email IS NULL OR length(notification_email) BETWEEN 3 AND 254
  ),
  digest_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (digest_opt_in IN (0, 1)),
  digest_unsubscribed_at TEXT,
  unsubscribe_token_hash TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactional_email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  causal_event_id TEXT,
  sponsor_id TEXT NOT NULL,
  recipient_hash TEXT NOT NULL,
  email_class TEXT NOT NULL CHECK (
    email_class IN (
      'enrollment_approval',
      'security_alert',
      'moderation_notice',
      'opt_in_digest'
    )
  ),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  text_body TEXT NOT NULL CHECK (length(text_body) BETWEEN 1 AND 8192),
  html_body TEXT NOT NULL CHECK (length(html_body) BETWEEN 1 AND 16384),
  action_url TEXT NOT NULL CHECK (length(action_url) BETWEEN 1 AND 1024),
  list_unsubscribe_url TEXT CHECK (
    list_unsubscribe_url IS NULL OR length(list_unsubscribe_url) BETWEEN 1 AND 1024
  ),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (
    state IN (
      'pending',
      'delivered',
      'dead_letter',
      'suppressed_unsubscribed',
      'deferred_spend_cap'
    )
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 16),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 16),
  next_retry_at TEXT NOT NULL,
  provider_name TEXT NOT NULL DEFAULT 'resend',
  provider_message_id TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  dead_lettered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_transactional_email_pending
  ON transactional_email_outbox (state, next_retry_at, id);

CREATE INDEX IF NOT EXISTS idx_transactional_email_sponsor
  ON transactional_email_outbox (sponsor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS email_spend_counters (
  month_utc TEXT PRIMARY KEY,
  sent_count INTEGER NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  monthly_cap INTEGER NOT NULL DEFAULT 3000 CHECK (monthly_cap > 0),
  warn_threshold INTEGER NOT NULL DEFAULT 2400 CHECK (warn_threshold >= 0),
  updated_at TEXT NOT NULL
);
