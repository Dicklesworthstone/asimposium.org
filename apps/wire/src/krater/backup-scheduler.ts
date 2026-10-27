/**
 * OPS.6 nightly ledger archives, advanced by the existing five-minute cron.
 * A tick handles one bounded portion of a problem. R2's conditional writes lease
 * and advance the durable cursor; an interrupted tick can replay its archive
 * writes but cannot skip a problem or regress a newer worker's progress.
 *
 * These are private per-problem ledger exports, not full SQL/account backups.
 * ARTIFACTS is the private bucket; no backup bytes enter PUBLIC_ARTIFACTS.
 */
import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import type { R2Bucket, R2Object } from "@cloudflare/workers-types";
import { z } from "zod";
import type { Env } from "../env.ts";
import { backupProblem } from "./backup.ts";
import {
  BACKUP_SEGMENT_LIMITS,
  BackupSegmentProgressSchema,
  backupProblemSegment,
} from "./backup-segments.ts";
import { checkpointSigningKey, checkpointVerifyKeys } from "./checkpoint-signing.ts";

export const BACKUP_RUN_KEY = "backups/control/nightly-v1.json";
export const BACKUP_LEASE_MS = 10 * 60 * 1000;
export const BACKUP_SIGNATURE_WAIT_MS = 24 * 60 * 60 * 1000;
export const SCHEDULED_BACKUP_LIMITS = BACKUP_SEGMENT_LIMITS;

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const PendingSchema = z
  .object({
    id: PublicLedgerProblemIdSchema,
    title: z.string().max(500),
    cursor: count,
    chainDigest: digest,
    waitingSince: count.nullable().default(null),
    segmented: BackupSegmentProgressSchema.nullable().default(null),
  })
  .strict();
const StateSchema = z
  .object({
    version: z.literal(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startedAt: z.iso.datetime(),
    upper: PublicLedgerProblemIdSchema.nullable(),
    after: PublicLedgerProblemIdSchema.nullable(),
    pending: PendingSchema.nullable(),
    status: z.enum(["running", "complete", "incomplete"]),
    written: count,
    empty: count,
    failed: count,
    lease: z.object({ owner: z.uuid(), expiresAt: count }).strict().nullable(),
    reportKey: z.string().startsWith("backups/runs/").max(200).nullable(),
  })
  .strict();
type RunState = z.infer<typeof StateSchema>;
type BackupEnv = Pick<
  Env,
  "DB" | "ARTIFACTS" | "CHECKPOINT_SIGNING_KEY" | "CHECKPOINT_VERIFY_KEYS"
>;

export type BackupTickResult =
  | {
      readonly enabled: false;
      readonly status: "disabled";
      readonly reason: "signing_key_missing" | "verification_keys_missing";
    }
  | {
      readonly enabled: true;
      readonly status:
        | "busy"
        | "advanced"
        | "waiting-for-signature"
        | "segment-written"
        | "complete"
        | "incomplete"
        | "lost-lease";
      readonly date: string;
      readonly written: number;
      readonly failed: number;
      readonly totalWritten: number;
      readonly totalFailed: number;
    };

function result(
  state: RunState,
  status: Extract<BackupTickResult, { enabled: true }>["status"],
  written = 0,
  failed = 0,
): BackupTickResult {
  return {
    enabled: true,
    status,
    date: state.date,
    written,
    failed,
    totalWritten: state.written,
    totalFailed: state.failed,
  };
}

/** Absent keys are an explicit disabled capability. Configured but malformed,
 * conflicting, or unpinned keys are errors, never a successful empty run. */
async function checkKeys(env: BackupEnv): Promise<BackupTickResult | null> {
  const signer = await checkpointSigningKey(env.CHECKPOINT_SIGNING_KEY);
  if (env.CHECKPOINT_SIGNING_KEY !== undefined && signer === null)
    throw new Error("BACKUP_SIGNING_KEY_INVALID");
  const keys = checkpointVerifyKeys(env.CHECKPOINT_VERIFY_KEYS);
  if (env.CHECKPOINT_VERIFY_KEYS !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.CHECKPOINT_VERIFY_KEYS);
    } catch {
      parsed = null;
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length < 1 ||
      parsed.length !== keys.length ||
      new Set(keys.map((key) => key.kid)).size !== keys.length
    )
      throw new Error("BACKUP_VERIFICATION_KEYS_INVALID");
  }
  if (env.CHECKPOINT_SIGNING_KEY === undefined)
    return { enabled: false, status: "disabled", reason: "signing_key_missing" };
  if (env.CHECKPOINT_VERIFY_KEYS === undefined)
    return { enabled: false, status: "disabled", reason: "verification_keys_missing" };
  if (
    !signer ||
    !keys.some((key) => key.kid === signer.kid && key.publicKeyHex === signer.publicKeyHex)
  )
    throw new Error("BACKUP_SIGNING_KEY_NOT_PINNED");
  return null;
}

