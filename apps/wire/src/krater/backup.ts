/**
 * W2.8 backup export: the nightly per-problem export to the backups bucket.
 * For each problem, read the full event log and its canonical payload texts,
 * serialize the NDJSON export (header + events + terminal record, integrity
 * checkpoints embedded), VERIFY the chain before trusting the bytes, then
 * write to the backups bucket under a dated, content-addressed key. A backup
 * that fails its own chain verification is never written — a corrupt backup is
 * worse than none.
 *
 * The bucket is injected so the handler is testable with a fake and the
 * binding-topology decision (which bucket, which cron) stays with OPS.6. The
 * cron trigger supplies `now`; nothing here reads a clock directly.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { readBackupSnapshot } from "./backup-snapshot.ts";
import { readCheckpointSignatures } from "./checkpoint-face.ts";
import {
  EXPORT_FORMAT,
  serializeProblemExport,
  verifyProblemExportChain,
} from "./export.ts";

/** The minimal bucket surface the backup writer needs. */
export interface BackupBucket {
  put(
    key: string,
    body: string,
    options?: { readonly customMetadata?: Record<string, string> },
  ): Promise<unknown>;
}

export interface BackupProblemResult {
  readonly problemId: string;
  readonly eventCount: number;
  readonly key: string;
  readonly chainDigest: string;
  /** The signed checkpoint face stored beside the export, when keys are set. */
  readonly signaturesKey: string | null;
}

/** One bounded page of a backup run. `next` resumes the run (null: complete).
 * A failed page reports what it wrote and where to resume; the failed problem
 * is never counted as written. */
export type BackupRun =
  | {
      readonly ok: true;
      readonly written: readonly BackupProblemResult[];
      readonly datePrefix: string;
      readonly next: string | null;
    }
  | {
      readonly ok: false;
      readonly written: readonly BackupProblemResult[];
      readonly datePrefix: string;
      readonly problemId: string;
      readonly detail: string;
      readonly resumeAfter: string | null;
    };

/** The dated key prefix: `backups/<YYYY-MM-DD>/<problem>/<final-chain>.jsonl`. */
export function backupKeyFor(
  datePrefix: string,
  problemId: string,
  finalChainDigest: string,
): string {
  const digest = finalChainDigest
    .replace(/^sha256:/, "")
    .replace(/[^a-f0-9]/gi, "")
    .slice(0, 32);
  return `backups/${datePrefix}/${problemId}/${digest}.jsonl`;
}

/**
 * Back up one problem: read its log, serialize, verify, write. Returns null if
 * the problem has no events (nothing to back up). Throws on a verification
 * failure — the caller treats that as a run failure, not a skipped problem.
 */
