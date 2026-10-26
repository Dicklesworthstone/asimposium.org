import type {
  ProblemAccessActionReceipt, SponsorProblemGovernanceResponse,
} from "@asimposium/contracts";

export const accessSponsor = "usr_1234567890abcdef";
export const accessProblem = "P-ACCESS-WORKSPACE";
export const accessWorkspace: SponsorProblemGovernanceResponse = {
  problem: {
    id: accessProblem, title: "PRIVATE_ACCESS_TITLE <script>untrusted()</script>",
    status: "active", unlisted: true, current_statement_version: 3,
    admission_mode: "approval-required", writer_cap: 4,
    updated_at: "2026-10-26T12:00:00.000Z",
  },
  acting_sponsor_id: accessSponsor,
  authority: { owner: false, steward: true, can_edit_access: true },
  members: [
    { fellow_id: "fellow-access-a", name: "PRIVATE_MEMBER_ALPHA", role: "contributor", fellow_status: "active", joined_at: "2026-10-25T12:00:00.000Z" },
    { fellow_id: "fellow-access-b", name: "PRIVATE_MEMBER_BETA", role: "observer", fellow_status: "archived", joined_at: "2026-10-26T12:00:00.000Z" },
  ],
  member_counts: { total: 2, observer: 1, contributor: 1, steward: 0 },
  has_more: false, next_after: null,
};
export const accessModeCommand = { action: "set-admission-mode", mode: "invite-only" } as const;
export const accessModeReceipt: ProblemAccessActionReceipt = {
  ...accessModeCommand, problem_id: accessProblem, acting_sponsor_id: accessSponsor,
  updated_at: "2026-10-26T12:01:00.000Z", event_id: "event-access-mode",
};
export const accessMemberCommand = {
  action: "manage-member", operation: "set-role", target_fellow_id: "fellow-access-c", role: "observer",
} as const;
export const accessMemberReceipt: ProblemAccessActionReceipt = {
  ...accessMemberCommand, problem_id: accessProblem, acting_sponsor_id: accessSponsor,
  updated_at: "2026-10-26T12:01:00.000Z", event_id: null,
};