async function readState(bucket: R2Bucket): Promise<{ state: RunState; etag: string } | null> {
  const object = await bucket.get(BACKUP_RUN_KEY);
  if (object === null) return null;
  if (object.size > 16 * 1024) throw new Error("BACKUP_RUN_STATE_INVALID");
  const parsed = StateSchema.safeParse(await object.json());
  if (!parsed.success) throw new Error("BACKUP_RUN_STATE_INVALID");
  const state = parsed.data;
  if (
    state.date !== state.startedAt.slice(0, 10) ||
    (state.after !== null && (state.upper === null || state.after > state.upper)) ||
    (state.pending !== null &&
      (state.upper === null ||
        state.pending.id > state.upper ||
        (state.after !== null && state.pending.id <= state.after) ||
        (state.pending.segmented !== null &&
          (state.pending.segmented.after >= state.pending.cursor ||
            state.pending.segmented.segments > state.pending.segmented.after ||
            (state.pending.segmented.after === 0) !==
              (state.pending.segmented.segments === 0))))) ||
    (state.status !== "running" && (state.pending !== null || state.lease !== null)) ||
    (state.status === "complete" && state.failed !== 0)
  )
    throw new Error("BACKUP_RUN_STATE_INVALID");
  return { state, etag: object.etag };
}

async function putState(
  bucket: R2Bucket,
  state: RunState,
  etag: string | null,
): Promise<R2Object | null> {
  return bucket.put(BACKUP_RUN_KEY, JSON.stringify(StateSchema.parse(state)), {
    onlyIf: etag === null ? { etagDoesNotMatch: "*" } : { etagMatches: etag },
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
  });
}

async function freshState(env: BackupEnv, now: number): Promise<RunState> {
  const startedAt = new Date(now).toISOString();
  // Finite sweep: later problem creation cannot keep this run alive forever.
  // A problem published behind this cursor is picked up by the next daily run.
  const head = await env.DB.prepare(`SELECT MAX(id) AS id FROM problems
    WHERE status <> 'private-draft' AND created_at <= ?`)
    .bind(startedAt)
    .first<{ id: string | null }>();
  return StateSchema.parse({
    version: 1,
    date: startedAt.slice(0, 10),
    startedAt,
    upper: head?.id ?? null,
    after: null,
    pending: null,
    status: "running",
    written: 0,
    empty: 0,
    failed: 0,
    lease: null,
    reportKey: null,
  });
}

/** One safe, restartable cron tick. A missing terminal signature keeps the
 * exact captured prefix pending, so a continuously active problem can still
 * finish once the separately bounded signer reaches that checkpoint. */
