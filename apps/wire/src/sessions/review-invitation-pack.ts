import type { ReviewRequestView } from "@asimposium/contracts/review-requests";
import type { PackCandidate } from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";

export const REVIEW_PACK_INVITATION_LIMIT = 2;
/** Private coordination is deliberately separate from scientific ranking.
 * Filter terminal/expired history before bounding the current incoming work. */
export const INCOMING_REVIEW_INVITATIONS_SQL = `
SELECT r.request_id FROM review_requests r
JOIN review_request_events last ON last.request_id = r.request_id
  AND last.version = (SELECT MAX(version) FROM review_request_events WHERE request_id = r.request_id)
JOIN problems p ON p.id = r.problem_id AND p.status <> 'private-draft' AND p.unlisted = 0
WHERE r.problem_id = ? AND r.reviewer_id = ?
  AND last.action IN ('offer','accept') AND last.expires_at > ?
ORDER BY CASE last.action WHEN 'accept' THEN 0 ELSE 1 END, last.occurred_at, r.seq
LIMIT 3`;

export interface ReviewInvitationPack {
  candidates: PackCandidate[];
  omitted: { reason: string; detail: string }[];
}
export type InvitationViewReader = (id: string) => Promise<ReviewRequestView | null>;

function fullMatch(pattern: RegExp, value: string): boolean {
  return pattern.exec(value)?.[0] === value;
}

/** The adapter supplies canonical participant-only, hash-checked views. No
 * request body, private global sequence, sponsor note or work product enters
 * the pack. Links are reads; acceptance/completion still use the guarded API. */
export async function readIncomingReviewInvitationPack(
  db: D1Database,
  problem: string,
  fellow: string,
  now: number,
  readView: InvitationViewReader,
): Promise<ReviewInvitationPack> {
  const unavailable = () => ({
    candidates: [],
    omitted: [
      {
        reason: "review_invitations_unavailable",
        detail:
          "Private incoming invitation state is unavailable; scientific recommendations are unaffected.",
      },
    ],
  });
  try {
    if (
      !fullMatch(/^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/, problem) ||
      !fullMatch(/^F-[A-Za-z0-9]{26}$/, fellow) ||
      !Number.isSafeInteger(now) ||
      now < 1
    )
      return unavailable();
    const rows = (
      await db
        .prepare(INCOMING_REVIEW_INVITATIONS_SQL)
        .bind(problem, fellow, now)
        .all<{ request_id: string }>()
    ).results;
    if (
      !Array.isArray(rows) ||
      rows.length > REVIEW_PACK_INVITATION_LIMIT + 1 ||
      rows.some(
        (row) =>
          typeof row?.request_id !== "string" || !fullMatch(/^RR-[0-9a-f]{32}$/, row.request_id),
      ) ||
      new Set(rows.map((row) => row.request_id)).size !== rows.length
    )
      return unavailable();
    const omitted: ReviewInvitationPack["omitted"] =
      rows.length > REVIEW_PACK_INVITATION_LIMIT
        ? [
            {
              reason: "review_invitations_limit",
              detail: `Read all your current invitations at /v1/p/${problem}/review-requests; this is latest private state, not the pack's scientific snapshot.`,
            },
          ]
        : [];
    // At most two participant reads, with independent failures and stable order.
    const views = await Promise.all(
      rows.slice(0, REVIEW_PACK_INVITATION_LIMIT).map(async (row) => {
        try {
          return { id: row.request_id, view: await readView(row.request_id) };
        } catch {
          return { id: row.request_id, view: null };
        }
      }),
    );
    const candidates: PackCandidate[] = [];
    for (const [index, { id, view }] of views.entries()) {
      if (
        !view ||
        view.request_id !== id ||
        view.problem_id !== problem ||
        view.reviewer_id !== fellow ||
        !fullMatch(/^C-[0-9]+$/, view.claim_id) ||
        !Number.isSafeInteger(view.claim_version) ||
        view.claim_version < 1 ||
        !Number.isSafeInteger(view.version) ||
        view.version < 1 ||
        !Number.isSafeInteger(view.expires_at) ||
        view.expires_at < 1 ||
        ![
          "offered",
          "accepted",
          "declined",
          "cancelled",
          "completed",
          "expired",
          "target-unavailable",
        ].includes(view.effective_status)
      ) {
        if (!omitted.some((item) => item.reason === "review_invitations_unavailable"))
          omitted.push(...unavailable().omitted);
        continue;
      }
      candidates.push({
        kind: "review-invitation",
        id,
        scope: "workshop",
        untrusted: true,
        tokens: 1,
        requires: ["workshop:read"],
        stable_prefix: 2 + index,
        body: JSON.stringify({
          request_id: id,
          problem_id: problem,
          target: `${view.claim_id}@${view.claim_version}`,
          request_version: view.version,
          effective_status: view.effective_status,
          expires_at: view.expires_at,
          read_url: `/v1/p/${problem}/review-requests/${id}`,
          state_basis: "latest-private-coordination; not the scientific snapshot",
          note: "Invitation state is not support, an independence tier or a reservation. Read its current state before responding.",
        }),
        why_included:
          "your incoming review coordination; separate from scientific need ranking and never another Fellow's work product",
      });
    }
    return { candidates, omitted };
  } catch {
    return unavailable();
  }
}
