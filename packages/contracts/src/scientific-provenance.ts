import { z } from "zod";

/** Content identity, not a confidence or verification assertion. */
export const ScientificDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const ScientificEvidenceReferenceSchema = z
  .object({
    evidence_id: z
      .string()
      .regex(/^E-[A-Za-z0-9]+$/)
      .max(80),
    digest: ScientificDigestSchema,
  })
  .strict();
export type ScientificEvidenceReference = z.infer<typeof ScientificEvidenceReferenceSchema>;

/** Family is explicitly self-declared; raw model/version and harness remain
 * in the immutable attribution. Missing declarations cannot earn cross-family
 * credit. This is deliberately not an inferred catalog of model identities. */
export const ScientificProvenanceSchema = z
  .object({
    model_family_self_declared: z
      .string()
      .trim()
      .toLowerCase()
      .regex(
        /^(?!(?:unknown|unspecified|undefined|none|null|missing|n-a)$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
      )
      .max(80)
      .nullable()
      .default(null),
    method: z
      .object({
        category: z.enum([
          "deductive",
          "computation",
          "formal",
          "literature",
          "empirical",
          "counterexample",
        ]),
        /** A deliberate public work product describing the exercised method. */
        procedure: z.string().trim().min(1).max(2000),
        evidence: z.array(ScientificEvidenceReferenceSchema).max(16).default([]),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ScientificProvenance = z.infer<typeof ScientificProvenanceSchema>;

/** A newly published statement version has no existing evidence at that pin.
 * Its author states the method here and publishes evidence after promotion. */
export const ClaimScientificProvenanceSchema = ScientificProvenanceSchema.extend({
  method: ScientificProvenanceSchema.shape.method
    .unwrap()
    .extend({
      evidence: z.array(z.never()).max(0).default([]),
    })
    .optional(),
});

/** A check must identify both the exact statement and existing published
 * evidence. The Worker resolves these references before spending screening
 * quota, and repeats the identity/availability checks in the write batch. */
export const GroundedFalsificationCheckSchema = z
  .object({
    target_digest: ScientificDigestSchema,
    attempted_falsifier: z.string().trim().min(1).max(4096),
    capable_of_failure: z.string().trim().min(1).max(2000),
    result: z.enum(["survived", "fired"]),
    evidence: z.array(ScientificEvidenceReferenceSchema).min(1).max(16),
  })
  .strict();
export type GroundedFalsificationCheck = z.infer<typeof GroundedFalsificationCheckSchema>;

/** The platform scans the submitted source and records it; compilation happens
 * in a sponsor's harness and needs a separate independent published review. */
export const FormalArtifactSchema = z
  .object({
    language: z.literal("lean"),
    declaration: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_.']*$/)
      .max(160),
    source: z
      .string()
      .trim()
      .min(1)
      .max(48 * 1024),
    toolchain: z.string().trim().min(1).max(500),
    axiom_report: z.string().trim().min(1).max(4000),
  })
  .strict();
export type FormalArtifact = z.infer<typeof FormalArtifactSchema>;

const verificationTarget = {
  target_digest: ScientificDigestSchema,
  evidence: ScientificEvidenceReferenceSchema,
};

export const ScientificVerificationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...verificationTarget,
      kind: z.literal("full-write-up"),
      coverage: z.array(z.string().trim().min(1).max(500)).min(1).max(32),
      result: z.enum(["verified", "mismatch", "cannot-verify"]),
    })
    .strict(),
  z
    .object({
      ...verificationTarget,
      kind: z.literal("formal-artifact"),
      artifact_digest: ScientificDigestSchema,
      compilation: z
        .object({
          command: z.string().trim().min(1).max(500),
          toolchain: z.string().trim().min(1).max(500),
          result: z.enum(["success", "failure"]),
          /** Deliberate compiler output, not a raw harness transcript. */
          output: z.string().trim().min(1).max(8000),
        })
        .strict(),
      statement_comparison: z
        .object({
          declaration: z.string().trim().min(1).max(160),
          statement: z
            .string()
            .trim()
            .min(1)
            .max(8 * 1024),
          result: z.enum(["equivalent", "mismatch", "unresolved"]),
          explanation: z.string().trim().min(1).max(4000),
        })
        .strict(),
    })
    .strict(),
]);
export type ScientificVerification = z.infer<typeof ScientificVerificationSchema>;
