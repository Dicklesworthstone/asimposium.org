import {
  PROBLEM_GOVERNANCE_MEMBER_PAGE_SIZE,
  type SponsorProblemGovernanceQuery,
  type SponsorProblemGovernanceResponse,
  SponsorProblemGovernanceResponseSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

/** The authorization and all displayed membership state share one SQL snapshot. */
export async function readSponsorProblemGovernance(
  db: D1Database,
  problemId: string,
  sponsorId: string,
  query: SponsorProblemGovernanceQuery = {},
): Promise<SponsorProblemGovernanceResponse | undefined> {
  const row = await db
    .prepare(`SELECT p.id, p.title, p.status, p.unlisted,
    p.current_statement_version, p.admission_mode, p.writer_cap, p.updated_at,
    p.sponsor_id = ? AS is_owner,
    EXISTS (SELECT 1 FROM problem_stewards WHERE problem_id = p.id AND sponsor_id = ?) AS is_steward,
    (SELECT json_object('total', COUNT(*),
      'observer', COALESCE(SUM(role = 'observer'), 0),
      'contributor', COALESCE(SUM(role = 'contributor'), 0),
      'steward', COALESCE(SUM(role = 'steward'), 0))
      FROM problem_memberships WHERE problem_id = p.id) AS counts_json,
    (SELECT json_group_array(json_object('fellow_id', fellow_id, 'name', name,
      'role', role, 'fellow_status', fellow_status, 'joined_at', joined_at))
      FROM (SELECT m.fellow_id, f.name, m.role, f.status AS fellow_status, m.joined_at
        FROM problem_memberships m JOIN enrollment_fellows f ON f.fellow_id = m.fellow_id
        WHERE m.problem_id = p.id AND m.fellow_id > ?
        ORDER BY m.fellow_id LIMIT ?)) AS members_json
    FROM problems p WHERE p.id = ?
      AND NOT EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = p.id)
      AND EXISTS (SELECT 1 FROM sponsors WHERE sponsor_id = ? AND tombstoned_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = ?)
      AND (p.sponsor_id = ? OR EXISTS (SELECT 1 FROM problem_stewards
        WHERE problem_id = p.id AND sponsor_id = ?))`)
    .bind(
      sponsorId,
      sponsorId,
      query.after ?? "",
      PROBLEM_GOVERNANCE_MEMBER_PAGE_SIZE + 1,
      problemId,
      sponsorId,
      sponsorId,
      sponsorId,
      sponsorId,
    )
    .first<{
      id: string;
      title: string;
      status: string;
      unlisted: number;
      current_statement_version: number;
      admission_mode: string;
      writer_cap: number | null;
      updated_at: string;
      is_owner: number | null;
      is_steward: number;
      counts_json: string;
      members_json: string;
    }>();
  if (!row) return undefined;
  const allMembers = JSON.parse(row.members_json) as SponsorProblemGovernanceResponse["members"];
  const has_more = allMembers.length > PROBLEM_GOVERNANCE_MEMBER_PAGE_SIZE;
  const members = allMembers.slice(0, PROBLEM_GOVERNANCE_MEMBER_PAGE_SIZE);
  return SponsorProblemGovernanceResponseSchema.parse({
    problem: {
      id: row.id,
      title: row.title,
      status: row.status,
      unlisted: row.unlisted === 1,
      current_statement_version: row.current_statement_version,
      admission_mode: row.admission_mode,
      writer_cap: row.writer_cap,
      updated_at: row.updated_at,
    },
    acting_sponsor_id: sponsorId,
    authority: {
      owner: row.is_owner === 1,
      steward: row.is_steward === 1,
      can_edit_access: row.status !== "resolved" && row.status !== "retired",
    },
    members,
    member_counts: JSON.parse(row.counts_json),
    has_more,
    next_after: has_more ? members.at(-1)?.fellow_id : null,
  });
}

/** Apply to successes and refusals alike: a private console response is never cached. */
export function privateProblemGovernanceResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("x-robots-tag", "noindex, nofollow");
  headers.set("referrer-policy", "no-referrer");
  return new Response(response.body, { status: response.status, headers });
}
