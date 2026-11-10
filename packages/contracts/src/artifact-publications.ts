import { z } from "zod";
import { ScreeningPublicationNoticeSchema } from "./screening.ts";

export const ARTIFACT_PUBLICATIONS_SCHEMA_ID =
  "https://a.asimposium.org/schemas/artifact-publications.v1.json";
export const ARTIFACT_PUBLICATION_MAX_RETRIES = 8;
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const problemId = z.string().regex(/^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/);
const publicationId = z.string().regex(/^AP-[a-f0-9]{32}$/);
const evidenceId = z.string().regex(/^E-[A-Za-z0-9]{1,78}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const cursor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const statusPath = z.string().regex(/^\/v1\/artifact-publications\/AP-[a-f0-9]{32}$/);
const retryPath = z.string().regex(/^\/v1\/artifact-publications\/AP-[a-f0-9]{32}\/retry$/);
const manifestPath = z
  .string()
  .regex(/^\/p\/P-[A-Z0-9][A-Z0-9-]{1,30}\/artifacts\/AP-[a-f0-9]{32}\.json$/);
const downloadUrl = z
  .string()
  .regex(/^https:\/\/artifacts(?:-staging)?\.asimposium\.org\/sha256\/[a-f0-9]{64}$/);
const listPath = z
  .string()
  .regex(
    /^\/p\/P-[A-Z0-9][A-Z0-9-]{1,30}\/evidence\/E-[A-Za-z0-9]{1,78}\/artifacts\.json\?after=(?:0|[1-9][0-9]*)(?:&through=(?:0|[1-9][0-9]*))?&evidence_digest=sha256:[a-f0-9]{64}$/,
  );

const queryCursor = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$(?![\s\S])/)
  .refine((value) => Number.isSafeInteger(Number(value)), "Use a safe-integer delivery cursor.");

/** Delivery cursors belong to the global publication stream, not a claim's
 * problem-local ledger snapshot. The optional digest pins the evidence source
 * while following current availability, including after later deliveries. */
export const EvidenceArtifactsQuerySchema = z
  .object({
    after: queryCursor.optional(),
    through: queryCursor.optional(),
    evidence_digest: digest.optional(),
  })
  .strict()
  .refine(
    (query) => query.through === undefined || Number(query.through) >= Number(query.after ?? 0),
    "The delivery cutoff must be at least after.",
  );
export type EvidenceArtifactsQuery = z.infer<typeof EvidenceArtifactsQuerySchema>;

export function evidenceArtifactsPath(
  problem: string,
  evidence: string,
  format: "json" | "md" | "human",
  query: EvidenceArtifactsQuery = {},
): string {
  const parsed = EvidenceArtifactsQuerySchema.parse(query);
  const suffix = format === "human" ? "" : `.${format}`;
  const path = `/p/${problemId.parse(problem)}/evidence/${evidenceId.parse(evidence)}/artifacts${suffix}`;
  const values = [
    ...(parsed.after === undefined ? [] : [`after=${parsed.after}`]),
    ...(parsed.through === undefined ? [] : [`through=${parsed.through}`]),
    ...(parsed.evidence_digest === undefined ? [] : [`evidence_digest=${parsed.evidence_digest}`]),
  ];
  return `${path}${values.length === 0 ? "" : `?${values.join("&")}`}`;
}

export const EvidenceArtifactsTargetSchema = z
  .object({
    problem_id: problemId,
    evidence_id: evidenceId,
  })
  .strict();
const EvidenceArtifactSourceSchema = EvidenceArtifactsTargetSchema.extend({
  evidence_event_id: safeId,
  evidence_digest: digest,
}).strict();

export const EvidenceArtifactDiscoverySchema = z
  .object({
    ...EvidenceArtifactSourceSchema.shape,
    json_path: z.string().max(512),
    markdown_path: z.string().max(512),
    human_path: z.string().max(512),
    temporal_scope: z.literal("current-publications"),
    verification: z.literal("bytes-only"),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      !problemId.safeParse(value.problem_id).success ||
      !evidenceId.safeParse(value.evidence_id).success ||
      !digest.safeParse(value.evidence_digest).success
    )
      return;
    const query = { evidence_digest: value.evidence_digest };
    for (const [key, format] of [
      ["json_path", "json"],
      ["markdown_path", "md"],
      ["human_path", "human"],
    ] as const)
      if (value[key] !== evidenceArtifactsPath(value.problem_id, value.evidence_id, format, query))
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Discovery must pin this exact evidence source.",
        });
  });
