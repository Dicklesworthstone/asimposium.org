import {
  FellowIdSchema,
  type SponsorFellowRebindCreateRequest,
  type SponsorFellowRebindDecisionRequest,
  SponsorFellowRebindCreateRequestSchema,
  SponsorFellowRebindDecisionRequestSchema,
  type SponsorFellowTransferInitiateRequest,
  SponsorFellowTransferInitiateRequestSchema,
  type SponsorFellowTransferSummary,
  SponsorFellowTransferSummarySchema,
} from "@asimposium/contracts";

export const TRANSFER_RECOVERY_SCOPE = "fellow-transfer";

type TransferTarget = Pick<
  SponsorFellowTransferSummary,
  "transfer_id" | "fellow_id" | "source_sponsor_id" | "target_sponsor_id"
>;

/** Stable intent only. Agora supplies fresh, authenticated step-up evidence. */
export type TransferIntent =
  | {
      readonly kind: "offer";
      readonly request: Omit<
        SponsorFellowTransferInitiateRequest,
        "step_up_authenticated_at" | "directive_attestation"
      >;
    }
  | { readonly kind: "accept" | "reject" | "cancel"; readonly transfer: TransferTarget }
  | {
      readonly kind: "rebind-create";
      readonly request: Omit<SponsorFellowRebindCreateRequest, "step_up_authenticated_at">;
    }
  | {
      readonly kind: "rebind-decision";
      readonly request: Omit<SponsorFellowRebindDecisionRequest, "step_up_authenticated_at">;
      readonly fellow_id: string;
    };

const offerSchema = SponsorFellowTransferInitiateRequestSchema.omit({
  step_up_authenticated_at: true,
  directive_attestation: true,
});
const targetSchema = SponsorFellowTransferSummarySchema.pick({
  transfer_id: true,
  fellow_id: true,
  source_sponsor_id: true,
  target_sponsor_id: true,
});
const createSchema = SponsorFellowRebindCreateRequestSchema.omit({
  step_up_authenticated_at: true,
});
const decisionSchema = SponsorFellowRebindDecisionRequestSchema.omit({
  step_up_authenticated_at: true,
});

/** Reuse the contracts; recovery cannot carry arbitrary private fields or credentials. */
export function parseTransferIntent(raw: unknown): TransferIntent | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  if (value.kind === "offer" && keys === "kind,request") {
    const request = offerSchema.safeParse(value.request);
    return request.success ? { kind: value.kind, request: request.data } : undefined;
  }
  if (
    (value.kind === "accept" || value.kind === "reject" || value.kind === "cancel") &&
    keys === "kind,transfer"
  ) {
    const transfer = targetSchema.safeParse(value.transfer);
    return transfer.success && transfer.data.source_sponsor_id !== transfer.data.target_sponsor_id
      ? { kind: value.kind, transfer: transfer.data }
      : undefined;
  }
  if (value.kind === "rebind-create" && keys === "kind,request") {
    const request = createSchema.safeParse(value.request);
    return request.success ? { kind: value.kind, request: request.data } : undefined;
  }
  if (value.kind === "rebind-decision" && keys === "fellow_id,kind,request") {
    const request = decisionSchema.safeParse(value.request);
    const fellow = FellowIdSchema.safeParse(value.fellow_id);
    return request.success && fellow.success
      ? { kind: value.kind, request: request.data, fellow_id: fellow.data }
      : undefined;
  }
  return undefined;
}

/** The immutable transfer ID identifies the reviewed manifest, without copying its private detail. */
export function transferTarget(transfer: SponsorFellowTransferSummary): TransferTarget {
  return targetSchema.parse({
    transfer_id: transfer.transfer_id,
    fellow_id: transfer.fellow_id,
    source_sponsor_id: transfer.source_sponsor_id,
    target_sponsor_id: transfer.target_sponsor_id,
  });
}

export function transferIntentBelongsToSponsor(intent: TransferIntent, sponsorId: string): boolean {
  switch (intent.kind) {
    case "offer":
      return intent.request.target_sponsor_id !== sponsorId;
    case "accept":
    case "reject":
      return intent.transfer.target_sponsor_id === sponsorId;
    case "cancel":
      return intent.transfer.source_sponsor_id === sponsorId;
    case "rebind-create":
    case "rebind-decision":
      // These requests carry no sponsor-controlled authority; Stoa resolves
      // ownership from the authenticated principal and stored transfer/rebind.
      return true;
  }
}
