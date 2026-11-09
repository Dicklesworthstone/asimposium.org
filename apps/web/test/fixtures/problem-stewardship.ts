import type {
  ProblemStewardshipActionReceipt,
  SponsorProblemGovernanceResponse,
} from "@asimposium/contracts";
import { accessProblem, accessSponsor, accessWorkspace } from "./problem-governance";

export const stewardTarget = "usr_fedcba0987654321";
export const stewardshipWorkspace: SponsorProblemGovernanceResponse = {
  ...accessWorkspace,
  authority: { owner: true, steward: true, can_edit_access: true },
  stewardship: {
    version: 7,
    accountable_sponsor_id: accessSponsor,
    stewards: [
      { sponsor_id: accessSponsor, is_founding: true, created_at: "2026-10-26T12:00:00.000Z" },
    ],
    total_count: 1,
    has_more: false,
    next_after: null,
  },
};
export const stewardshipCommand = {
  action: "manage-steward",
  operation: "transfer",
  target_sponsor_id: stewardTarget,
  expected_stewardship_version: 7,
} as const;
export const stewardshipReceipt: ProblemStewardshipActionReceipt = {
  ...stewardshipCommand,
  problem_id: accessProblem,
  acting_sponsor_id: accessSponsor,
  updated_at: "2026-10-26T12:01:00.000Z",
  event_id: null,
};
