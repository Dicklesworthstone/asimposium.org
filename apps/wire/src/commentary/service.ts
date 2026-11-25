import {
  COMMENTARY_SCHEMA_ID,
  type CommentaryItem,
  CommentaryItemSchema,
  type CommentaryListQuery,
  type CommentaryListResponse,
  CommentaryListResponseSchema,
  type ProblemCode,
  SCREENING_APPEAL_CODE,
  ScreeningCoarseCategorySchema,
  ScreeningPromotionDeniedResponseSchema,
  type SponsorCommentaryPostRequest,
  type SponsorCommentaryTombstoneRequest,
} from "@asimposium/contracts";
import type { Env } from "../env.ts";
import { type ProblemInput, validatedProblem } from "../http/envelope.ts";
import {
  KraterIdempotencyConflictError,
  KraterLedgerPreconditionError,
  writeLedgerEvent,
} from "../krater/krater.ts";
import { hiddenByContentControlSql } from "../krater/public-content.ts";
import { getScreeningCase, screeningCaseFor, sponsorCaseActorId } from "../moderation/store.ts";
import {
  scanFieldsForCredentials,
  secretShapedContentProblem,
} from "../screening/credential-scan.ts";
import {
  isScreeningDecisionChangedError,
  screeningDecisionGuardStatement,
  supersedeHeldCaseStatement,
} from "../screening/ingress.ts";
import { screenWithProvider } from "../screening/provider.ts";
import {
  type PublicCandidateScreener,
  screeningHoldResponse,
  screenPublicCandidate,
} from "../screening/public-candidate.ts";
import {
  isScreeningContextStaleError,
  screeningContextGuardStatement,
  screeningContextStaleProblem,
} from "../screening/publication-context.ts";
import { publicationScreeningNotice } from "../screening/publication-notice.ts";
import { POLICY_CATEGORIES, type PolicyCategory } from "../screening/types.ts";
import {
  type PublicationScreeningObservation,
  promotionScreeningBinding,
  screenPromotionWithWorkersAI,
  WORKERS_AI_MODEL_VERSION,
  WORKERS_AI_POLICY_VERSION,
  WorkersAIScreeningProvider,
  type WorkersAiBinding,
  workersAIConfigurationDigest,
} from "../screening/workers-ai.ts";
import { PROMOTION_RATE_LIMIT_WINDOW_MS, parseSponsorLimit } from "../sessions/quota.ts";

export const COMMENTARY_MAX_BODY_CHARS = 2000;
export const COMMENTARY_RATE_LIMIT_PER_MINUTE = 20;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const COMMENTARY_RESERVATION_EXPIRY_MS = 60_000;

const PUBLIC_PROBLEM_SQL = `p.status <> 'private-draft'
  AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}`;
const COMMENTARY_SOURCE_SQL = `FROM problem_commentaries pc
  JOIN problems p ON p.id = pc.problem_id
  JOIN events e ON e.id = pc.event_id AND e.problem_id = pc.problem_id
    AND e.object_kind = 'commentary' AND e.object_id = pc.id
    AND e.type IN ('commentary.posted', 'commentary.superseded')
    AND e.actor_sponsor_id = pc.sponsor_id AND e.seq = pc.seq AND e.seq <= p.public_seq
  JOIN event_content ec ON ec.event_id = e.id AND ec.payload_sha256 = e.payload_sha256
    AND ec.redacted_at IS NULL
  LEFT JOIN screening_publications sp ON sp.event_id = pc.event_id
  WHERE ${PUBLIC_PROBLEM_SQL}
    AND NOT ${hiddenByContentControlSql("pc.problem_id", "pc.id")}`;
// Public bytes come from their available, digest-bound source event. A retained
// projection cannot restore a redacted body or evade a current content control.
const COMMENTARY_COLUMNS = `pc.id, pc.problem_id, pc.seq, pc.sponsor_id,
  CASE WHEN pc.tombstoned = 1 THEN NULL ELSE json_extract(ec.payload_json, '$.body') END AS body,
  json_extract(ec.payload_json, '$.relates_to') AS relates_to_json,
  pc.supersedes_commentary_id, pc.superseded_by_commentary_id, pc.tombstoned,
  pc.tombstone_reason, pc.created_at, pc.updated_at, pc.event_id,
  CASE WHEN pc.tombstoned = 1 THEN NULL ELSE sp.provenance_json END AS screening_provenance_json`;

export function commentaryContractProblem(
  input: Omit<ProblemInput, "code"> & {
    readonly code: ProblemCode;
    readonly example?: Record<string, unknown>;
  },
): Response {
  return validatedProblem({
    ...input,
    rule: "A5",
    extensions: {
      schema: COMMENTARY_SCHEMA_ID,
      example: input.example ?? {
        method: "POST",
        path: "/v1/problems/P-DEMO/commentary",
        body: { problem_id: "P-DEMO", body: "Human context for this public problem." },
      },
    },
  });
}

function problemNotFound(): Response {
  return commentaryContractProblem({
    status: 404,
    code: "PROBLEM_NOT_FOUND",
    title: "Problem not found",
    detail: "No public problem is available at this identifier.",
    fixHint: "Open a currently public problem before reading or posting commentary.",
    example: { method: "GET", path: "/problems.json" },
  });
}

function commentaryNotFound(): Response {
  return commentaryContractProblem({
    status: 404,
    code: "COMMENTARY_NOT_FOUND",
    title: "Commentary not found",
    detail: "This commentary is unavailable on the current public problem.",
    fixHint: "Refresh the public commentary before choosing an entry.",
    example: { method: "GET", path: "/p/P-DEMO/commentary.json" },
  });
}

function idempotencyConflict(): Response {
  return commentaryContractProblem({
    status: 409,
    code: "IDEMPOTENCY_CONFLICT",
    title: "Idempotency key already used",
    detail: "This key identifies a different sponsor, action, or exact request.",
    fixHint: "Retry the original request unchanged, or use a fresh key for a new action.",
    example: { headers: { "Idempotency-Key": "fresh-commentary-action" } },
  });
}

function idempotencyInFlight(): Response {
  const response = commentaryContractProblem({
    status: 409,
    code: "IDEMPOTENCY_CONFLICT",
    title: "This commentary submission is already in progress",
    detail: "Another identical request currently owns screening for this Idempotency-Key.",
    fixHint: "Wait briefly and retry the exact unchanged request with the same Idempotency-Key.",
    example: { headers: { "Retry-After": "1" } },
  });
  response.headers.set("retry-after", "1");
  return response;
}

