import {
  DIRECTIVE_DISCLOSURES_SCHEMA_ID,
  SponsorDirectiveDisclosureReceiptSchema,
  SponsorDirectiveDisclosureRequestSchema,
  SponsorDirectiveDisclosureStateSchema,
} from "@asimposium/contracts/directive-disclosures";

export const disclosureSponsor = "usr_disclosure_owner";
export const disclosureOtherSponsor = "usr_disclosure_prior";
export const disclosureTarget = { problemId: "P-4DSP", claimId: "C-7", version: 2 };
export const disclosureSource = {
  problem_id: "P-4DSP", claim_id: "C-7", version: 2,
  content_digest: `sha256:${"1".repeat(64)}`,
  publication_event_id: "EV-P-4DSP-23", publication_seq: 23, statement_version: 1,
};
export const disclosureDirectiveId = `DIR-${"a".repeat(32)}`;
export const disclosureInitialInstructionId = `EI-${"b".repeat(32)}`;
export const disclosureCommand = SponsorDirectiveDisclosureRequestSchema.parse({
  scope_id: "a".repeat(64), expected_lineage_digest: "c".repeat(64), expected_revision: 0,
  decision: "no-undisclosed", disclosures: [],
});
export const disclosureReceipt = SponsorDirectiveDisclosureReceiptSchema.parse({
  schema: DIRECTIVE_DISCLOSURES_SCHEMA_ID,
  event_id: `DD-${"d".repeat(32)}`, seq: 42, target: disclosureSource,
  scope_id: disclosureCommand.scope_id, coverage_digest: "e".repeat(64), revision: 1,
  decision: "no-undisclosed", recorded_at: "2026-10-26T13:00:00.000Z",
  sponsor_id: disclosureSponsor, fellow_id: "FEL-DISCLOSURE-1", disclosures: [],
});
export const disclosureInitial = SponsorDirectiveDisclosureStateSchema.parse({
  schema: DIRECTIVE_DISCLOSURES_SCHEMA_ID, target: disclosureSource,
  lineage_digest: disclosureCommand.expected_lineage_digest, status: "unresolved",
  scopes: [{
    scope_id: disclosureCommand.scope_id, fellow_id: "FEL-DISCLOSURE-1",
    sponsor_id: disclosureSponsor, can_attest: true, status: "missing", revision: 0,
    directives: [{
      directive_id: disclosureDirectiveId, source_kind: "directive", verb: "focus", text: "PRIVATE_DIRECTIVE_FIXTURE <script>not executable</script>",
      created_at: 1793016000000,
    }, {
      directive_id: disclosureInitialInstructionId, source_kind: "enrollment-instruction", verb: "initial",
      text: "PRIVATE_INITIAL_INSTRUCTION_FIXTURE: inspect the endpoint before generalizing.",
      created_at: 1793015000000,
    }], receipt: null,
  }, {
    scope_id: "b".repeat(64), fellow_id: "FEL-DISCLOSURE-1",
    sponsor_id: disclosureOtherSponsor, can_attest: false, status: "unresolved", revision: 0,
    directives: [], receipt: null,
  }],
});
export const disclosureCompleted = SponsorDirectiveDisclosureStateSchema.parse({
  ...disclosureInitial,
  scopes: disclosureInitial.scopes.map((scope) => scope.can_attest
    ? { ...scope, status: "complete", revision: 1, receipt: disclosureReceipt } : scope),
});
