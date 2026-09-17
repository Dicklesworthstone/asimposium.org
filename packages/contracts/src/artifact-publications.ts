import { z } from "zod";

export const ARTIFACT_PUBLICATIONS_SCHEMA_ID = "https://a.asimposium.org/schemas/artifact-publications.v1.json";
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const problemId = z.string().regex(/^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/);
const publicationId = z.string().regex(/^AP-[a-f0-9]{32}$/);
const evidenceId = z.string().regex(/^E-[A-Za-z0-9]{1,78}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const cursor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const statusPath = z.string().regex(/^\/v1\/artifact-publications\/AP-[a-f0-9]{32}$/);
const manifestPath = z.string().regex(/^\/p\/P-[A-Z0-9][A-Z0-9-]{1,30}\/artifacts\/AP-[a-f0-9]{32}\.json$/);
const downloadUrl = z.string().regex(/^https:\/\/artifacts(?:-staging)?\.asimposium\.org\/sha256\/[a-f0-9]{64}$/);
const listPath = z.string().regex(/^\/p\/P-[A-Z0-9][A-Z0-9-]{1,30}\/evidence\/E-[A-Za-z0-9]{1,78}\/artifacts\.json\?after=(?:0|[1-9][0-9]*)(?:&through=(?:0|[1-9][0-9]*))?$/);

/** Only this explicit consent shape may enqueue publication. Upload completion
 * is private and byte-only; it cannot imply a public license or evidence link. */
export const ArtifactPublicationRequestSchema = z.object({
  session_id: z.string().regex(/^S-[A-Za-z0-9]{26}$/), evidence_id: evidenceId,
  evidence_digest: digest, publish: z.literal(true), license: z.literal("CC-BY-4.0"),
}).strict();
export type ArtifactPublicationRequest = z.infer<typeof ArtifactPublicationRequestSchema>;

const receipt = {
  schema: z.literal(ARTIFACT_PUBLICATIONS_SCHEMA_ID), publication_id: publicationId,
  problem_id: problemId, event_id: safeId, seq: positive, sha256: hash,
  evidence_id: evidenceId, evidence_digest: digest, license: z.literal("CC-BY-4.0"),
  verification: z.literal("bytes-only"), initial_delivery: z.literal("queued"),
  status_path: statusPath, manifest_path: manifestPath,
};
export const ArtifactPublicationReceiptSchema = z.object(receipt).strict();
export const ArtifactPublicationStatusSchema = z.discriminatedUnion("delivery", [
  z.object({ ...receipt, delivery: z.literal("queued"), release_authorized: z.literal(false),
    published_at: z.null(), download_url: z.null(), appeal_path: z.null() }).strict(),
  z.object({ ...receipt, delivery: z.literal("held"), release_authorized: z.literal(false),
    published_at: z.null(), download_url: z.null(), appeal_path: z.literal("/policy.md") }).strict(),
  z.object({ ...receipt, delivery: z.literal("release-authorized"), release_authorized: z.literal(true),
    published_at: z.null(), download_url: z.null(), appeal_path: z.null() }).strict(),
  z.object({ ...receipt, delivery: z.literal("published"), release_authorized: z.literal(true),
    published_at: positive, download_url: downloadUrl, appeal_path: z.null() }).strict(),
]);
export const PublicArtifactManifestSchema = z.object({
  schema: z.literal(ARTIFACT_PUBLICATIONS_SCHEMA_ID), publication_id: publicationId, problem_id: problemId,
  evidence: z.object({ evidence_id: evidenceId, event_id: safeId, digest }).strict(),
  artifact: z.object({ sha256: hash, size_bytes: positive.max(20 * 1024 * 1024),
    encoding: z.enum(["text", "lake-archive"]),
    content_type: z.enum(["text/plain; charset=utf-8", "application/gzip"]), download_url: downloadUrl }).strict(),
  author: z.object({ fellow_id: safeId, sponsor_id: safeId }).strict(),
  publication_event: z.object({ event_id: safeId, seq: positive, digest }).strict(),
  license: z.literal("CC-BY-4.0"), verification: z.literal("bytes-only"),
  published_at: positive, delivery_cursor: positive,
}).strict();
export const EvidenceArtifactsSchema = z.object({
  schema: z.literal(ARTIFACT_PUBLICATIONS_SCHEMA_ID), problem_id: problemId, evidence_id: evidenceId,
  after: cursor, through: cursor, artifacts: z.array(PublicArtifactManifestSchema).max(20),
  next_after: positive.nullable(), next_path: listPath.nullable(), poll_path: listPath,
}).strict();
export type ArtifactPublicationReceipt = z.infer<typeof ArtifactPublicationReceiptSchema>;
export type ArtifactPublicationStatus = z.infer<typeof ArtifactPublicationStatusSchema>;
export type PublicArtifactManifest = z.infer<typeof PublicArtifactManifestSchema>;
export type EvidenceArtifacts = z.infer<typeof EvidenceArtifactsSchema>;

export function generateArtifactPublicationsSchema(): string {
  return `${JSON.stringify({ $id: ARTIFACT_PUBLICATIONS_SCHEMA_ID,
    title: "ASImposium evidence-bound artifact publication",
    description: "POST /v1/artifacts/:upload_id/publish with a Fellow bearer and Idempotency-Key accepts explicit CC-BY consent; 202 is acceptance, not delivery. GET /v1/artifact-publications/:publication_id reads private status. GET /p/:problem/artifacts/:publication_id.json reads public provenance. GET /p/:problem/evidence/:evidence_id/artifacts.json pages by delivery cursor (after, through), not request-event time. All artifact verification is bytes-only, not scientific certification. Release authorization is irreversible; held is not a public download.",
    ...z.toJSONSchema(z.object({ request: ArtifactPublicationRequestSchema,
      receipt: ArtifactPublicationReceiptSchema, status: ArtifactPublicationStatusSchema,
      manifest: PublicArtifactManifestSchema, evidence_artifacts: EvidenceArtifactsSchema }).strict()),
  })}\n`;
}
