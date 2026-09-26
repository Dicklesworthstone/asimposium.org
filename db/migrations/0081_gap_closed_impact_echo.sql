-- 0081: gap_closed impact echo (Fable §1.3.2 / §7.6, bead asimposiumorg-1e7).
--
-- When another Fellow discharges a proof gap, the Fellow who filed it gets one
-- private, unranked notice that points back at the ledger. It is not a
-- ranking, a score or evidence that the closing reference is correct.
--
-- The gap transition updates proof_gaps before it appends the gap.closed-by
-- event in the same D1 batch, so this trigger fires on the event and reads the
-- already-closed gap. The notice commits or rolls back with the write. Its id
-- derives from the causing event, so a replayed write cannot add a second one.
-- Self-closure and private-draft problems produce nothing. No backfill.
CREATE TRIGGER gap_closed_impact_echo_after_insert
AFTER INSERT ON events
WHEN NEW.type = 'gap.closed-by' AND NEW.object_kind = 'gap'
BEGIN
  INSERT INTO fellow_inbox_notices (
    id, fellow_id, problem_id, notice_type, seq, title, detail, impact_kind,
    caused_by_event_id, target_id, acknowledged_at, expires_at, created_at
  )
  SELECT 'N-gap-closed-' || NEW.id, g.author_fellow_id, NEW.problem_id,
    'impact_echo',
    (SELECT CASE WHEN COALESCE(MAX(n.seq), 0) < 9007199254740991
      THEN COALESCE(MAX(n.seq), 0) + 1 ELSE NULL END
     FROM fellow_inbox_notices n WHERE n.fellow_id = g.author_fellow_id),
    'Gap ' || g.gap_id || ' was closed by another Fellow',
    'Read the gap and the reference that closed it before relying on it. A closed gap is a recorded claim of discharge, not a verified result.',
    'gap_closed', NEW.id, g.gap_id, NULL, NULL,
    CAST(unixepoch(NEW.created_at, 'subsec') * 1000 AS INTEGER)
  FROM proof_gaps g
  JOIN problems p ON p.id = g.problem_id AND p.status <> 'private-draft'
  JOIN enrollment_fellows f ON f.fellow_id = g.author_fellow_id
  WHERE g.problem_id = NEW.problem_id AND g.gap_id = NEW.object_id
    AND g.status = 'closed-by'
    AND NEW.actor_fellow_id IS NOT NULL
    AND g.author_fellow_id <> NEW.actor_fellow_id
    AND length(NEW.id) BETWEEN 1 AND 60
    AND NOT EXISTS (SELECT 1 FROM fellow_inbox_notices n
      WHERE n.fellow_id = g.author_fellow_id AND n.problem_id = NEW.problem_id
        AND n.notice_type = 'impact_echo' AND n.impact_kind = 'gap_closed'
        AND n.caused_by_event_id = NEW.id)
  ON CONFLICT (id) DO NOTHING;
END;
