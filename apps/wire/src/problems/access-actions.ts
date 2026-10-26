import {
  canonicalJson,
  type ProblemAccessActionReceipt,
  ProblemAccessActionReceiptSchema,
  ProblemGovernanceKeySchema,
  type ProblemLifecycleActionRequest,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope.ts";
import { sha256Hex } from "../krater/krater.ts";
import { privateProblemGovernanceResponse } from "./governance-read.ts";

export type ProblemAccessAction = Extract<
  ProblemLifecycleActionRequest,
  { action: "set-admission-mode" | "manage-member" }
>;

export function isProblemAccessAction(
  action: ProblemLifecycleActionRequest,
): action is ProblemAccessAction {
  return action.action === "set-admission-mode" || action.action === "manage-member";
}

export function problemAccessActionReceipt(
  problemId: string,
  sponsorId: string,
  action: ProblemAccessAction,
  updatedAt: string,
  eventId: string | null,
): ProblemAccessActionReceipt {
  return ProblemAccessActionReceiptSchema.parse({
    problem_id: problemId,
    acting_sponsor_id: sponsorId,
    updated_at: updatedAt,
    event_id: eventId,
    ...(action.action === "set-admission-mode"
      ? { action: action.action, mode: action.mode }
      : {
          action: action.action,
          operation: action.operation,
          target_fellow_id: action.target_fellow_id,
          role: action.operation === "remove" ? null : (action.role ?? "contributor"),
        }),
  });
}

function response(receipt: ProblemAccessActionReceipt): Response {
  return privateProblemGovernanceResponse(
    Response.json({
      problem: {
        id: receipt.problem_id,
        updated_at: receipt.updated_at,
        ...(receipt.action === "set-admission-mode" ? { admission_mode: receipt.mode } : {}),
      },
      governance_action: receipt,
    }),
  );
}

async function commandIdentity(action: ProblemAccessAction, request: Request) {
  const key = ProblemGovernanceKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!key.success)
    return privateProblemGovernanceResponse(
      validatedProblem({
        status: 400,
        code: "IDEMPOTENCY_KEY_INVALID",
        title: "An exact retry key is required",
        detail: "Access actions require 1–160 letters, digits, dots, underscores or hyphens.",
        fixHint: "Retain one Idempotency-Key and the same body until the action is confirmed.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/problems.v1.json",
          example: { action: "set-admission-mode", mode: "approval-required" },
        },
      }),
    );
  return { keyHash: await sha256Hex(key.data), digest: await sha256Hex(canonicalJson(action)) };
}

async function replay(
  db: D1Database,
  problemId: string,
  sponsorId: string,
  identity: { keyHash: string; digest: string },
  now: string,
): Promise<Response | undefined> {
  const row = await db
    .prepare(`SELECT r.request_digest, r.receipt_json
    FROM private_problem_access_replays r JOIN problems p ON p.id = r.problem_id
    JOIN sponsors s ON s.sponsor_id = r.sponsor_id
    WHERE r.problem_id = ? AND r.sponsor_id = ? AND r.key_hash = ? AND r.expires_at > ?
      AND s.tombstoned_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = s.sponsor_id)
      AND NOT EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = p.id)
      AND (p.sponsor_id = s.sponsor_id OR EXISTS (SELECT 1 FROM problem_stewards
        WHERE problem_id = p.id AND sponsor_id = s.sponsor_id))`)
    .bind(problemId, sponsorId, identity.keyHash, now)
    .first<{ request_digest: string; receipt_json: string }>();
  if (!row) return undefined;
  if (row.request_digest !== identity.digest)
    return privateProblemGovernanceResponse(
      validatedProblem({
        status: 409,
        code: "IDEMPOTENCY_CONFLICT",
        title: "This access action key was already used",
        detail: "The retained key identifies a different access action.",
        fixHint: "Retry the unchanged original request or use a new key for a new decision.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/problems.v1.json",
          example: { action: "set-admission-mode", mode: "approval-required" },
        },
      }),
    );
  const receipt = ProblemAccessActionReceiptSchema.parse(JSON.parse(row.receipt_json));
  if (
    receipt.problem_id !== problemId ||
    receipt.acting_sponsor_id !== sponsorId ||
    receipt.event_id !== null
  )
    throw new Error("Private problem access receipt binding is invalid.");
  return response(receipt);
}

/** Read before selecting draft/public handling: publication cannot turn an old
 * private retry into a fresh public action. Current authority is still required. */
export async function replayPrivateProblemAccessAction(
  db: D1Database,
  problemId: string,
  sponsorId: string,
  action: ProblemAccessAction,
  request: Request,
): Promise<Response | undefined> {
  const identity = await commandIdentity(action, request);
  if (identity instanceof Response) return identity;
  return replay(db, problemId, sponsorId, identity, new Date().toISOString());
}

export async function applyPrivateProblemAccessAction(
  db: D1Database,
  problemId: string,
  sponsorId: string,
  action: ProblemAccessAction,
  request: Request,
): Promise<Response> {
  const identity = await commandIdentity(action, request);
  if (identity instanceof Response) return identity;
  const now = new Date().toISOString();
  const previous = await replay(db, problemId, sponsorId, identity, now);
  if (previous) return previous;
  const receipt = problemAccessActionReceipt(problemId, sponsorId, action, now, null);
  try {
    await db.batch([
      db
        .prepare(`DELETE FROM private_problem_access_replays WHERE rowid IN (
        SELECT rowid FROM private_problem_access_replays WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)`)
        .bind(now),
      db
        .prepare(`DELETE FROM private_problem_access_replays
        WHERE problem_id = ? AND sponsor_id = ? AND key_hash = ? AND expires_at <= ?`)
        .bind(problemId, sponsorId, identity.keyHash, now),
      db
        .prepare(`INSERT INTO private_problem_access_replays
        (problem_id, sponsor_id, key_hash, request_digest, receipt_json, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(problem_id, sponsor_id, key_hash) DO NOTHING`)
        .bind(
          problemId,
          sponsorId,
          identity.keyHash,
          identity.digest,
          JSON.stringify(receipt),
          now,
          new Date(Date.parse(now) + 86_400_000).toISOString(),
        ),
    ]);
  } catch (error) {
    const winner = await replay(db, problemId, sponsorId, identity, now);
    if (winner) return winner;
    if (String(error).includes("PRIVATE_PROBLEM_ACCESS_NOT_CURRENT")) {
      return privateProblemGovernanceResponse(
        validatedProblem({
          status: 409,
          code: "OBJECT_VERSION_CONFLICT",
          title: "Problem access authority changed",
          detail:
            "The draft or its current sponsor/steward authority changed; this action was not applied.",
          fixHint: "Reload the workspace and make a new access decision under its current state.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/problems.v1.json",
            example: { action: "set-admission-mode", mode: "approval-required" },
          },
        }),
      );
    }
    throw error;
  }
  const committed = await replay(db, problemId, sponsorId, identity, now);
  if (!committed) throw new Error("Private problem access action has no retained receipt.");
  return committed;
}
