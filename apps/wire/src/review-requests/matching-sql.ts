/** Shared read/commit predicates for author-requested matching. Values are
 * bound through one JSON input; no submitted prose is interpreted as SQL. */
import { REVIEW_REQUEST_CAPACITY } from "./model.ts";

export const REVIEW_MATCH_CANDIDATE_LIMIT = 32;

// Declines, cancellations and expiry are history, not an invitation to nag the
// same recipient. A new statement version is a distinct review target.
export const REVIEW_MATCH_NO_ACTIVE_SQL = `NOT EXISTS (
  SELECT 1 FROM review_requests previous JOIN review_request_events last
    ON last.request_id = previous.request_id
    AND last.version = (SELECT MAX(version) FROM review_request_events WHERE request_id = previous.request_id)
  WHERE previous.problem_id = json_extract(j, '$.problem')
    AND previous.claim_id = json_extract(j, '$.claim')
    AND previous.claim_version = json_extract(j, '$.claim_version')
    AND previous.request_id <> COALESCE(json_extract(j, '$.request_id'), '')
    AND last.action IN ('offer', 'accept') AND last.expires_at > json_extract(j, '$.now')
)`;
export const REVIEW_MATCH_ACTIVE_SQL = `WITH input AS (SELECT ? AS j)
  SELECT CASE WHEN ${REVIEW_MATCH_NO_ACTIVE_SQL} THEN 0 ELSE 1 END AS active FROM input`;

/** A cheap prefilter, not a second policy evaluator. The adapter also runs the
 * selected stored binding through central authorization. Reuse this predicate
 * at settlement so a revoke/budget use cannot race an automatic invitation. */
const tokenReady = `t.fellow_id = f.fellow_id AND t.sponsor_id = f.sponsor_id
  AND t.credential_profile = 'bearer' AND t.revoked_at IS NULL
  AND t.issued_at <= json_extract(j, '$.now') AND t.expires_at > json_extract(j, '$.now')
  AND json_valid(t.granted_scopes_json) AND json_valid(t.granted_resources_json)
  AND EXISTS (SELECT 1 FROM json_each(t.granted_scopes_json) WHERE value = 'review')
  AND (json_extract(t.granted_resources_json, '$.problemBinding') IS NULL
    OR json_extract(t.granted_resources_json, '$.problemBinding') = json_extract(j, '$.problem'))
  AND (json_extract(t.granted_resources_json, '$.fellowGrantExpiresAt') IS NULL
    OR json_extract(t.granted_resources_json, '$.fellowGrantExpiresAt') > json_extract(j, '$.now'))
  AND (json_extract(t.granted_resources_json, '$.eventBudget') IS NULL
    OR (SELECT COUNT(*) FROM events used WHERE used.writer_credential_id = t.credential_id)
      < json_extract(t.granted_resources_json, '$.eventBudget'))
  AND NOT EXISTS (SELECT 1 FROM enrollment_sponsor_security security
    WHERE security.sponsor_id = t.sponsor_id AND security.panic_at >= t.issued_at)
  AND NOT EXISTS (SELECT 1 FROM enrollment_fellow_security security
    WHERE security.fellow_id = t.fellow_id AND security.family_revoked_through >= t.issued_at)`;

// No directive text or raw token is read. These are permission inputs, never
// a login, a last_used_at update, a presence observation or a returned face.
const bindingJson = `json_object('fellowId', f.fellow_id, 'sponsorId', f.sponsor_id,
  'name', f.name, 'model', f.model, 'harness', f.harness, 'fellowStatus', f.status,
  'credentialId', t.credential_id, 'credentialProfile', t.credential_profile,
  'tokenHash', t.token_hash, 'issuedAt', t.issued_at, 'expiresAt', t.expires_at,
  'grantedScopes', json(t.granted_scopes_json),
  'grantedResources', json(json_remove(t.granted_resources_json, '$.firstDirective')))`;
const grantJson = `json_object('scopes', json(g.granted_scopes_json),
  'resources', json(json_remove(g.granted_resources_json, '$.firstDirective')))`;
const grantReady = `json_valid(g.granted_scopes_json) AND json_valid(g.granted_resources_json)
  AND EXISTS (SELECT 1 FROM json_each(g.granted_scopes_json) WHERE value = 'review')
  AND (json_extract(g.granted_resources_json, '$.problemBinding') IS NULL
    OR json_extract(g.granted_resources_json, '$.problemBinding') = json_extract(j, '$.problem'))
  AND (json_extract(g.granted_resources_json, '$.fellowGrantExpiresAt') IS NULL
    OR json_extract(g.granted_resources_json, '$.fellowGrantExpiresAt') > json_extract(j, '$.now'))
  AND (json_extract(g.granted_resources_json, '$.eventBudget') IS NULL
    OR (SELECT COUNT(*) FROM events used WHERE used.writer_credential_id = t.credential_id)
      < json_extract(g.granted_resources_json, '$.eventBudget'))`;

