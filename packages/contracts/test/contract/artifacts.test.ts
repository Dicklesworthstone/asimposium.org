import { expect, test } from "bun:test";
import type {
  ScreeningContracts as PackageScreeningContracts,
  ScreeningPromotionDecisionProvenance as PackageScreeningPromotionDecisionProvenance,
  ScreeningPublicAction as PackageScreeningPublicAction,
} from "@asimposium/contracts";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type {
  ScreeningContracts as GeneratedScreeningContracts,
  ScreeningPromotionDecisionProvenance as GeneratedScreeningPromotionDecisionProvenance,
  ScreeningPublicAction as GeneratedScreeningPublicAction,
} from "../../generated/screening.types.ts";
import {
  checkGeneratedArtifacts,
  compareGeneratedArtifact,
  generatedArtifacts,
} from "../../src/artifacts.ts";
import { type DiagnosticCode, REPRODUCE, safeDiagnostic } from "../../src/diagnostics.ts";
import { ScreeningContractsSchema } from "../../src/screening.ts";

const GENERATED_SCREENING_SCHEMA = new URL(
  "../../generated/screening.schema.json",
  import.meta.url,
);
const VALID_PUBLIC_ACTION = new URL(
  "../fixtures/valid/screening-public-action.json",
  import.meta.url,
);
const VALID_OPERATOR_RECEIPT = new URL(
  "../fixtures/valid/screening-operator-receipt.json",
  import.meta.url,
);
const INVALID_PUBLIC_ACTION_PRIVATE_DETAIL = new URL(
  "../fixtures/invalid/screening-public-action-private-detail.json",
  import.meta.url,
);
const INVALID_OPERATOR_RECEIPT_PRIVATE_DETAIL = new URL(
  "../fixtures/invalid/screening-operator-receipt-private-detail.json",
  import.meta.url,
);

function failureDiagnostic(suite: string, startedAt: number, code: DiagnosticCode): string {
  return safeDiagnostic({
    suite,
    status: code.includes("STALE") ? "stale" : "invalid",
    startedAt,
    code,
    reproduce: REPRODUCE.contract,
  });
}

test("committed JSON Schema and TypeScript outputs have no drift", async () => {
  const startedAt = performance.now();
  const drifts = await checkGeneratedArtifacts();

  if (drifts.length > 0) {
    const [firstDrift] = drifts;
    if (firstDrift === undefined) {
      throw new Error(failureDiagnostic("artifacts.drift", startedAt, "NO_ARTIFACT"));
    }
    throw new Error(failureDiagnostic("artifacts.drift", startedAt, firstDrift.code));
  }

  expect(drifts).toEqual([]);
});

test("planted stale generated content fails the drift comparison", () => {
  const startedAt = performance.now();
  const [artifact] = generatedArtifacts();

  if (artifact === undefined) {
    throw new Error(failureDiagnostic("artifacts.stale-negative", startedAt, "NO_ARTIFACT"));
  }

  const drift = compareGeneratedArtifact(artifact, `${artifact.content}// stale\n`);
  if (drift === undefined) {
    throw new Error(
      failureDiagnostic("artifacts.stale-negative", startedAt, "STALE_ARTIFACT_ACCEPTED"),
    );
  }

  expect(drift).toEqual({
    code: "GENERATED_ARTIFACT_STALE",
    artifact: artifact.relativePath,
  });
});

test("planted stale enrollment schema is rejected by the artifact manifest", () => {
  const startedAt = performance.now();
  const artifact = generatedArtifacts().find(
    (candidate) => candidate.relativePath === "generated/enrollment.schema.json",
  );

  if (artifact === undefined) {
    throw new Error(failureDiagnostic("artifacts.enrollment-missing", startedAt, "NO_ARTIFACT"));
  }

  const drift = compareGeneratedArtifact(
    artifact,
    `${artifact.content}// stale enrollment schema\n`,
  );
  if (drift === undefined) {
    throw new Error(
      failureDiagnostic(
        "artifacts.enrollment-stale-negative",
        startedAt,
        "STALE_ARTIFACT_ACCEPTED",
      ),
    );
  }

  expect(drift).toEqual({
    code: "GENERATED_ARTIFACT_STALE",
    artifact: "generated/enrollment.schema.json",
  });
});

