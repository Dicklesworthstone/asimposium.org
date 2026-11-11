import {
  canonicalJson,
  PROBLEM_HIDE_AUTH_CLOCK_SKEW_SECONDS,
  PROBLEM_HIDE_AUTH_WINDOW_SECONDS,
  problemHideAuthIsRecent,
  type SponsorProblemHideReceipt,
  SponsorProblemHideReceiptSchema,
  type SponsorProblemHideRequest,
  SponsorProblemHideRequestSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope.ts";
import { contentControlJournalStatements } from "../krater/retention.ts";
import {
  scanFieldsForCredentials,
  secretShapedContentProblem,
} from "../screening/credential-scan.ts";
import { sha256Hex } from "../split/policy.ts";
import { currentContentControl, mintModerationId } from "./store.ts";

const EXAMPLE = {
  problem_id: "P-DEMO",
  reason: "Withdraw this problem from public display.",
  step_up_authenticated_at: 1794398400,
};
const SCHEMA = "https://a.asimposium.org/schemas/problems.v1.json";

/** Owner authority is deliberately narrower than stewardship or Fellow sponsorship. */
const OWNER_SQL = `EXISTS (
  SELECT 1 FROM problems p JOIN sponsors sponsor ON sponsor.sponsor_id = p.sponsor_id
  WHERE p.id = ? AND p.sponsor_id = ?
    AND p.status <> 'private-draft' AND p.public_seq > 0
    AND sponsor.tombstoned_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM sponsor_suspension_events suspension
      WHERE suspension.sponsor_id = sponsor.sponsor_id
    )
)`;

export class ProblemHideError extends Error {
  constructor(readonly code: "NOT_FOUND" | "STEP_UP" | "CONFLICT" | "REPLAY_CONFLICT") {
    super(code);
    this.name = "ProblemHideError";
  }
}

async function requireOwner(db: D1Database, problemId: string, sponsorId: string): Promise<void> {
  const owner = await db
    .prepare(`SELECT 1 AS allowed WHERE ${OWNER_SQL}`)
    .bind(problemId, sponsorId)
    .first();
  if (owner === null) throw new ProblemHideError("NOT_FOUND");
}

/** One transaction owns the control, coarse log, cursor invalidation and retry receipt.
 * Retrying an accepted key only reads its historical receipt, even after restoration. */
export async function hideSponsorProblem(
  db: D1Database,
  sponsorId: string,
  request: SponsorProblemHideRequest,
  idempotencyKey: string,
): Promise<SponsorProblemHideReceipt> {
  await requireOwner(db, request.problem_id, sponsorId);
  if (!problemHideAuthIsRecent(request.step_up_authenticated_at))
    throw new ProblemHideError("STEP_UP");
  const keyDigest = await sha256Hex(idempotencyKey);
  // Reauthentication changes the signed envelope, never the meaning of the command.
  const requestDigest = await sha256Hex(
    canonicalJson({
      action: "hide",
      problem_id: request.problem_id,
      reason: request.reason,
    }),
  );
  const replay = async (): Promise<SponsorProblemHideReceipt | null> => {
    const saved = await db
      .prepare(`SELECT request_digest, problem_id, control_id,
      control_version, receipt_json, created_at FROM sponsor_problem_hide_receipts
      WHERE sponsor_id = ? AND key_digest = ? AND ${OWNER_SQL}`)
      .bind(sponsorId, keyDigest, request.problem_id, sponsorId)
      .first<{
        request_digest: string;
        problem_id: string;
        control_id: string;
        control_version: number;
        receipt_json: string;
        created_at: string;
      }>();
    if (saved === null) return null;
    if (saved.request_digest !== requestDigest) throw new ProblemHideError("REPLAY_CONFLICT");
    const receipt = SponsorProblemHideReceiptSchema.parse(JSON.parse(saved.receipt_json));
    if (
      receipt.problem_id !== request.problem_id ||
      receipt.problem_id !== saved.problem_id ||
      receipt.control_id !== saved.control_id ||
      receipt.version !== saved.control_version ||
      receipt.applied_at !== saved.created_at
    )
      throw new Error("SPONSOR_PROBLEM_HIDE_RECEIPT_INVALID");
    return receipt;
  };

  const previous = await replay();
  if (previous !== null) return previous;
  const current = await currentContentControl(db, request.problem_id, "problem");
  if (current?.visibility === "hidden") throw new ProblemHideError("CONFLICT");
  const controlId = mintModerationId("CC");
  const appliedAt = new Date().toISOString();
  const receipt = SponsorProblemHideReceiptSchema.parse({
    ok: true,
    problem_id: request.problem_id,
    action: "hide",
    visibility: "hidden",
    actor_kind: "sponsor",
    control_id: controlId,
    version: (current?.version ?? 0) + 1,
    applied_at: appliedAt,
  });
  try {
    const [control] = await db.batch([
      db
        .prepare(`INSERT INTO content_controls
        (control_id, problem_id, target_kind, target_ref, visibility, source,
         reason_category, actor, reason, version, created_at, actor_kind)
        SELECT ?, ?, 'problem', 'problem', 'hidden', 'operator',
          'sponsor-requested', ?, ?, ?, ?, 'sponsor'
        WHERE ${OWNER_SQL}
          AND CAST(strftime('%s', 'now') AS INTEGER) BETWEEN ? AND ?
          AND COALESCE((SELECT control_id FROM content_controls
            WHERE problem_id = ? AND target_ref = 'problem'
            ORDER BY version DESC LIMIT 1), '') = ?`)
        .bind(
          controlId,
          request.problem_id,
          sponsorId,
          request.reason,
          receipt.version,
          appliedAt,
          request.problem_id,
          sponsorId,
          request.step_up_authenticated_at - PROBLEM_HIDE_AUTH_CLOCK_SKEW_SECONDS,
          request.step_up_authenticated_at +
            PROBLEM_HIDE_AUTH_WINDOW_SECONDS +
            PROBLEM_HIDE_AUTH_CLOCK_SKEW_SECONDS,
          request.problem_id,
          current?.control_id ?? "",
        ),
      ...(await contentControlJournalStatements(db, {
        control_id: controlId,
        problem_id: request.problem_id,
        target_kind: "problem",
        target_ref: "problem",
        visibility: "hidden",
        source: "operator",
        reason_category: "sponsor-requested",
        actor: sponsorId,
        reason: request.reason,
        version: receipt.version,
        created_at: appliedAt,
        actor_kind: "sponsor",
      })),
      db
        .prepare(`INSERT INTO moderation_log
        (entry_id, seq, action, category, subject, problem_id, created_at)
        SELECT ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM moderation_log),
          'hidden', 'sponsor-requested', 'problem',
          (SELECT p.id FROM problems p WHERE p.id = ? AND p.unlisted = 0
            AND p.status <> 'private-draft' AND p.public_seq > 0), ?
        WHERE EXISTS (SELECT 1 FROM content_controls WHERE control_id = ?)`)
        .bind(mintModerationId("ML"), request.problem_id, appliedAt, controlId),
      // This unique key is last: a concurrent loser rolls back every earlier effect.
      db
        .prepare(`INSERT INTO sponsor_problem_hide_receipts
        (sponsor_id, key_digest, request_digest, problem_id, control_id, control_version,
         step_up_authenticated_at, receipt_json, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM content_controls WHERE control_id = ?)`)
        .bind(
          sponsorId,
          keyDigest,
          requestDigest,
          request.problem_id,
          controlId,
          receipt.version,
          request.step_up_authenticated_at,
          JSON.stringify(receipt),
          appliedAt,
          controlId,
        ),
    ]);
    const committed = await replay();
    if (committed !== null) return committed;
    await requireOwner(db, request.problem_id, sponsorId);
    if (!problemHideAuthIsRecent(request.step_up_authenticated_at))
      throw new ProblemHideError("STEP_UP");
    if ((control?.meta.changes ?? 0) === 1) throw new Error("SPONSOR_PROBLEM_HIDE_RECEIPT_MISSING");
    throw new ProblemHideError("CONFLICT");
  } catch (error) {
    // A lost response or a concurrently accepted identical key is recoverable.
    // Current ownership is still required; an old receipt is not authority.
    await requireOwner(db, request.problem_id, sponsorId);
    const concurrent = await replay();
    if (concurrent !== null) return concurrent;
    throw error;
  }
}

function privateResponse(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
}

function invalid(): Response {
  return privateResponse(
    validatedProblem({
      status: 422,
      code: "SCHEMA_INVALID",
      title: "The hide command does not match its contract",
      detail:
        "The signed problem id, private reason, recent authentication and retry key are required.",
      fixHint:
        "Use hide <problem> <reason> in Agora with a recent Google sign-in. Retry an unchanged command with its original Idempotency-Key.",
      rule: "A5",
      extensions: { schema: SCHEMA, example: EXAMPLE },
    }),
  );
}

/** Called only after verifying a sponsor envelope for this exact path and action. */
export async function sponsorProblemHideHttp(input: {
  readonly db: D1Database;
  readonly sponsorId: string;
  readonly problemId: string;
  readonly body: unknown;
  readonly idempotencyKey: string;
}): Promise<Response> {
  const parsed = SponsorProblemHideRequestSchema.safeParse(input.body);
  if (
    !parsed.success ||
    parsed.data.problem_id !== input.problemId ||
    !/^[A-Za-z0-9._-]{1,160}$/.test(input.idempotencyKey)
  )
    return invalid();
  const secrets = scanFieldsForCredentials({ reason: parsed.data.reason });
  if (secrets.length > 0) return privateResponse(secretShapedContentProblem(secrets, EXAMPLE));
  try {
    return privateResponse(
      Response.json(
        await hideSponsorProblem(input.db, input.sponsorId, parsed.data, input.idempotencyKey),
      ),
    );
  } catch (error) {
    if (error instanceof ProblemHideError) {
      if (error.code === "STEP_UP")
        return privateResponse(
          validatedProblem({
            status: 403,
            code: "STEP_UP_REQUIRED",
            title: "Recent Google authentication is required",
            detail: "This hide command needs a recent authentication time signed by Agora.",
            fixHint: "Sign in again with Google, then retry the unchanged command and key.",
          }),
        );
      const absent = error.code === "NOT_FOUND";
      return privateResponse(
        validatedProblem({
          status: absent ? 404 : 409,
          code: absent
            ? "MODERATION_TARGET_NOT_FOUND"
            : error.code === "REPLAY_CONFLICT"
              ? "IDEMPOTENCY_CONFLICT"
              : "MODERATION_STATE_CONFLICT",
          title: absent ? "No manageable published problem matches" : "The hide command conflicts",
          detail: absent
            ? "The problem is not available to this sponsor for hiding."
            : "No new control was applied. The problem is already hidden, its control changed, or the retry key belongs to a different command.",
          fixHint:
            "Only the problem's current owning sponsor may hide it here. Inspect current visibility before a new command; retry an accepted command with its exact problem, reason and key to retrieve its receipt.",
          rule: "A5",
          extensions: { schema: SCHEMA, example: EXAMPLE },
        }),
      );
    }
    return privateResponse(
      validatedProblem({
        status: 503,
        code: "OPERATOR_CONTROL_UNAVAILABLE",
        title: "Problem hiding is temporarily unavailable",
        detail: "An authoritative hide receipt could not be read or committed safely.",
        fixHint: "Retry later with the same problem, reason and Idempotency-Key.",
      }),
    );
  }
}