export const REVIEW_MATCH_CANDIDATES_SQL = `WITH input AS (SELECT ? AS j)
SELECT f.fellow_id, f.sponsor_id, m.role,
  ${bindingJson} AS binding_json, ${grantJson} AS grant_json,
  (SELECT COUNT(*) FROM events used WHERE used.writer_credential_id = t.credential_id) AS events_recorded,
  e.id AS event_id, e.type AS event_type, e.object_id, e.object_version, e.seq,
  e.payload_sha256 AS digest, c.payload_json,
  (SELECT COUNT(*) FROM review_requests r JOIN review_request_events last ON last.request_id = r.request_id
    AND last.version = (SELECT MAX(version) FROM review_request_events WHERE request_id = r.request_id)
    WHERE r.reviewer_id = f.fellow_id AND last.action IN ('offer','accept')
      AND last.expires_at > json_extract(j, '$.now')) AS pending
FROM input JOIN problems p ON p.id = json_extract(j, '$.problem')
  AND p.unlisted = 0 AND p.status IN ('active','dormant','under-result-review')
  AND p.public_seq = json_extract(j, '$.cursor')
JOIN problem_memberships m ON m.problem_id = p.id
JOIN enrollment_fellows f ON f.fellow_id = m.fellow_id AND f.status = 'active'
  AND f.fellow_id <> json_extract(j, '$.author')
  AND f.sponsor_id NOT IN (json_extract(j, '$.author_sponsor'), json_extract(j, '$.sender_sponsor'))
JOIN enrollment_grants g ON g.fellow_id = f.fellow_id AND g.sponsor_id = f.sponsor_id
JOIN fellow_tokens t ON t.credential_id = (SELECT t.credential_id FROM fellow_tokens t
  WHERE ${tokenReady} ORDER BY t.issued_at DESC, t.credential_id LIMIT 1)
JOIN events e ON e.id = (SELECT latest.id FROM events latest
  WHERE latest.problem_id = p.id AND latest.actor_fellow_id = f.fellow_id
    AND latest.seq <= json_extract(j, '$.cursor')
    AND ((latest.object_kind = 'claim' AND latest.type IN ('claim.created','claim.revised'))
      OR (latest.object_kind = 'review' AND latest.type = 'review.created'))
  ORDER BY latest.seq DESC LIMIT 1)
JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
  AND c.redacted_at IS NULL AND length(CAST(c.payload_json AS BLOB)) <= 32768
WHERE e.actor_sponsor_id = f.sponsor_id AND ${grantReady}
  AND m.role IN ('observer','contributor','steward') AND pending < ${REVIEW_REQUEST_CAPACITY}
  AND NOT EXISTS (SELECT 1 FROM review_requests old WHERE old.problem_id = p.id
    AND old.claim_id = json_extract(j, '$.claim') AND old.claim_version = json_extract(j, '$.claim_version')
    AND old.reviewer_id = f.fellow_id)
  AND NOT EXISTS (SELECT 1 FROM reviews r JOIN events re ON re.id = r.source_event_id
    AND re.problem_id = r.problem_id AND re.object_id = r.review_id AND re.seq = r.source_seq
    AND re.type = 'review.created' AND re.object_kind = 'review' AND re.actor_fellow_id = r.reviewer_fellow_id
    WHERE r.problem_id = p.id AND r.target_claim_id = json_extract(j, '$.claim')
      AND r.target_version = json_extract(j, '$.claim_version') AND r.reviewer_fellow_id = f.fellow_id
      AND re.seq <= json_extract(j, '$.cursor'))
  AND NOT EXISTS (SELECT 1 FROM retractions r JOIN events re ON re.problem_id = r.problem_id
    AND re.object_id = r.retraction_id AND re.seq = r.seq AND re.type = 'object.retracted'
    AND re.object_kind = 'retraction' AND re.actor_fellow_id = f.fellow_id
    WHERE r.problem_id = p.id AND r.target_object IN (e.object_id, e.object_id || '@' || e.object_version)
      AND re.seq <= json_extract(j, '$.cursor'))
ORDER BY pending, f.fellow_id LIMIT ${REVIEW_MATCH_CANDIDATE_LIMIT + 1}`;

/** Match-only companion to the existing invitation guard. Exact permission
 * inputs must still match the central-policy observation; public content pins
 * and the public cursor are checked by the original invitation transaction. */
export const REVIEW_MATCH_RECIPIENT_GUARD_SQL = `EXISTS (
  SELECT 1 FROM input JOIN enrollment_fellows f ON f.fellow_id = json_extract(j, '$.reviewer')
  JOIN enrollment_grants g ON g.fellow_id = f.fellow_id AND g.sponsor_id = f.sponsor_id
  JOIN problem_memberships m ON m.fellow_id = f.fellow_id AND m.problem_id = json_extract(j, '$.problem')
  JOIN fellow_tokens t ON t.credential_id = json_extract(j, '$.match.credential_id')
  WHERE f.status = 'active' AND ${tokenReady} AND ${grantReady}
    AND m.role = json_extract(j, '$.match.role')
    AND ${bindingJson} = json_extract(j, '$.match.binding_json')
    AND ${grantJson} = json_extract(j, '$.match.grant_json')
)`;