function ownershipMismatch(): Response {
  return validatedProblem({
    status: 403,
    code: "COMMENTARY_OWNERSHIP_MISMATCH",
    title: "Commentary action not authorized",
    detail: "A sponsor may change only their own commentary.",
    fixHint: "Choose your own entry or post a separate comment.",
  });
}

function sponsorUnavailable(): Response {
  return commentaryContractProblem({
    status: 403,
    code: "SPONSOR_ACCOUNT_DELETED",
    title: "Sponsor account unavailable",
    detail: "This sponsor account cannot perform a new commentary action.",
    fixHint: "Check the current account in the console before continuing.",
  });
}

function sponsorSuspended(): Response {
  return validatedProblem({
    status: 403,
    code: "WRITE_REFUSED",
    title: "Sponsor account suspended",
    detail: "This sponsor account is suspended and cannot perform commentary actions.",
    fixHint: "Contact the operator regarding the sponsor suspension before writing.",
  });
}

function rateLimited(retryAfterSeconds = 60, detail?: string): Response {
  const retryAfter = Math.max(1, Math.ceil(retryAfterSeconds));
  const response = commentaryContractProblem({
    status: 429,
    code: "RATE_LIMITED",
    title: "Commentary rate limit reached",
    detail:
      detail ??
      `A sponsor may attempt at most ${COMMENTARY_RATE_LIMIT_PER_MINUTE} comments or revisions per rolling minute.`,
    fixHint: `Wait ${retryAfter} seconds before submitting further commentary.`,
    example: { headers: { "Retry-After": String(retryAfter) } },
  });
  response.headers.set("retry-after", String(retryAfter));
  return response;
}

export interface CommentaryServiceOptions {
  readonly db: Env["DB"];
  readonly ai?: unknown;
  readonly sponsorLimit?: string | number | null;
  readonly screenPromotion?: PublicCandidateScreener;
}

export type CommentaryRow = {
  id: string;
  problem_id: string;
  seq: number;
  sponsor_id: string;
  body: string | null;
  relates_to_json: string;
  supersedes_commentary_id: string | null;
  superseded_by_commentary_id: string | null;
  tombstoned: number;
  tombstone_reason: string | null;
  created_at: string;
  updated_at: string;
  event_id: string;
  screening_provenance_json?: string | null;
};

