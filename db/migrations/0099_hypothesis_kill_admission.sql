-- Fable 6.5 / P6 / A6: an elimination is a recorded, evidence-backed transition,
-- not a claim that the platform independently verified a refutation.
-- Check at the same NULL -> settled replay boundary as migration 0098. The
-- event, content and projection exist here, but the D1 batch has not committed.
-- Historical replay reads and ledger-only restoration do not settle a new
-- invocation, so a later hide/withdrawal cannot rewrite a recorded outcome.
-- Stored digests are joined, not recomputed in SQL; cryptographic verification
-- of archived bytes remains the existing integrity reader's responsibility.
CREATE TRIGGER hypothesis_kill_admission_before_settlement
BEFORE UPDATE OF event_id ON idempotency
WHEN OLD.event_id IS NULL AND NEW.event_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM events e WHERE e.id = NEW.event_id
      AND e.problem_id = NEW.problem_id AND e.type = 'hypothesis.killed'
  )
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    WITH
    elimination AS MATERIALIZED (
      SELECT e.*, CASE WHEN length(CAST(c.payload_json AS BLOB)) <= 16384
        THEN CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END
        ELSE '{}' END AS body
      FROM events e JOIN event_content c ON c.event_id = e.id
        AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
      JOIN problems p ON p.id = e.problem_id AND p.public_seq >= e.seq
        AND p.status NOT IN ('private-draft', 'resolved', 'retired')
      WHERE e.id = NEW.event_id AND e.problem_id = NEW.problem_id
        AND e.seq = NEW.event_seq AND e.object_kind = 'hypothesis'
        AND e.type = 'hypothesis.killed' AND e.object_version = 1
    ),
    sources AS MATERIALIZED (
      SELECT k.id AS kill_event, k.problem_id, k.seq AS kill_seq, k.object_id,
        k.created_at AS killed_at, k.body AS kill_body,
        h.id AS hypothesis_event, h.seq AS hypothesis_seq,
        h.actor_fellow_id AS hypothesis_author,
        ev.id AS evidence_event, ev.object_id AS evidence_id, ev.seq AS evidence_seq,
        ev.actor_fellow_id AS evidence_author,
        CASE WHEN length(CAST(hc.payload_json AS BLOB)) <= 524288
          THEN CASE WHEN json_valid(hc.payload_json) THEN hc.payload_json ELSE '{}' END
          ELSE '{}' END AS hypothesis_body,
        CASE WHEN length(CAST(ec.payload_json AS BLOB)) <= 524288
          THEN CASE WHEN json_valid(ec.payload_json) THEN ec.payload_json ELSE '{}' END
          ELSE '{}' END AS evidence_body
      FROM elimination k
      JOIN events h ON h.problem_id = k.problem_id AND h.object_id = k.object_id
        AND h.type = 'hypothesis.created' AND h.object_kind = 'hypothesis'
        AND h.object_version = 1 AND h.seq < k.seq
      JOIN event_content hc ON hc.event_id = h.id
        AND hc.payload_sha256 = h.payload_sha256 AND hc.redacted_at IS NULL
      JOIN events ev ON ev.problem_id = k.problem_id
        AND ev.object_id = json_extract(k.body, '$.killed_by_evidence_id')
        AND ev.type = 'evidence.created' AND ev.object_kind = 'evidence'
        AND ev.object_version = 1 AND ev.seq > h.seq AND ev.seq < k.seq
      JOIN event_content ec ON ec.event_id = ev.id
        AND ec.payload_sha256 = ev.payload_sha256 AND ec.redacted_at IS NULL
    )
    SELECT 1 FROM sources s
    JOIN hypotheses hp ON hp.problem_id = s.problem_id AND hp.hypothesis_id = s.object_id
      AND hp.source_event_id = s.hypothesis_event AND hp.source_seq = s.hypothesis_seq
      AND hp.status = 'killed' AND hp.kill_event_id = s.kill_event
      AND hp.kill_source_seq = s.kill_seq AND hp.killed_at = s.killed_at
      AND hp.killed_by_evidence_id = s.evidence_id
      AND hp.kill_reason = json_extract(s.kill_body, '$.reason')
    JOIN evidence ep ON ep.problem_id = s.problem_id AND ep.evidence_id = s.evidence_id
      AND ep.source_event_id = s.evidence_event AND ep.source_seq = s.evidence_seq
      AND ep.bears_on_kind = 'hypothesis' AND ep.bears_on_id = s.object_id
      AND ep.direction = 'refutes'
    WHERE (SELECT COUNT(*) FROM sources) = 1
      -- An unavailable duplicate must not make ambiguous history look unique.
      -- Inspect envelopes independently of their body/visibility join above.
      AND NOT EXISTS (
        SELECT 1 FROM events duplicate WHERE duplicate.problem_id = s.problem_id
          AND duplicate.object_id = s.object_id AND duplicate.object_kind = 'hypothesis'
          AND duplicate.type = 'hypothesis.created' AND duplicate.seq < s.kill_seq
          AND duplicate.id <> s.hypothesis_event
      )
      AND NOT EXISTS (
        SELECT 1 FROM events duplicate WHERE duplicate.problem_id = s.problem_id
          AND duplicate.object_id = s.evidence_id AND duplicate.object_kind = 'evidence'
          AND duplicate.type = 'evidence.created' AND duplicate.seq < s.kill_seq
          AND duplicate.id <> s.evidence_event
      )
      AND json_type(s.kill_body) = 'object'
      AND json_extract(s.kill_body, '$.hypothesis_id') = s.object_id
      AND json_type(s.kill_body, '$.killed_by_evidence_id') = 'text'
      AND json_type(s.kill_body, '$.reason') = 'text'
      AND length(trim(json_extract(s.kill_body, '$.reason'))) BETWEEN 1 AND 2000
      AND json_type(s.hypothesis_body) = 'object'
      AND json_type(s.hypothesis_body, '$.falsifier') = 'text'
      AND length(trim(json_extract(s.hypothesis_body, '$.falsifier'))) > 0
      AND json_type(s.evidence_body) = 'object'
      AND json_extract(s.evidence_body, '$.bears_on_kind') = 'hypothesis'
      AND json_extract(s.evidence_body, '$.bears_on_id') = s.object_id
      AND json_extract(s.evidence_body, '$.direction') = 'refutes'
      AND json_type(s.evidence_body, '$.body_md') = 'text'
      AND length(trim(json_extract(s.evidence_body, '$.body_md'))) > 0
      -- The log, not a mutable 'open' projection, determines prior elimination.
      AND NOT EXISTS (
        SELECT 1 FROM events prior WHERE prior.problem_id = s.problem_id
          AND prior.object_id = s.object_id AND prior.object_kind = 'hypothesis'
          AND prior.type = 'hypothesis.killed' AND prior.seq < s.kill_seq
      )
      AND NOT EXISTS (
        SELECT 1 FROM scientific_withdrawals w
          WHERE w.source_event_id IN (s.hypothesis_event, s.evidence_event)
      )
      AND NOT EXISTS (
        SELECT 1 FROM retractions r JOIN events re ON re.problem_id = r.problem_id
          AND re.object_id = r.retraction_id AND re.seq = r.seq
          AND re.object_kind = 'retraction' AND re.type = 'object.retracted'
        WHERE r.problem_id = s.problem_id AND re.seq < s.kill_seq AND (
          (re.actor_fellow_id = s.hypothesis_author
            AND r.target_object IN (s.object_id, s.object_id || '@1')) OR
          (re.actor_fellow_id = s.evidence_author
            AND r.target_object IN (s.evidence_id, s.evidence_id || '@1'))
        )
      )
      -- Each scope has its own latest control; restoring one cannot override
      -- a hidden version, event, source object, or the whole problem.
      AND NOT EXISTS (
        SELECT 1 FROM content_controls cc
        WHERE cc.problem_id = s.problem_id AND cc.visibility = 'hidden'
          AND cc.target_ref IN ('problem', s.object_id, s.object_id || '@1',
            '#' || s.hypothesis_seq, s.evidence_id, s.evidence_id || '@1',
            '#' || s.evidence_seq, '#' || s.kill_seq)
          AND cc.version = (SELECT MAX(latest.version) FROM content_controls latest
            WHERE latest.problem_id = cc.problem_id AND latest.target_ref = cc.target_ref)
      )
  ) THEN RAISE(ABORT, 'HYPOTHESIS_KILL_SOURCE_INVALID') END;
END;
