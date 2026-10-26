import {
  PROBLEM_SLOW_MODE_MAX_DURATION_MS,
  PROBLEM_SLOW_MODE_STEP_UP_SECONDS,
  type ProblemSlowModeReceipt,
  ProblemSlowModeReceiptSchema,
  type ProblemSlowModeRequest,
  type ProblemSlowModeState,
  ProblemSlowModeStateSchema,
  type RateLimitBudget,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { sha256Hex } from "../split/policy";
import { mintModerationId } from "./store";

export interface SlowModePrincipal {
  readonly kind: "operator" | "sponsor";
  readonly id: string;
}

interface SlowModeRow {
  event_id: string;
  revision: number;
  action: "set" | "clear";
  limit_per_hour: number | null;
  expires_at: number | null;
  reason: string;
  created_at: number;
}

export class SlowModeError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "CONFLICT" | "REPLAY_CONFLICT" | "STEP_UP" | "EXPIRY" | "TARGET",
  ) {
    super(code);
    this.name = "SlowModeError";
  }
}

async function current(db: D1Database, problemId: string): Promise<SlowModeRow | null> {
  return db
    .prepare(`SELECT event_id, revision, action, limit_per_hour, expires_at, reason, created_at
    FROM problem_slow_mode_current WHERE problem_id = ?`)
    .bind(problemId)
    .first<SlowModeRow>();
}

/** Missing or unreadable policy storage is an error, never an invented default. */
export async function readPromotionPolicy(
  db: D1Database,
  problemId: string | null | undefined,
  now: number,
): Promise<{ limit: number; slow_mode?: NonNullable<RateLimitBudget["slow_mode"]> }> {
  if (!problemId) return { limit: 20 };
  const row = await current(db, problemId);
  if (row === null) return { limit: 20 };
  if (
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !Number.isSafeInteger(row.created_at) ||
    row.created_at <= 0 ||
    !/^SM-[0-9A-HJKMNP-TV-Z]{26}$/.test(row.event_id)
  )
    throw new Error("SLOW_MODE_STATE_INVALID");
  if (row.action === "clear") {
    if (row.limit_per_hour !== null || row.expires_at !== null)
      throw new Error("SLOW_MODE_STATE_INVALID");
    return { limit: 20 };
  }
  if (
    row.action !== "set" ||
    !Number.isInteger(row.limit_per_hour) ||
    row.limit_per_hour === null ||
    row.limit_per_hour < 1 ||
    row.limit_per_hour > 19 ||
    row.expires_at === null ||
    !Number.isSafeInteger(row.expires_at) ||
    row.expires_at <= row.created_at ||
    row.expires_at > row.created_at + PROBLEM_SLOW_MODE_MAX_DURATION_MS
  )
    throw new Error("SLOW_MODE_STATE_INVALID");
  if (row.expires_at <= now) return { limit: 20 };
  return {
    limit: row.limit_per_hour,
    slow_mode: {
      event_id: row.event_id,
      revision: row.revision,
      expires_at: new Date(row.expires_at).toISOString(),
    },
  };
}

async function requireAuthority(db: D1Database, problemId: string, principal: SlowModePrincipal) {
  const row = await db
    .prepare(`SELECT p.id FROM problems p
    WHERE p.id = ? AND p.status <> 'private-draft' AND p.public_seq > 0
      AND (? = 'operator' OR EXISTS (
        SELECT 1 FROM sponsors sponsor WHERE sponsor.sponsor_id = ? AND sponsor.tombstoned_at IS NULL
          AND EXISTS (
            SELECT 1 FROM problem_stewards steward
            WHERE steward.problem_id = p.id AND steward.sponsor_id = sponsor.sponsor_id
          )
      ))`)
    .bind(problemId, principal.kind, principal.id)
    .first<{ id: string }>();
  if (row === null) throw new SlowModeError("NOT_FOUND");
}

