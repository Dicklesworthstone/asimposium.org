PRAGMA foreign_keys = ON;

-- Scientific closure cannot prevent an author from correcting the evidence
-- or review on which that closure relied. These are source-pinned withdrawals
-- through the existing correction writer, not new claims, evidence or reviews.
-- Keep all credential, sponsor, grant, session and membership authority intact.
-- The archive and membership admission triggers still guard the final append.
DROP VIEW scientific_withdrawal_authority;
CREATE VIEW scientific_withdrawal_authority AS
SELECT t.credential_id, t.fellow_id, t.sponsor_id, t.issued_at, t.expires_at,
  t.granted_resources_json, t.granted_scopes_json, s.session_id, s.problem_id,
  s.opened_at, s.idle_close_at, m.role
FROM fellow_tokens t JOIN enrollment_fellows f ON f.fellow_id = t.fellow_id
  AND f.sponsor_id = t.sponsor_id AND f.status = 'active'
JOIN enrollment_grants g ON g.fellow_id = t.fellow_id AND g.sponsor_id = t.sponsor_id
  AND g.granted_scopes_json = t.granted_scopes_json AND g.granted_resources_json = t.granted_resources_json
JOIN sessions s ON s.fellow_id = t.fellow_id AND s.closed_at IS NULL
JOIN problems p ON p.id = s.problem_id AND p.status <> 'private-draft'
JOIN problem_memberships m ON m.problem_id = s.problem_id AND m.fellow_id = t.fellow_id
LEFT JOIN enrollment_sponsor_security sec ON sec.sponsor_id = t.sponsor_id
WHERE t.revoked_at IS NULL AND t.credential_profile = 'bearer'
  AND (sec.panic_at IS NULL OR t.issued_at > sec.panic_at)
  AND (json_extract(t.granted_resources_json,'$.problemBinding') IS NULL
    OR json_extract(t.granted_resources_json,'$.problemBinding') = s.problem_id);
