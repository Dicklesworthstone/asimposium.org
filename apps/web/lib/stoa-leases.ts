import "server-only";
import {
  SPONSOR_LEASE_LIST_MAX_RESPONSE_BYTES,
  type SponsorLeaseListRequest,
  SponsorLeaseListRequestSchema,
  type SponsorLeaseListResponse,
  SponsorLeaseListResponseSchema,
  SponsorLeaseReleaseRequestSchema,
  type SponsorLeaseReleaseResponse,
  SponsorLeaseReleaseResponseSchema,
  SponsorLeaseSummarySchema,
  sponsorLeaseListPageIsValid,
} from "@asimposium/contracts";
import { callStoa, type StoaCall } from "./stoa";

export function stoaSponsorLeases(
  sponsorId: string,
  request: SponsorLeaseListRequest,
): Promise<StoaCall<SponsorLeaseListResponse>> {
  const command = SponsorLeaseListRequestSchema.parse(request);
  const route = "/v1/sponsors/leases";
  return callStoa({
    method: "POST",
    route,
    path: route,
    action: "lease.list",
    principalId: sponsorId,
    body: JSON.stringify(command),
    responseMaxBytes: SPONSOR_LEASE_LIST_MAX_RESPONSE_BYTES,
    parse: (value) => {
      const page = SponsorLeaseListResponseSchema.parse(value);
      if (page.sponsor_id !== sponsorId || !sponsorLeaseListPageIsValid(page, command))
        throw new TypeError("Private lease response does not match the signed request");
      return page;
    },
  });
}

const TargetSchema = SponsorLeaseSummarySchema.pick({
  lease_id: true,
  problem_id: true,
  object: true,
});

/** Pin the existing release command to one lease, never a replaceable object alias. */
export function stoaSponsorReleaseLease(
  sponsorId: string,
  target: { readonly lease_id: string; readonly problem_id: string; readonly object: string },
): Promise<StoaCall<SponsorLeaseReleaseResponse>> {
  const pin = TargetSchema.parse(target);
  const command = SponsorLeaseReleaseRequestSchema.parse({
    problem_id: pin.problem_id,
    object: pin.lease_id,
  });
  const route = "/v1/sponsors/leases/release";
  return callStoa({
    method: "POST",
    route,
    path: route,
    action: "lease.release",
    principalId: sponsorId,
    body: JSON.stringify(command),
    idempotencyKey: `console-lease-release-${pin.lease_id}`,
    responseMaxBytes: 4096,
    parse: (value) => {
      const receipt = SponsorLeaseReleaseResponseSchema.parse(value);
      if (
        receipt.lease_id !== pin.lease_id ||
        receipt.object !== pin.object ||
        receipt.released_by !== sponsorId
      )
        throw new TypeError("Lease release receipt does not match the signed request");
      return receipt;
    },
  });
}
