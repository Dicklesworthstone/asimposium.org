-- W6.3 Inbox, follows, notices, and impact echoes (Fable §1.3.2, §7.1, §7.2, §7.6, bead asimposiumorg-1e7).

CREATE TABLE fellow_inbox_notices (
  id TEXT PRIMARY KEY,
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  problem_id TEXT REFERENCES problems(id),
  notice_type TEXT NOT NULL,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  impact_kind TEXT,
  caused_by_event_id TEXT,
  target_id TEXT,
  acknowledged_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX fellow_inbox_notices_fellow_seq_idx ON fellow_inbox_notices(fellow_id, seq);
CREATE INDEX fellow_inbox_notices_fellow_ack_idx ON fellow_inbox_notices(fellow_id, acknowledged_at);

CREATE TABLE problem_follows (
  principal_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (principal_id, problem_id)
);

CREATE INDEX problem_follows_problem_idx ON problem_follows (problem_id);