test("the generated enrollment TypeScript face exports the exact public contract roster", () => {
  const artifact = generatedArtifacts().find(
    (candidate) => candidate.relativePath === "generated/enrollment.types.ts",
  );
  expect(artifact).toBeDefined();
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
  ] as const;
  expect(artifact?.content).toBe(
    [
      "// Generated from src/enrollment.ts by `bun run generate`. Do not edit.",
      `export type { ${typeNames.join(", ")} } from "../src/enrollment.ts";`,
      "",
    ].join("\n"),
  );
});

/**
 * The one name the curated public face deliberately withholds.
 *
 * `ParsedStoaJoinUrl` is the return shape of the internal `parseStoaJoinUrl`
 * helper, not a wire contract, so it is excluded by decision rather than by
 * oversight. It is named here so that decision is reviewable: the assertion
 * below refuses a silent subtraction, so if the name is ever renamed or
 * removed this list stops matching and the exclusion must be re-justified.
 */
const ENROLLMENT_FACE_EXCLUSIONS: readonly string[] = ["ParsedStoaJoinUrl"];

test("the generated enrollment face is complete against independently derived source exports", async () => {
  // The two sides are derived INDEPENDENTLY, which is the whole point: the
  // source side is parsed out of src/enrollment.ts, the roster side out of the
  // generator's own emitted re-export line. Neither is a hand-copied list, so
  // neither can be satisfied by editing the other — the failure mode the
  // existing roster test above cannot detect, because it compares one hand-copy
  // against output derived from a second hand-copy.
  const source = await Bun.file(new URL("../../src/enrollment.ts", import.meta.url)).text();
  const declared = [...source.matchAll(/^export (?:type|interface) (\w+)/gm)].map((match) => {
    // Same noUncheckedIndexedAccess discipline the fixture inventory uses: a
    // capture that did not capture is a broken derivation, not a name.
    const name = match[1];
    if (name === undefined) throw new Error("enrollment export match captured no name");
    return name;
  });
  // A regex that silently matched nothing would make every assertion below
  // vacuously true, so the derived side must be non-empty before it is used.
  expect(declared.length).toBeGreaterThan(0);

  const excluded = new Set(ENROLLMENT_FACE_EXCLUSIONS);
  // Every declared exclusion must actually be present in source. Without this a
  // renamed or deleted exclusion would be subtracted from nothing and the face
  // would silently lose a type with the census still green.
  for (const name of ENROLLMENT_FACE_EXCLUSIONS) {
    expect(declared, name).toContain(name);
  }
  const expectedFace = declared.filter((name) => !excluded.has(name)).sort();

  const artifact = generatedArtifacts().find(
    (candidate) => candidate.relativePath === "generated/enrollment.types.ts",
  );
  expect(artifact).toBeDefined();
  const reExport = /^export type \{ (.+) \} from "\.\.\/src\/enrollment\.ts";$/m.exec(
    artifact?.content ?? "",
  );
  if (reExport === null) throw new Error("generated enrollment face has no re-export line");
  const emittedNames = reExport[1];
  if (emittedNames === undefined) {
    throw new Error("generated enrollment face re-export line captured no names");
  }
  const emittedFace = emittedNames.split(", ").sort();

  // Set equality in BOTH directions, with the offending names in the message: a
  // one-way subset check is exactly how a face can go stale while staying green.
  expect(emittedFace).toEqual(expectedFace);
});

async function jsonFixture(url: URL): Promise<unknown> {
  try {
    return JSON.parse(await Bun.file(url).text()) as unknown;
  } catch {
    throw new Error("screening generated artifact or fixture is not valid JSON");
  }
}

