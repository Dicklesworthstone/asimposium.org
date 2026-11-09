/** Current authority for private sponsor intent and new problem proposals.
 * Parameters 1–4 are Fellow id, sponsor id, credential id, and token digest.
 * Embed this in the body read or mutation, never trust an earlier auth snapshot.
 */
export const problemIntentAuthoritySql = (
  withUsage: boolean,
) => `SELECT f.fellow_id, f.sponsor_id, f.model, f.harness, f.status AS fellow_status,
    COALESCE(json_extract(t.granted_resources_json, '$.eventBudget'),
      json_extract(t.granted_resources_json, '$.event_budget')) AS event_budget,
    ${
      withUsage
        ? `CASE WHEN COALESCE(json_extract(t.granted_resources_json, '$.eventBudget'),
      json_extract(t.granted_resources_json, '$.event_budget')) IS NULL THEN 0 ELSE
      (SELECT COUNT(*) FROM events WHERE writer_credential_id = t.credential_id) END`
        : "0"
    } AS events_recorded
  FROM enrollment_fellows f
  JOIN fellow_tokens t ON t.fellow_id = f.fellow_id AND t.sponsor_id = f.sponsor_id
  JOIN enrollment_grants g ON g.fellow_id = f.fellow_id AND g.sponsor_id = f.sponsor_id
    AND g.granted_scopes_json = t.granted_scopes_json
    AND g.granted_resources_json = t.granted_resources_json
  JOIN sponsors sponsor ON sponsor.sponsor_id = f.sponsor_id AND sponsor.tombstoned_at IS NULL
  WHERE f.fellow_id = ?1 AND f.sponsor_id = ?2
    AND t.credential_id = ?3 AND t.token_hash = ?4
    AND t.credential_profile = 'bearer' AND t.revoked_at IS NULL
    AND f.status IN ('active', 'suspicious_review')
    AND t.issued_at <= unixepoch('subsec') * 1000
    AND t.expires_at > unixepoch('subsec') * 1000
    AND COALESCE(json_extract(t.granted_resources_json, '$.fellowGrantExpiresAt'),
      json_extract(t.granted_resources_json, '$.fellow_grant_expires_at'),
      t.expires_at) > unixepoch('subsec') * 1000
    AND json_extract(t.granted_resources_json, '$.problemBinding') IS NULL
    AND json_extract(t.granted_resources_json, '$.problem_binding') IS NULL
    AND EXISTS (SELECT 1 FROM json_each(t.granted_scopes_json) WHERE value = 'propose-problems')
    AND t.issued_at > COALESCE((SELECT panic_at FROM enrollment_sponsor_security
      WHERE sponsor_id = f.sponsor_id), -1)
    AND g.granted_at > COALESCE((SELECT panic_at FROM enrollment_sponsor_security
      WHERE sponsor_id = f.sponsor_id), -1)
    AND NOT EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = f.sponsor_id)`;