export type EvidenceArtifactDiscovery = z.infer<typeof EvidenceArtifactDiscoverySchema>;

/** Server-authored read affordance only. It asserts neither that files exist
 * nor that any file was available at the enclosing historical ledger cursor. */
export function buildEvidenceArtifactDiscovery(input: {
  readonly problem_id: string;
  readonly evidence_id: string;
  readonly evidence_event_id: string;
  readonly evidence_digest: string;
}): EvidenceArtifactDiscovery {
  const query = { evidence_digest: input.evidence_digest };
  return EvidenceArtifactDiscoverySchema.parse({
    ...input,
    json_path: evidenceArtifactsPath(input.problem_id, input.evidence_id, "json", query),
    markdown_path: evidenceArtifactsPath(input.problem_id, input.evidence_id, "md", query),
    human_path: evidenceArtifactsPath(input.problem_id, input.evidence_id, "human", query),
    temporal_scope: "current-publications",
    verification: "bytes-only",
  });
}

/** Older ledger identifiers may lie outside the artifact gateway's namespace.
 * Preserve those records without advertising a route that cannot serve them. */
export function tryBuildEvidenceArtifactDiscovery(input: {
  readonly problem_id: string;
  readonly evidence_id: string;
  readonly evidence_event_id: string;
  readonly evidence_digest: string;
}): EvidenceArtifactDiscovery | undefined {
  const source = EvidenceArtifactSourceSchema.safeParse(input);
  return source.success ? buildEvidenceArtifactDiscovery(source.data) : undefined;
}

/** Only this explicit consent shape may enqueue publication. Upload completion
 * is private and byte-only; it cannot imply a public license or evidence link. */
export const ArtifactPublicationRequestSchema = z
  .object({
    session_id: z.string().regex(/^S-[A-Za-z0-9]{26}$/),
    evidence_id: evidenceId,
    evidence_digest: digest,
    publish: z.literal(true),
    license: z.literal("CC-BY-4.0"),
  })
  .strict();
export type ArtifactPublicationRequest = z.infer<typeof ArtifactPublicationRequestSchema>;

/** Recover original consent using a current owned session. Source recovery
 * increments the generation; approved human review records fresh release consent
 * without another screen. Replaying an accepted request never repeats either. */
export const ArtifactPublicationRetryRequestSchema = z
  .object({
    session_id: z.string().regex(/^S-[A-Za-z0-9]{26}$/),
    expected_retry_generation: z.number().int().min(0).max(ARTIFACT_PUBLICATION_MAX_RETRIES),
  })
  .strict();
export type ArtifactPublicationRetryRequest = z.infer<typeof ArtifactPublicationRetryRequestSchema>;
const retryReceipt = {
  schema: z.literal(ARTIFACT_PUBLICATIONS_SCHEMA_ID),
  publication_id: publicationId,
  problem_id: problemId,
  retry_id: z.string().regex(/^APR-[a-f0-9]{32}$/),
  status_path: statusPath,
};
export const ArtifactPublicationRetryReceiptSchema = z.discriminatedUnion("initial_delivery", [
  z
    .object({
      ...retryReceipt,
      retry_generation: z.number().int().min(1).max(ARTIFACT_PUBLICATION_MAX_RETRIES),
      requeued_at: positive,
      initial_delivery: z.literal("queued"),
    })
    .strict(),
  z
    .object({
      ...retryReceipt,
      retry_generation: z.number().int().min(0).max(ARTIFACT_PUBLICATION_MAX_RETRIES),
      authorized_at: positive,
      initial_delivery: z.literal("release-authorized"),
      review_case_id: z.string().regex(/^QC-[0-9A-HJKMNP-TV-Z]{26}$/),
    })
    .strict(),
]);
export type ArtifactPublicationRetryReceipt = z.infer<typeof ArtifactPublicationRetryReceiptSchema>;
const recovery = z
  .object({
    retry_path: retryPath,
    expected_retry_generation: z.number().int().min(0).max(ARTIFACT_PUBLICATION_MAX_RETRIES),
  })
  .strict();

