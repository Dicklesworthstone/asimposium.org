/** Bounded private ledger archives. A completed manifest authenticates every
 * contiguous segment through one independently signed terminal checkpoint.
 * Partial segments are never advertised as a recoverable whole problem. */
import { CheckpointSignatureSchema, PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { BackupBucket, BackupProblemResult } from "./backup.ts";
import { type BackupSnapshotLimits, readBackupSnapshot } from "./backup-snapshot.ts";
import { checkpointVerifyKeys, verifyCheckpointSignature } from "./checkpoint-signing.ts";
import { serializeProblemExport, verifyProblemExportSegment } from "./export.ts";
import { checkpointDigest, genesisChainDigest } from "./krater.ts";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const BACKUP_SEGMENT_LIMITS = {
  maxEvents: 1000,
  maxPayloadBytes: 4 * 1024 * 1024,
  maxExportBytes: 12 * 1024 * 1024,
} as const;
export const BackupSegmentProgressSchema = z
  .object({
    after: count,
    chainDigest: digest,
    segments: count,
  })
  .strict();
export type BackupSegmentProgress = z.infer<typeof BackupSegmentProgressSchema>;

/** Private storage format, not a second public export/API. The existing v3
 * export is assembled offline after verifying all ranges and the pinned key. */
export const BackupManifestSchema = z
  .object({
    format: z.literal("asimposium.segmented-ledger-backup.v1"),
    problem_id: PublicLedgerProblemIdSchema,
    title: z.string().max(500),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    cursor: count.min(1),
    chain_digest: digest,
    segments: count.min(1),
    terminal_signature: CheckpointSignatureSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.segments <= value.cursor &&
      value.terminal_signature.checkpoint_seq === value.cursor &&
      value.terminal_signature.root_chain_digest === value.chain_digest,
    "manifest must name its exact terminal checkpoint",
  );
export type BackupManifest = z.infer<typeof BackupManifestSchema>;

type Identity = Pick<BackupManifest, "problem_id" | "date" | "chain_digest">;
export function backupSegmentKey(identity: Identity, index: number): string {
  if (!Number.isSafeInteger(index) || index < 1) throw new Error("BACKUP_SEGMENT_INDEX_INVALID");
  return `backups/${identity.date}/${identity.problem_id}/${identity.chain_digest}.segments/${String(index).padStart(12, "0")}.jsonl`;
}
export function backupManifestKey(identity: Identity): string {
  return `backups/${identity.date}/${identity.problem_id}/${identity.chain_digest}.manifest.json`;
}

/** Read exactly the pinned terminal signature, with no count or materialized
 * signature history proportional to the problem's lifetime. */
async function signedTerminal(
  db: D1Database,
  problemId: string,
  cursor: number,
  root: string,
  verifyKeysRaw: string,
) {
  const keys = checkpointVerifyKeys(verifyKeysRaw);
  const expected = await checkpointDigest(problemId, cursor, root);
  for (const key of keys) {
    const row = await db
      .prepare(`SELECT s.checkpoint_seq, c.root_chain_digest,
      c.checkpoint_digest, s.key_id, s.algorithm, s.signature, s.signed_at
      FROM checkpoint_signatures s JOIN checkpoint_chain_v2 c
        ON c.problem_id = s.problem_id AND c.checkpoint_seq = s.checkpoint_seq
      WHERE s.problem_id = ? AND s.checkpoint_seq = ? AND s.key_id = ?`)
      .bind(problemId, cursor, key.kid)
      .first();
    if (row === null) continue;
    const signature = CheckpointSignatureSchema.safeParse(row);
    if (
      !signature.success ||
      signature.data.root_chain_digest !== root ||
      signature.data.checkpoint_digest !== expected ||
      !(await verifyCheckpointSignature(problemId, signature.data, key.publicKeyHex))
    )
      throw new Error("BACKUP_SIGNATURE_INVALID");
    return signature.data;
  }
  throw new Error("BACKUP_SIGNATURE_UNAVAILABLE");
}

/** Write one segment, never a whole unbounded history. The outer scheduler
 * persists progress using its existing conditional lease before continuing. */
export async function backupProblemSegment(input: {
  db: D1Database;
  bucket: BackupBucket;
  problemId: string;
  title: string;
  date: string;
  cursor: number;
  chainDigest: string;
  progress: BackupSegmentProgress | null;
  checkpointVerifyKeys: string;
  limits: BackupSnapshotLimits & { readonly maxExportBytes: number };
}): Promise<{
  complete: boolean;
  progress: BackupSegmentProgress;
  archive?: BackupProblemResult & { readonly format: "segmented-v1" };
}> {
  const { db, bucket, problemId, cursor, limits } = input;
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 1 ||
    !Number.isSafeInteger(limits.maxEvents) ||
    limits.maxEvents < 1 ||
    limits.maxEvents > BACKUP_SEGMENT_LIMITS.maxEvents ||
    !Number.isSafeInteger(limits.maxPayloadBytes) ||
    limits.maxPayloadBytes < 1 ||
    limits.maxPayloadBytes > BACKUP_SEGMENT_LIMITS.maxPayloadBytes ||
    !Number.isSafeInteger(limits.maxExportBytes) ||
    limits.maxExportBytes < 1 ||
    limits.maxExportBytes > BACKUP_SEGMENT_LIMITS.maxExportBytes
  )
    throw new Error("BACKUP_LIMITS_INVALID");
  const progress = BackupSegmentProgressSchema.parse(
    input.progress ?? {
      after: 0,
      chainDigest: await genesisChainDigest(problemId),
      segments: 0,
    },
  );
  if (
    progress.after >= cursor ||
    progress.segments > progress.after ||
    (progress.after === 0) !== (progress.segments === 0)
  )
    throw new Error("BACKUP_SEGMENT_PROGRESS_INVALID");
  const signature = await signedTerminal(
    db,
    problemId,
    cursor,
    input.chainDigest,
    input.checkpointVerifyKeys,
  );
  // Read only sizes and roots before allocating any bodies. The lower indexed
  // bound advances every tick; a large ledger is never rescanned from genesis.
  const rows = await db
    .prepare(`SELECT e.seq, ch.chain_digest AS chainDigest,
      LENGTH(CAST(c.payload_json AS BLOB)) AS bytes
    FROM events e JOIN event_chain_v2 ch ON ch.event_id = e.id
      AND ch.problem_id = e.problem_id AND ch.seq = e.seq
    LEFT JOIN event_content c ON c.event_id = e.id
      AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
    WHERE e.problem_id = ? AND e.seq > ? AND e.seq <= ? ORDER BY e.seq LIMIT ?`)
    .bind(problemId, progress.after, cursor, limits.maxEvents)
    .all<{ seq: number; chainDigest: string; bytes: number | null }>();
  let bytes = 0;
  let cut: { cursor: number; chainDigest: string } | null = null;
  for (const row of rows.results) {
    if (row.bytes === null || !Number.isSafeInteger(row.bytes) || row.bytes < 0)
      throw new Error("BACKUP_CONTENT_UNAVAILABLE");
    if (bytes + row.bytes > limits.maxPayloadBytes) break;
    bytes += row.bytes;
    cut = { cursor: row.seq, chainDigest: row.chainDigest };
  }
  if (cut === null) throw new Error("BACKUP_LIMIT_EXCEEDED");
  const snapshot = await readBackupSnapshot(db, problemId, {
    cut,
    after: { cursor: progress.after, chainDigest: progress.chainDigest },
    limits,
  });
  if (snapshot === null) throw new Error("BACKUP_EVENT_PREFIX_INCOMPLETE");
  const ndjson = serializeProblemExport({
    problemId,
    problemTitle: input.title,
    generatedAt: `${input.date}T00:00:00Z`,
    events: snapshot.events,
    checkpoints: snapshot.checkpoints,
  });
  if (new TextEncoder().encode(ndjson).byteLength > limits.maxExportBytes)
    throw new Error("BACKUP_LIMIT_EXCEEDED");
  const verified = await verifyProblemExportSegment(
    ndjson,
    { problemId, checkpointSeq: progress.after, rootChainDigest: progress.chainDigest },
    { problemId, checkpointSeq: cut.cursor, rootChainDigest: cut.chainDigest },
  );
  if (!verified.intact) throw new Error("BACKUP_SEGMENT_VERIFICATION_FAILED");
  const complete = cut.cursor === cursor;
  if (complete && verified.finalChainDigest !== input.chainDigest)
    throw new Error("BACKUP_HEAD_PREFIX_MISMATCH");
  const next = {
    after: cut.cursor,
    chainDigest: verified.finalChainDigest,
    segments: progress.segments + 1,
  };
  const identity = { problem_id: problemId, date: input.date, chain_digest: input.chainDigest };
  await bucket.put(backupSegmentKey(identity, next.segments), ndjson, {
    customMetadata: {
      problem: problemId,
      first_seq: String(progress.after + 1),
      last_seq: String(next.after),
      terminal_root: input.chainDigest,
    },
  });
  if (!complete) return { complete, progress: next };
  const manifest = BackupManifestSchema.parse({
    ...identity,
    format: "asimposium.segmented-ledger-backup.v1",
    title: input.title,
    cursor,
    segments: next.segments,
    terminal_signature: signature,
  });
  const key = backupManifestKey(identity);
  // Completion is published last; an interrupted upload has only segments.
  await bucket.put(key, JSON.stringify(manifest), {
    customMetadata: {
      problem: problemId,
      event_count: String(cursor),
      final_chain_digest: input.chainDigest,
      format: manifest.format,
    },
  });
  return {
    complete,
    progress: next,
    archive: {
      problemId,
      eventCount: cursor,
      key,
      chainDigest: input.chainDigest,
      signaturesKey: null,
      format: "segmented-v1",
    },
  };
}
