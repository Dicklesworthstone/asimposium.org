import { z } from "zod";

export const S2_COST_RECEIPT_SCHEMA_VERSION = "s2-cost-input-v1";
export const S2_COST_RECEIPT_RECORD = "s2_cost_measurement";
export const S2_COST_RECEIPT_RELATIVE_PATH = "s2-cost-input.json";
export const S2_COST_MANIFEST_RELATIVE_PATH = "manifest.json";
export const S2_COST_PUBLICATION_RELATIVE_PATH = "s2-cost-publication.json";
export const S2_COST_PUBLICATION_SCHEMA_VERSION = "s2-cost-publication-v1";
export const S2_COST_PUBLICATION_RECORD = "s2_cost_receipt_publication";
export const S2_COST_EVIDENCE_MANIFEST_VERSION = "s2-krater-evidence-v2";
export const S2_COST_METRIC_SCOPE = "selected-settled-write-receipts";
export const S2_SUCCESSFUL_BATCH_SCOPE = "settled-db.batch-only";
export const S2_FAILED_RETRY_SCOPE = "excluded-d1-error-has-no-meta";
export const S2_WRITE_CLAIM_SCOPE = "writeClaim-entry-to-return";
export const S2_LOCAL_SCOPE = "local-workerd-d1-do";
export const MAX_S2_COST_RECEIPT_BYTES = 64 * 1024;
export const MAX_S2_COST_EVIDENCE_MANIFEST_BYTES = 1024 * 1024;

export const REQUIRED_ROW_TOTAL_EXCLUSIONS = [
  "head-and-post-write-verification-reads-no-meta",
  "failed-retry-batches-no-meta",
] as const;

export const S2_COST_RECEIPT_ROOT_KEYS = [
  "schema_version",
  "record",
  "run_id",
  "phase",
  "revision",
  "dirty_state",
  "source_digest",
  "scope",
  "bindings",
  "status",
  "metric_scope",
  "write_receipt_count",
  "successful_batch_metric_scope",
  "failed_retry_batch_metrics",
  "write_claim_wall_scope",
  "p95_write_phase_ms",
  "p95_preflight_wall_ms",
  "p95_write_claim_wall_ms",
  "sum_successful_batch_rows_read",
  "sum_successful_batch_rows_written",
  "sum_preflight_rows_read",
  "sum_preflight_rows_written",
  "sum_preflight_statements",
  "sum_retry_count",
  "known_row_total_exclusions",
] as const;
export const S2_COST_RECEIPT_BINDINGS_KEYS = ["d1", "durable_object", "r2"] as const;
export const S2_COST_LOCAL_PHASES = [
  "exercise",
  "restart_verify",
  "upgrade_existing",
  "upgrade_empty",
  "upgrade_journal_existing",
  "upgrade_journal_empty",
] as const;

const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const GIT_REVISION = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NonNegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const NonNegativeMillisecondsSchema = z.number().finite().min(0);
const Sha256Schema = z.string().regex(SHA256);
const ProvenanceSchema = z.strictObject({
  run_id: z.string().regex(SAFE_COMPONENT),
  revision: z.string().regex(GIT_REVISION),
  dirty_state: z.enum(["clean", "dirty"]),
  source_digest: Sha256Schema,
});
const ReceiptArtifactSchema = z.strictObject({
  path: z.literal(S2_COST_RECEIPT_RELATIVE_PATH),
  digest: Sha256Schema,
  bytes: NonNegativeSafeIntegerSchema,
});
const PhaseStatusSchema = z.enum(["not-run", "pass", "fail", "interrupted"]);

export const S2CostReceiptBindingsSchema = z.strictObject({
  d1: z.literal("DB"),
  durable_object: z.literal("KRATER_OUTBOX"),
  r2: z.null(),
});

export const S2CostMeasurementReceiptSchema = z.strictObject({
  schema_version: z.literal(S2_COST_RECEIPT_SCHEMA_VERSION),
  record: z.literal(S2_COST_RECEIPT_RECORD),
  run_id: ProvenanceSchema.shape.run_id,
  phase: z.literal("exercise"),
  revision: ProvenanceSchema.shape.revision,
  dirty_state: ProvenanceSchema.shape.dirty_state,
  source_digest: ProvenanceSchema.shape.source_digest,
  scope: z.literal(S2_LOCAL_SCOPE),
  bindings: S2CostReceiptBindingsSchema,
  status: z.literal("pass"),
  metric_scope: z.literal(S2_COST_METRIC_SCOPE),
  write_receipt_count: NonNegativeSafeIntegerSchema.min(1),
  successful_batch_metric_scope: z.literal(S2_SUCCESSFUL_BATCH_SCOPE),
  failed_retry_batch_metrics: z.literal(S2_FAILED_RETRY_SCOPE),
  write_claim_wall_scope: z.literal(S2_WRITE_CLAIM_SCOPE),
  p95_write_phase_ms: NonNegativeMillisecondsSchema,
  p95_preflight_wall_ms: NonNegativeMillisecondsSchema,
  p95_write_claim_wall_ms: NonNegativeMillisecondsSchema,
  sum_successful_batch_rows_read: NonNegativeSafeIntegerSchema,
  sum_successful_batch_rows_written: NonNegativeSafeIntegerSchema,
  sum_preflight_rows_read: NonNegativeSafeIntegerSchema,
  sum_preflight_rows_written: NonNegativeSafeIntegerSchema,
  sum_preflight_statements: NonNegativeSafeIntegerSchema,
  sum_retry_count: NonNegativeSafeIntegerSchema,
  known_row_total_exclusions: z.tuple([
    z.literal(REQUIRED_ROW_TOTAL_EXCLUSIONS[0]),
    z.literal(REQUIRED_ROW_TOTAL_EXCLUSIONS[1]),
  ]),
});

