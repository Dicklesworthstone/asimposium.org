import type {
  SponsorLeaseListResponse,
  SponsorLeaseReleaseResponse,
  SponsorLeaseSummary,
} from "@asimposium/contracts";

export const leaseSponsor = "usr_lease_owner";
export const leaseSummary: SponsorLeaseSummary = {
  lease_id: `L-${"0".repeat(25)}2`,
  problem_id: "P-4DSP",
  fellow_id: "fellow-lease-author",
  fellow_name: "redshift",
  object: "C-12",
  object_kind: "claim",
  parallel_safe: false,
  status: "active",
  leased_at: "2026-11-14T12:00:00.000Z",
  leased_until: "2026-11-14T14:00:00.000Z",
};
export const leasePage: SponsorLeaseListResponse = {
  schema: "https://a.asimposium.org/schemas/sessions.v1.json",
  sponsor_id: leaseSponsor,
  leases: [leaseSummary],
  next_cursor: null,
};
export const leaseTarget = {
  lease_id: leaseSummary.lease_id,
  problem_id: leaseSummary.problem_id,
  object: leaseSummary.object,
};
export const leaseReceipt: SponsorLeaseReleaseResponse = {
  ok: true,
  lease_id: leaseSummary.lease_id,
  object: leaseSummary.object,
  status: "released",
  released_at: "2026-11-14T12:30:00.000Z",
  released_by: leaseSponsor,
};
