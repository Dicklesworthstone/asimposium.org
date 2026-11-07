import { z } from "zod";
import { PRODUCTION_STOA_ORIGIN, STAGING_STOA_ORIGIN } from "./enrollment.ts";

export const READINESS_SCHEMA_ID = "https://a.asimposium.org/schemas/readiness.v1.json";
export const MAX_READINESS_RECEIPT_BYTES = 16 * 1024;
export const ReadinessRevisionSchema = z
  .string()
  .length(40)
  .regex(/^[0-9a-f]{40}$/);
export const ReadinessDigestSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/);
export const ReadinessEnvironmentSchema = z.enum(["production", "staging"]);

const IdentityShape = {
  revision: ReadinessRevisionSchema,
  environment: ReadinessEnvironmentSchema,
  origin: z.enum([PRODUCTION_STOA_ORIGIN, STAGING_STOA_ORIGIN]),
  run_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}(?![\s\S])/),
};
const ObservationShape = {
  observed_at: z.iso.datetime({ precision: 3 }).length(24),
  expires_at: z.iso.datetime({ precision: 3 }).length(24),
};

/** The order also binds the enrollment-to-publication journey, not just endpoint reachability. */
export const REQUIRED_READINESS_PROOFS = [
  { capability: "enrollment", proof_id: "sponsor_approved_fellow" },
  { capability: "sessions", proof_id: "session_opened" },
  { capability: "packs", proof_id: "session_pack_read" },
  { capability: "workshop", proof_id: "workshop_pushed" },
  { capability: "promotion", proof_id: "claim_promoted" },
  { capability: "public_ledger_delta", proof_id: "diptych_delta_visible" },
  { capability: "cursor", proof_id: "cursor_advanced" },
  { capability: "visible_budgets", proof_id: "write_budgets_visible" },
] as const;

function proofSchema<C extends string, P extends string>(proof: {
  readonly capability: C;
  readonly proof_id: P;
}) {
  return z.strictObject({
    capability: z.literal(proof.capability),
    proof_id: z.literal(proof.proof_id),
    result: z.literal("pass"),
    ...IdentityShape,
    ...ObservationShape,
    evidence_sha256: ReadinessDigestSchema,
  });
}

/**
 * Operator-authorized, retained mock-free evidence. A tuple deliberately makes
 * missing, duplicate, reordered, and invented proofs invalid in JSON Schema too.
 * This contract carries digests only; private journey payloads stay private.
 */
export const ReadinessReceiptSchema = z.strictObject({
  schema: z.literal(READINESS_SCHEMA_ID),
  record: z.literal("readiness_receipt"),
  mode: z.literal("mock_free"),
  ...IdentityShape,
  ...ObservationShape,
  proofs: z.tuple([
    proofSchema(REQUIRED_READINESS_PROOFS[0]),
    proofSchema(REQUIRED_READINESS_PROOFS[1]),
    proofSchema(REQUIRED_READINESS_PROOFS[2]),
    proofSchema(REQUIRED_READINESS_PROOFS[3]),
    proofSchema(REQUIRED_READINESS_PROOFS[4]),
    proofSchema(REQUIRED_READINESS_PROOFS[5]),
    proofSchema(REQUIRED_READINESS_PROOFS[6]),
    proofSchema(REQUIRED_READINESS_PROOFS[7]),
  ]),
});

export const ReadinessUnavailableReasonSchema = z.enum([
  "origin_unavailable",
  "revision_unavailable",
  "build_revision_mismatch",
  "receipt_unconfigured",
  "receipt_configuration_invalid",
  "receipt_unavailable",
  "receipt_oversize",
  "receipt_digest_mismatch",
  "invalid_evidence",
  "mixed_evidence",
  "origin_mismatch",
  "environment_mismatch",
  "revision_mismatch",
  "future_evidence",
  "expired_evidence",
  "capabilities_unavailable",
]);

