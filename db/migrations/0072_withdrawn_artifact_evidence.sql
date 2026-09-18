-- asimposium:allow-destructive
-- Replace only the derived view, never event content or artifact records.
-- An authored withdrawal invalidates this source for NEW public releases.
-- The request, live-pin check and release CAS all consume this same view, so
-- withdrawal during inspection/screening cannot race into a new release.
-- Already release-authorized bytes require a separate takedown workflow.
DROP VIEW artifact_publication_evidence;
CREATE VIEW artifact_publication_evidence AS
SELECT v.problem_id, v.evidence_id, e.id AS evidence_event_id,
  e.payload_sha256 AS evidence_sha256, c.payload_json AS evidence_json,
  e.actor_fellow_id AS fellow_id, e.actor_sponsor_id AS sponsor_id
FROM evidence v JOIN events e ON e.problem_id = v.problem_id AND e.object_id = v.evidence_id
  AND e.object_kind = 'evidence' AND e.type = 'evidence.created' AND e.object_version = 1
  AND e.actor_fellow_id = v.author_fellow_id
JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
JOIN problems p ON p.id = e.problem_id AND p.status <> 'private-draft' AND e.seq <= p.public_seq
WHERE length(CAST(c.payload_json AS BLOB)) BETWEEN 1 AND 524288
  AND NOT EXISTS (SELECT 1 FROM scientific_withdrawals w WHERE w.source_event_id = e.id);