export async function backupProblem(
  db: D1Database,
  bucket: BackupBucket,
  problemId: string,
  problemTitle: string,
  datePrefix: string,
  options: {
    /** CHECKPOINT_VERIFY_KEYS. When set, the problem's signed checkpoint face
     * is written beside the export so scripts/verify-export.ts can verify the
     * backup offline with an independently pinned key (ADR-23). */
    readonly checkpointVerifyKeys?: string;
  } = {},
): Promise<BackupProblemResult | null> {
  // Capture the head before paging. New appends must not extend this run or
  // replace the root against which its immutable prefix is verified.
  const snapshot = await readBackupSnapshot(db, problemId);
  if (snapshot === null) return null;

  const ndjson = serializeProblemExport({
    problemId,
    problemTitle,
    events: snapshot.events,
    checkpoints: snapshot.checkpoints,
    generatedAt: `${datePrefix}T00:00:00Z`,
  });

  // Never write a backup that fails its own chain verification.
  const verification = await verifyProblemExportChain(ndjson, {
    problemId,
    checkpointSeq: snapshot.cursor,
    rootChainDigest: snapshot.chainDigest,
  });
  if (!verification.intact) {
    throw new Error(`backup chain verification failed for ${problemId}: ${verification.detail}`);
  }

  const key = backupKeyFor(datePrefix, problemId, verification.finalChainDigest);
  let signaturesKey: string | null = null;
  let signaturesBody: string | null = null;
  if (options.checkpointVerifyKeys !== undefined) {
    // A trusted signature on the terminal root authenticates the whole
    // recomputed chain (verify-export.ts). Retain every key for that checkpoint,
    // not the unbounded signature history: the shared face caps arrays at 500.
    // Historical signatures remain available on the paginated public face.
    const face = await readCheckpointSignatures(
      db, options.checkpointVerifyKeys, problemId, snapshot.cursor - 1, snapshot.cursor,
    );
    if (face !== null) {
      const pins = new Map(snapshot.checkpoints.map((pin) => [pin.checkpointSeq, pin]));
      if (face.problem_id !== problemId || face.next_after !== null || face.signatures.some((signature) => {
        const pin = pins.get(signature.checkpoint_seq);
        return !pin || signature.root_chain_digest !== pin.rootChainDigest ||
          signature.checkpoint_digest !== pin.checkpointDigest;
      })) throw new Error("BACKUP_SIGNATURE_SNAPSHOT_MISMATCH");
      const signed = new Set(face.signatures.map((signature) => signature.checkpoint_seq));
      signaturesKey = key.replace(/\.jsonl$/, ".checkpoints.json");
      signaturesBody = JSON.stringify({ ...face,
        unsigned: snapshot.checkpoints.filter((pin) => !signed.has(pin.checkpointSeq)).length,
        next_after: null,
      });
    }
  }
  // Prepare the complete pair before publishing anything. Write the companion
  // first: the final export object is never newly published without its promised
  // signature file. R2 is not a multi-object transaction; retries reuse these keys.
  if (signaturesKey !== null && signaturesBody !== null) {
    await bucket.put(signaturesKey, signaturesBody, {
      customMetadata: { problem: problemId, export_key: key },
    });
  }
  await bucket.put(key, ndjson, {
    customMetadata: {
      problem: problemId,
      event_count: String(verification.eventCount),
      final_chain_digest: verification.finalChainDigest,
      format: EXPORT_FORMAT,
      license: "CC BY 4.0",
    },
  });

  return {
    problemId,
    eventCount: verification.eventCount,
    key,
    chainDigest: verification.finalChainDigest,
    signaturesKey,
  };
}

/**
 * Back up one bounded page of public problems in id order, after `after`.
 * This is the primitive a scheduled job (OPS.6) calls until `next` is null.
 * Keys are content-addressed, so re-running a page after an interruption
 * rewrites identical objects: resuming from any earlier cursor is safe.
 */
export async function backupProblemsPage(
  db: D1Database,
  bucket: BackupBucket,
  datePrefix: string,
  options: {
    readonly after?: string | null;
    readonly limit?: number;
    readonly checkpointVerifyKeys?: string;
  } = {},
): Promise<BackupRun> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 200);
  const rows = await db
    .prepare(
      "SELECT id, title FROM problems WHERE status <> 'private-draft' AND id > ? ORDER BY id LIMIT ?",
    )
    .bind(options.after ?? "", limit + 1)
    .all<{ id: string; title: string | null }>();
  const page = (rows.results ?? []).slice(0, limit);
  const written: BackupProblemResult[] = [];
  let resumeAfter = options.after ?? null;
  for (const problem of page) {
    try {
      const result = await backupProblem(
        db,
        bucket,
        problem.id,
        problem.title ?? problem.id,
        datePrefix,
        {
          ...(options.checkpointVerifyKeys === undefined
            ? {}
            : { checkpointVerifyKeys: options.checkpointVerifyKeys }),
        },
      );
      if (result !== null) written.push(result);
      resumeAfter = problem.id;
    } catch (error) {
      return {
        ok: false,
        written,
        datePrefix,
        problemId: problem.id,
        detail: error instanceof Error ? error.message : String(error),
        resumeAfter,
      };
    }
  }
  return {
    ok: true,
    written,
    datePrefix,
    next: (rows.results ?? []).length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}