type CommentaryAttemptRow = {
  reservation_id: string;
  request_digest: string;
  reserved_at: number;
  expires_at: number;
  status:
    | "reserved"
    | "settled_published"
    | "settled_held"
    | "settled_rejected"
    | "settled_failed"
    | "recovered";
  case_id: string | null;
  event_id: string | null;
};

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function rowToCommentaryItem(row: CommentaryRow): CommentaryItem {
  let relatesTo: CommentaryItem["relates_to"] = [];
  try {
    if (!row.tombstoned) relatesTo = JSON.parse(row.relates_to_json);
  } catch {
    relatesTo = [];
  }
  const screeningNotice = row.tombstoned
    ? undefined
    : publicationScreeningNotice(row.screening_provenance_json);
  return CommentaryItemSchema.parse({
    schema: COMMENTARY_SCHEMA_ID,
    commentary_id: row.id,
    problem_id: row.problem_id,
    seq: row.seq,
    sponsor_id: row.sponsor_id,
    body: row.tombstoned ? null : row.body,
    relates_to: relatesTo,
    supersedes_commentary_id: row.supersedes_commentary_id,
    superseded_by_commentary_id: row.superseded_by_commentary_id,
    tombstoned: row.tombstoned === 1,
    tombstone_reason: row.tombstone_reason,
    ...(screeningNotice === undefined ? {} : { screening_notice: screeningNotice }),
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

export interface ScreeningCheckResult {
  readonly ok: boolean;
  readonly category: string;
  readonly unavailable?: boolean;
}

/**
 * Fast deterministic L0 screening against prompt injection, control markers,
 * and unauthorized attempts to mint scientific claims/falsifiers/dispositions in commentary.
 */
export function screenCommentaryL0(body: string): ScreeningCheckResult {
  // 1. Control markers & prompt injection
  const injectionPatterns = [
    /<<</,
    />>>/,
    /<!--\s*asimp/i,
    /ignore\s+(all\s+|previous\s+|prior\s+)*instructions/i,
    /system\s*:\s*(?:you are|act as|new instructions)/i,
    /\[system\]/i,
  ];
  for (const pattern of injectionPatterns) {
    if (pattern.test(body)) {
      return {
        ok: false,
        category: "injection",
      };
    }
  }

  // 2. Claim-shaped / operational-harm content attempting to mint scientific objects in commentary
  const claimPatterns = [
    /claim\s*:\s*.+falsifier\s*:/is,
    /falsifier\s*:\s*.+claim\s*:/is,
    /^\[?(?:claim|theorem|lemma|conjecture)\]?\s*:/im,
    /disposition\s*:\s*(?:strongly-supported|supported|open|refuted)/i,
    /proof\s*:\s*```lean/i,
  ];
  for (const pattern of claimPatterns) {
    if (pattern.test(body)) {
      return {
        ok: false,
        category: "operational-harm",
      };
    }
  }

  return { ok: true, category: "benign-context" };
}

export interface CommentaryScreeningContext {
  readonly problemTitle?: string | null;
  readonly priorCommentary?: readonly string[];
}

export async function screenCommentaryText(
  body: string,
  problemId: string,
  sponsorId: string,
  aiBinding?: unknown,
  context?: CommentaryScreeningContext,
): Promise<ScreeningCheckResult> {
  const l0 = screenCommentaryL0(body);
  if (!l0.ok) {
    return l0;
  }

  if (!aiBinding || typeof (aiBinding as { run?: unknown }).run !== "function")
    return { ok: false, category: "provider-unavailable", unavailable: true };
  try {
    const prior = (context?.priorCommentary ?? []).slice(0, 8);
    const contextualEnvelope =
      prior.length > 0 || context?.problemTitle
        ? JSON.stringify({
            problem_id: problemId,
            problem_title: context?.problemTitle ?? null,
            prior_sponsor_commentary: prior,
            current_commentary: body,
          })
        : body;
    const bodyDigest = `sha256:${await sha256Hex(body)}`;
    const contextDigest = `sha256:${await sha256Hex(
      JSON.stringify({
        problem_id: problemId,
        sponsor_id: sponsorId,
        problem_title: context?.problemTitle ?? null,
        prior_sponsor_commentary: prior,
      }),
    )}`;
    const identity = {
      corpus_revision: "commentary-contextual-v2",
      corpus_digest: bodyDigest,
      model_version: WORKERS_AI_MODEL_VERSION,
      policy_version: WORKERS_AI_POLICY_VERSION,
      configuration_digest: await workersAIConfigurationDigest(),
    } as const;

    const provider = new WorkersAIScreeningProvider(aiBinding as WorkersAiBinding, {
      maxBodyBytes: 32_768,
      resolveBody: () => contextualEnvelope,
    });

    const observation = await screenWithProvider(
      provider,
      {
        example_id: "commentary-post",
        body_digest: bodyDigest,
        context_digest: contextDigest,
        identity,
      },
      { timeout_ms: 10_000 },
    );

    if (observation.decision !== "pass" || observation.provider_status !== "ok") {
      return {
        ok: false,
        category: observation.coarse_category,
        unavailable: observation.provider_status !== "ok" || observation.decision !== "reject",
      };
    }
  } catch {
    return {
      ok: false,
      category: "provider-unavailable",
      unavailable: true,
    };
  }

  return { ok: true, category: "benign-context" };
}

function createCommentaryScreener(delegate?: PublicCandidateScreener): PublicCandidateScreener {
  return async (input, env): Promise<PublicationScreeningObservation> => {
    const l0 = screenCommentaryL0(input.statement);
    if (!l0.ok) {
      const binding = await promotionScreeningBinding(input);
      const category: PolicyCategory =
        l0.category === "injection" ? "injection" : "operational-harm";
      return {
        example_id: "commentary-l0",
        status_code: "SCREENED",
        decision: "reject",
        coarse_category: category,
        category_score_bands: Object.fromEntries(
          POLICY_CATEGORIES.map((name) => [name, undefined]),
        ) as Readonly<Record<PolicyCategory, undefined>>,
        decision_path: "provider",
        provider_status: "ok",
        evaluated_body_digest: binding.bodyDigest,
        evaluated_context_digest: binding.contextDigest,
        model_version: "commentary-l0:deterministic-v1",
        policy_version: WORKERS_AI_POLICY_VERSION,
        configuration_digest: await workersAIConfigurationDigest(),
        latency_ms: 0,
        retry_count: 0,
      };
    }
    if (delegate !== undefined) return delegate(input, env);
    const ai = env.AI as unknown as WorkersAiBinding | undefined;
    const validAi =
      ai !== undefined && ai !== null && typeof (ai as { run?: unknown }).run === "function"
        ? ai
        : undefined;
    return screenPromotionWithWorkersAI(validAi, input);
  };
}

async function extractCaseId(response: Response): Promise<string | null> {
  if (response.status !== 202 && response.status !== 403) return null;
  try {
    const parsed = (await response.clone().json()) as { case_id?: unknown };
    return typeof parsed.case_id === "string" ? parsed.case_id : null;
  } catch {
    return null;
  }
}

export class CommentaryService {
  constructor(private readonly options: CommentaryServiceOptions) {}

  private async sponsorStatus(sponsorId: string): Promise<"active" | "deleted" | "suspended"> {
    const row = await this.options.db
      .prepare(
        `SELECT s.tombstoned_at,
                EXISTS (SELECT 1 FROM sponsor_suspension_events se WHERE se.sponsor_id = s.sponsor_id) AS suspended
           FROM sponsors s
          WHERE s.sponsor_id = ?`,
      )
      .bind(sponsorId)
      .first<{ tombstoned_at: number | null; suspended: number }>();
    if (!row || row.tombstoned_at !== null) return "deleted";
    if (row.suspended === 1) return "suspended";
    return "active";
  }

  private async publicProblemScope(problemId: string): Promise<{ unlisted: boolean } | null> {
    const row = await this.options.db
      .prepare(`SELECT p.id, p.unlisted FROM problems p WHERE p.id = ? AND ${PUBLIC_PROBLEM_SQL}`)
      .bind(problemId)
      .first<{ id: string; unlisted: number }>();
    if (row === null || row === undefined) return null;
    return { unlisted: row.unlisted === 1 };
  }

  private async publicProblem(problemId: string): Promise<boolean> {
    return (await this.publicProblemScope(problemId)) !== null;
  }

  private async visibleCommentary(problemId: string, commentaryId: string) {
    return this.options.db
      .prepare(`SELECT ${COMMENTARY_COLUMNS} ${COMMENTARY_SOURCE_SQL}
        AND pc.problem_id = ? AND pc.id = ?`)
      .bind(problemId, commentaryId)
      .first<CommentaryRow>();
  }

  private requestDigest(sponsorId: string, action: string, problemId: string, bodyDigest: string) {
    return sha256Hex(
      JSON.stringify({
        sponsor_id: sponsorId,
        action,
        problem_id: problemId,
        body_digest: bodyDigest,
      }),
    );
  }

  private async replay(input: {
    sponsorId: string;
    problemId: string;
    key: string;
    digest: string;
    bodyDigest: string;
    eventType: "commentary.posted" | "commentary.superseded" | "commentary.tombstoned";
    commentaryId?: string;
  }): Promise<CommentaryItem | Response | undefined> {
    const existing = await this.options.db
      .prepare(`SELECT i.request_digest, e.type, e.object_kind, e.object_id,
          e.actor_sponsor_id, e.actor_fellow_id
        FROM idempotency i LEFT JOIN events e ON e.id = i.event_id AND e.problem_id = i.problem_id
        WHERE i.problem_id = ? AND i.idempotency_key = ? AND i.created_at > ?`)
      .bind(input.problemId, input.key, new Date(Date.now() - IDEMPOTENCY_TTL_MS).toISOString())
      .first<{
        request_digest: string;
        type: string | null;
        object_kind: string | null;
        object_id: string | null;
        actor_sponsor_id: string | null;
        actor_fellow_id: string | null;
      }>();
    if (!existing) return undefined;
    // Older receipts used the exact body digest alone. Their immutable event
    // must still prove the same sponsor and action before they can be replayed.
    if (
      (existing.request_digest !== input.digest && existing.request_digest !== input.bodyDigest) ||
      existing.actor_sponsor_id !== input.sponsorId ||
      existing.actor_fellow_id !== null ||
      existing.object_kind !== "commentary" ||
      existing.type !== input.eventType ||
      !existing.object_id ||
      (input.commentaryId !== undefined && existing.object_id !== input.commentaryId)
    )
      return idempotencyConflict();
    const row = await this.visibleCommentary(input.problemId, existing.object_id);
    if (!row) return commentaryNotFound();
    const item = rowToCommentaryItem(row);
    if (input.eventType === "commentary.tombstoned" || item.tombstoned) return item;
    // Return the original publication receipt, even after a later revision.
    // Current withdrawal still wins: no replay restores removed bytes.
    return { ...item, superseded_by_commentary_id: null, updated_at: item.created_at };
  }

  /**
   * Sealed replay for non-committed screening outcomes bound to the same
   * (sponsor, problem, idempotency_key) within 24h. Never re-calls Workers AI
   * while a case stays pending or rejected; permits clean operator-release retry
   * once a reviewer or appeal releases the exact case.
   */
  private async replayNonCommittedAttempt(input: {
    sponsorId: string;
    problemId: string;
    key: string;
    digest: string;
    now: number;
  }): Promise<Response | "in_flight" | undefined> {
    const row = await this.options.db
      .prepare(
        `SELECT reservation_id, request_digest, reserved_at, expires_at, status, case_id, event_id
           FROM sponsor_commentary_attempt_reservations
          WHERE sponsor_id = ? AND problem_id = ? AND idempotency_key = ?
            AND reserved_at > ?
          ORDER BY reserved_at DESC, reservation_id DESC
          LIMIT 1`,
      )
      .bind(input.sponsorId, input.problemId, input.key, input.now - IDEMPOTENCY_TTL_MS)
      .first<CommentaryAttemptRow>();
    if (!row) return undefined;
    if (row.request_digest !== input.digest) return idempotencyConflict();
    if (row.status === "reserved" && row.expires_at > input.now) return "in_flight";
    if (
      (row.status === "settled_held" || row.status === "settled_rejected") &&
      row.case_id !== null
    ) {
      const stored = await getScreeningCase(this.options.db, row.case_id);
      if (!stored || stored.sponsor_id !== input.sponsorId || stored.problem_id !== input.problemId)
        return undefined;
      // Re-resolve via screeningCaseFor so appellate releases take effect immediately.
      const resolved =
        (await screeningCaseFor(
          this.options.db,
          sponsorCaseActorId(input.sponsorId),
          input.problemId,
          stored.input_digest,
        )) ?? stored;
      if (resolved.state === "released") return undefined;
      const category = ScreeningCoarseCategorySchema.safeParse(resolved.coarse_category);
      const safeCategory = category.success ? category.data : "provider-unavailable";
      if (resolved.state === "pending") {
        return screeningHoldResponse(safeCategory, resolved.case_id);
      }
      if (resolved.state === "rejected") {
        const denied = ScreeningPromotionDeniedResponseSchema.safeParse({
          code: "POLICY_DENIED",
          coarse_category: safeCategory,
          appeal: SCREENING_APPEAL_CODE,
          case_id: resolved.case_id,
        });
        if (denied.success) {
          return new Response(JSON.stringify(denied.data), {
            status: 403,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "private, no-store",
            },
          });
        }
        return screeningHoldResponse("provider-unavailable", resolved.case_id);
      }
    }
    return undefined;
  }

  private async reserveAttempt(input: {
    sponsorId: string;
    problemId: string;
    key: string;
    digest: string;
    now: number;
    sponsorLimit: number;
  }): Promise<
    | { readonly ok: true; readonly reservationId: string }
    | { readonly ok: false; readonly reason: "rate_limited"; readonly response: Response }
    | { readonly ok: false; readonly reason: "in_flight" }
    | { readonly ok: false; readonly reason: "conflict" }
  > {
    const db = this.options.db;
    const now = input.now;
    // 1. Recover expired in-flight commentary reservations for this sponsor.
    await db
      .prepare(
        `UPDATE sponsor_commentary_attempt_reservations
            SET status = 'recovered', settled_at = ?
          WHERE sponsor_id = ? AND status = 'reserved' AND expires_at <= ?`,
      )
      .bind(now, input.sponsorId, now)
      .run();

    // 2. Check rolling-minute commentary attempt cap AND shared sponsor hourly cap.
    const [minuteAttempts, minuteCommitted, hourPromotionAttempts, hourCommentaryAttempts] =
      await Promise.all([
        db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM sponsor_commentary_attempt_reservations
              WHERE sponsor_id = ? AND reserved_at > ?`,
          )
          .bind(input.sponsorId, now - 60_000)
          .first<{ cnt: number }>(),
        db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM problem_commentaries
              WHERE sponsor_id = ? AND created_at > ?`,
          )
          .bind(input.sponsorId, new Date(now - 60_000).toISOString())
          .first<{ cnt: number }>(),
        db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM public_write_attempt_reservations
              WHERE sponsor_id = ? AND reserved_at > ?`,
          )
          .bind(input.sponsorId, now - PROMOTION_RATE_LIMIT_WINDOW_MS)
          .first<{ cnt: number }>(),
        db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM sponsor_commentary_attempt_reservations
              WHERE sponsor_id = ? AND reserved_at > ?`,
          )
          .bind(input.sponsorId, now - PROMOTION_RATE_LIMIT_WINDOW_MS)
          .first<{ cnt: number }>(),
      ]);

    const perMinuteCount = Math.max(minuteAttempts?.cnt ?? 0, minuteCommitted?.cnt ?? 0);
    if (perMinuteCount >= COMMENTARY_RATE_LIMIT_PER_MINUTE) {
      return { ok: false, reason: "rate_limited", response: rateLimited(60) };
    }
    const perHourSponsorCount =
      (hourPromotionAttempts?.cnt ?? 0) + (hourCommentaryAttempts?.cnt ?? 0);
    if (perHourSponsorCount >= input.sponsorLimit) {
      return {
        ok: false,
        reason: "rate_limited",
        response: rateLimited(
          3600,
          `This sponsor has reached its rolling-hour public-write screening budget (${input.sponsorLimit}/hour).`,
        ),
      };
    }

    // 3. Atomic pre-provider reservation insert: enforces single-flight per key,
    // the 20/min commentary trigger, AND the shared sponsor hourly cap atomically
    // inside SQL (closing concurrent TOCTOU bursts at sponsorLimit - 1).
    const reservationId = `CQ-${crypto.randomUUID()}`;
    const hourWindowStart = now - PROMOTION_RATE_LIMIT_WINDOW_MS;
    try {
      const inserted = await db
        .prepare(
          `INSERT INTO sponsor_commentary_attempt_reservations (
             reservation_id, sponsor_id, problem_id, idempotency_key,
             request_digest, reserved_at, expires_at, status
           ) SELECT ?, ?, ?, ?, ?, ?, ?, 'reserved'
              WHERE (
                (SELECT COUNT(*) FROM public_write_attempt_reservations
                  WHERE sponsor_id = ? AND reserved_at > ?) +
                (SELECT COUNT(*) FROM sponsor_commentary_attempt_reservations
                  WHERE sponsor_id = ? AND reserved_at > ?)
              ) < ?`,
        )
        .bind(
          reservationId,
          input.sponsorId,
          input.problemId,
          input.key,
          input.digest,
          now,
          now + COMMENTARY_RESERVATION_EXPIRY_MS,
          input.sponsorId,
          hourWindowStart,
          input.sponsorId,
          hourWindowStart,
          input.sponsorLimit,
        )
        .run();
      if ((inserted.meta?.changes ?? 0) === 0) {
        // Distinguish a concurrent same-key in-flight retry on the final hourly slot
        // from a genuinely new request exceeding the shared sponsor budget.
        const inflight = await db
          .prepare(
            `SELECT request_digest FROM sponsor_commentary_attempt_reservations
              WHERE sponsor_id = ? AND problem_id = ? AND idempotency_key = ?
                AND status = 'reserved' AND expires_at > ?
              LIMIT 1`,
          )
          .bind(input.sponsorId, input.problemId, input.key, now)
          .first<{ request_digest: string }>();
        if (inflight) {
          return inflight.request_digest !== input.digest
            ? { ok: false, reason: "conflict" }
            : { ok: false, reason: "in_flight" };
        }
        return {
          ok: false,
          reason: "rate_limited",
          response: rateLimited(
            3600,
            `This sponsor has reached its rolling-hour public-write screening budget (${input.sponsorLimit}/hour).`,
          ),
        };
      }
      return { ok: true, reservationId };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("COMMENTARY_RATE_LIMIT_EXCEEDED")) {
        return { ok: false, reason: "rate_limited", response: rateLimited(60) };
      }
      if (
        msg.includes("UNIQUE constraint failed") ||
        msg.includes("sponsor_commentary_reservations_inflight_idx")
      ) {
        const inflight = await db
          .prepare(
            `SELECT request_digest FROM sponsor_commentary_attempt_reservations
              WHERE sponsor_id = ? AND problem_id = ? AND idempotency_key = ?
                AND status = 'reserved' AND expires_at > ?
              LIMIT 1`,
          )
          .bind(input.sponsorId, input.problemId, input.key, now)
          .first<{ request_digest: string }>();
        if (inflight && inflight.request_digest !== input.digest) {
          return { ok: false, reason: "conflict" };
        }
        return { ok: false, reason: "in_flight" };
      }
      throw error;
    }
  }

  private async settleAttempt(
    reservationId: string,
    status: "settled_held" | "settled_rejected" | "settled_failed",
    caseId?: string | null,
  ): Promise<void> {
    try {
      await this.options.db
        .prepare(
          `UPDATE sponsor_commentary_attempt_reservations
              SET status = ?, settled_at = ?, case_id = COALESCE(?, case_id)
            WHERE reservation_id = ? AND status = 'reserved'`,
        )
        .bind(status, Date.now(), caseId ?? null, reservationId)
        .run();
    } catch {
      // Best-effort settlement; refusal or error stands.
    }
  }

  private async priorRefusal(sponsorId: string, problemId: string, commentaryId: string) {
    const prior = await this.visibleCommentary(problemId, commentaryId);
    if (!prior) return commentaryNotFound();
    if (prior.sponsor_id !== sponsorId) return ownershipMismatch();
    if (prior.tombstoned === 1)
      return commentaryContractProblem({
        status: 409,
        code: "COMMENTARY_ALREADY_TOMBSTONED",
        title: "This commentary has been removed",
        detail: "A removed commentary cannot be revised.",
        fixHint: "Post a new comment if you have further context to add.",
      });
    if (prior.superseded_by_commentary_id !== null)
      return commentaryContractProblem({
        status: 409,
        code: "COMMENTARY_ALREADY_SUPERSEDED",
        title: "This commentary already has a newer revision",
        detail: "Another revision replaced the entry you selected.",
        fixHint: "Refresh commentary and revise the latest entry in the chain.",
      });
    return undefined;
  }

  private async rateExceeded(sponsorId: string): Promise<boolean> {
    const now = Date.now();
    const [recentCommitted, recentAttempts] = await Promise.all([
      this.options.db
        .prepare(`SELECT COUNT(*) AS cnt FROM problem_commentaries
          WHERE sponsor_id = ? AND created_at > ?`)
        .bind(sponsorId, new Date(now - 60_000).toISOString())
        .first<{ cnt: number }>(),
      this.options.db
        .prepare(`SELECT COUNT(*) AS cnt FROM sponsor_commentary_attempt_reservations
          WHERE sponsor_id = ? AND reserved_at > ?`)
        .bind(sponsorId, now - 60_000)
        .first<{ cnt: number }>(),
    ]);
    return (
      Math.max(recentCommitted?.cnt ?? 0, recentAttempts?.cnt ?? 0) >=
      COMMENTARY_RATE_LIMIT_PER_MINUTE
    );
  }

  async listCommentariesWithScope(
    problemId: string,
    query: CommentaryListQuery,
  ): Promise<{ readonly list: CommentaryListResponse; readonly unlisted: boolean } | null> {
    const db = this.options.db;
    const scopeBefore = await this.publicProblemScope(problemId);
    if (!scopeBefore) return null;

    const cursor = query.cursor ?? 0;
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);

    const rows = await db
      .prepare(
        `SELECT ${COMMENTARY_COLUMNS} ${COMMENTARY_SOURCE_SQL}
         AND pc.problem_id = ? AND pc.seq > ?
         ORDER BY pc.seq ASC
         LIMIT ?`,
      )
      .bind(problemId, cursor, limit + 1)
      .all<CommentaryRow>();

    const items = rows.results ?? [];
    const scopeAfter = await this.publicProblemScope(problemId);
    if (!scopeAfter) return null;
    const hasMore = items.length > limit;
    const paged = hasMore ? items.slice(0, limit) : items;
    const lastItem = paged.at(-1);
    const maxSeq = lastItem?.seq ?? cursor;

    const list = CommentaryListResponseSchema.parse({
      schema: COMMENTARY_SCHEMA_ID,
      problem_id: problemId,
      cursor: maxSeq,
      has_more: hasMore,
      commentaries: paged.map(rowToCommentaryItem),
      omitted: [
        "Sponsor commentary is human discussion; it is excluded from scientific claims, proof trees, and disposition calculation (Rule A2)",
      ],
    });
    return { list, unlisted: scopeBefore.unlisted || scopeAfter.unlisted };
  }

  async listCommentaries(
    problemId: string,
    query: CommentaryListQuery,
  ): Promise<CommentaryListResponse | null> {
    const result = await this.listCommentariesWithScope(problemId, query);
    return result ? result.list : null;
  }

  async postCommentary(
    sponsorId: string,
    input: SponsorCommentaryPostRequest,
    idempotencyKey: string,
    bodyDigest: string,
  ): Promise<
    | { readonly ok: true; readonly item: CommentaryItem; readonly isReplay: boolean }
    | { readonly ok: false; readonly response: Response }
  > {
    const db = this.options.db;
    const startTime = performance.now();
    if (!(await this.publicProblem(input.problem_id)))
      return { ok: false, response: problemNotFound() };
    const requestDigest = await this.requestDigest(
      sponsorId,
      "post-commentary",
      input.problem_id,
      bodyDigest,
    );
    const eventType = input.supersedes_commentary_id
      ? "commentary.superseded"
      : "commentary.posted";
    const replayInput = {
      sponsorId,
      problemId: input.problem_id,
      key: idempotencyKey,
      digest: requestDigest,
      bodyDigest,
      eventType,
    } as const;
    const existing = await this.replay(replayInput);
    if (existing instanceof Response) return { ok: false, response: existing };
    if (existing) return { ok: true, item: existing, isReplay: true };

    const status = await this.sponsorStatus(sponsorId);
    if (status === "deleted") return { ok: false, response: sponsorUnavailable() };
    if (status === "suspended") return { ok: false, response: sponsorSuspended() };

    if (input.supersedes_commentary_id) {
      const refused = await this.priorRefusal(
        sponsorId,
        input.problem_id,
        input.supersedes_commentary_id,
      );
      if (refused) return { ok: false, response: refused };
    }

    // Every human-authored public field is scanned deterministically for
    // credential-shaped material before reaching quota reservation, Workers AI,
    // or public storage (P7/§10.4).
    const credentialFields: Record<string, string | undefined> = { body: input.body };
    for (const [index, ref] of (input.relates_to ?? []).entries()) {
      credentialFields[`relates_to[${index}].id`] = ref.id;
      credentialFields[`relates_to[${index}].label`] = ref.label;
    }
    const secrets = scanFieldsForCredentials(credentialFields);
    if (secrets.length > 0) {
      return {
        ok: false,
        response: secretShapedContentProblem(
          secrets,
          { problem_id: input.problem_id, body: "<the same text with the credential removed>" },
          COMMENTARY_SCHEMA_ID,
        ),
      };
    }

    // Sealed replay for prior non-committed screening outcomes on the same key.
    const nowMs = Date.now();
    const waitForInFlight = async (): Promise<
      | { readonly ok: true; readonly item: CommentaryItem; readonly isReplay: boolean }
      | { readonly ok: false; readonly response: Response }
    > => {
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const committed = await this.replay(replayInput);
        if (committed instanceof Response) return { ok: false, response: committed };
        if (committed) return { ok: true, item: committed, isReplay: true };
        const nonCommitted = await this.replayNonCommittedAttempt({
          sponsorId,
          problemId: input.problem_id,
          key: idempotencyKey,
          digest: requestDigest,
          now: Date.now(),
        });
        if (nonCommitted instanceof Response) return { ok: false, response: nonCommitted };
        if (nonCommitted === undefined) break;
      }
      return { ok: false, response: idempotencyInFlight() };
    };

    const sealed = await this.replayNonCommittedAttempt({
      sponsorId,
      problemId: input.problem_id,
      key: idempotencyKey,
      digest: requestDigest,
      now: nowMs,
    });
    if (sealed instanceof Response) return { ok: false, response: sealed };
    if (sealed === "in_flight") return waitForInFlight();

    // Atomic pre-provider attempt reservation (per-minute + shared sponsor hourly cap).
    let sponsorLimit: number;
    try {
      sponsorLimit = parseSponsorLimit(this.options.sponsorLimit);
    } catch {
      return { ok: false, response: screeningHoldResponse("provider-unavailable") };
    }
    const reserved = await this.reserveAttempt({
      sponsorId,
      problemId: input.problem_id,
      key: idempotencyKey,
      digest: requestDigest,
      now: nowMs,
      sponsorLimit,
    });
    if (!reserved.ok) {
      const committed = await this.replay(replayInput);
      if (committed instanceof Response) return { ok: false, response: committed };
      if (committed) return { ok: true, item: committed, isReplay: true };
      if (reserved.reason === "rate_limited") return { ok: false, response: reserved.response };
      if (reserved.reason === "conflict") return { ok: false, response: idempotencyConflict() };
      return waitForInFlight();
    }
    const reservationId = reserved.reservationId;

    // Every human-authored public field is screened through the shared
    // contextual public-candidate boundary, including link IDs and labels.
    // Each field stays on its own line so L0's line-start markers still apply.
    const publicText = [
      input.body,
      ...(input.relates_to ?? []).flatMap((ref) => [ref.id, ref.label ?? ""]),
    ].join("\n\n");

    let screened: Awaited<ReturnType<typeof screenPublicCandidate>>;
    try {
      screened = await screenPublicCandidate(
        createCommentaryScreener(this.options.screenPromotion),
        { DB: db, AI: this.options.ai } as Env,
        {
          problemId: input.problem_id,
          fellowId: sponsorCaseActorId(sponsorId),
          kind: "commentary",
          statement: publicText,
          falsifier: null,
        },
        {
          sponsorId,
          route: "post-commentary",
          authorKind: "sponsor",
        },
      );

      if (screened instanceof Response) {
        const caseId = await extractCaseId(screened);
        await this.settleAttempt(
          reservationId,
          screened.status === 202
            ? "settled_held"
            : screened.status === 403
              ? "settled_rejected"
              : "settled_failed",
          caseId,
        );
        console.info(
          JSON.stringify({
            facility: "OPS.2a",
            stage: "sponsor-commentary-post",
            sponsor_id: sponsorId,
            problem_id: input.problem_id,
            request_digest: requestDigest,
            case_id: caseId,
            screening_result:
              screened.status === 202
                ? "held"
                : screened.status === 403
                  ? "rejected"
                  : "unavailable",
            status_code: screened.status,
            duration_ms: Math.round(performance.now() - startTime),
          }),
        );
        return { ok: false, response: screened };
      }
    } catch (error) {
      await this.settleAttempt(reservationId, "settled_failed");
      throw error;
    }

    // Write Krater ledger event + projection + screening provenance + attempt settlement atomically.
    const now = new Date().toISOString();
    const commentaryId = `COMM-${crypto.randomUUID().replace(/-/g, "")}`;
    const eventId = `EV-COMM-${crypto.randomUUID()}`;
    const relatesToJson = JSON.stringify(input.relates_to ?? []);

    const preconditionBindings: (string | number)[] = [
      input.problem_id,
      sponsorId,
      sponsorId,
      sponsorId,
      COMMENTARY_RATE_LIMIT_PER_MINUTE,
    ];
    let preconditionSql = ` AND EXISTS (SELECT 1 FROM problems p WHERE p.id = ? AND ${PUBLIC_PROBLEM_SQL})
      AND EXISTS (SELECT 1 FROM sponsors WHERE sponsor_id = ? AND tombstoned_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = ?)
      AND (SELECT COUNT(*) FROM problem_commentaries rate_commentary
        WHERE rate_commentary.sponsor_id = ?
          AND rate_commentary.created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds')) < ?`;
    if (input.supersedes_commentary_id) {
      preconditionSql += ` AND EXISTS (SELECT 1 ${COMMENTARY_SOURCE_SQL}
        AND pc.id = ? AND pc.problem_id = ? AND pc.sponsor_id = ?
        AND pc.tombstoned = 0 AND pc.superseded_by_commentary_id IS NULL)`;
      preconditionBindings.push(input.supersedes_commentary_id, input.problem_id, sponsorId);
    }

    let writeResult: Awaited<ReturnType<typeof writeLedgerEvent>>;
    try {
      writeResult = await writeLedgerEvent(
        db,
        {
          problemId: input.problem_id,
          eventId,
          idempotencyKey,
          requestDigest,
          eventType,
          objectKind: "commentary",
          objectId: commentaryId,
          objectVersion: 1,
          payloadJson: JSON.stringify({
            commentary_id: commentaryId,
            problem_id: input.problem_id,
            sponsor_id: sponsorId,
            body: input.body,
            relates_to: input.relates_to ?? [],
            supersedes_commentary_id: input.supersedes_commentary_id ?? null,
            created_at: now,
          }),
          createdAt: now,
          attribution: {
            principalType: "sponsor",
            sponsorId,
            fellowId: null,
            sessionId: null,
            modelSelfDeclared: null,
            harness: null,
          },
        },
        {
          // D1 rechecks the public scope, sponsor standing, rolling window,
          // exact prior head, screening decision and publication context in the
          // same transaction that allocates the event and links the chain.
          preconditionSql,
          preconditionBindings,
          statementsAfterEvent: (settlement) => {
            const stmts = [
              db
                .prepare(
                  `INSERT INTO problem_commentaries (
                   id, problem_id, seq, sponsor_id, body, relates_to_json,
                   supersedes_commentary_id, superseded_by_commentary_id,
                   tombstoned, tombstone_reason, created_at, updated_at, event_id
                 ) SELECT ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?, ?
                   WHERE EXISTS (SELECT 1 FROM events WHERE id = ?)`,
                )
                .bind(
                  commentaryId,
                  input.problem_id,
                  settlement.sequence,
                  sponsorId,
                  input.body,
                  relatesToJson,
                  input.supersedes_commentary_id ?? null,
                  now,
                  now,
                  eventId,
                  eventId,
                ),
              db
                .prepare(
                  `UPDATE public_cursor SET cursor = cursor + 1
                 WHERE singleton = 1 AND EXISTS (SELECT 1 FROM events WHERE id = ?)`,
                )
                .bind(eventId),
            ];

            if (input.supersedes_commentary_id) {
              stmts.push(
                db
                  .prepare(
                    `UPDATE problem_commentaries
                   SET superseded_by_commentary_id = ?, updated_at = ?
                   WHERE id = ? AND problem_id = ? AND sponsor_id = ?
                     AND tombstoned = 0 AND superseded_by_commentary_id IS NULL
                     AND EXISTS (SELECT 1 FROM events WHERE id = ?)`,
                  )
                  .bind(
                    commentaryId,
                    now,
                    input.supersedes_commentary_id,
                    input.problem_id,
                    sponsorId,
                    eventId,
                  ),
              );
            }

            stmts.push(screeningDecisionGuardStatement(db, screened, eventId));
            if (screened.contextGuard !== undefined) {
              stmts.push(screeningContextGuardStatement(db, screened.contextGuard, eventId));
            }
            stmts.push(
              db
                .prepare(
                  `INSERT INTO screening_publications (event_id, request_digest, provenance_json)
                   SELECT id, ?, ? FROM events
                    WHERE id = ? AND problem_id = ? AND actor_sponsor_id = ? AND actor_fellow_id IS NULL`,
                )
                .bind(
                  requestDigest,
                  JSON.stringify(screened.provenance),
                  eventId,
                  input.problem_id,
                  sponsorId,
                ),
            );
            if (screened.supersedeInputDigest !== undefined) {
              stmts.push(supersedeHeldCaseStatement(db, screened, eventId));
            }
            stmts.push(
              db
                .prepare(
                  `UPDATE sponsor_commentary_attempt_reservations
                      SET status = 'settled_published', settled_at = ?, event_id = ?
                    WHERE reservation_id = ? AND status = 'reserved'
                      AND EXISTS (SELECT 1 FROM events WHERE id = ?)`,
                )
                .bind(Date.now(), eventId, reservationId, eventId),
            );

            return stmts;
          },
        },
      );
    } catch (error) {
      await this.settleAttempt(
        reservationId,
        isScreeningDecisionChangedError(error) ? "settled_held" : "settled_failed",
      );
      const winner = await this.replay(replayInput);
      if (winner instanceof Response) return { ok: false, response: winner };
      if (winner) return { ok: true, item: winner, isReplay: true };
      if (isScreeningDecisionChangedError(error)) {
        return { ok: false, response: screeningHoldResponse("provider-unavailable") };
      }
      if (isScreeningContextStaleError(error)) {
        return { ok: false, response: screeningContextStaleProblem() };
      }
      if (error instanceof KraterIdempotencyConflictError)
        return { ok: false, response: idempotencyConflict() };
      if (error instanceof KraterLedgerPreconditionError) {
        if (!(await this.publicProblem(input.problem_id)))
          return { ok: false, response: problemNotFound() };
        const postStatus = await this.sponsorStatus(sponsorId);
        if (postStatus === "deleted") return { ok: false, response: sponsorUnavailable() };
        if (postStatus === "suspended") return { ok: false, response: sponsorSuspended() };
        if (input.supersedes_commentary_id) {
          const refused = await this.priorRefusal(
            sponsorId,
            input.problem_id,
            input.supersedes_commentary_id,
          );
          if (refused) return { ok: false, response: refused };
        }
        if (await this.rateExceeded(sponsorId)) return { ok: false, response: rateLimited() };
      }
      throw error;
    }
    // If an idempotent race won, settle our losing reservation cleanly.
    if (writeResult.idempotent) {
      await this.settleAttempt(reservationId, "settled_failed");
    }
    // A same-key concurrent writer can win after the preflight. Its committed
    // event owns the receipt; a freshly minted losing ID must never escape.
    const item = await this.replay(replayInput);
    if (item instanceof Response) return { ok: false, response: item };
    if (!item) throw new Error("Commentary publication has no committed replay receipt");

    // OPS.2a structured logging (safe, no body/tokens)
    const durationMs = Math.round(performance.now() - startTime);
    const publicBodyDigest = `sha256:${await sha256Hex(publicText)}`;
    console.info(
      JSON.stringify({
        facility: "OPS.2a",
        stage: "sponsor-commentary-post",
        sponsor_id: sponsorId,
        problem_id: input.problem_id,
        commentary_id: item.commentary_id,
        event_id: writeResult.eventId,
        body_digest: publicBodyDigest,
        relates_to_count: (input.relates_to ?? []).length,
        request_digest: requestDigest,
        public_seq: writeResult.seq,
        screening_result: screened.provenance.outcome,
        screening_notice: screened.provenance.public_action.notice,
        status_code: writeResult.idempotent ? 200 : 201,
        duration_ms: durationMs,
      }),
    );

    return { ok: true, item, isReplay: writeResult.idempotent };
  }

  async tombstoneCommentary(
    sponsorId: string,
    input: SponsorCommentaryTombstoneRequest,
    idempotencyKey: string,
    bodyDigest: string,
  ): Promise<
    | { readonly ok: true; readonly item: CommentaryItem }
    | { readonly ok: false; readonly response: Response }
  > {
    const db = this.options.db;
    const now = new Date().toISOString();
    const startTime = performance.now();
    if (!(await this.publicProblem(input.problem_id)))
      return { ok: false, response: problemNotFound() };
    const requestDigest = await this.requestDigest(
      sponsorId,
      "tombstone-commentary",
      input.problem_id,
      bodyDigest,
    );
    const replayInput = {
      sponsorId,
      problemId: input.problem_id,
      key: idempotencyKey,
      digest: requestDigest,
      bodyDigest,
      eventType: "commentary.tombstoned",
      commentaryId: input.commentary_id,
    } as const;
    const existing = await this.replay(replayInput);
    if (existing instanceof Response) return { ok: false, response: existing };
    if (existing) return { ok: true, item: existing };

    const status = await this.sponsorStatus(sponsorId);
    if (status === "deleted") return { ok: false, response: sponsorUnavailable() };
    if (status === "suspended") return { ok: false, response: sponsorSuspended() };

    const target = await this.visibleCommentary(input.problem_id, input.commentary_id);
    if (!target) return { ok: false, response: commentaryNotFound() };
    if (target.sponsor_id !== sponsorId) return { ok: false, response: ownershipMismatch() };

    if (target.tombstoned === 1) {
      // Already tombstoned: idempotent outcome
      return { ok: true, item: rowToCommentaryItem(target) };
    }

    // Write Krater tombstone event
    const eventId = `EV-COMM-TOMB-${crypto.randomUUID()}`;
    let committedEventId = eventId;
    try {
      const writeResult = await writeLedgerEvent(
        db,
        {
          problemId: input.problem_id,
          eventId,
          idempotencyKey,
          requestDigest,
          eventType: "commentary.tombstoned",
          objectKind: "commentary",
          objectId: input.commentary_id,
          objectVersion: 2,
          payloadJson: JSON.stringify({
            commentary_id: input.commentary_id,
            problem_id: input.problem_id,
            sponsor_id: sponsorId,
            reason: input.reason,
            tombstoned_at: now,
          }),
          createdAt: now,
          attribution: {
            principalType: "sponsor",
            sponsorId,
            fellowId: null,
            sessionId: null,
            modelSelfDeclared: null,
            harness: null,
          },
        },
        {
          // A concurrent tombstone is a no-op; withdrawal of public scope,
          // sponsor suspension, or source redaction must not leak a projection.
          preconditionSql: ` AND EXISTS (SELECT 1 FROM sponsors WHERE sponsor_id = ? AND tombstoned_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = ?)
            AND EXISTS (SELECT 1 ${COMMENTARY_SOURCE_SQL}
            AND pc.id = ? AND pc.problem_id = ? AND pc.sponsor_id = ? AND pc.tombstoned = 0)`,
          preconditionBindings: [
            sponsorId,
            sponsorId,
            input.commentary_id,
            input.problem_id,
            sponsorId,
          ],
          statementsAfterEvent: () => {
            return [
              db
                .prepare(
                  `UPDATE problem_commentaries
                 SET tombstoned = 1, tombstone_reason = ?, body = NULL, updated_at = ?
                 WHERE id = ? AND problem_id = ? AND sponsor_id = ? AND tombstoned = 0
                   AND EXISTS (SELECT 1 FROM events WHERE id = ?)`,
                )
                .bind(input.reason, now, input.commentary_id, input.problem_id, sponsorId, eventId),
              db
                .prepare(
                  `UPDATE public_cursor SET cursor = cursor + 1
                 WHERE singleton = 1 AND EXISTS (SELECT 1 FROM events WHERE id = ?)`,
                )
                .bind(eventId),
            ];
          },
        },
      );
      committedEventId = writeResult.eventId;
    } catch (error) {
      const winner = await this.replay(replayInput);
      if (winner instanceof Response) return { ok: false, response: winner };
      if (winner) return { ok: true, item: winner };
      if (error instanceof KraterLedgerPreconditionError) {
        if (!(await this.publicProblem(input.problem_id)))
          return { ok: false, response: problemNotFound() };
        const postStatus = await this.sponsorStatus(sponsorId);
        if (postStatus === "deleted") return { ok: false, response: sponsorUnavailable() };
        if (postStatus === "suspended") return { ok: false, response: sponsorSuspended() };
        const current = await this.visibleCommentary(input.problem_id, input.commentary_id);
        if (!current) return { ok: false, response: commentaryNotFound() };
        // Only a tombstone that actually landed is the idempotent outcome; an
        // exhausted retry budget leaves the row live and must not report ok.
        if (current?.tombstoned === 1) return { ok: true, item: rowToCommentaryItem(current) };
        throw error;
      }
      if (!(error instanceof KraterIdempotencyConflictError)) throw error;
      return { ok: false, response: idempotencyConflict() };
    }

    const updated = await this.visibleCommentary(input.problem_id, input.commentary_id);
    if (!updated) return { ok: false, response: commentaryNotFound() };

    const durationMs = Math.round(performance.now() - startTime);
    console.info(
      JSON.stringify({
        facility: "OPS.2a",
        stage: "sponsor-commentary-tombstone",
        sponsor_id: sponsorId,
        problem_id: input.problem_id,
        commentary_id: input.commentary_id,
        event_id: committedEventId,
        reason: input.reason,
        status_code: 200,
        duration_ms: durationMs,
      }),
    );

    return { ok: true, item: rowToCommentaryItem(updated) };
  }
}
