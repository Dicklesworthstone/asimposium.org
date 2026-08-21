/**
 * W2.8 backup export: the nightly per-problem export to the backups bucket.
 * For each problem, read the full event log, serialize the NDJSON export
 * (header + events + terminal record, integrity checkpoints embedded), VERIFY
 * the chain before trusting the bytes, then write to the backups bucket under
 * a dated, content-addressed key. A backup that fails its own chain
 * verification is never written — a corrupt backup is worse than none.
 *
 * The bucket is injected so the handler is testable with a fake and the
 * binding-topology decision (which bucket, which cron) stays with OPS.6. The
 * cron trigger supplies `now`; nothing here reads a clock directly.
 */

import type { D1Database } from "@cloudflare/workers-types";

import { serializeProblemExport, verifyProblemExportChain } from "./export.ts";
import { readEvents, type KraterEvent } from "./krater.ts";

/** The minimal bucket surface the backup writer needs. */
export interface BackupBucket {
  put(key: string, body: string, options?: { readonly customMetadata?: Record<string, string> }): Promise<unknown>;
}

export interface BackupProblemResult {
  readonly problemId: string;
  readonly eventCount: number;
  readonly key: string;
  readonly chainDigest: string;
}

export type BackupRun =
  | { readonly ok: true; readonly written: readonly BackupProblemResult[]; readonly datePrefix: string }
  | { readonly ok: false; readonly problemId: string; readonly detail: string };

/** The dated key prefix: `backups/<YYYY-MM-DD>/<problem>/<final-chain>.jsonl`. */
export function backupKeyFor(datePrefix: string, problemId: string, finalChainDigest: string): string {
  const digest = finalChainDigest.replace(/^sha256:/, "").replace(/[^a-f0-9]/gi, "").slice(0, 32);
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

  const ndjson = serializeProblemExport({
    problemId,
    problemTitle,
    events,
    checkpoints: [],
    generatedAt: `${datePrefix}T00:00:00Z`,
  });

  // Never write a backup that fails its own chain verification.
  const verification = await verifyProblemExportChain(ndjson);
  if (!verification.intact) {
    throw new Error(
      `backup chain verification failed for ${problemId}: ${verification.detail}`,
    );
  }

  const key = backupKeyFor(datePrefix, problemId, verification.finalChainDigest);
  await bucket.put(key, ndjson, {
    customMetadata: {
      problem: problemId,
      event_count: String(verification.eventCount),
      final_chain_digest: verification.finalChainDigest,
      format: "asimposium.problem-export.v1",
      license: "CC BY 4.0",
    },
  });

  return {
    problemId,
    eventCount: verification.eventCount,
    key,
    chainDigest: verification.finalChainDigest,
  };
}
