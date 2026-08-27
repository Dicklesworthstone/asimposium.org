import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { BatchContractsSchema } from "./batch.ts";
import {
  type DeviceCodeStartRequest,
  type DeviceCodeStartResponse,
  type DeviceLookupRequest,
  type DeviceLookupResponse,
  type EnrollmentApprovalCard,
  type EnrollmentCapsuleProjection,
  EnrollmentCapsuleProjectionSchema,
  type EnrollmentClaimResponse,
  EnrollmentContractsSchema,
  type EnrollmentFlowHandle,
  type EnrollmentFlowPollRequest,
  type EnrollmentGrantReduction,
  type EnrollmentHelloResponse,
  type EnrollmentId,
  type EnrollmentNextAction,
  type EnrollmentSecret,
  type FellowCredentialId,
  type FellowCredentialProfile,
  type FellowId,
  type FellowLifecycleEventId,
  type FellowLifecycleStatus,
  type FellowRegistrationRequest,
  type FellowToken,
  type MintEnrollmentRequest,
  type MintEnrollmentResponse,
  type OperatorFellowCapAuditCursor,
  type OperatorFellowCapAuditCursorKey,
  type OperatorFellowCapAuditEvent,
  type OperatorFellowCapAuditEventId,
  type OperatorFellowCapAuditPageResponse,
  type OperatorFellowCapOverrideRequest,
  type OperatorFellowCapOverrideResponse,
  type OperatorFellowCapSignerKid,
  type OperatorFellowCapStateResponse,
  type RequestedScope,
  type SponsorBootstrapRequest,
  type SponsorBootstrapResponse,
  type SponsorCredentialRevokeRequest,
  type SponsorCredentialRevokeResponse,
  type SponsorCredentialSummary,
  type SponsorEnrollmentDecision,
  type SponsorEnrollmentDecisionCommand,
  type SponsorEnrollmentDecisionResponse,
  type SponsorFellowCursor,
  type SponsorFellowCursorKey,
  type SponsorFellowLifecycleRequest,
  type SponsorFellowLifecycleResponse,
  type SponsorFellowLifecycleTarget,
  type SponsorFellowListResponse,
  type SponsorFellowSummary,
  type SponsorPanicRequest,
  type SponsorPanicResponse,
  type SponsorProposalListResponse,
} from "./enrollment.ts";
import { embeddedExamplesFor } from "./examples.ts";
import { InternalHealthContractsSchema } from "./health.ts";
import {
  LedgerContractsSchema,
  type ProblemFaceResponse,
  type ProblemIndexEntry,
  type ProblemsIndexResponse,
  type PublicLedgerProblemId,
} from "./ledger.ts";
import {
  type ContractProblem,
  type OpaqueProblem,
  type ProblemCode,
  ProblemContractsSchema,
  type ProblemDocument,
  type ProblemRule,
} from "./problem.ts";
import {
  type S2CostEvidenceManifest,
  S2CostEvidenceManifestSchema,
  type S2CostMeasurementReceipt,
  S2CostMeasurementReceiptSchema,
  type S2CostReceiptPublication,
  type S2CostReceiptPublicationCommit,
  S2CostReceiptPublicationCommitSchema,
  S2CostReceiptPublicationSchema,
} from "./s2-cost-receipt.ts";
import { CONTRACT_SCAFFOLD_SCHEMA_ID, ContractScaffoldSchema } from "./schema.ts";
import {
  type ScreeningCoarseCategory,
  ScreeningContractsSchema,
  type ScreeningDecisionPath,
  type ScreeningOutcome,
  type ScreeningPromotionDecisionProvenance,
  type ScreeningProviderStatus,
  type ScreeningPublicAction,
  type ScreeningPublicationAction,
  type ScreeningPublicNotice,
  type ScreeningReviewState,
} from "./screening.ts";
import {
  type ClaimId,
  type ClaimKind,
  type CursorResponse,
  type NextAction,
  type PackBudget,
  type PackItem,
  type PackNeutralization,
  type PackNeutralizationMarker,
  type PackProfile,
  type PackResponse,
  type ProblemId,
  type PromoteRequest,
  type PromoteResponse,
  type SessionCloseRequest,
  type SessionCloseResponse,
  type SessionId,
  type SessionIntent,
  type SessionOpenRequest,
  type SessionOpenResponse,
  type SessionsContracts,
  SessionsContractsSchema,
  type SponsorWorkshopObject,
  type SponsorWorkshopRequest,
  type SponsorWorkshopView,
  type WorkshopObjectId,
  type WorkshopPushRequest,
  type WorkshopPushResponse,
  type WorkshopPushType,
} from "./sessions.ts";

