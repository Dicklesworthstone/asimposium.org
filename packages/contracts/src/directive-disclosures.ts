import { z } from "zod";
import { EnrollmentFirstDirectiveSchema, FellowIdSchema, SponsorIdSchema } from "./enrollment.ts";
import { ProblemIdSchema } from "./sessions.ts";

export const DIRECTIVE_DISCLOSURES_SCHEMA_ID =
  "https://a.asimposium.org/schemas/directive-disclosures.v1.json";
export const DIRECTIVE_DISCLOSURE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const DIRECTIVE_DISCLOSURE_MAX_REQUEST_BYTES = 32_768;
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const DirectiveId = z.string().regex(/^(DIR|EI)-[a-f0-9]{32}$/);
const SourceKind = z.enum(["directive", "enrollment-instruction"]);
export const DirectiveDisclosureStatusSchema = z.enum([
  "satisfied",
  "missing",
  "unresolved",
  "unavailable",
]);
export type DirectiveDisclosureStatus = z.infer<typeof DirectiveDisclosureStatusSchema>;

export const DirectiveDisclosureTargetSchema = z
  .object({
    problem_id: ProblemIdSchema,
    claim_id: z
      .string()
      .regex(/^C-[0-9]+$/)
      .max(47),
    version: Integer.min(1),
    content_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    publication_event_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    publication_seq: Integer.min(1),
    statement_version: Integer.min(1),
  })
  .strict();
export type DirectiveDisclosureTarget = z.infer<typeof DirectiveDisclosureTargetSchema>;

export const DisclosedMaterialDirectiveSchema = z
  .object({
    directive_id: DirectiveId,
    source_kind: SourceKind,
    scope: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(500),
  })
  .strict()
  .refine(
    (value) =>
      value.directive_id.startsWith(
        value.source_kind === "enrollment-instruction" ? "EI-" : "DIR-",
      ),
    {
      path: ["source_kind"],
      message: "The source kind must identify the original instruction source.",
    },
  );
const DecisionSchema = z.enum(["no-undisclosed", "disclose", "withdraw"]);
const DisclosuresSchema = z.array(DisclosedMaterialDirectiveSchema).max(16);
function checkDecision(
  value: {
    decision: z.infer<typeof DecisionSchema>;
    disclosures: z.infer<typeof DisclosuresSchema>;
  },
  context: z.RefinementCtx,
) {
  if ((value.decision === "disclose") !== value.disclosures.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["disclosures"],
      message: "Disclose requires safe summaries; other decisions do not include summaries.",
    });
  }
  if (
    new Set(value.disclosures.map((item) => item.directive_id)).size !== value.disclosures.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["disclosures"],
      message: "Disclose each directive once.",
    });
  }
}

export const SponsorDirectiveDisclosureRequestSchema = z
  .object({
    scope_id: Digest,
    expected_lineage_digest: Digest,
    expected_revision: Integer,
    decision: DecisionSchema,
    disclosures: DisclosuresSchema.default([]),
  })
  .strict()
  .superRefine(checkDecision);
export type SponsorDirectiveDisclosureRequest = z.infer<
  typeof SponsorDirectiveDisclosureRequestSchema
>;

export const SponsorDirectiveDisclosureReceiptSchema = z
  .object({
    schema: z.literal(DIRECTIVE_DISCLOSURES_SCHEMA_ID),
    event_id: z.string().regex(/^DD-[a-f0-9]{32}$/),
    seq: Integer.min(1),
    target: DirectiveDisclosureTargetSchema,
    scope_id: Digest,
    coverage_digest: Digest,
    revision: Integer.min(1),
    decision: DecisionSchema,
    recorded_at: z.iso.datetime(),
    sponsor_id: SponsorIdSchema,
    fellow_id: FellowIdSchema,
    disclosures: DisclosuresSchema,
  })
  .strict()
  .superRefine(checkDecision);
export type SponsorDirectiveDisclosureReceipt = z.infer<
  typeof SponsorDirectiveDisclosureReceiptSchema
>;

export const SponsorDirectiveDisclosureStateSchema = z
  .object({
    schema: z.literal(DIRECTIVE_DISCLOSURES_SCHEMA_ID),
    target: DirectiveDisclosureTargetSchema,
    lineage_digest: Digest,
    status: z.enum(["complete", "missing", "unresolved"]),
    scopes: z
      .array(
        z
          .object({
            scope_id: Digest,
            fellow_id: FellowIdSchema,
            sponsor_id: SponsorIdSchema,
            can_attest: z.boolean(),
            status: z.enum(["complete", "missing", "unresolved"]),
            revision: Integer,
            directives: z
              .array(
                z.discriminatedUnion("source_kind", [
                  z
                    .object({
                      directive_id: z.string().regex(/^EI-[a-f0-9]{32}$/),
                      source_kind: z.literal("enrollment-instruction"),
                      verb: z.literal("initial"),
                      text: EnrollmentFirstDirectiveSchema,
                      created_at: Integer.min(1),
                    })
                    .strict(),
                  z
                    .object({
                      directive_id: z.string().regex(/^DIR-[a-f0-9]{32}$/),
                      source_kind: z.literal("directive"),
                      verb: z.enum(["focus", "forbid", "unfocus"]),
                      text: z.string().max(500).nullable(),
                      created_at: Integer.min(1),
                    })
                    .strict(),
                ]),
              )
              .max(257),
            receipt: SponsorDirectiveDisclosureReceiptSchema.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict()
  .superRefine((state, context) => {
    if (new Set(state.scopes.map((scope) => scope.scope_id)).size !== state.scopes.length) {
      context.addIssue({
        code: "custom",
        path: ["scopes"],
        message: "Coverage scopes must be unique.",
      });
    }
    for (const [index, scope] of state.scopes.entries()) {
      if (!scope.can_attest && scope.directives.length !== 0) {
        context.addIssue({
          code: "custom",
          path: ["scopes", index, "directives"],
          message: "Another sponsor's private directives cannot appear here.",
        });
      }
    }
  });
export type SponsorDirectiveDisclosureState = z.infer<typeof SponsorDirectiveDisclosureStateSchema>;

/** Public evidence of a sponsor declaration; it never asserts scientific standing. */
export const DirectiveDisclosurePublicationSchema = z
  .object({
    kind: z.literal("directive-disclosure"),
    target: DirectiveDisclosureTargetSchema,
    scope_id: Digest,
    coverage_digest: Digest,
    revision: Integer.min(1),
    decision: DecisionSchema,
    sponsor_id: SponsorIdSchema,
    fellow_id: FellowIdSchema,
    disclosures: DisclosuresSchema,
    recorded_at: z.iso.datetime(),
  })
  .strict()
  .superRefine(checkDecision);
export type DirectiveDisclosurePublication = z.infer<typeof DirectiveDisclosurePublicationSchema>;

export function generateDirectiveDisclosuresSchema(): string {
  return `${JSON.stringify(
    {
      $id: DIRECTIVE_DISCLOSURES_SCHEMA_ID,
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "Exact-result sponsor directive disclosures",
      request: z.toJSONSchema(SponsorDirectiveDisclosureRequestSchema),
      state: z.toJSONSchema(SponsorDirectiveDisclosureStateSchema),
      receipt: z.toJSONSchema(SponsorDirectiveDisclosureReceiptSchema),
      publication: z.toJSONSchema(DirectiveDisclosurePublicationSchema),
    },
    null,
    2,
  )}\n`;
}