const receipt = {
  schema: z.literal(ARTIFACT_PUBLICATIONS_SCHEMA_ID),
  publication_id: publicationId,
  problem_id: problemId,
  event_id: safeId,
  seq: positive,
  sha256: hash,
  evidence_id: evidenceId,
  evidence_digest: digest,
  license: z.literal("CC-BY-4.0"),
  verification: z.literal("bytes-only"),
  initial_delivery: z.literal("queued"),
  status_path: statusPath,
  manifest_path: manifestPath,
};
export const ArtifactPublicationReceiptSchema = z.object(receipt).strict();
export const ArtifactPublicationStatusSchema = z.discriminatedUnion("delivery", [
  z
    .object({
      ...receipt,
      delivery: z.literal("queued"),
      release_authorized: z.literal(false),
      published_at: z.null(),
      download_url: z.null(),
      appeal_path: z.null(),
      recovery: z.null(),
    })
    .strict(),
  z
    .object({
      ...receipt,
      delivery: z.literal("held"),
      release_authorized: z.literal(false),
      published_at: z.null(),
      download_url: z.null(),
      appeal_path: z.literal("/policy.md"),
      recovery: recovery.nullable(),
      review: z
        .object({
          case_id: z.string().regex(/^QC-[0-9A-HJKMNP-TV-Z]{26}$/),
          state: z.enum(["pending", "approved", "rejected", "superseded", "unavailable"]),
          sponsor_case_path: z
            .string()
            .regex(/^\/v1\/sponsors\/screening-cases\/QC-[0-9A-HJKMNP-TV-Z]{26}$/),
        })
        .strict()
        .nullable()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...receipt,
      delivery: z.literal("release-authorized"),
      release_authorized: z.literal(true),
      published_at: z.null(),
      download_url: z.null(),
      appeal_path: z.null(),
      recovery: z.null(),
    })
    .strict(),
  z
    .object({
      ...receipt,
      delivery: z.literal("published"),
      release_authorized: z.literal(true),
      published_at: positive,
      download_url: downloadUrl,
      appeal_path: z.null(),
      recovery: z.null(),
    })
    .strict(),
]);
export const PublicArtifactManifestSchema = z
  .object({
    schema: z.literal(ARTIFACT_PUBLICATIONS_SCHEMA_ID),
    publication_id: publicationId,
    problem_id: problemId,
    evidence: z
      .object({
        evidence_id: evidenceId,
        event_id: safeId,
        digest,
        screening_notice: ScreeningPublicationNoticeSchema.optional(),
      })
      .strict(),
    artifact: z
      .object({
        sha256: hash,
        size_bytes: positive.max(20 * 1024 * 1024),
        encoding: z.enum(["text", "lake-archive"]),
        content_type: z.enum(["text/plain; charset=utf-8", "application/gzip"]),
        download_url: downloadUrl,
      })
      .strict(),
    author: z.object({ fellow_id: safeId, sponsor_id: safeId }).strict(),
    publication_event: z.object({ event_id: safeId, seq: positive, digest }).strict(),
    license: z.literal("CC-BY-4.0"),
    verification: z.literal("bytes-only"),
    published_at: positive,
    delivery_cursor: positive,
  })
  .strict()
  .refine(
    (value) => value.artifact.download_url.endsWith(`/sha256/${value.artifact.sha256}`),
    "The public download must name the declared artifact digest.",
  );
export const EvidenceArtifactsSchema = z
  .object({
    schema: z.literal(ARTIFACT_PUBLICATIONS_SCHEMA_ID),
    problem_id: problemId,
    evidence_id: evidenceId,
    evidence_event_id: safeId,
    evidence_digest: digest,
    after: cursor,
    through: cursor,
    artifacts: z.array(PublicArtifactManifestSchema).max(20),
    next_after: positive.nullable(),
    next_path: listPath.nullable(),
    poll_path: listPath,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      !problemId.safeParse(value.problem_id).success ||
      !evidenceId.safeParse(value.evidence_id).success ||
      !digest.safeParse(value.evidence_digest).success ||
      !cursor.safeParse(value.after).success ||
      !cursor.safeParse(value.through).success ||
      (value.next_after !== null && !positive.safeParse(value.next_after).success)
    )
      return;
    let previous = value.after;
    for (const artifact of value.artifacts) {
      if (
        artifact.problem_id !== value.problem_id ||
        artifact.evidence.evidence_id !== value.evidence_id ||
        artifact.evidence.event_id !== value.evidence_event_id ||
        artifact.evidence.digest !== value.evidence_digest ||
        artifact.delivery_cursor <= previous ||
        artifact.delivery_cursor > value.through
      )
        context.addIssue({
          code: "custom",
          message: "Artifacts must belong to this evidence and ordered delivery window.",
        });
      previous = artifact.delivery_cursor;
    }
    const pin = { evidence_digest: value.evidence_digest };
    if (
      value.through < value.after ||
      (value.next_after !== null &&
        (value.next_after <= value.after ||
          value.next_after < previous ||
          value.next_after > value.through)) ||
      value.next_path !==
        (value.next_after === null
          ? null
          : evidenceArtifactsPath(value.problem_id, value.evidence_id, "json", {
              after: String(value.next_after),
              through: String(value.through),
              ...pin,
            })) ||
      value.poll_path !==
        evidenceArtifactsPath(value.problem_id, value.evidence_id, "json", {
          after: String(value.through),
          ...pin,
        })
    )
      context.addIssue({
        code: "custom",
        message: "Continuation must preserve the evidence source and delivery window.",
      });
  });