export interface GeneratedArtifact {
  readonly relativePath: string;
  readonly content: string;
}

export interface ArtifactDrift {
  readonly code: "GENERATED_ARTIFACT_MISSING" | "GENERATED_ARTIFACT_STALE";
  readonly artifact: string;
}

const TYPES_ARTIFACT = "generated/contracts-scaffold.types.ts";
const JSON_SCHEMA_ARTIFACT = "generated/contracts-scaffold.schema.json";
const ENROLLMENT_TYPES_ARTIFACT = "generated/enrollment.types.ts";
const ENROLLMENT_JSON_SCHEMA_ARTIFACT = "generated/enrollment.schema.json";
const ENROLLMENT_SCHEMA_ID = "https://a.asimposium.org/schemas/enrollment.v1.json";
const ENROLLMENT_CAPSULE_JSON_SCHEMA_ARTIFACT = "generated/enrollment-capsule.schema.json";
const ENROLLMENT_CAPSULE_SCHEMA_ID = "https://a.asimposium.org/schemas/enrollment-capsule.v1.json";
const PROBLEM_TYPES_ARTIFACT = "generated/problem.types.ts";
const PROBLEM_JSON_SCHEMA_ARTIFACT = "generated/problem.schema.json";
const PROBLEM_SCHEMA_ID = "https://a.asimposium.org/schemas/problem.v1.json";
const EXAMPLES_INDEX_ARTIFACT = "generated/examples.index.json";
const S2_COST_RECEIPT_TYPES_ARTIFACT = "generated/s2-cost-receipt.types.ts";
const S2_COST_RECEIPT_JSON_SCHEMA_ARTIFACT = "generated/s2-cost-receipt.schema.json";
const S2_COST_RECEIPT_SCHEMA_ID = "https://a.asimposium.org/schemas/s2-cost-receipt.v1.json";
const LEDGER_TYPES_ARTIFACT = "generated/ledger.types.ts";
const LEDGER_JSON_SCHEMA_ARTIFACT = "generated/ledger.schema.json";
const LEDGER_SCHEMA_ID = "https://a.asimposium.org/schemas/ledger.v1.json";
const SCREENING_TYPES_ARTIFACT = "generated/screening.types.ts";
const SCREENING_JSON_SCHEMA_ARTIFACT = "generated/screening.schema.json";
const SCREENING_SCHEMA_ID = "https://a.asimposium.org/schemas/screening.v1.json";
const INTERNAL_HEALTH_TYPES_ARTIFACT = "generated/internal-health.types.ts";
const INTERNAL_HEALTH_JSON_SCHEMA_ARTIFACT = "generated/internal-health.schema.json";
const INTERNAL_HEALTH_SCHEMA_ID = "https://a.asimposium.org/schemas/internal.health.v1.json";
const SESSIONS_TYPES_ARTIFACT = "generated/sessions.types.ts";
const SESSIONS_JSON_SCHEMA_ARTIFACT = "generated/sessions.schema.json";
const SESSIONS_SCHEMA_ID = "https://a.asimposium.org/schemas/sessions.v1.json";
const BATCH_TYPES_ARTIFACT = "generated/batch.types.ts";
const BATCH_JSON_SCHEMA_ARTIFACT = "generated/batch.schema.json";
const BATCH_SCHEMA_ID = "https://a.asimposium.org/schemas/batch.v1.json";

