-- 0082: citation_reused impact echo (Fable §1.3.2 / §7.1, bead asimposiumorg-1e7).
--
-- When a Fellow records a citation whose canonical locator (DOI, arXiv, ISBN
-- or URL after normalization) a different Fellow recorded first on a public
-- problem, that first recorder gets one private, unranked notice pointing at
-- the new citation. It is not a count, a ranking or evidence that either
-- citation supports anything. The citation row is written after its event in
-- the same batch, so NEW.seq names the causing event. The notice commits or
-- rolls back with the write; its id derives from the new citation, so a
-- replay cannot add a second one. No backfill.
CREATE TRIGGER citation_reused_impact_echo_after_insert
AFTER INSERT ON citations
WHEN NEW.canonical_locator IS NOT NULL AND NEW.locator_kind IN ('doi', 'arxiv', 'isbn', 'url')
BEGIN
  INSERT INTO fellow_inbox_notices (
    id, fellow_id, problem_id, notice_type, seq, title, detail, impact_kind,
    caused_by_event_id, target_id, acknowledged_at, expires_at, created_at
  )
  SELECT 'N-citation-reused-' || NEW.problem_id || '-' || NEW.citation_id,
    first.author_fellow_id, NEW.problem_id, 'impact_echo',
    (SELECT CASE WHEN COALESCE(MAX(n.seq), 0) < 9007199254740991
      THEN COALESCE(MAX(n.seq), 0) + 1 ELSE NULL END
     FROM fellow_inbox_notices n WHERE n.fellow_id = first.author_fellow_id),
    'A source you cited was cited again',
    'Your citation ' || first.citation_id || ' on ' || first.problem_id ||
      ' names the same source as ' || NEW.citation_id || ' on ' || NEW.problem_id ||
      '. Read both before relying on either; a shared source is not agreement.',
    'citation_reused', cause.id, NEW.citation_id, NULL, NULL,
    CAST(unixepoch(NEW.created_at, 'subsec') * 1000 AS INTEGER)
  FROM citations first
  JOIN problems first_problem ON first_problem.id = first.problem_id
    AND first_problem.status <> 'private-draft'
  JOIN problems reuse_problem ON reuse_problem.id = NEW.problem_id
    AND reuse_problem.status <> 'private-draft'
  JOIN enrollment_fellows f ON f.fellow_id = first.author_fellow_id
  JOIN events cause ON cause.problem_id = NEW.problem_id AND cause.seq = NEW.seq
  WHERE first.canonical_locator = NEW.canonical_locator
    AND first.author_fellow_id <> NEW.author_fellow_id
    AND NOT (first.problem_id = NEW.problem_id AND first.citation_id = NEW.citation_id)
    AND length(NEW.problem_id) + length(NEW.citation_id) <= 60
    AND NOT EXISTS (SELECT 1 FROM citations earlier
      WHERE earlier.canonical_locator = NEW.canonical_locator
        AND earlier.author_fellow_id <> NEW.author_fellow_id
        AND (earlier.created_at < first.created_at OR (earlier.created_at = first.created_at
          AND (earlier.problem_id || '/' || earlier.citation_id)
            < (first.problem_id || '/' || first.citation_id))))
  ON CONFLICT (id) DO NOTHING;
END;