export async function readProblemSlowMode(
  db: D1Database,
  problemId: string,
  principal: SlowModePrincipal,
  now = Date.now(),
): Promise<ProblemSlowModeState> {
  await requireAuthority(db, problemId, principal);
  const row = await current(db, problemId);
  // One row supplies both the revision and effective state. A concurrent
  // command makes the next mutation conflict; it cannot produce mixed cuts.
  if (row === null)
    return { problem_id: problemId, revision: 0, effective_limit_per_hour: 20, slow_mode: null };
  const active = row.action === "set" && row.expires_at !== null && row.expires_at > now;
  return ProblemSlowModeStateSchema.parse({
    problem_id: problemId,
    revision: row.revision,
    effective_limit_per_hour: active ? row.limit_per_hour : 20,
    slow_mode: active
      ? {
          event_id: row.event_id,
          revision: row.revision,
          limit_per_hour: row.limit_per_hour,
          expires_at: new Date(row.expires_at as number).toISOString(),
          applied_at: new Date(row.created_at).toISOString(),
          reason: row.reason,
        }
      : null,
  });
}

export async function changeProblemSlowMode(
  db: D1Database,
  problemId: string,
  principal: SlowModePrincipal,
  request: ProblemSlowModeRequest,
  idempotencyKey: string,
  now = Date.now(),
): Promise<ProblemSlowModeReceipt> {
  if (request.problem_id !== problemId) throw new SlowModeError("TARGET");
  await requireAuthority(db, problemId, principal);
  const keyHash = await sha256Hex(idempotencyKey);
  // Fresh authentication proves authority for a new command; it is not part
  // of the product intent, so a receipt survives safe reauthentication.
  const { step_up_authenticated_at: _authenticatedAt, ...intent } = request;
  const digest = await sha256Hex(JSON.stringify(intent));
  const replay = async () => {
    const saved = await db
      .prepare(`SELECT request_digest, receipt_json FROM problem_slow_mode_events
      WHERE problem_id = ? AND actor_kind = ? AND actor_id = ? AND idempotency_key_hash = ?`)
      .bind(problemId, principal.kind, principal.id, keyHash)
      .first<{ request_digest: string; receipt_json: string }>();
    if (saved === null) return null;
    if (saved.request_digest !== digest) throw new SlowModeError("REPLAY_CONFLICT");
    return ProblemSlowModeReceiptSchema.parse(JSON.parse(saved.receipt_json));
  };
  // A known accepted receipt remains replayable after the mode or step-up
  // expires. Replaying it changes no state and never reactivates the cap.
  const previous = await replay();
  if (previous !== null) return previous;
  const age = Math.floor(now / 1000) - request.step_up_authenticated_at;
  if (age < 0 || age > PROBLEM_SLOW_MODE_STEP_UP_SECONDS) throw new SlowModeError("STEP_UP");
  const expiresAt = request.action === "set" ? Date.parse(request.expires_at) : null;
  if (
    expiresAt !== null &&
    (!Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      expiresAt > now + PROBLEM_SLOW_MODE_MAX_DURATION_MS)
  )
    throw new SlowModeError("EXPIRY");
  const row = await current(db, problemId);
  if ((row?.revision ?? 0) !== request.expected_revision) throw new SlowModeError("CONFLICT");
  const eventId = mintModerationId("SM");
  const receipt = ProblemSlowModeReceiptSchema.parse({
    problem_id: problemId,
    event_id: eventId,
    revision: request.expected_revision + 1,
    action: request.action,
    limit_per_hour: request.action === "set" ? request.limit_per_hour : null,
    expires_at: expiresAt === null ? null : new Date(expiresAt).toISOString(),
    applied_at: new Date(now).toISOString(),
  });
  try {
    await db
      .prepare(`INSERT INTO problem_slow_mode_events (
      event_id, problem_id, revision, actor_kind, actor_id, action, limit_per_hour,
      expires_at, reason, created_at, step_up_authenticated_at, idempotency_key_hash, request_digest, receipt_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        eventId,
        problemId,
        receipt.revision,
        principal.kind,
        principal.id,
        request.action,
        receipt.limit_per_hour,
        expiresAt,
        request.reason,
        now,
        request.step_up_authenticated_at,
        keyHash,
        digest,
        JSON.stringify(receipt),
      )
      .run();
  } catch (error) {
    const concurrent = await replay();
    if (concurrent !== null) return concurrent;
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("SLOW_MODE_CONTROL_NOT_CURRENT") ||
      message.includes("UNIQUE constraint failed")
    )
      throw new SlowModeError("CONFLICT");
    throw error;
  }
  console.info(
    JSON.stringify({
      facility: "OPS.2a",
      stage: "problem-slow-mode",
      problem_id: problemId,
      event_id: eventId,
      revision: receipt.revision,
      action: request.action,
      principal_class: principal.kind,
    }),
  );
  return receipt;
}