export const S2CostEvidenceManifestSchema = z
  .object({
    manifest_version: z.literal(S2_COST_EVIDENCE_MANIFEST_VERSION),
    run_id: ProvenanceSchema.shape.run_id,
    revision: ProvenanceSchema.shape.revision,
    dirty_state: ProvenanceSchema.shape.dirty_state,
    source_digest: ProvenanceSchema.shape.source_digest,
    exit_code: z.number().int().min(0).max(255),
    local_phase_status: z.strictObject({
      exercise: PhaseStatusSchema,
      restart_verify: PhaseStatusSchema,
      upgrade_existing: PhaseStatusSchema,
      upgrade_empty: PhaseStatusSchema,
      upgrade_journal_existing: PhaseStatusSchema,
      upgrade_journal_empty: PhaseStatusSchema,
    }),
    s2_cost_receipt: ReceiptArtifactSchema.nullable(),
  })
  .passthrough();

export const S2CostReceiptPublicationSchema = z.strictObject({
  schema_version: z.literal(S2_COST_PUBLICATION_SCHEMA_VERSION),
  record: z.literal(S2_COST_PUBLICATION_RECORD),
  manifest: z.strictObject({
    path: z.literal(S2_COST_MANIFEST_RELATIVE_PATH),
    digest: Sha256Schema,
  }),
  receipt: ReceiptArtifactSchema,
  provenance: ProvenanceSchema,
  local_phase_status: z.strictObject({
    exercise: z.literal("pass"),
    restart_verify: z.literal("pass"),
    upgrade_existing: z.literal("pass"),
    upgrade_empty: z.literal("pass"),
    upgrade_journal_existing: z.literal("pass"),
    upgrade_journal_empty: z.literal("pass"),
  }),
});

export type S2CostMeasurementReceipt = z.infer<typeof S2CostMeasurementReceiptSchema>;
export type S2CostEvidenceManifest = z.infer<typeof S2CostEvidenceManifestSchema>;
export type S2CostReceiptPublication = z.infer<typeof S2CostReceiptPublicationSchema>;

export class S2CostReceiptContractError extends Error {
  constructor(
    readonly code: "S2_COST_RECEIPT_INVALID" | "S2_COST_RECEIPT_TOO_LARGE",
  ) {
    super(code);
    this.name = "S2CostReceiptContractError";
  }
}

function parseJsonBytes(bytes: Uint8Array, maximumBytes: number): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximumBytes) {
    throw new S2CostReceiptContractError(
      bytes instanceof Uint8Array ? "S2_COST_RECEIPT_TOO_LARGE" : "S2_COST_RECEIPT_INVALID",
    );
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new S2CostReceiptContractError("S2_COST_RECEIPT_INVALID");
  }
}

function parseSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new S2CostReceiptContractError("S2_COST_RECEIPT_INVALID");
  return parsed.data;
}

export function parseS2CostMeasurementReceiptValue(value: unknown): S2CostMeasurementReceipt {
  return parseSchema(S2CostMeasurementReceiptSchema, value);
}

export function parseS2CostMeasurementReceiptBytes(bytes: Uint8Array): S2CostMeasurementReceipt {
  return parseS2CostMeasurementReceiptValue(parseJsonBytes(bytes, MAX_S2_COST_RECEIPT_BYTES));
}

export function parseS2CostEvidenceManifestBytes(bytes: Uint8Array): S2CostEvidenceManifest {
  return parseSchema(S2CostEvidenceManifestSchema, parseJsonBytes(bytes, MAX_S2_COST_EVIDENCE_MANIFEST_BYTES));
}

export function parseS2CostReceiptPublicationBytes(bytes: Uint8Array): S2CostReceiptPublication {
  return parseSchema(S2CostReceiptPublicationSchema, parseJsonBytes(bytes, MAX_S2_COST_RECEIPT_BYTES));
}
