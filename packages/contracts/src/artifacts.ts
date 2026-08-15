import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  type EnrollmentApprovalCard,
  type EnrollmentCapsuleProjection,
  type EnrollmentClaimResponse,
  EnrollmentContractsSchema,
  type EnrollmentFlowPollRequest,
  type EnrollmentGrantReduction,
  type EnrollmentHelloResponse,
  type EnrollmentId,
  type EnrollmentSecret,
  type FellowRegistrationRequest,
  type FellowToken,
  type MintEnrollmentRequest,
  type RequestedScope,
  type SponsorEnrollmentDecision,
} from "./enrollment.ts";
import {
  LedgerContractsSchema,
  type ProblemIndexEntry,
  type ProblemsIndexResponse,
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
const PROBLEM_TYPES_ARTIFACT = "generated/problem.types.ts";
const PROBLEM_JSON_SCHEMA_ARTIFACT = "generated/problem.schema.json";
const PROBLEM_SCHEMA_ID = "https://a.asimposium.org/schemas/problem.v1.json";
const S2_COST_RECEIPT_TYPES_ARTIFACT = "generated/s2-cost-receipt.types.ts";
const S2_COST_RECEIPT_JSON_SCHEMA_ARTIFACT = "generated/s2-cost-receipt.schema.json";
const S2_COST_RECEIPT_SCHEMA_ID = "https://a.asimposium.org/schemas/s2-cost-receipt.v1.json";
const LEDGER_TYPES_ARTIFACT = "generated/ledger.types.ts";
const LEDGER_JSON_SCHEMA_ARTIFACT = "generated/ledger.schema.json";
const LEDGER_SCHEMA_ID = "https://a.asimposium.org/schemas/ledger.v1.json";

export function packageDirectory(): string {
  return fileURLToPath(new URL("../", import.meta.url));
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
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

  return formatJson(document);
}

function generatedEnrollmentTypes(): string {
  const typeNames = [
    "EnrollmentFlowPollRequest",
    "EnrollmentApprovalCard",
    "EnrollmentCapsuleProjection",
    "EnrollmentClaimResponse",
    "EnrollmentGrantReduction",
    "EnrollmentId",
    "EnrollmentHelloResponse",
    "EnrollmentSecret",
    "FellowRegistrationRequest",
    "FellowToken",
    "MintEnrollmentRequest",
    "RequestedScope",
    "SponsorEnrollmentDecision",
  ] as const satisfies readonly (keyof {
    EnrollmentFlowPollRequest: EnrollmentFlowPollRequest;
    EnrollmentApprovalCard: EnrollmentApprovalCard;
    EnrollmentCapsuleProjection: EnrollmentCapsuleProjection;
    EnrollmentClaimResponse: EnrollmentClaimResponse;
    EnrollmentGrantReduction: EnrollmentGrantReduction;
    EnrollmentId: EnrollmentId;
    EnrollmentHelloResponse: EnrollmentHelloResponse;
    EnrollmentSecret: EnrollmentSecret;
    FellowRegistrationRequest: FellowRegistrationRequest;
    FellowToken: FellowToken;
    MintEnrollmentRequest: MintEnrollmentRequest;
    RequestedScope: RequestedScope;
    SponsorEnrollmentDecision: SponsorEnrollmentDecision;
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

  return formatJson(document);
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
      "W6.1 public faces. The problems index mirrors the Krater projection; omitted[] is mandatory so readers see what the face left out.",
    ...z.toJSONSchema(LedgerContractsSchema),
  };
  return formatJson(document);
}

function generatedLedgerTypes(): string {
  const typeNames = ["ProblemIndexEntry", "ProblemsIndexResponse"] as const satisfies readonly (keyof {
    ProblemIndexEntry: ProblemIndexEntry;
    ProblemsIndexResponse: ProblemsIndexResponse;
  })[];
  return [
    "// Generated from src/ledger.ts by `bun run generate`. Do not edit.",
    `export type { ${typeNames.join(", ")} } from "../src/ledger.ts";`,
    "",
  ].join("\n");
}

export function generatedArtifacts(): readonly GeneratedArtifact[] {
  return [
    { relativePath: JSON_SCHEMA_ARTIFACT, content: generatedJsonSchema() },
    { relativePath: TYPES_ARTIFACT, content: generatedTypes() },
    { relativePath: ENROLLMENT_JSON_SCHEMA_ARTIFACT, content: generatedEnrollmentJsonSchema() },
    { relativePath: ENROLLMENT_TYPES_ARTIFACT, content: generatedEnrollmentTypes() },
    { relativePath: PROBLEM_JSON_SCHEMA_ARTIFACT, content: generatedProblemJsonSchema() },
    { relativePath: PROBLEM_TYPES_ARTIFACT, content: generatedProblemTypes() },
    { relativePath: LEDGER_JSON_SCHEMA_ARTIFACT, content: generatedLedgerJsonSchema() },
    { relativePath: LEDGER_TYPES_ARTIFACT, content: generatedLedgerTypes() },
    {
      relativePath: S2_COST_RECEIPT_JSON_SCHEMA_ARTIFACT,
      content: generatedS2CostReceiptJsonSchema(),
    },
    { relativePath: S2_COST_RECEIPT_TYPES_ARTIFACT, content: generatedS2CostReceiptTypes() },
  ];
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