function combined(publicAction: unknown, operatorReceipt: unknown): Record<string, unknown> {
  return { public_action: publicAction, operator_receipt: operatorReceipt };
}

function publicAction(
  category: string,
  action: string,
  decisionPath: string,
): Record<string, string> {
  return {
    category,
    action,
    notice:
      action === "published-with-warning"
        ? decisionPath === "benign-outage-degraded"
          ? "screening-degraded"
          : "screening-warning"
        : "none",
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function packageToGenerated(value: PackageScreeningContracts): GeneratedScreeningContracts {
  return value;
}

function generatedToPackage(value: GeneratedScreeningContracts): PackageScreeningContracts {
  return value;
}

function packageActionToGenerated(
  value: PackageScreeningPublicAction,
): GeneratedScreeningPublicAction {
  return value;
}

function generatedActionToPackage(
  value: GeneratedScreeningPublicAction,
): PackageScreeningPublicAction {
  return value;
}

function packageReceiptToGenerated(
  value: PackageScreeningPromotionDecisionProvenance,
): GeneratedScreeningPromotionDecisionProvenance {
  return value;
}

function generatedReceiptToPackage(
  value: GeneratedScreeningPromotionDecisionProvenance,
): PackageScreeningPromotionDecisionProvenance {
  return value;
}

test("generated Draft 2020-12 schema accepts only the screening tuple closure", async () => {
  const validPublicAction = await jsonFixture(VALID_PUBLIC_ACTION);
  const operatorReceipt = await jsonFixture(VALID_OPERATOR_RECEIPT);
  const privatePublicAction = await jsonFixture(INVALID_PUBLIC_ACTION_PRIVATE_DETAIL);
  const privateReceipt = await jsonFixture(INVALID_OPERATOR_RECEIPT_PRIVATE_DETAIL);
  const schema = await jsonFixture(GENERATED_SCREENING_SCHEMA);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validator = ajv.compile(schema as object);
  const valid = combined(validPublicAction, operatorReceipt);
  const zodValid = ScreeningContractsSchema.safeParse(valid);

  expect(zodValid.success).toBe(true);
  if (!zodValid.success) return;
  expect(validator(valid)).toBe(true);
  expect(generatedToPackage(packageToGenerated(zodValid.data))).toEqual(zodValid.data);
  expect(generatedActionToPackage(packageActionToGenerated(zodValid.data.public_action))).toEqual(
    zodValid.data.public_action,
  );
  expect(
    generatedReceiptToPackage(packageReceiptToGenerated(zodValid.data.operator_receipt)),
  ).toEqual(zodValid.data.operator_receipt);

  const base = asRecord(operatorReceipt, "valid screening operator receipt");
  const timeout = {
    ...base,
    outcome: "quarantine",
    public_action: publicAction(
      "provider-unavailable",
      "quarantined",
      "provider-timeout-fail-closed",
    ),
    provider_status: "timeout",
    decision_path: "provider-timeout-fail-closed",
    reviewer_state: "pending-operator-review",
  };
  const providerError = {
    ...timeout,
    provider_status: "error",
    decision_path: "provider-error-fail-closed",
  };
  const warning = {
    ...base,
    outcome: "allow-with-warning",
    public_action: publicAction("injection", "published-with-warning", "provider"),
    provider_status: "ok",
    decision_path: "provider",
    reviewer_state: "not-required",
  };
  const directWarning = {
    ...warning,
    decision_path: "direct-content-warning",
  };
  const outageTimeoutWarning = {
    ...warning,
    public_action: publicAction(
      "provider-unavailable",
      "published-with-warning",
      "benign-outage-degraded",
    ),
    provider_status: "timeout",
    decision_path: "benign-outage-degraded",
  };
  const outageErrorWarning = {
    ...outageTimeoutWarning,
    provider_status: "error",
  };
  const directHold = {
    ...base,
    outcome: "quarantine",
    public_action: publicAction("dual-use-boundary", "quarantined", "direct-content-hold"),
    provider_status: "ok",
    decision_path: "direct-content-hold",
    reviewer_state: "pending-operator-review",
  };
  const directReject = {
    ...base,
    outcome: "reject",
    public_action: publicAction("injection", "rejected", "direct-content-reject"),
    provider_status: "ok",
    decision_path: "direct-content-reject",
    reviewer_state: "not-required",
  };

  for (const [label, receipt] of [
    ["provider warning", warning],
    ["direct warning", directWarning],
    ["benign outage timeout warning", outageTimeoutWarning],
    ["benign outage error warning", outageErrorWarning],
    ["direct hold", directHold],
    ["direct reject", directReject],
    ["timeout fail-closed", timeout],
    ["error fail-closed", providerError],
  ] as const) {
    const candidate = combined(receipt.public_action, receipt);
    expect(ScreeningContractsSchema.safeParse(candidate).success, label).toBe(true);
    expect(validator(candidate), label).toBe(true);
  }

  const negatives = [
    ["private public fields", combined(privatePublicAction, operatorReceipt)],
    ["private receipt fields", combined(validPublicAction, privateReceipt)],
    [
      "public face plus another receipt path",
      combined(publicAction("injection", "rejected", "provider"), operatorReceipt),
    ],
    [
      "public face plus a receipt with a different coarse category",
      combined(publicAction("injection", "quarantined", "provider-timeout-fail-closed"), timeout),
    ],
    [
      "warning with benign context",
      combined(publicAction("benign-context", "published-with-warning", "provider"), {
        ...warning,
        public_action: publicAction("benign-context", "published-with-warning", "provider"),
      }),
    ],
    [
      "warning with provider-unavailable",
      combined(publicAction("provider-unavailable", "published-with-warning", "provider"), {
        ...warning,
        public_action: publicAction("provider-unavailable", "published-with-warning", "provider"),
      }),
    ],
    [
      "warning with a hold path",
      combined(warning.public_action, {
        ...warning,
        decision_path: "provider-contextual-hold",
      }),
    ],
    [
      "warning pending review",
      combined(warning.public_action, { ...warning, reviewer_state: "pending-operator-review" }),
    ],
    [
      "warning with a plain publication action",
      combined(publicAction("injection", "published", "provider"), {
        ...warning,
        public_action: publicAction("injection", "published", "provider"),
      }),
    ],
    [
      "warning with a mismatched public category",
      combined(publicAction("dual-use-boundary", "published-with-warning", "provider"), warning),
    ],
    [
      "ok plus provider-unavailable",
      combined(
        publicAction("provider-unavailable", "quarantined", "provider-timeout-fail-closed"),
        {
          ...timeout,
          provider_status: "ok",
          decision_path: "provider-contextual-hold",
        },
      ),
    ],
    [
      "pass plus reject path",
      combined(validPublicAction, { ...base, decision_path: "direct-content-reject" }),
    ],
    [
      "timeout plus error path",
      combined(timeout.public_action, { ...timeout, decision_path: "provider-error-fail-closed" }),
    ],
    [
      "error plus timeout path",
      combined(providerError.public_action, {
        ...providerError,
        decision_path: "provider-timeout-fail-closed",
      }),
    ],
    [
      "ok plus fail-closed path",
      combined(publicAction("dual-use-boundary", "quarantined", "provider-timeout-fail-closed"), {
        ...base,
        outcome: "quarantine",
        public_action: publicAction(
          "dual-use-boundary",
          "quarantined",
          "provider-timeout-fail-closed",
        ),
        provider_status: "ok",
        decision_path: "provider-timeout-fail-closed",
        reviewer_state: "pending-operator-review",
      }),
    ],
    ["strict extra field", combined(validPublicAction, { ...base, extra: "nope" })],
  ] as const;

  for (const [label, candidate] of negatives) {
    expect(ScreeningContractsSchema.safeParse(candidate).success, label).toBe(false);
    expect(validator(candidate), label).toBe(false);
  }
});