export function packageDirectory(): string {
  return fileURLToPath(new URL("../", import.meta.url));
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Attach validated corpus examples to an agent-facing schema document
 * (bead asimposiumorg-zjs9). Fails generation loudly on any mismatch so a
 * drifted contract can never publish stale or lying examples.
 */
function withExamples(kind: string, document: Record<string, unknown>): Record<string, unknown> {
  const doc = { ...document };
  if (doc.examples !== undefined) {
    throw new Error(`EXAMPLES_SLOT_TAKEN ${kind}`);
  }
  return { ...doc, examples: embeddedExamplesFor(kind).examples };
}

function generatedJsonSchema(): string {
  const document = {
    $id: CONTRACT_SCAFFOLD_SCHEMA_ID,
    title: "Contracts scaffold marker",
    description: "Non-product tooling marker. This is not an ASImposium protocol schema.",
    ...z.toJSONSchema(ContractScaffoldSchema),
  };

  return formatJson(document);
}

function generatedTypes(): string {
  return [
    "// Generated from src/schema.ts by `bun run generate`. Do not edit.",
    'export type { ContractScaffold } from "../src/schema.ts";',
    "",
  ].join("\n");
}

function generatedEnrollmentJsonSchema(): string {
  const document = {
    $id: ENROLLMENT_SCHEMA_ID,
    title: "ASImposium enrollment contracts",
    description:
      "Fable §5.2 enrollment contract. Public enrollment ids are path-safe; credentials are body-only.",
    ...z.toJSONSchema(EnrollmentContractsSchema),
  };

  return formatJson(withExamples("enrollment", document));
}

function generatedEnrollmentCapsuleJsonSchema(): string {
  const document = {
    $id: ENROLLMENT_CAPSULE_SCHEMA_ID,
    title: "ASImposium public enrollment capsule",
    description:
      "Public fragment-safe onboarding projection. Sponsor-private scopes, directives, and budgets are intentionally absent.",
    ...z.toJSONSchema(EnrollmentCapsuleProjectionSchema),
  };
  return formatJson(document);
}

function generatedEnrollmentTypes(): string {
  const typeNames = [
    "DeviceCodeStartRequest",
    "DeviceCodeStartResponse",
    "DeviceLookupRequest",
    "DeviceLookupResponse",
    "EnrollmentFlowPollRequest",
    "EnrollmentApprovalCard",
    "EnrollmentCapsuleProjection",
    "EnrollmentClaimResponse",
    "EnrollmentFlowHandle",
    "EnrollmentGrantReduction",
    "EnrollmentId",
    "EnrollmentHelloResponse",
    "EnrollmentSecret",
    "EnrollmentNextAction",
    "FellowCredentialProfile",
    "FellowRegistrationRequest",
    "FellowId",
    "FellowCredentialId",
    "FellowLifecycleEventId",
    "FellowLifecycleStatus",
    "FellowToken",
    "MintEnrollmentRequest",
    "MintEnrollmentResponse",
    "OperatorFellowCapAuditCursor",
    "OperatorFellowCapAuditCursorKey",
    "OperatorFellowCapAuditEvent",
    "OperatorFellowCapAuditEventId",
    "OperatorFellowCapAuditPageResponse",
    "OperatorFellowCapOverrideRequest",
    "OperatorFellowCapOverrideResponse",
    "OperatorFellowCapSignerKid",
    "OperatorFellowCapStateResponse",
    "RequestedScope",
    "SponsorBootstrapRequest",
    "SponsorBootstrapResponse",
    "SponsorCredentialSummary",
    "SponsorEnrollmentDecision",
    "SponsorEnrollmentDecisionCommand",
    "SponsorEnrollmentDecisionResponse",
    "SponsorCredentialRevokeRequest",
    "SponsorCredentialRevokeResponse",
    "SponsorFellowLifecycleRequest",
    "SponsorFellowLifecycleResponse",
    "SponsorFellowLifecycleTarget",
    "SponsorFellowCursor",
    "SponsorFellowCursorKey",
    "SponsorFellowListResponse",
    "SponsorFellowSummary",
    "SponsorPanicRequest",
    "SponsorPanicResponse",
    "SponsorProposalListResponse",
  ] as const satisfies readonly (keyof {
    DeviceCodeStartRequest: DeviceCodeStartRequest;
    DeviceCodeStartResponse: DeviceCodeStartResponse;
    DeviceLookupRequest: DeviceLookupRequest;
    DeviceLookupResponse: DeviceLookupResponse;
    EnrollmentFlowPollRequest: EnrollmentFlowPollRequest;
    EnrollmentApprovalCard: EnrollmentApprovalCard;
    EnrollmentCapsuleProjection: EnrollmentCapsuleProjection;
    EnrollmentClaimResponse: EnrollmentClaimResponse;
    EnrollmentFlowHandle: EnrollmentFlowHandle;
    EnrollmentGrantReduction: EnrollmentGrantReduction;
    EnrollmentId: EnrollmentId;
    EnrollmentHelloResponse: EnrollmentHelloResponse;
    EnrollmentSecret: EnrollmentSecret;
    EnrollmentNextAction: EnrollmentNextAction;
    FellowCredentialProfile: FellowCredentialProfile;
    FellowCredentialId: FellowCredentialId;
    FellowId: FellowId;
    FellowLifecycleEventId: FellowLifecycleEventId;
    FellowLifecycleStatus: FellowLifecycleStatus;
    FellowRegistrationRequest: FellowRegistrationRequest;
    FellowToken: FellowToken;
    MintEnrollmentRequest: MintEnrollmentRequest;
    MintEnrollmentResponse: MintEnrollmentResponse;
    OperatorFellowCapAuditCursor: OperatorFellowCapAuditCursor;
    OperatorFellowCapAuditCursorKey: OperatorFellowCapAuditCursorKey;
    OperatorFellowCapAuditEvent: OperatorFellowCapAuditEvent;
    OperatorFellowCapAuditEventId: OperatorFellowCapAuditEventId;
    OperatorFellowCapAuditPageResponse: OperatorFellowCapAuditPageResponse;
    OperatorFellowCapOverrideRequest: OperatorFellowCapOverrideRequest;
    OperatorFellowCapOverrideResponse: OperatorFellowCapOverrideResponse;
    OperatorFellowCapSignerKid: OperatorFellowCapSignerKid;
    OperatorFellowCapStateResponse: OperatorFellowCapStateResponse;
    RequestedScope: RequestedScope;
    SponsorBootstrapRequest: SponsorBootstrapRequest;
    SponsorBootstrapResponse: SponsorBootstrapResponse;
    SponsorCredentialSummary: SponsorCredentialSummary;
    SponsorEnrollmentDecision: SponsorEnrollmentDecision;
    SponsorEnrollmentDecisionCommand: SponsorEnrollmentDecisionCommand;
    SponsorEnrollmentDecisionResponse: SponsorEnrollmentDecisionResponse;
    SponsorCredentialRevokeRequest: SponsorCredentialRevokeRequest;
    SponsorCredentialRevokeResponse: SponsorCredentialRevokeResponse;
    SponsorFellowLifecycleRequest: SponsorFellowLifecycleRequest;
    SponsorFellowLifecycleResponse: SponsorFellowLifecycleResponse;
    SponsorFellowLifecycleTarget: SponsorFellowLifecycleTarget;
    SponsorFellowCursor: SponsorFellowCursor;
    SponsorFellowCursorKey: SponsorFellowCursorKey;
    SponsorFellowListResponse: SponsorFellowListResponse;
    SponsorFellowSummary: SponsorFellowSummary;
    SponsorPanicRequest: SponsorPanicRequest;
    SponsorPanicResponse: SponsorPanicResponse;
    SponsorProposalListResponse: SponsorProposalListResponse;
  })[];
  return [
    "// Generated from src/enrollment.ts by `bun run generate`. Do not edit.",
    `export type { ${typeNames.join(", ")} } from "../src/enrollment.ts";`,
    "",
  ].join("\n");
}

function generatedProblemJsonSchema(): string {
  const document = {
    $id: PROBLEM_SCHEMA_ID,
    title: "ASImposium refusal contracts",
    description:
      "Rule A5 refusal faces. Contract problems teach with rule/schema/example; opaque problems deliberately do not.",
    ...z.toJSONSchema(ProblemContractsSchema),
  };

  return formatJson(withExamples("problem", document));
}

function generatedProblemTypes(): string {
  const typeNames = [
    "ContractProblem",
    "OpaqueProblem",
    "ProblemCode",
    "ProblemDocument",
    "ProblemRule",
  ] as const satisfies readonly (keyof {
    ContractProblem: ContractProblem;
    OpaqueProblem: OpaqueProblem;
    ProblemCode: ProblemCode;
    ProblemDocument: ProblemDocument;
    ProblemRule: ProblemRule;
  })[];
  return [
    "// Generated from src/problem.ts by `bun run generate`. Do not edit.",
    `export type { ${typeNames.join(", ")} } from "../src/problem.ts";`,
    "",
  ].join("\n");
}

function generatedS2CostReceiptJsonSchema(): string {
  const document = {
    $id: S2_COST_RECEIPT_SCHEMA_ID,
    title: "ASImposium S-2 cost receipt evidence contracts",
    description:
      "Closed normalized receipt plus manifest-bound local publication evidence for S-7 verification.",
    ...z.toJSONSchema(
      z.strictObject({
        receipt: S2CostMeasurementReceiptSchema,
        manifest: S2CostEvidenceManifestSchema,
        publication: S2CostReceiptPublicationSchema,
        publication_commit: S2CostReceiptPublicationCommitSchema,
      }),
    ),
  };
  return formatJson(document);
}

function generatedS2CostReceiptTypes(): string {
  const typeNames = [
    "S2CostEvidenceManifest",
    "S2CostMeasurementReceipt",
    "S2CostReceiptPublication",
    "S2CostReceiptPublicationCommit",
  ] as const satisfies readonly (keyof {
    S2CostEvidenceManifest: S2CostEvidenceManifest;
    S2CostMeasurementReceipt: S2CostMeasurementReceipt;
    S2CostReceiptPublication: S2CostReceiptPublication;
    S2CostReceiptPublicationCommit: S2CostReceiptPublicationCommit;
  })[];
  return [
    "// Generated from src/s2-cost-receipt.ts by `bun run generate`. Do not edit.",
    `export type { ${typeNames.join(", ")} } from "../src/s2-cost-receipt.ts";`,
    "",
  ].join("\n");
}

function generatedLedgerJsonSchema(): string {
  const document = {
    $id: LEDGER_SCHEMA_ID,
    title: "ASImposium public ledger read faces",
    description:
      "W6.1 public read faces. The problems index mirrors the Krater projection; the per-problem JSON digest is a bounded public-claim projection. omitted[] is mandatory so readers see what either face left out.",
    $comment:
      "Runtime Zod additionally requires timestamps to round-trip as real canonical UTC instants and items[].id values to be unique. Standard Draft 2020-12 cannot express uniqueness by one property across array members.",
    ...z.toJSONSchema(LedgerContractsSchema),
  };
  return formatJson(withExamples("ledger", document));
}

function generatedLedgerTypes(): string {
  const typeNames = [
    "ProblemFaceResponse",
    "ProblemIndexEntry",
    "ProblemsIndexResponse",
    "PublicLedgerProblemId",
  ] as const satisfies readonly (keyof {
    ProblemFaceResponse: ProblemFaceResponse;
    ProblemIndexEntry: ProblemIndexEntry;
    ProblemsIndexResponse: ProblemsIndexResponse;
    PublicLedgerProblemId: PublicLedgerProblemId;
  })[];
  return [
    "// Generated from src/ledger.ts by `bun run generate`. Do not edit.",
    `export type { ${typeNames.join(", ")} } from "../src/ledger.ts";`,
    "",
  ].join("\n");
}

function generatedSessionsJsonSchema(): string {
  const document = {
    $id: SESSIONS_SCHEMA_ID,
    title: "ASImposium session-protocol contracts",
    description:
      "Fable §7 session loop: open, pack, workshop push, promote, close. Writes are JSON only; packs are budgeted with mandatory omitted[] and server-authored next_actions.",
    ...z.toJSONSchema(SessionsContractsSchema),
  };

  return formatJson(withExamples("sessions", document));
}

function generatedSessionsTypes(): string {
  const typeNames = [
    "ClaimId",
    "ClaimKind",
    "CursorResponse",
    "NextAction",
    "PackBudget",
    "PackItem",
    "PackNeutralization",
    "PackNeutralizationMarker",
    "PackProfile",
    "PackResponse",
    "ProblemId",
    "PromoteRequest",
    "PromoteResponse",
    "SessionCloseRequest",
    "SessionCloseResponse",
    "SessionId",
    "SessionIntent",
    "SessionOpenRequest",
    "SessionOpenResponse",
    "SponsorWorkshopObject",
    "SponsorWorkshopRequest",
    "SponsorWorkshopView",
    "SessionsContracts",
    "WorkshopObjectId",
    "WorkshopPushRequest",
    "WorkshopPushResponse",
    "WorkshopPushType",
  ] as const satisfies readonly (keyof {
    ClaimId: ClaimId;
    ClaimKind: ClaimKind;
    CursorResponse: CursorResponse;
    NextAction: NextAction;
    PackBudget: PackBudget;
    PackItem: PackItem;
    PackNeutralization: PackNeutralization;
    PackNeutralizationMarker: PackNeutralizationMarker;
    PackProfile: PackProfile;
    PackResponse: PackResponse;
    ProblemId: ProblemId;
    PromoteRequest: PromoteRequest;
    PromoteResponse: PromoteResponse;
    SessionCloseRequest: SessionCloseRequest;
    SessionCloseResponse: SessionCloseResponse;
    SessionId: SessionId;
    SessionIntent: SessionIntent;
    SessionOpenRequest: SessionOpenRequest;
    SessionOpenResponse: SessionOpenResponse;
    SponsorWorkshopObject: SponsorWorkshopObject;
    SponsorWorkshopRequest: SponsorWorkshopRequest;
    SponsorWorkshopView: SponsorWorkshopView;
    SessionsContracts: SessionsContracts;
    WorkshopObjectId: WorkshopObjectId;
    WorkshopPushRequest: WorkshopPushRequest;
    WorkshopPushResponse: WorkshopPushResponse;
    WorkshopPushType: WorkshopPushType;
  })[];
  return [
    "// Generated from src/sessions.ts by `bun run generate`. Do not edit.",
    `export type { ${typeNames.join(", ")} } from "../src/sessions.ts";`,
    "",
  ].join("\n");
}

function generatedScreeningJsonSchema(): string {
  const document = {
    $id: SCREENING_SCHEMA_ID,
    title: "ASImposium screening promotion decision contracts",
    description:
      "Fable §7.7 and §9.1. Public actions contain only category, action, and a coarse notice. Promotion decision provenance retains bounded digests and decision facts, never submitted content or detector detail; it is not the canonical screening log.",
    ...z.toJSONSchema(ScreeningContractsSchema),
  };
  return formatJson(withExamples("screening", document));
}

function generatedScreeningTypes(): string {
  const typeNames = [
    "ScreeningCoarseCategory",
    "ScreeningContracts",
    "ScreeningDecisionPath",
    "ScreeningPromotionDecisionProvenance",
    "ScreeningOutcome",
    "ScreeningProviderStatus",
    "ScreeningPublicationAction",
    "ScreeningPublicAction",
    "ScreeningPublicNotice",
    "ScreeningReviewState",
  ] as const satisfies readonly (keyof {
    ScreeningCoarseCategory: ScreeningCoarseCategory;
    ScreeningContracts: import("./screening.ts").ScreeningContracts;
    ScreeningDecisionPath: ScreeningDecisionPath;
    ScreeningPromotionDecisionProvenance: ScreeningPromotionDecisionProvenance;
    ScreeningOutcome: ScreeningOutcome;
    ScreeningProviderStatus: ScreeningProviderStatus;
    ScreeningPublicationAction: ScreeningPublicationAction;
    ScreeningPublicAction: ScreeningPublicAction;
    ScreeningPublicNotice: ScreeningPublicNotice;
    ScreeningReviewState: ScreeningReviewState;
  })[];
  return [
    "// Generated from src/screening.ts by `bun run generate`. Do not edit.",
    `export type { ${typeNames.join(", ")} } from "../src/screening.ts";`,
    "",
  ].join("\n");
}

function generatedInternalHealthJsonSchema(): string {
  const document = {
    $id: INTERNAL_HEALTH_SCHEMA_ID,
    title: "ASImposium internal health readiness envelope",
    description:
      "Shape-only readiness for the mounted GET /internal/health scaffold face: binding names and bound/missing states, never values, ids, or secrets. The advertised schema literal is part of the contract.",
    ...z.toJSONSchema(InternalHealthContractsSchema),
  };
  return formatJson(document);
}

function generatedInternalHealthTypes(): string {
  const typeNames = [
    "HealthBindingName",
    "HealthBindingState",
    "InternalHealthContracts",
    "InternalHealthData",
  ] as const satisfies readonly (keyof {
    HealthBindingName: import("./health.ts").HealthBindingName;
    HealthBindingState: import("./health.ts").HealthBindingState;
    InternalHealthContracts: import("./health.ts").InternalHealthContracts;
    InternalHealthData: import("./health.ts").InternalHealthData;
  })[];
  return [
    "// Generated from src/health.ts by `bun run generate`. Do not edit.",
    `export type { ${typeNames.join(", ")} } from "../src/health.ts";`,
    "",
  ].join("\n");
}

function generatedBatchJsonSchema(): string {
  const document = {
    $id: BATCH_SCHEMA_ID,
    title: "ASImposium batch planning contracts",
    description:
      "W2.2 / W1.2 batch commit planning contract. Validates batch members, causal DAG, bounds, and topological order.",
    ...z.toJSONSchema(BatchContractsSchema),
  };
  return formatJson(document);
}

function generatedBatchTypes(): string {
  const typeNames = [
    "BatchCommitPlanRequest",
    "BatchContracts",
    "BatchMember",
    "BatchPlan",
    "BatchPlanFailure",
    "BatchPlanRefusalCode",
    "BatchPlanSuccess",
    "BatchTempId",
  ] as const satisfies readonly (keyof {
    BatchCommitPlanRequest: import("./batch.ts").BatchCommitPlanRequest;
    BatchContracts: import("./batch.ts").BatchContracts;
    BatchMember: import("./batch.ts").BatchMember;
    BatchPlan: import("./batch.ts").BatchPlan;
    BatchPlanFailure: import("./batch.ts").BatchPlanFailure;
    BatchPlanRefusalCode: import("./batch.ts").BatchPlanRefusalCode;
    BatchPlanSuccess: import("./batch.ts").BatchPlanSuccess;
    BatchTempId: import("./batch.ts").BatchTempId;
  })[];
  return [
    "// Generated from src/batch.ts by `bun run generate`. Do not edit.",
    `export type { ${typeNames.join(", ")} } from "../src/batch.ts";`,
    "",
  ].join("\n");
}

export function generatedArtifacts(): readonly GeneratedArtifact[] {
  return [
    { relativePath: JSON_SCHEMA_ARTIFACT, content: generatedJsonSchema() },
    { relativePath: TYPES_ARTIFACT, content: generatedTypes() },
    { relativePath: BATCH_JSON_SCHEMA_ARTIFACT, content: generatedBatchJsonSchema() },
    { relativePath: BATCH_TYPES_ARTIFACT, content: generatedBatchTypes() },
    { relativePath: ENROLLMENT_JSON_SCHEMA_ARTIFACT, content: generatedEnrollmentJsonSchema() },
    {
      relativePath: INTERNAL_HEALTH_JSON_SCHEMA_ARTIFACT,
      content: generatedInternalHealthJsonSchema(),
    },
    { relativePath: INTERNAL_HEALTH_TYPES_ARTIFACT, content: generatedInternalHealthTypes() },
    {
      relativePath: ENROLLMENT_CAPSULE_JSON_SCHEMA_ARTIFACT,
      content: generatedEnrollmentCapsuleJsonSchema(),
    },
    { relativePath: ENROLLMENT_TYPES_ARTIFACT, content: generatedEnrollmentTypes() },
    { relativePath: PROBLEM_JSON_SCHEMA_ARTIFACT, content: generatedProblemJsonSchema() },
    { relativePath: PROBLEM_TYPES_ARTIFACT, content: generatedProblemTypes() },
    { relativePath: LEDGER_JSON_SCHEMA_ARTIFACT, content: generatedLedgerJsonSchema() },
    { relativePath: LEDGER_TYPES_ARTIFACT, content: generatedLedgerTypes() },
    { relativePath: SESSIONS_JSON_SCHEMA_ARTIFACT, content: generatedSessionsJsonSchema() },
    { relativePath: SESSIONS_TYPES_ARTIFACT, content: generatedSessionsTypes() },
    { relativePath: SCREENING_JSON_SCHEMA_ARTIFACT, content: generatedScreeningJsonSchema() },
    { relativePath: SCREENING_TYPES_ARTIFACT, content: generatedScreeningTypes() },
    {
      relativePath: S2_COST_RECEIPT_JSON_SCHEMA_ARTIFACT,
      content: generatedS2CostReceiptJsonSchema(),
    },
    { relativePath: S2_COST_RECEIPT_TYPES_ARTIFACT, content: generatedS2CostReceiptTypes() },
    { relativePath: EXAMPLES_INDEX_ARTIFACT, content: generatedExamplesIndex() },
  ];
}

/** Served URL per kind's schema document (ids are the canonical constants). */
const EXAMPLES_SERVED_URL_BY_KIND: Readonly<Record<string, string>> = Object.freeze({
  enrollment: ENROLLMENT_SCHEMA_ID,
  ledger: LEDGER_SCHEMA_ID,
  problem: PROBLEM_SCHEMA_ID,
  screening: SCREENING_SCHEMA_ID,
  sessions: SESSIONS_SCHEMA_ID,
});

const EXAMPLE_KINDS: readonly string[] = Object.keys(EXAMPLES_SERVED_URL_BY_KIND);

/**
 * Machine-readable index of every embedded examples set (goc W1.4). Lists
 * exactly the agent-facing schemas that embed corpus examples, with their
 * served schema URL, example count, and source fixture names.
 */
export function generatedExamplesIndex(): string {
  const schemas = EXAMPLE_KINDS.map((kind) => {
    const loaded = embeddedExamplesFor(kind);
    return {
      kind,
      schema_url: EXAMPLES_SERVED_URL_BY_KIND[kind],
      example_count: loaded.examples.length,
      fixture_sources: [...loaded.fixtures],
    };
  });
  return formatJson({ schema_version: "1", schemas });
}

export function compareGeneratedArtifact(
  artifact: GeneratedArtifact,
  actual: string | undefined,
): ArtifactDrift | undefined {
  if (actual === undefined) {
    return { code: "GENERATED_ARTIFACT_MISSING", artifact: artifact.relativePath };
  }

  if (actual !== artifact.content) {
    return { code: "GENERATED_ARTIFACT_STALE", artifact: artifact.relativePath };
  }

  return undefined;
}

export async function checkGeneratedArtifacts(
  root = packageDirectory(),
): Promise<readonly ArtifactDrift[]> {
  const drifts: ArtifactDrift[] = [];

  for (const artifact of generatedArtifacts()) {
    let actual: string | undefined;
    try {
      actual = await readFile(join(root, artifact.relativePath), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const drift = compareGeneratedArtifact(artifact, actual);
    if (drift !== undefined) drifts.push(drift);
  }

  return drifts;
}

export async function writeGeneratedArtifacts(root = packageDirectory()): Promise<void> {
  for (const artifact of generatedArtifacts()) {
    const destination = join(root, artifact.relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, artifact.content, "utf8");
  }
}
