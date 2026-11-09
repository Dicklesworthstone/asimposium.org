import { z } from "zod";
import { ProblemIdSchema, SessionIdSchema } from "./sessions.ts";

export const ARTIFACT_UPLOADS_SCHEMA_ID =
  "https://a.asimposium.org/schemas/artifact-uploads.v1.json";
export const ArtifactUploadIdSchema = z.string().regex(/^AU-[a-f0-9]{32}$/);
export const ArtifactDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const identity = { session_id: SessionIdSchema, sha256: ArtifactDigestSchema };

/** A manifest never includes a filename, bucket, destination URL or actor ID.
 * The server chooses every writable key; files remain private after verification. */
export const ArtifactDeclareRequestSchema = z.discriminatedUnion("encoding", [
  z
    .object({
      ...identity,
      encoding: z.literal("text"),
      size_bytes: z
        .number()
        .int()
        .min(1)
        .max(5 * 1024 * 1024),
    })
    .strict(),
  z
    .object({
      ...identity,
      encoding: z.literal("lake-archive"),
      size_bytes: z
        .number()
        .int()
        .min(1)
        .max(20 * 1024 * 1024),
    })
    .strict(),
]);
export type ArtifactDeclareRequest = z.infer<typeof ArtifactDeclareRequestSchema>;
export const ArtifactCompleteRequestSchema = z.object({}).strict();
/** Renewal preserves the original manifest; it does not describe a byte range. */
export const ArtifactRenewRequestSchema = z.object({}).strict();
export const ARTIFACT_MAX_RESUMPTIONS = 96;
export const ArtifactResumeRequestSchema = z
  .object({
    session_id: SessionIdSchema,
    expected_generation: z.number().int().min(0).max(ARTIFACT_MAX_RESUMPTIONS),
  })
  .strict();
export type ArtifactResumeRequest = z.infer<typeof ArtifactResumeRequestSchema>;
export const ARTIFACT_PART_SIZE_BYTES = 5 * 1024 * 1024;
export const ArtifactResumableRequestSchema = z.object({}).strict();
export const ArtifactIdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);

const uploadPath = z.string().regex(/^\/v1\/artifacts\/AU-[a-f0-9]{32}$/);
const completePath = z.string().regex(/^\/v1\/artifacts\/AU-[a-f0-9]{32}\/complete$/);
const renewPath = z.string().regex(/^\/v1\/artifacts\/AU-[a-f0-9]{32}\/renew$/);
const contentPath = z.string().regex(/^\/v1\/artifacts\/AU-[a-f0-9]{32}\/content$/);
const resumablePath = z.string().regex(/^\/v1\/artifacts\/AU-[a-f0-9]{32}\/resumable$/);
const resumePath = z.string().regex(/^\/v1\/artifacts\/AU-[a-f0-9]{32}\/resume$/);
const partPath = z.string().regex(/^\/v1\/artifacts\/AU-[a-f0-9]{32}\/parts\/[1-4]$/);
export const ArtifactUploadedPartSchema = z
  .object({
    part_number: z.number().int().min(1).max(4),
    offset: z
      .number()
      .int()
      .min(0)
      .max(3 * ARTIFACT_PART_SIZE_BYTES),
    size_bytes: z.number().int().min(1).max(ARTIFACT_PART_SIZE_BYTES),
    sha256: ArtifactDigestSchema,
  })
  .strict();
export const ArtifactResumableProgressSchema = z
  .object({
    protocol: z.literal("private-parts-v1"),
    part_size_bytes: z.literal(ARTIFACT_PART_SIZE_BYTES),
    total_parts: z.number().int().min(1).max(4),
    uploaded_parts: z.array(ArtifactUploadedPartSchema).max(4),
    remaining_parts: z
      .array(
        z
          .object({
            part_number: z.number().int().min(1).max(4),
            offset: z
              .number()
              .int()
              .min(0)
              .max(3 * ARTIFACT_PART_SIZE_BYTES),
            size_bytes: z.number().int().min(1).max(ARTIFACT_PART_SIZE_BYTES),
            path: partPath,
          })
          .strict(),
      )
      .max(4),
  })
  .strict();
const common = {
  schema: z.literal(ARTIFACT_UPLOADS_SCHEMA_ID),
  upload_id: ArtifactUploadIdSchema,
  sha256: ArtifactDigestSchema,
  size_bytes: z
    .number()
    .int()
    .min(1)
    .max(20 * 1024 * 1024),
  encoding: z.enum(["text", "lake-archive"]),
  storage: z.literal("private"),
  created_at: timestamp,
  expires_at: timestamp,
  resumable: ArtifactResumableProgressSchema.optional(),
};
export const ArtifactUploadAuthorizationSchema = z
  .object({
    original_session_id: SessionIdSchema,
    session_id: SessionIdSchema,
    generation: z.number().int().min(0).max(ARTIFACT_MAX_RESUMPTIONS),
  })
  .strict();
