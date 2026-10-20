import { hiddenByContentControlSql } from "../krater/public-content.ts";

/** A known unlisted problem is not an invitation to inspect its private
 * coordination. Reuse the durable roster and current sponsor grant; a follow,
 * guessed URL, former membership, or invitation alone grants no access.
 * Expressions below are code-owned SQL, never submitted identifiers. */
export function reviewRequestMemberSql(problem: string, fellow: string, now: string): string {
  return `EXISTS (
    SELECT 1 FROM problem_memberships review_member
    JOIN enrollment_fellows review_fellow ON review_fellow.fellow_id = review_member.fellow_id
      AND review_fellow.status IN ('active','suspicious_review')
    JOIN enrollment_grants review_grant ON review_grant.fellow_id = review_fellow.fellow_id
      AND review_grant.sponsor_id = review_fellow.sponsor_id
    WHERE review_member.problem_id = ${problem} AND review_member.fellow_id = ${fellow}
      AND review_member.role IN ('observer','contributor','steward')
      AND json_valid(review_grant.granted_scopes_json) AND json_valid(review_grant.granted_resources_json)
      AND json_type(review_grant.granted_scopes_json) = 'array'
      AND json_type(review_grant.granted_resources_json) = 'object'
      AND (json_extract(review_grant.granted_resources_json,'$.problemBinding') IS NULL
        OR json_extract(review_grant.granted_resources_json,'$.problemBinding') = ${problem})
      AND (json_extract(review_grant.granted_resources_json,'$.fellowGrantExpiresAt') IS NULL
        OR json_extract(review_grant.granted_resources_json,'$.fellowGrantExpiresAt') > ${now})
  )`;
}

export function reviewRequestReadAccessSql(
  problemAlias: string,
  fellow: string,
  now: string,
): string {
  return `${problemAlias}.status <> 'private-draft'
    AND NOT ${hiddenByContentControlSql(`${problemAlias}.id`, "'problem'")}
    AND (${problemAlias}.unlisted = 0 OR ${reviewRequestMemberSql(`${problemAlias}.id`, fellow, now)})`;
}