export const ReadinessStatusSchema = z.discriminatedUnion("status", [
  z.strictObject({
    schema: z.literal(READINESS_SCHEMA_ID),
    status: z.literal("unavailable"),
    reason: ReadinessUnavailableReasonSchema,
  }),
  z.strictObject({
    schema: z.literal(READINESS_SCHEMA_ID),
    status: z.literal("ready"),
    receipt_sha256: ReadinessDigestSchema,
    receipt: ReadinessReceiptSchema,
  }),
]);

export const ReadinessContractsSchema = z.union([ReadinessReceiptSchema, ReadinessStatusSchema]);
export type ReadinessReceipt = z.infer<typeof ReadinessReceiptSchema>;
export type ReadinessStatus = z.infer<typeof ReadinessStatusSchema>;
export type ReadinessUnavailableReason = z.infer<typeof ReadinessUnavailableReasonSchema>;
export type ReadinessEnvironment = z.infer<typeof ReadinessEnvironmentSchema>;

export function readinessEnvironmentForOrigin(
  origin: string | undefined,
): ReadinessEnvironment | undefined {
  if (origin === PRODUCTION_STOA_ORIGIN) return "production";
  if (origin === STAGING_STOA_ORIGIN) return "staging";
  return undefined;
}

export function unavailableReadiness(reason: ReadinessUnavailableReason): ReadinessStatus {
  return { schema: READINESS_SCHEMA_ID, status: "unavailable", reason };
}

/** Canonical retained bytes: fixed Zod field order, compact JSON, one newline. */
export function canonicalReadinessReceipt(receipt: ReadinessReceipt): string {
  return `${JSON.stringify(ReadinessReceiptSchema.parse(receipt))}\n`;
}

/** Cross-field checks shared by Stoa and Agora, after strict schema validation. */
export function readinessReceiptProblem(
  receipt: ReadinessReceipt,
  expected: { readonly origin: string; readonly revision: string; readonly now: number },
): ReadinessUnavailableReason | undefined {
  if (receipt.origin !== expected.origin) return "origin_mismatch";
  if (receipt.environment !== readinessEnvironmentForOrigin(expected.origin)) {
    return "environment_mismatch";
  }
  if (receipt.revision !== expected.revision) return "revision_mismatch";
  if (!Number.isFinite(expected.now)) return "invalid_evidence";

  const observed = Date.parse(receipt.observed_at);
  const expires = Date.parse(receipt.expires_at);
  let lastJourneyObservation = Number.NEGATIVE_INFINITY;
  let latestObservation = Number.NEGATIVE_INFINITY;
  let earliestExpiry = Number.POSITIVE_INFINITY;
  for (const [index, proof] of receipt.proofs.entries()) {
    if (
      proof.revision !== receipt.revision ||
      proof.environment !== receipt.environment ||
      proof.origin !== receipt.origin ||
      proof.run_id !== receipt.run_id
    ) {
      return "mixed_evidence";
    }
    const proofObserved = Date.parse(proof.observed_at);
    const proofExpires = Date.parse(proof.expires_at);
    if (proofObserved >= proofExpires) return "invalid_evidence";
    // Cursor and budgets are separate proofs; the first six form one journey.
    if (index < 6) {
      if (proofObserved < lastJourneyObservation) return "mixed_evidence";
      lastJourneyObservation = proofObserved;
    }
    latestObservation = Math.max(latestObservation, proofObserved);
    earliestExpiry = Math.min(earliestExpiry, proofExpires);
  }
  if (observed !== latestObservation || expires !== earliestExpiry || observed >= expires) {
    return "invalid_evidence";
  }
  if (observed > expected.now) return "future_evidence";
  if (expires <= expected.now) return "expired_evidence";
  return undefined;
}

export function generateReadinessSchema(): string {
  return `${JSON.stringify(
    {
      $id: READINESS_SCHEMA_ID,
      title: "ASImposium revision-bound research readiness evidence",
      description:
        "Complete mock-free journey proofs, or the readiness result embedded in /capabilities. The receipt must also match the serving revision, origin, environment, and current time; reachability alone is never readiness.",
      ...z.toJSONSchema(ReadinessContractsSchema),
    },
    null,
    2,
  )}\n`;
}
