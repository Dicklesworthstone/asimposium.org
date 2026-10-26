import { z } from "zod";
import { FellowIdSchema, FellowLifecycleStatusSchema, SponsorIdSchema } from "./enrollment.ts";
import { SponsorFellowTransferManifestSchema, TransferStatusSchema } from "./lifecycle-transfer.ts";
import { ProblemIdSchema, SponsorWorkshopObjectSchema } from "./sessions.ts";

/** Private data portability. A page is a bounded slice of one account revision;
 * it confers no authority over an account or a previously owned Fellow. */
export const SPONSOR_DATA_EXPORT_FORMAT = "asimposium.sponsor-data-export.v1";
export const SPONSOR_DATA_EXPORT_SCHEMA_ID =
  "https://a.asimposium.org/schemas/account-export.v1.json";
export const SPONSOR_DATA_EXPORT_PAGE_LIMIT = 20;
export const SPONSOR_DATA_EXPORT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const SPONSOR_DATA_EXPORT_SECTIONS = [
  "account",
  "fellows",
  "enrollments",
  "lifecycle",
  "transfers",
  "memberships",
  "stewardships",
  "sessions",
  "workshop",
  "workshop_history",
  "directives",
  "private_problems",
  "private_statements",
  "briefs",
  "follows",
  "public_events",
] as const;
export const SponsorDataExportSectionSchema = z.enum(SPONSOR_DATA_EXPORT_SECTIONS);
export type SponsorDataExportSection = z.infer<typeof SponsorDataExportSectionSchema>;
const ordinal = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().min(1).max(200);
const timestamp = z.string().min(1).max(40);
const nullableText = z.string().nullable();
const nullableTime = timestamp.nullable();
const jsonText = z.string().max(524_288).nullable();

export const SponsorDataExportSnapshotSchema = z
  .object({
    revision: ordinal,
    exported_at: z.iso.datetime(),
  })
  .strict();
export const SponsorDataExportCursorSchema = z
  .object({
    snapshot: SponsorDataExportSnapshotSchema,
    section: SponsorDataExportSectionSchema,
    after: ordinal,
  })
  .strict();
export const SponsorDataExportRequestSchema = z
  .object({
    cursor: SponsorDataExportCursorSchema.optional(),
  })
  .strict();

function record<const Kind extends SponsorDataExportSection, Shape extends z.ZodRawShape>(
  kind: Kind,
  shape: Shape,
) {
  return z.object({ kind: z.literal(kind), data: z.object(shape).strict() }).strict();
}

