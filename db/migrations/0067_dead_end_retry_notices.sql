-- Fable §1.3.2 / §7.6: a recorded retry trigger is actionable private feedback,
-- not a leaderboard entry or evidence that the failed approach now succeeds.
CREATE INDEX fellow_inbox_notices_cause_idx ON fellow_inbox_notices
  (fellow_id, problem_id, caused_by_event_id, notice_type, target_id, impact_kind);

-- Review delivery should resolve one claim author, not scan every Fellow.
CREATE INDEX events_inbox_claim_author_idx ON events (problem_id, object_id, seq)
  WHERE type = 'claim.created' AND object_kind = 'claim' AND object_version = 1;

-- Unlike revision fan-out, each fired trigger has one immutable author. Keep
-- its one notice in the SAME transaction as prepareDeadEndTriggers' verified
-- trigger insertion. Its existing (problem_id, dead_end_id) key owns replay.
-- No retrospective condition evaluation or historical notification backfill.
CREATE TRIGGER dead_end_retry_notice_after_insert
AFTER INSERT ON dead_end_fired_triggers
BEGIN
  INSERT INTO fellow_inbox_notices (
    id, fellow_id, problem_id, notice_type, seq, title, detail, impact_kind,
    caused_by_event_id, target_id, acknowledged_at, expires_at, created_at
  )
  SELECT lower(hex(randomblob(32))), author.actor_fellow_id, NEW.problem_id,
    'impact_echo',
    (SELECT CASE WHEN COALESCE(MAX(n.seq), 0) < 9007199254740991
      THEN COALESCE(MAX(n.seq), 0) + 1 ELSE NULL END
     FROM fellow_inbox_notices n WHERE n.fellow_id = author.actor_fellow_id),
    'Retry condition fired for ' || NEW.dead_end_id,
    'Read the negative-evidence ledger and current problem state before trying again. A fired condition is not proof that the old approach works.',
    'retry_trigger_fired', cause.id, NEW.dead_end_id, NULL, NULL,
    CAST(unixepoch(cause.created_at, 'subsec') * 1000 AS INTEGER)
  FROM dead_ends d
  JOIN problems p ON p.id = d.problem_id AND p.status <> 'private-draft'
  JOIN events author ON author.problem_id = d.problem_id AND author.seq = d.seq
    AND author.type = 'dead_end.recorded' AND author.object_kind = 'dead_end'
    AND author.object_id = d.dead_end_id AND author.actor_fellow_id = d.author_fellow_id
  JOIN enrollment_fellows f ON f.fellow_id = author.actor_fellow_id
  JOIN event_content content ON content.event_id = author.id
    AND content.payload_sha256 = author.payload_sha256 AND content.redacted_at IS NULL
  JOIN events cause ON cause.id = NEW.event_id AND cause.problem_id = d.problem_id
    AND cause.seq > author.seq
  JOIN event_content cause_content ON cause_content.event_id = cause.id
    AND cause_content.payload_sha256 = cause.payload_sha256 AND cause_content.redacted_at IS NULL
  WHERE d.problem_id = NEW.problem_id AND d.dead_end_id = NEW.dead_end_id
    AND d.superseded_by IS NULL
    AND length(NEW.dead_end_id) BETWEEN 1 AND 80 AND length(cause.id) BETWEEN 1 AND 80
    AND strftime('%Y-%m-%dT%H:%M:%fZ', cause.created_at) = cause.created_at
    AND json_extract(CASE WHEN json_valid(content.payload_json)
      THEN content.payload_json ELSE '{}' END, '$.retry_when.kind') = NEW.trigger_kind
    AND (
      (NEW.trigger_kind = 'statement-revised' AND cause.type = 'problem.statement-revised')
      OR (NEW.trigger_kind = 'gap-closed' AND cause.type = 'gap.closed-by')
      OR (NEW.trigger_kind = 'claim-reaches' AND cause.type IN
        ('claim.revised', 'review.created', 'evidence.created', 'object.retracted'))
    )
    AND NOT EXISTS (SELECT 1 FROM fellow_inbox_notices n
      WHERE n.fellow_id = author.actor_fellow_id AND n.problem_id = NEW.problem_id
        AND n.notice_type = 'impact_echo' AND n.impact_kind = 'retry_trigger_fired'
        AND n.caused_by_event_id = cause.id AND n.target_id = NEW.dead_end_id)
  ON CONFLICT (id) DO NOTHING;
END;
