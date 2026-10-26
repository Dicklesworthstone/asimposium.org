import "server-only";

import {
  DIRECTIVE_DISCLOSURE_MAX_RESPONSE_BYTES,
  SponsorDirectiveDisclosureReceiptSchema,
  SponsorDirectiveDisclosureRequestSchema,
  SponsorDirectiveDisclosureStateSchema,
  type SponsorDirectiveDisclosureReceipt,
  type SponsorDirectiveDisclosureRequest,
  type SponsorDirectiveDisclosureState,
} from "@asimposium/contracts/directive-disclosures";
import { callStoa, type StoaCall } from "./stoa";
import {
  isDirectiveDisclosureTarget,
  type DirectiveDisclosureTarget,
} from "./directive-disclosure-target";

const route = "/v1/sponsors/disclosures/:problemId/:claimId/:version";

function path(target: DirectiveDisclosureTarget): string {
  return `/v1/sponsors/disclosures/${encodeURIComponent(target.problemId)}/${encodeURIComponent(target.claimId)}/${target.version}`;
}

function sameTarget(
  received: SponsorDirectiveDisclosureState["target"],
  expected: DirectiveDisclosureTarget,
): boolean {
  return received.problem_id === expected.problemId && received.claim_id === expected.claimId &&
    received.version === expected.version;
}

/** A schema-valid response must still belong to this claim and current principal. */
export function stoaDirectiveDisclosure(
  principalId: string,
  target: DirectiveDisclosureTarget,
): Promise<StoaCall<SponsorDirectiveDisclosureState>> {
  if (!isDirectiveDisclosureTarget(target)) {
    return Promise.resolve({ ok: false, reason: "refused", status: 400 });
  }
  return callStoa({
    method: "GET", route, path: path(target), action: "sponsor.disclosure.read",
    principalId, body: "", responseMaxBytes: DIRECTIVE_DISCLOSURE_MAX_RESPONSE_BYTES,
    parse: (value) => {
      const state = SponsorDirectiveDisclosureStateSchema.parse(value);
      if (!sameTarget(state.target, target) || state.scopes.some((scope) =>
        (scope.can_attest && scope.sponsor_id !== principalId) ||
        (scope.receipt !== null && (
          !sameTarget(scope.receipt.target, target) ||
          scope.receipt.target.content_digest !== state.target.content_digest ||
          scope.receipt.scope_id !== scope.scope_id ||
          scope.receipt.sponsor_id !== scope.sponsor_id ||
          scope.receipt.fellow_id !== scope.fellow_id || scope.receipt.revision > scope.revision
        ))
      )) throw new Error("Disclosure state does not match the requested claim and sponsor scope.");
      return state;
    },
  });
}

/** The declaration is signed exactly; no caller can supply acting sponsor authority. */
export function stoaRecordDirectiveDisclosure(
  principalId: string,
  target: DirectiveDisclosureTarget,
  input: SponsorDirectiveDisclosureRequest,
  idempotencyKey: string,
): Promise<StoaCall<SponsorDirectiveDisclosureReceipt>> {
  const parsed = SponsorDirectiveDisclosureRequestSchema.safeParse(input);
  if (!isDirectiveDisclosureTarget(target) || !parsed.success || typeof idempotencyKey !== "string" ||
      /^[A-Za-z0-9._-]{1,160}$/.exec(idempotencyKey)?.[0] !== idempotencyKey) {
    return Promise.resolve({ ok: false, reason: "refused", status: 422 });
  }
  const command = parsed.data;
  return callStoa({
    method: "POST", route, path: path(target), action: "sponsor.disclosure.write",
    principalId, body: JSON.stringify(command), idempotencyKey,
    screenedPublication: true,
    responseMaxBytes: DIRECTIVE_DISCLOSURE_MAX_RESPONSE_BYTES,
    parse: (value) => {
      const receipt = SponsorDirectiveDisclosureReceiptSchema.parse(value);
      const disclosed = new Map(command.disclosures.map((item) => [item.directive_id, item]));
      if (!sameTarget(receipt.target, target) || receipt.sponsor_id !== principalId ||
          receipt.scope_id !== command.scope_id || receipt.revision !== command.expected_revision + 1 ||
          receipt.decision !== command.decision || receipt.disclosures.length !== disclosed.size ||
          new Set(receipt.disclosures.map((item) => item.directive_id)).size !== disclosed.size ||
          receipt.disclosures.some((item) => {
            const requested = disclosed.get(item.directive_id);
            return requested === undefined || requested.scope !== item.scope || requested.summary !== item.summary ||
              requested.source_kind !== item.source_kind;
          })) throw new Error("Disclosure receipt does not match the signed declaration.");
      return receipt;
    },
  });
}