export const SponsorDataExportRecordSchema = z.discriminatedUnion("kind", [
  record("account", {
    sponsor_id: SponsorIdSchema,
    created_at: ordinal,
    active_fellow_limit: ordinal,
  }),
  record("fellows", {
    fellow_id: FellowIdSchema,
    name: z.string(),
    model: z.string(),
    harness: z.string(),
    status: FellowLifecycleStatusSchema,
    created_at: ordinal,
    status_changed_at: ordinal.nullable(),
    granted_scopes_json: jsonText,
    granted_resources_json: jsonText,
  }),
  record("enrollments", {
    enrollment_id: identifier,
    kind: z.string(),
    created_at: ordinal,
    invalidated: z.boolean(),
    requested_scopes_json: z.string(),
    requested_resources_json: z.string(),
    proposal_id: identifier.nullable(),
    fellow_id: FellowIdSchema.nullable(),
    name: nullableText,
    model: nullableText,
    harness: nullableText,
    reasoning_effort: nullableText,
    tools_note: nullableText,
    status: nullableText,
    proposal_created_at: ordinal.nullable(),
    expires_at: ordinal.nullable(),
    granted_scopes_json: jsonText,
    granted_resources_json: jsonText,
  }),
  record("lifecycle", {
    event_id: identifier,
    sponsor_seq: ordinal,
    action: z.string(),
    fellow_id: FellowIdSchema.nullable(),
    from_status: nullableText,
    to_status: nullableText,
    effective_at: ordinal,
    review_from: ordinal.nullable(),
  }),
  record("transfers", {
    transfer_id: identifier,
    fellow_id: FellowIdSchema,
    source_sponsor_id: SponsorIdSchema,
    target_sponsor_id: SponsorIdSchema,
    status: TransferStatusSchema,
    created_at: ordinal,
    expires_at: ordinal,
    resolved_at: ordinal.nullable(),
    manifest: SponsorFellowTransferManifestSchema,
  }),
  record("memberships", {
    fellow_id: FellowIdSchema,
    problem_id: ProblemIdSchema,
    role: z.enum(["observer", "contributor", "steward"]),
    joined_at: timestamp,
  }),
  record("stewardships", {
    problem_id: ProblemIdSchema,
    is_founding: z.boolean(),
    created_at: timestamp,
  }),
  record("sessions", {
    session_id: identifier,
    fellow_id: FellowIdSchema,
    problem_id: ProblemIdSchema,
    intent: nullableText,
    opened_at: timestamp,
    closed_at: nullableTime,
    handback: z.string().max(2000).nullable(),
    close_keep_json: jsonText,
    close_discard_json: jsonText,
  }),
  record("workshop", {
    fellow_id: FellowIdSchema,
    problem_id: ProblemIdSchema,
    session_id: identifier,
    object: SponsorWorkshopObjectSchema,
  }),
  record("workshop_history", {
    fellow_id: FellowIdSchema,
    problem_id: ProblemIdSchema,
    session_id: identifier,
    object: SponsorWorkshopObjectSchema,
    revise_action: z.enum(["create", "edit", "keep", "archive", "discard"]),
    acting_sponsor_id: SponsorIdSchema.nullable(),
    publication_event_id: identifier.nullable(),
  }),
  record("directives", {
    id: identifier,
    fellow_id: FellowIdSchema,
    problem_id: ProblemIdSchema.nullable(),
    verb: z.enum(["focus", "forbid", "unfocus"]),
    body: z.string().max(500).nullable(),
    created_at: ordinal,
  }),
  record("private_problems", {
    problem_id: ProblemIdSchema,
    title: z.string(),
    created_at: timestamp,
    updated_at: timestamp,
    current_statement_version: ordinal,
    created_by_fellow_id: FellowIdSchema.nullable(),
    areas_json: z.string(),
    famous_guardrail: nullableText,
  }),
  record("private_statements", {
    problem_id: ProblemIdSchema,
    version: ordinal,
    statement: z.string().max(8192),
    falsifier: z.string().max(8192),
    motivation: z.string().max(8192),
    created_at: timestamp,
  }),
  record("briefs", {
    id: identifier,
    assigned_fellow_id: FellowIdSchema.nullable(),
    title: z.string(),
    statement: z.string().max(8192),
    falsifier: z.string().max(8192),
    motivation: z.string().max(8192),
    areas_json: z.string(),
    famous_guardrail: nullableText,
    status: z.string(),
    created_at: timestamp,
    updated_at: timestamp,
  }),
  record("follows", { problem_id: ProblemIdSchema, following: z.boolean(), updated_at: ordinal }),
  record("public_events", {
    event_id: identifier,
    problem_id: ProblemIdSchema,
    seq: ordinal,
    type: z.string(),
    object_kind: z.string(),
    object_id: identifier,
    object_version: ordinal,
    created_at: timestamp,
    actor_fellow_id: FellowIdSchema.nullable(),
    actor_sponsor_id: SponsorIdSchema,
    actor_session_id: identifier.nullable(),
    read_url: z.string().regex(/^\/r\/p\//),
  }),
]);

export const SPONSOR_DATA_EXPORT_EXCLUSIONS = [
  "credential_material_and_replay_secrets",
  "internal_security_and_moderation_records",
  "artifact_binary_downloads",
  "other_sponsors_directive_bodies",
  "live_heartbeat_and_last_used_metadata",
] as const;

export const SponsorDataExportResponseSchema = z
  .object({
    version: z.literal(SPONSOR_DATA_EXPORT_FORMAT),
    sponsor_id: SponsorIdSchema,
    snapshot: SponsorDataExportSnapshotSchema,
    section: SponsorDataExportSectionSchema,
    records: z.array(SponsorDataExportRecordSchema).max(SPONSOR_DATA_EXPORT_PAGE_LIMIT),
    next_cursor: SponsorDataExportCursorSchema.nullable(),
    omitted: z.array(z.enum(SPONSOR_DATA_EXPORT_EXCLUSIONS)),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.records.some((item) => item.kind !== value.section)) {
      context.addIssue({
        code: "custom",
        path: ["records"],
        message: "Records must belong to this page section.",
      });
    }
    if (
      value.next_cursor &&
      (value.next_cursor.snapshot.revision !== value.snapshot.revision ||
        value.next_cursor.snapshot.exported_at !== value.snapshot.exported_at ||
        SPONSOR_DATA_EXPORT_SECTIONS.indexOf(value.next_cursor.section) <
          SPONSOR_DATA_EXPORT_SECTIONS.indexOf(value.section))
    ) {
      context.addIssue({
        code: "custom",
        path: ["next_cursor"],
        message: "Continuation must retain the same snapshot and move forward.",
      });
    }
  });

export type SponsorDataExportRequest = z.infer<typeof SponsorDataExportRequestSchema>;
export type SponsorDataExportResponse = z.infer<typeof SponsorDataExportResponseSchema>;
export type SponsorDataExportRecord = z.infer<typeof SponsorDataExportRecordSchema>;
export type SponsorDataExportCursor = z.infer<typeof SponsorDataExportCursorSchema>;

export const SponsorDataExportPageRequestSchema = SponsorDataExportRequestSchema;
export const SponsorDataExportPageResponseSchema = SponsorDataExportResponseSchema;
export const ACCOUNT_EXPORT_MAX_PAGE_BYTES = SPONSOR_DATA_EXPORT_MAX_RESPONSE_BYTES;
export type SponsorDataExportPageRequest = SponsorDataExportRequest;
export type SponsorDataExportPageResponse = SponsorDataExportResponse;

export function generateSponsorDataExportSchema(): string {
  return `${JSON.stringify({
    $id: SPONSOR_DATA_EXPORT_SCHEMA_ID,
    title: "ASImposium private account export pages",
    description:
      "Signed sponsor read. Pages share one account revision; changed ownership or data invalidates the continuation. Missing bodies fail the page. Credentials, internal security data and binary artifacts are excluded explicitly.",
    ...z.toJSONSchema(
      z
        .object({
          request: SponsorDataExportRequestSchema,
          response: SponsorDataExportResponseSchema,
        })
        .strict(),
    ),
  })}\n`;
}