export async function runScheduledBackup(
  env: BackupEnv,
  now = Date.now(),
): Promise<BackupTickResult> {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime()))
    throw new Error("BACKUP_CLOCK_INVALID");
  const disabled = await checkKeys(env);
  if (disabled) return disabled;

  const previous = await readState(env.ARTIFACTS);
  const today = new Date(now).toISOString().slice(0, 10);
  if (previous?.state.lease && previous.state.lease.expiresAt > now)
    return result(previous.state, "busy");
  if (previous && previous.state.date > today) throw new Error("BACKUP_CLOCK_REGRESSED");
  if (previous && previous.state.status !== "running" && previous.state.date === today)
    return result(previous.state, previous.state.status);
  const initial =
    previous && previous.state.status === "running" ? previous.state : await freshState(env, now);
  const state: RunState = {
    ...initial,
    lease: { owner: crypto.randomUUID(), expiresAt: now + BACKUP_LEASE_MS },
  };
  const owned = await putState(env.ARTIFACTS, state, previous?.etag ?? null);
  if (owned === null) return result(state, "busy");

  // A crash or storage failure leaves the lease for the next tick to reclaim.
  // There is deliberately no finally-block that could release a newer lease.
  let pending = state.pending;
  if (pending === null && state.upper !== null) {
    const next = await env.DB.prepare(`SELECT id, COALESCE(title, id) AS title,
        public_seq AS cursor, chain_digest AS chainDigest
      FROM problems WHERE status <> 'private-draft' AND created_at <= ?
        AND id > ? AND id <= ? ORDER BY id LIMIT 1`)
      .bind(state.startedAt, state.after ?? "", state.upper)
      .first<z.infer<typeof PendingSchema>>();
    if (next) pending = PendingSchema.parse(next);
  }

  if (pending === null) {
    const complete: RunState = {
      ...state,
      lease: null,
      status: state.failed > 0 ? "incomplete" : "complete",
      reportKey: `backups/runs/${state.date}/${state.lease?.owner}.json`,
    };
    // Unique attempt key: an expired worker can leave an unreferenced receipt,
    // but cannot overwrite the receipt selected by a newer conditional cursor.
    await env.ARTIFACTS.put(
      complete.reportKey as string,
      JSON.stringify({
        format: "asimposium.nightly-ledger-backup.v1",
        ...complete,
        scope: "published-problem-ledger-only",
        archive_layout: "single-or-segmented-v1",
        limit_scope: "per-tick",
        limits: SCHEDULED_BACKUP_LIMITS,
      }),
      { httpMetadata: { contentType: "application/json", cacheControl: "no-store" } },
    );
    return (await putState(env.ARTIFACTS, complete, owned.etag)) === null
      ? result(state, "lost-lease")
      : result(complete, complete.status as "complete" | "incomplete");
  }

  let written = 0;
  let failed = 0;
  let empty = 0;
  let receipt: Record<string, unknown>;
  try {
    let archived: Awaited<ReturnType<typeof backupProblem>>;
    try {
      if (pending.segmented !== null) throw new Error("BACKUP_LIMIT_EXCEEDED");
      archived = await backupProblem(env.DB, env.ARTIFACTS, pending.id, pending.title, state.date, {
        checkpointVerifyKeys: env.CHECKPOINT_VERIFY_KEYS,
        ...(pending.cursor > 0
          ? { cut: { cursor: pending.cursor, chainDigest: pending.chainDigest } }
          : {}),
        limits: SCHEDULED_BACKUP_LIMITS,
        requireSignedCheckpoint: true,
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "BACKUP_LIMIT_EXCEEDED") throw error;
      const segment = await backupProblemSegment({
        db: env.DB,
        bucket: env.ARTIFACTS,
        problemId: pending.id,
        title: pending.title,
        date: state.date,
        cursor: pending.cursor,
        chainDigest: pending.chainDigest,
        progress: pending.segmented,
        checkpointVerifyKeys: env.CHECKPOINT_VERIFY_KEYS as string,
        limits: SCHEDULED_BACKUP_LIMITS,
      });
      if (!segment.complete) {
        const continuing: RunState = {
          ...state,
          pending: { ...pending, segmented: segment.progress, waitingSince: null },
          lease: null,
        };
        return (await putState(env.ARTIFACTS, continuing, owned.etag)) === null
          ? result(state, "lost-lease")
          : result(continuing, "segment-written");
      }
      if (!segment.archive) throw new Error("BACKUP_MANIFEST_UNAVAILABLE");
      archived = segment.archive;
    }
    written = archived === null ? 0 : 1;
    empty = archived === null ? 1 : 0;
    receipt = { status: archived === null ? "empty" : "written", archive: archived };
  } catch (error) {
    const signatureUnavailable =
      error instanceof Error && error.message === "BACKUP_SIGNATURE_UNAVAILABLE";
    if (signatureUnavailable) {
      const waitingSince = pending.waitingSince ?? now;
      // The signer may be permanently unable to validate a later checkpoint
      // in this scope. Preserve the first wait across retries, then record a
      // failed archive so that one unsigned scope cannot starve every other one.
      if (now - waitingSince < BACKUP_SIGNATURE_WAIT_MS) {
        const waiting: RunState = {
          ...state,
          pending: { ...pending, waitingSince },
          lease: null,
        };
        return (await putState(env.ARTIFACTS, waiting, owned.etag)) === null
          ? result(state, "lost-lease")
          : result(waiting, "waiting-for-signature");
      }
    }
    // Record the failure and continue other scopes. Raw SQL/provider messages
    // and private payloads never reach cron logs or persisted failure reports.
    failed = 1;
    const code = signatureUnavailable
      ? "BACKUP_SIGNATURE_UNAVAILABLE"
      : error instanceof Error && error.message === "BACKUP_LIMIT_EXCEEDED"
        ? "BACKUP_LIMIT_EXCEEDED"
        : "BACKUP_EXPORT_FAILED";
    receipt = { status: "failed", code };
  }
  await env.ARTIFACTS.put(
    `backups/receipts/${state.date}/${pending.id}/${state.lease?.owner}.json`,
    JSON.stringify({
      format: "asimposium.ledger-backup-receipt.v1",
      problemId: pending.id,
      cursor: pending.cursor,
      chainDigest: pending.chainDigest,
      ...receipt,
    }),
    { httpMetadata: { contentType: "application/json", cacheControl: "no-store" } },
  );
  const advanced: RunState = {
    ...state,
    after: pending.id,
    pending: null,
    lease: null,
    written: state.written + written,
    empty: state.empty + empty,
    failed: state.failed + failed,
  };
  return (await putState(env.ARTIFACTS, advanced, owned.etag)) === null
    ? result(state, "lost-lease")
    : result(advanced, "advanced", written, failed);
}