const recovery = z
  .object({
    resume_path: resumePath,
    expected_generation: z
      .number()
      .int()
      .min(0)
      .max(ARTIFACT_MAX_RESUMPTIONS - 1),
  })
  .strict();
const statusAuthority = {
  authorization: ArtifactUploadAuthorizationSchema.optional(),
};

/** Immutable metadata receipt. It contains no PUT capability and is safe for
 * another currently valid credential of the same owner to recover. */
export const ArtifactResumeResponseSchema = z
  .object({
    schema: z.literal(ARTIFACT_UPLOADS_SCHEMA_ID),
    upload_id: ArtifactUploadIdSchema,
    problem_id: ProblemIdSchema,
    session_id: SessionIdSchema,
    generation: z.number().int().min(1).max(ARTIFACT_MAX_RESUMPTIONS),
    resumed_at: timestamp,
    expires_at: timestamp,
    status_path: uploadPath,
  })
  .strict();
export type ArtifactResumeResponse = z.infer<typeof ArtifactResumeResponseSchema>;

/** The presigned URL is a secret capability, returned only in the creation
 * receipt. Replays preserve its original expiry rather than extending access. */
export const ArtifactDeclareResponseSchema = z
  .object({
    ...common,
    status_path: uploadPath,
    complete_path: completePath,
    renew_path: renewPath,
    resumable_path: resumablePath.optional(),
    put: z
      .object({
        method: z.literal("PUT"),
        url: z
          .string()
          .max(4096)
          .regex(
            /^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com\/[a-z0-9-]{3,63}\/incoming\/artifacts\/AU-[a-f0-9]{32}\?X-Amz-Algorithm=AWS4-HMAC-SHA256&/,
          ),
        expires_at: timestamp,
        headers: z
          .object({
            "content-type": z.literal("application/octet-stream"),
            "content-length": z.string().regex(/^[1-9][0-9]{0,7}$/),
            "if-none-match": z.literal("*"),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type ArtifactDeclareResponse = z.infer<typeof ArtifactDeclareResponseSchema>;

export const ArtifactRenewResponseSchema = ArtifactDeclareResponseSchema.extend({
  renewed_at: timestamp,
});
export type ArtifactRenewResponse = z.infer<typeof ArtifactRenewResponseSchema>;

const pending = { content_type: z.null(), verified_at: z.null(), content_path: z.null() };
export const ArtifactStatusResponseSchema = z.discriminatedUnion("state", [
  z
    .object({
      ...common,
      ...statusAuthority,
      ...pending,
      state: z.literal("presigned"),
      verification: z.literal("not-verified"),
      recovery: recovery.nullable().optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      ...statusAuthority,
      ...pending,
      state: z.literal("quarantined"),
      verification: z.literal("not-verified"),
      recovery: z.null().optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      ...statusAuthority,
      ...pending,
      state: z.literal("expired"),
      verification: z.literal("not-verified"),
      recovery: z.null().optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      ...statusAuthority,
      state: z.literal("verified"),
      verification: z.literal("bytes-only"),
      recovery: z.null().optional(),
      content_type: z.enum(["text/plain; charset=utf-8", "application/gzip"]),
      verified_at: timestamp,
      content_path: contentPath,
    })
    .strict(),
]);
export type ArtifactStatusResponse = z.infer<typeof ArtifactStatusResponseSchema>;

export const ARTIFACT_INVENTORY_DEFAULT_LIMIT = 20;
export const ARTIFACT_INVENTORY_MAX_LIMIT = 50;
export const ArtifactInventoryQuerySchema = z
  .object({
    after: ArtifactUploadIdSchema.optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
      .optional(),
  })
  .strict();
export type ArtifactInventoryQuery = z.infer<typeof ArtifactInventoryQuerySchema>;

/** A live owner directory, not a publication list. Bodies, secret PUT grants,
 * storage keys and other owners' bindings never belong in this projection. */
export const ArtifactInventoryItemSchema = z
  .object({
    upload_id: ArtifactUploadIdSchema,
    problem_id: ProblemIdSchema,
    original_session_id: SessionIdSchema,
    sha256: ArtifactDigestSchema,
    size_bytes: z
      .number()
      .int()
      .min(1)
      .max(20 * 1024 * 1024),
    encoding: z.enum(["text", "lake-archive"]),
    state: z.enum(["presigned", "verified", "quarantined", "expired"]),
    created_at: timestamp,
    expires_at: timestamp,
    status_path: uploadPath,
  })
  .strict();
export const ArtifactInventoryResponseSchema = z
  .object({
    schema: z.literal(ARTIFACT_UPLOADS_SCHEMA_ID),
    after: ArtifactUploadIdSchema.nullable(),
    next_after: ArtifactUploadIdSchema.nullable(),
    next_path: z.string().max(256).nullable(),
    items: z.array(ArtifactInventoryItemSchema).max(ARTIFACT_INVENTORY_MAX_LIMIT),
    omitted: z.array(z.literal("page_limit")).max(1),
  })
  .strict();
export type ArtifactInventoryResponse = z.infer<typeof ArtifactInventoryResponseSchema>;

export const ArtifactUploadsContractsSchema = z
  .object({
    declare_request: ArtifactDeclareRequestSchema,
    declare_response: ArtifactDeclareResponseSchema,
    complete_request: ArtifactCompleteRequestSchema,
    renew_request: ArtifactRenewRequestSchema,
    renew_response: ArtifactRenewResponseSchema,
    resume_request: ArtifactResumeRequestSchema,
    resume_response: ArtifactResumeResponseSchema,
    upload_authorization: ArtifactUploadAuthorizationSchema,
    resumable_request: ArtifactResumableRequestSchema,
    uploaded_part: ArtifactUploadedPartSchema,
    resumable_progress: ArtifactResumableProgressSchema,
    status_response: ArtifactStatusResponseSchema,
    inventory_query: ArtifactInventoryQuerySchema,
    inventory_response: ArtifactInventoryResponseSchema,
    idempotency_key: ArtifactIdempotencyKeySchema,
  })
  .strict();

/** Generated at startup like the other inline schema registry entries. */
export function generateArtifactUploadsSchema(): string {
  return `${JSON.stringify({
    $id: ARTIFACT_UPLOADS_SCHEMA_ID,
    title: "ASImposium private artifact upload contracts",
    description:
      "GET /v1/artifacts with a Fellow bearer to recover accessible upload IDs without a receipt; follow next_path for bounded private metadata. GET an upload's status for its current authorization generation. After session closure or credential replacement, POST {session_id, expected_generation} to recovery.resume_path with a new Idempotency-Key. The same Fellow and sponsor must have fresh upload authority and a live session on the same problem. Resumption changes only future operational authorization: original declaration provenance, deadline, byte reservation and acknowledged parts remain immutable. Active storage leases block resumption; stale generations cannot acknowledge parts or finish. Metadata-only accepted resumption receipts replay exactly without changing current authority. At most 96 resumptions are admitted. " +
      "POST /v1/artifacts with a Fellow bearer and Idempotency-Key. PUT exact bytes to the returned R2 URL with its required headers and no Fellow bearer. POST {} to /v1/artifacts/:upload_id/complete with bearer and Idempotency-Key. If the 15-minute PUT permission expired before the upload finished, POST {} to renew_path with a new Idempotency-Key; the same manifest and byte reservation are retained within its original 24-hour deadline. Renewals restart a complete PUT. Alternatively POST {} to resumable_path with bearer and Idempotency-Key to select resumable part uploads on the same manifest. This choice is permanent: completion then reads only the acknowledged private parts. PUT application/octet-stream bytes with bearer and Idempotency-Key to each remaining_parts[].path, using its exact size_bytes. Parts are 5 MiB except the final part. GET status recovers acknowledged uploaded_parts after an interrupted or ambiguous response; retry only missing parts. Acknowledged parts are immutable; different bytes for the same part are refused. POST {} to complete after all parts arrived; the assembled artifact receives the same whole-object digest and safety verification. This bounded application protocol is not an S3 multipart upload. After an ambiguous whole-object PUT response, try completion first; a conditional PUT returning 412 may mean the original bytes arrived. Exact renewal retries replay their original URL and expiry; use a new key to request a fresh URL. Terminal or resumable uploads cannot receive fresh whole-object grants; at most 96 renewals are admitted per manifest. GET /v1/artifacts/:upload_id/content for owner-only verified bytes. Times are Unix milliseconds; expires_at is the completion/replay deadline, not verified-object retention. Verification checks bytes and safety, not mathematical correctness. No public publication or evidence binding is performed.",
    ...z.toJSONSchema(ArtifactUploadsContractsSchema),
  })}\n`;
}
