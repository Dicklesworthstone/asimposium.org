-- W9.6 / asimposiumorg-mip: private, declinable, exact-version invitations.
-- No event here changes the public cursor, review weight or claim disposition.
CREATE TABLE review_requests (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  claim_id TEXT NOT NULL,
  claim_version INTEGER NOT NULL CHECK (claim_version > 0),
  claim_event_id TEXT NOT NULL REFERENCES events(id),
  claim_payload_sha256 TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  author_sponsor_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  reviewer_sponsor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (author_id <> reviewer_id AND author_sponsor_id <> reviewer_sponsor_id),
  -- Declining cannot be defeated by reissuing the same invitation under a new key.
  UNIQUE (problem_id, claim_id, claim_version, reviewer_id)
);
CREATE INDEX review_requests_author ON review_requests(author_id, problem_id, seq);
CREATE INDEX review_requests_reviewer ON review_requests(reviewer_id, problem_id, seq);
CREATE INDEX review_requests_rate ON review_requests(author_sponsor_id, created_at);
CREATE TABLE review_request_events (
  event_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES review_requests(request_id),
  version INTEGER NOT NULL CHECK (version > 0),
  action TEXT NOT NULL CHECK (action IN ('offer','accept','decline','cancel','complete')),
  actor_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  occurred_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  review_event_id TEXT REFERENCES events(id),
  -- A NULL from a failed transaction-time guard aborts the entire D1 batch.
  guard INTEGER NOT NULL CHECK (guard = 1),
  UNIQUE (request_id, version),
  CHECK ((action = 'complete') = (review_event_id IS NOT NULL))
);
CREATE TABLE review_request_replays (
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_ciphertext TEXT NOT NULL,
  response_initialization_vector TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (fellow_id, idempotency_key)
);
CREATE INDEX review_request_replays_expiry ON review_request_replays(expires_at);

CREATE TRIGGER review_requests_no_update BEFORE UPDATE ON review_requests
BEGIN SELECT RAISE(ABORT, 'REVIEW_REQUEST_IMMUTABLE'); END;
CREATE TRIGGER review_requests_no_delete BEFORE DELETE ON review_requests
BEGIN SELECT RAISE(ABORT, 'REVIEW_REQUEST_IMMUTABLE'); END;
CREATE TRIGGER review_requests_no_replace BEFORE INSERT ON review_requests
WHEN EXISTS (SELECT 1 FROM review_requests WHERE request_id = NEW.request_id)
BEGIN SELECT RAISE(ABORT, 'REVIEW_REQUEST_IMMUTABLE'); END;
CREATE TRIGGER review_request_events_no_update BEFORE UPDATE ON review_request_events
BEGIN SELECT RAISE(ABORT, 'REVIEW_REQUEST_EVENT_IMMUTABLE'); END;
CREATE TRIGGER review_request_events_no_delete BEFORE DELETE ON review_request_events
BEGIN SELECT RAISE(ABORT, 'REVIEW_REQUEST_EVENT_IMMUTABLE'); END;
CREATE TRIGGER review_request_events_no_replace BEFORE INSERT ON review_request_events
WHEN EXISTS (SELECT 1 FROM review_request_events WHERE event_id = NEW.event_id)
BEGIN SELECT RAISE(ABORT, 'REVIEW_REQUEST_EVENT_IMMUTABLE'); END;

CREATE TRIGGER review_request_transition BEFORE INSERT ON review_request_events
WHEN NOT EXISTS (
  SELECT 1 FROM review_requests r WHERE r.request_id = NEW.request_id AND (
    (NEW.action = 'offer' AND NEW.version = 1 AND NEW.actor_id = r.author_id
      AND NEW.occurred_at = r.created_at AND NEW.expires_at = NEW.occurred_at + 172800000
      AND NOT EXISTS (SELECT 1 FROM review_request_events e WHERE e.request_id = r.request_id))
    OR EXISTS (
      SELECT 1 FROM review_request_events previous
      WHERE previous.request_id = r.request_id AND previous.version = NEW.version - 1
        AND previous.version = (SELECT MAX(version) FROM review_request_events WHERE request_id = r.request_id)
        AND NEW.occurred_at >= previous.occurred_at
        AND (
          (NEW.action = 'accept' AND previous.action = 'offer' AND NEW.actor_id = r.reviewer_id
            AND NEW.occurred_at < previous.expires_at AND NEW.expires_at = NEW.occurred_at + 604800000)
          OR (NEW.action = 'decline' AND previous.action IN ('offer','accept') AND NEW.actor_id = r.reviewer_id
            AND NEW.expires_at = previous.expires_at)
          OR (NEW.action = 'cancel' AND previous.action IN ('offer','accept') AND NEW.actor_id = r.author_id
            AND NEW.expires_at = previous.expires_at)
          OR (NEW.action = 'complete' AND previous.action = 'accept' AND NEW.actor_id = r.reviewer_id
            AND NEW.occurred_at < previous.expires_at AND NEW.expires_at = previous.expires_at
            AND EXISTS (SELECT 1 FROM reviews review JOIN events evidence
              ON evidence.id = review.source_event_id AND evidence.problem_id = review.problem_id
              AND evidence.object_id = review.review_id AND evidence.seq = review.source_seq
              AND evidence.type = 'review.created' AND evidence.object_kind = 'review'
              JOIN problems p ON p.id = evidence.problem_id AND evidence.seq <= p.public_seq
              WHERE evidence.id = NEW.review_event_id AND review.problem_id = r.problem_id
                AND review.target_claim_id = r.claim_id AND review.target_version = r.claim_version
                AND evidence.actor_fellow_id = r.reviewer_id AND review.reviewer_fellow_id = r.reviewer_id))
        )
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'REVIEW_REQUEST_TRANSITION_INVALID'); END;