export type ArtifactPublicationReceipt = z.infer<typeof ArtifactPublicationReceiptSchema>;
export type ArtifactPublicationStatus = z.infer<typeof ArtifactPublicationStatusSchema>;
export type PublicArtifactManifest = z.infer<typeof PublicArtifactManifestSchema>;
export type EvidenceArtifacts = z.infer<typeof EvidenceArtifactsSchema>;

/** Consumers must check the response against their own requested scope before
 * rendering a link or treating an empty page as a successful read. */
export function evidenceArtifactsMatchesQuery(
  face: unknown,
  problem: string,
  evidence: string,
  query: EvidenceArtifactsQuery = {},
): face is EvidenceArtifacts {
  const parsed = EvidenceArtifactsSchema.safeParse(face);
  const requested = EvidenceArtifactsQuerySchema.safeParse(query);
  if (!parsed.success || !requested.success) return false;
  return (
    parsed.data.problem_id === problem &&
    parsed.data.evidence_id === evidence &&
    parsed.data.after === Number(requested.data.after ?? 0) &&
    (requested.data.through === undefined ||
      parsed.data.through === Number(requested.data.through)) &&
    (requested.data.evidence_digest === undefined ||
      parsed.data.evidence_digest === requested.data.evidence_digest)
  );
}

export function generateArtifactPublicationsSchema(): string {
  return `${JSON.stringify({
    $id: ARTIFACT_PUBLICATIONS_SCHEMA_ID,
    title: "ASImposium evidence-bound artifact publication",
    description:
      "POST /v1/artifacts/:upload_id/publish with a Fellow bearer and Idempotency-Key accepts explicit CC-BY consent; 202 is acceptance, not delivery. GET /v1/artifact-publications/:publication_id reads private status. When held status supplies recovery, restore the original sources and POST {session_id, expected_retry_generation} to recovery.retry_path with a new Idempotency-Key and a currently active owned session. A source-recovery receipt has initial_delivery=queued and requeues the same publication with its original quota and remaining screening allowance, at most eight times. A held review exposes a private case id and sponsor case path. After an audited operator approval, the same recovery request revalidates the exact private bytes, current ownership, current public evidence and live session, then records fresh owner consent. Its receipt has initial_delivery=release-authorized, authorized_at and review_case_id; retry_generation and paid screening attempts do not change. Approval alone never publishes bytes, rejection stays held, and an altered or missing source cannot reuse approval. Replay the exact same recovery request and key after an ambiguous response. GET /p/:problem/artifacts/:publication_id.json reads public provenance. GET /p/:problem/evidence/:evidence_id/artifacts.json pages by delivery cursor (after, through), not request-event time. All artifact verification is bytes-only, not scientific certification. Release authorization is irreversible; held is not a public download.",
    ...z.toJSONSchema(
      z
        .object({
          request: ArtifactPublicationRequestSchema,
          retry_request: ArtifactPublicationRetryRequestSchema,
          retry_receipt: ArtifactPublicationRetryReceiptSchema,
          receipt: ArtifactPublicationReceiptSchema,
          status: ArtifactPublicationStatusSchema,
          manifest: PublicArtifactManifestSchema,
          evidence_artifacts: EvidenceArtifactsSchema,
          evidence_artifacts_query: EvidenceArtifactsQuerySchema,
          evidence_artifact_discovery: EvidenceArtifactDiscoverySchema,
        })
        .strict(),
    ),
  })}\n`;
}
