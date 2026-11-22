-- Question-specific leases used a second live reservation in questions.
-- Adopt their current terms into the common lease authority without changing
-- any event, event_content, question history, cursor or replay receipt.
-- The L identifier is derived from the exact immutable question.leased event.
-- A historical overlap with an existing generic lease stays visible and blocks
-- further exclusive acquisition; this migration never chooses a winner.
--
-- SQLite cannot verify a payload SHA-256 here. Authored objective/deliverable
-- bytes are therefore NOT copied from event_content. These explicit operational
-- labels point to the preserved source; all new writes retain their exact
-- screened terms. Attribution comes only from the immutable event envelope.
INSERT INTO leases (
  lease_id, problem_id, object_ref, object_kind, object_id,
  session_id, fellow_id, sponsor_id, objective, deliverable, parallel_safe,
  status, leased_at, leased_until, created_at, updated_at
)
SELECT 'L-' || substr(e.id, 3), q.problem_id, 'Q-' || q.seq, 'question', q.question_id,
  e.actor_session_id, e.actor_fellow_id, e.actor_sponsor_id,
  'Legacy question reservation; inspect source event ' || e.id,
  'Historical deliverable remains in source event ' || e.id,
  0,
  CASE
    WHEN q.status IN ('resolved', 'withdrawn') OR s.closed_at IS NOT NULL THEN 'released'
    WHEN q.leased_until <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      OR s.idle_close_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') THEN 'expired'
    ELSE 'active'
  END,
  e.created_at, q.leased_until, e.created_at, e.created_at
FROM questions q
JOIN problems p ON p.id = q.problem_id
JOIN events e ON e.problem_id = q.problem_id AND e.object_id = q.question_id
  AND e.object_kind = 'question' AND e.type = 'question.leased'
  AND e.seq <= p.public_seq
  AND e.seq = (
    SELECT MAX(lease_event.seq) FROM events lease_event
    WHERE lease_event.problem_id = q.problem_id AND lease_event.object_id = q.question_id
      AND lease_event.object_kind = 'question' AND lease_event.type = 'question.leased'
      AND lease_event.seq <= p.public_seq
  )
JOIN events creation ON creation.problem_id = q.problem_id AND creation.seq = q.seq
  AND creation.object_id = q.question_id AND creation.object_kind = 'question'
  AND creation.type = 'question.asked' AND creation.seq < e.seq
JOIN events head ON head.problem_id = q.problem_id AND head.seq = (
  SELECT MAX(latest.seq) FROM events latest
  WHERE latest.problem_id = q.problem_id AND latest.object_id = q.question_id
    AND latest.object_kind = 'question' AND latest.seq <= p.public_seq
    AND latest.type NOT IN ('lease.acquired', 'lease.released', 'lease.challenged')
)
JOIN sessions s ON s.session_id = e.actor_session_id AND s.problem_id = q.problem_id
  AND s.fellow_id = e.actor_fellow_id
WHERE q.leased_by = e.actor_fellow_id
  AND q.leased_until IS NOT NULL AND julianday(q.leased_until) IS NOT NULL
  AND q.leased_until GLOB '????-??-??T??:??:??.???Z'
  AND ((q.status = 'leased' AND head.id = e.id)
    OR (q.status = 'resolved' AND head.type = 'question.answered')
    OR (q.status = 'withdrawn' AND head.type = 'question.withdrawn'))
  AND e.actor_sponsor_id IS NOT NULL
  AND length(e.id) = 28 AND substr(e.id, 1, 2) = 'E-'
  AND substr(e.id, 3) NOT GLOB '*[^A-HJKMNP-TV-Z0-9]*';

-- A terminal question may already have a generic reservation: the former
-- answer/withdraw routes did not release those rows. End those reservations
-- using the exact terminal event, including its actor and time, not a new
-- invented release publication. Historical generic and question events stay.
UPDATE leases SET status = 'released',
  released_by = (SELECT e.actor_fellow_id FROM events e JOIN problems p ON p.id = e.problem_id
    WHERE e.problem_id = leases.problem_id AND e.object_id = leases.object_id
      AND e.object_kind = 'question' AND e.type IN ('question.answered', 'question.withdrawn')
      AND e.seq <= p.public_seq ORDER BY e.seq DESC LIMIT 1),
  released_at = (SELECT e.created_at FROM events e JOIN problems p ON p.id = e.problem_id
    WHERE e.problem_id = leases.problem_id AND e.object_id = leases.object_id
      AND e.object_kind = 'question' AND e.type IN ('question.answered', 'question.withdrawn')
      AND e.seq <= p.public_seq ORDER BY e.seq DESC LIMIT 1),
  updated_at = (SELECT e.created_at FROM events e JOIN problems p ON p.id = e.problem_id
    WHERE e.problem_id = leases.problem_id AND e.object_id = leases.object_id
      AND e.object_kind = 'question' AND e.type IN ('question.answered', 'question.withdrawn')
      AND e.seq <= p.public_seq ORDER BY e.seq DESC LIMIT 1)
WHERE object_kind = 'question' AND status IN ('active', 'challenged')
  AND EXISTS (SELECT 1 FROM events e JOIN problems p ON p.id = e.problem_id
    WHERE e.problem_id = leases.problem_id AND e.object_id = leases.object_id
      AND e.object_kind = 'question' AND e.type IN ('question.answered', 'question.withdrawn')
      AND e.seq <= p.public_seq);
