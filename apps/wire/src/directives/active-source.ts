/** A directive is applicable only with its committed receipt and the Fellow's
 * current sponsor. ACK is deliberately absent: receipt state is not authority. */
export const ACTIVE_DIRECTIVE_SOURCE_SQL = `SELECT d.id, d.verb, d.body, d.problem_id,
    d.notice_id, d.created_at, n.seq, n.acknowledged_at
  FROM sponsor_directives d
  JOIN enrollment_fellows f ON f.fellow_id = d.fellow_id AND f.sponsor_id = d.sponsor_id
  JOIN fellow_inbox_notices n ON n.id = d.notice_id
    AND n.fellow_id = d.fellow_id AND n.notice_type = 'sponsor_directive'
    AND n.target_id = d.id AND n.problem_id IS d.problem_id
  WHERE d.fellow_id = ?1 AND d.sponsor_id = ?2
    AND (d.problem_id IS NULL OR d.problem_id = ?3)`;

export interface ActiveDirectiveRow {
  id: string;
  verb: "focus" | "forbid" | "unfocus";
  body: string | null;
  problem_id: string | null;
  notice_id: string;
  created_at: number;
  seq: number;
  acknowledged_at: number | null;
}

/** Live authority checked in the same statement as every private instruction read.
 * Bindings: Fellow, sponsor, optional problem, credential ID, token hash. */
export const ACTIVE_DIRECTIVE_AUTHORITY_SQL = `  SELECT f.fellow_id,
    ep.proposal_id AS initial_proposal_id,
    er.enrollment_id AS initial_enrollment_id, er.sponsor_id AS initial_sponsor_id,
    f.created_at AS initial_created_at,
    json_type(g.granted_resources_json, '$.firstDirective') AS initial_instruction_type,
    COALESCE(json_extract(g.granted_resources_json, '$.problemBinding'),
      json_extract(g.granted_resources_json, '$.problem_binding')) AS initial_problem_id,
    CASE WHEN er.sponsor_id = f.sponsor_id AND (
      COALESCE(json_extract(g.granted_resources_json, '$.problemBinding'),
        json_extract(g.granted_resources_json, '$.problem_binding')) IS NULL
      OR COALESCE(json_extract(g.granted_resources_json, '$.problemBinding'),
        json_extract(g.granted_resources_json, '$.problem_binding')) = ?3)
      THEN json_extract(g.granted_resources_json, '$.firstDirective') END AS initial_instruction_text
  FROM enrollment_fellows f
  JOIN fellow_tokens t ON t.fellow_id = f.fellow_id AND t.sponsor_id = f.sponsor_id
  JOIN enrollment_grants g ON g.fellow_id = f.fellow_id AND g.sponsor_id = f.sponsor_id
    AND g.granted_scopes_json = t.granted_scopes_json
    AND g.granted_resources_json = t.granted_resources_json
  JOIN enrollment_proposals ep ON ep.proposal_id = g.proposal_id AND ep.fellow_id = f.fellow_id
    AND ep.status IN ('approved', 'reduced')
    AND ep.granted_scopes_json = g.granted_scopes_json
    AND ep.granted_resources_json = g.granted_resources_json
  JOIN enrollment_records er ON er.enrollment_id = ep.enrollment_id
  JOIN sponsors sponsor ON sponsor.sponsor_id = f.sponsor_id AND sponsor.tombstoned_at IS NULL
  WHERE f.fellow_id = ?1 AND f.sponsor_id = ?2
    AND t.credential_id = ?4 AND t.token_hash = ?5
    AND t.credential_profile = 'bearer' AND t.revoked_at IS NULL
    AND f.status IN ('active', 'suspicious_review')
    AND (json_type(g.granted_resources_json, '$.firstDirective') IS NULL OR (
      json_type(g.granted_resources_json, '$.firstDirective') = 'text'
      AND json_type(er.requested_resources_json, '$.firstDirective') = 'text'
      AND json_extract(g.granted_resources_json, '$.firstDirective') =
        json_extract(er.requested_resources_json, '$.firstDirective')))
    AND t.issued_at <= unixepoch('subsec') * 1000
    AND t.expires_at > unixepoch('subsec') * 1000
    AND COALESCE(json_extract(t.granted_resources_json, '$.fellowGrantExpiresAt'),
      json_extract(t.granted_resources_json, '$.fellow_grant_expires_at'),
      t.expires_at) > unixepoch('subsec') * 1000
    AND t.issued_at > COALESCE((SELECT panic_at FROM enrollment_sponsor_security
      WHERE sponsor_id = f.sponsor_id), -1)
    AND g.granted_at > COALESCE((SELECT panic_at FROM enrollment_sponsor_security
      WHERE sponsor_id = f.sponsor_id), -1)
    AND (?3 IS NULL OR COALESCE(json_extract(t.granted_resources_json, '$.problemBinding'),
      json_extract(t.granted_resources_json, '$.problem_binding'), ?3) = ?3)
    AND (?3 IS NULL OR EXISTS (SELECT 1 FROM problems p WHERE p.id = ?3 AND (
      p.status <> 'private-draft' OR (p.sponsor_id = f.sponsor_id AND (
        p.created_by_fellow_id = f.fellow_id OR p.id = COALESCE(
          json_extract(t.granted_resources_json, '$.problemBinding'),
          json_extract(t.granted_resources_json, '$.problem_binding')))))))`;
