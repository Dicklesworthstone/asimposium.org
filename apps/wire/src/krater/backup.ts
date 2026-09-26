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
import { readAllCheckpointSignatures } from "./checkpoint-face.ts";
import {
  EXPORT_FORMAT,
  type ProblemExportEvent,
  serializeProblemExport,
  verifyProblemExportChain,
} from "./export.ts";
import { type KraterEvent, readCheckpoints, readEvents, readIntegrityState } from "./krater.ts";

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

/** D1 and SQLite bound-variable ceilings differ; 90 keeps the IN list lawful. */
const PAYLOAD_CHUNK = 90;

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
  // Read the full event log in pages.
  const events: KraterEvent[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = await readEvents(db, problemId, afterSeq, 200);
    if (page.length === 0) break;
    events.push(...page);
    afterSeq = page[page.length - 1]?.seq ?? afterSeq;
    if (page.length < 200) break;
  }
  if (events.length === 0) return null;

  const [checkpoints, integrity] = await Promise.all([
    readCheckpoints(db, problemId),
    readIntegrityState(db, problemId),
  ]);

  // v3 exports carry the exact payload bytes each event's digest binds, so the
  // backup reads event_content alongside the envelopes and refuses to emit a
  // line whose payload text is missing.
  const payloadByText = new Map<string, string>();
  for (let offset = 0; offset < events.length; offset += PAYLOAD_CHUNK) {
    const chunk = events.slice(offset, offset + PAYLOAD_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await db
      .prepare(
        `SELECT event_id, payload_json FROM event_content WHERE event_id IN (${placeholders})`,
      )
      .bind(...chunk.map((event) => event.eventId))
      .all<{ event_id: string; payload_json: string }>();
    for (const row of rows.results) payloadByText.set(row.event_id, row.payload_json);
  }
  const exportEvents: ProblemExportEvent[] = events.map((event) => {
    const payloadJson = payloadByText.get(event.eventId);
    if (payloadJson === undefined) {
      throw new Error(
        `backup of ${problemId} is missing event_content payload bytes for ${event.eventId}`,
      );
    }
    return { ...event, payloadJson };
  });

  const ndjson = serializeProblemExport({
    problemId,
    problemTitle,
    events: exportEvents,
    checkpoints,
    generatedAt: `${datePrefix}T00:00:00Z`,
  });

  // Never write a backup that fails its own chain verification.
  const verification = await verifyProblemExportChain(ndjson, {
    problemId,
    checkpointSeq: events[events.length - 1]?.seq ?? 0,
    rootChainDigest: integrity.chainDigest,
  });
  if (!verification.intact) {
    throw new Error(`backup chain verification failed for ${problemId}: ${verification.detail}`);
  }

  const key = backupKeyFor(datePrefix, problemId, verification.finalChainDigest);
  await bucket.put(key, ndjson, {
    customMetadata: {
      problem: problemId,
      event_count: String(verification.eventCount),
      final_chain_digest: verification.finalChainDigest,
      format: EXPORT_FORMAT,
      license: "CC BY 4.0",
    },
  });

  let signaturesKey: string | null = null;
  if (options.checkpointVerifyKeys !== undefined) {
    const face = await readAllCheckpointSignatures(db, options.checkpointVerifyKeys, problemId);
    if (face !== null) {
      signaturesKey = key.replace(/\.jsonl$/, ".checkpoints.json");
      await bucket.put(signaturesKey, JSON.stringify(face), {
        customMetadata: { problem: problemId, export_key: key },
      });
    }
  }

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
