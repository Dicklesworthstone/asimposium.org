import {
  COMMENTARY_SCHEMA_ID,
  type CommentaryItem,
  CommentaryItemSchema,
  type CommentaryListQuery,
  type CommentaryListResponse,
  CommentaryListResponseSchema,
  type ProblemCode,
  SCREENING_APPEAL_CODE,
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
import { screenWithProvider } from "../screening/provider.ts";
import {
  WORKERS_AI_MODEL_VERSION,
  WORKERS_AI_POLICY_VERSION,
  WorkersAIScreeningProvider,
  type WorkersAiBinding,
  workersAIConfigurationDigest,
} from "../screening/workers-ai.ts";

export const COMMENTARY_MAX_BODY_CHARS = 2000;
export const COMMENTARY_RATE_LIMIT_PER_MINUTE = 20;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;

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
  WHERE ${PUBLIC_PROBLEM_SQL}
    AND NOT ${hiddenByContentControlSql("pc.problem_id", "pc.id")}`;
// Public bytes come from their available, digest-bound source event. A retained
// projection cannot restore a redacted body or evade a current content control.
const COMMENTARY_COLUMNS = `pc.id, pc.problem_id, pc.seq, pc.sponsor_id,
  CASE WHEN pc.tombstoned = 1 THEN NULL ELSE json_extract(ec.payload_json, '$.body') END AS body,
  json_extract(ec.payload_json, '$.relates_to') AS relates_to_json,
  pc.supersedes_commentary_id, pc.superseded_by_commentary_id, pc.tombstoned,
  pc.tombstone_reason, pc.created_at, pc.updated_at, pc.event_id`;

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

function screeningUnavailable(): Response {
  return validatedProblem({
    status: 503,
    code: "INTERNAL_ERROR",
    title: "Commentary screening is unavailable",
    detail: "The complete commentary could not be cleared for publication. Nothing was posted.",
    fixHint: "Keep the draft and retry later, or contact the operator for help.",
  });
}

function rateLimited(): Response {
  const response = commentaryContractProblem({
    status: 429,
    code: "RATE_LIMITED",
    title: "Commentary rate limit reached",
    detail: `A sponsor may publish ${COMMENTARY_RATE_LIMIT_PER_MINUTE} comments or revisions per rolling minute.`,
    fixHint: "Wait 60 seconds before submitting further commentary.",
    example: { headers: { "Retry-After": "60" } },
  });
  response.headers.set("retry-after", "60");
  return response;
}

export interface CommentaryServiceOptions {
  readonly db: Env["DB"];
  readonly ai?: unknown;
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

export async function screenCommentaryText(
  body: string,
  problemId: string,
  sponsorId: string,
  aiBinding?: unknown,
): Promise<ScreeningCheckResult> {
  const l0 = screenCommentaryL0(body);
  if (!l0.ok) {
    return l0;
  }

  if (!aiBinding || typeof (aiBinding as { run?: unknown }).run !== "function")
    return { ok: false, category: "provider-unavailable", unavailable: true };
  try {
    const bodyDigest = `sha256:${await sha256Hex(body)}`;
    const contextDigest = `sha256:${await sha256Hex(
      JSON.stringify({ problem_id: problemId, sponsor_id: sponsorId }),
    )}`;
    const identity = {
      corpus_revision: "commentary-direct-v1",
      corpus_digest: bodyDigest,
      model_version: WORKERS_AI_MODEL_VERSION,
      policy_version: WORKERS_AI_POLICY_VERSION,
      configuration_digest: await workersAIConfigurationDigest(),
    } as const;

    const provider = new WorkersAIScreeningProvider(aiBinding as WorkersAiBinding, {
      maxBodyBytes: 32_768,
      resolveBody: () => body,
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
        // Commentary has no durable quarantine case. An unresolved screen
        // must not claim a successful hold or masquerade as a hard denial.
        unavailable: observation.provider_status !== "ok" || observation.decision !== "reject",
      };
    }
  } catch {
    // Fail-closed on provider unexpected error
    return {
      ok: false,
      category: "provider-unavailable",
      unavailable: true,
    };
  }

  return { ok: true, category: "benign-context" };
}

export class CommentaryService {
  constructor(private readonly options: CommentaryServiceOptions) {}

  private async activeSponsor(sponsorId: string): Promise<boolean> {
    const row = await this.options.db
      .prepare("SELECT 1 AS active FROM sponsors WHERE sponsor_id = ? AND tombstoned_at IS NULL")
      .bind(sponsorId)
      .first<{ active: number }>();
    return row !== null && row !== undefined;
  }

  private async publicProblem(problemId: string): Promise<boolean> {
    const row = await this.options.db
      .prepare(`SELECT p.id FROM problems p WHERE p.id = ? AND ${PUBLIC_PROBLEM_SQL}`)
      .bind(problemId)
      .first<{ id: string }>();
    return row !== null && row !== undefined;
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
    const recent = await this.options.db
      .prepare(`SELECT COUNT(*) AS cnt FROM problem_commentaries
        WHERE sponsor_id = ? AND created_at > ?`)
      .bind(sponsorId, new Date(Date.now() - 60_000).toISOString())
      .first<{ cnt: number }>();
    return (recent?.cnt ?? 0) >= COMMENTARY_RATE_LIMIT_PER_MINUTE;
  }

  async listCommentaries(
    problemId: string,
    query: CommentaryListQuery,
  ): Promise<CommentaryListResponse | null> {
    const db = this.options.db;
    if (!(await this.publicProblem(problemId))) return null;

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
    if (!(await this.publicProblem(problemId))) return null;
    const hasMore = items.length > limit;
    const paged = hasMore ? items.slice(0, limit) : items;
    const lastItem = paged.at(-1);
    const maxSeq = lastItem?.seq ?? cursor;

    return CommentaryListResponseSchema.parse({
      schema: COMMENTARY_SCHEMA_ID,
      problem_id: problemId,
      cursor: maxSeq,
      has_more: hasMore,
      commentaries: paged.map(rowToCommentaryItem),
      omitted: [
        "Sponsor commentary is human discussion; it is excluded from scientific claims, proof trees, and disposition calculation (Rule A2)",
      ],
    });
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
    if (!(await this.activeSponsor(sponsorId)))
      return { ok: false, response: sponsorUnavailable() };
    if (await this.rateExceeded(sponsorId)) return { ok: false, response: rateLimited() };
    if (input.supersedes_commentary_id) {
      const refused = await this.priorRefusal(
        sponsorId,
        input.problem_id,
        input.supersedes_commentary_id,
      );
      if (refused) return { ok: false, response: refused };
    }

    // Every human-authored public field is screened, including link labels.
    // Each field stays on its own line so L0's line-start markers still apply.
    const publicText = [
      input.body,
      ...(input.relates_to ?? []).flatMap((ref) => [ref.id, ref.label ?? ""]),
    ].join("\n\n");
    const screening = await screenCommentaryText(
      publicText,
      input.problem_id,
      sponsorId,
      this.options.ai,
    );

    if (!screening.ok) {
      const denied = ScreeningPromotionDeniedResponseSchema.safeParse({
        code: "POLICY_DENIED",
        coarse_category: screening.category,
        appeal: SCREENING_APPEAL_CODE,
      });
      if (screening.unavailable || !denied.success)
        return { ok: false, response: screeningUnavailable() };
      return {
        ok: false,
        response: new Response(JSON.stringify(denied.data), {
          status: 403,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
        }),
      };
    }

    // 6. Write Krater ledger event
    const now = new Date().toISOString();
    const commentaryId = `COMM-${crypto.randomUUID().replace(/-/g, "")}`;
    const eventId = `EV-COMM-${crypto.randomUUID()}`;
    const relatesToJson = JSON.stringify(input.relates_to ?? []);

    const preconditionBindings: (string | number)[] = [
      input.problem_id,
      sponsorId,
      sponsorId,
      COMMENTARY_RATE_LIMIT_PER_MINUTE,
    ];
    let preconditionSql = ` AND EXISTS (SELECT 1 FROM problems p WHERE p.id = ? AND ${PUBLIC_PROBLEM_SQL})
      AND EXISTS (SELECT 1 FROM sponsors WHERE sponsor_id = ? AND tombstoned_at IS NULL)
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
          // D1 rechecks the public scope, rolling window, and exact prior head
          // in the same transaction that allocates the event and links the chain.
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

            return stmts;
          },
        },
      );
    } catch (error) {
      const winner = await this.replay(replayInput);
      if (winner instanceof Response) return { ok: false, response: winner };
      if (winner) return { ok: true, item: winner, isReplay: true };
      if (error instanceof KraterIdempotencyConflictError)
        return { ok: false, response: idempotencyConflict() };
      if (error instanceof KraterLedgerPreconditionError) {
        if (!(await this.publicProblem(input.problem_id)))
          return { ok: false, response: problemNotFound() };
        if (!(await this.activeSponsor(sponsorId)))
          return { ok: false, response: sponsorUnavailable() };
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
    // A same-key concurrent writer can win after the preflight. Its committed
    // event owns the receipt; a freshly minted losing ID must never escape.
    const item = await this.replay(replayInput);
    if (item instanceof Response) return { ok: false, response: item };
    if (!item) throw new Error("Commentary publication has no committed replay receipt");

    // 7. OPS.2a structured logging (safe, no body/tokens)
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
        screening_result: "pass",
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
    if (!(await this.activeSponsor(sponsorId)))
      return { ok: false, response: sponsorUnavailable() };

    const target = await this.visibleCommentary(input.problem_id, input.commentary_id);
    if (!target) return { ok: false, response: commentaryNotFound() };
    if (target.sponsor_id !== sponsorId) return { ok: false, response: ownershipMismatch() };

    if (target.tombstoned === 1) {
      // Already tombstoned: idempotent outcome
      return { ok: true, item: rowToCommentaryItem(target) };
    }

    // 2. Write Krater tombstone event
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
          // A concurrent tombstone is a no-op; withdrawal of public scope or
          // source content must not let this write leak a retained projection.
          preconditionSql: ` AND EXISTS (SELECT 1 FROM sponsors WHERE sponsor_id = ? AND tombstoned_at IS NULL)
            AND EXISTS (SELECT 1 ${COMMENTARY_SOURCE_SQL}
            AND pc.id = ? AND pc.problem_id = ? AND pc.sponsor_id = ? AND pc.tombstoned = 0)`,
          preconditionBindings: [sponsorId, input.commentary_id, input.problem_id, sponsorId],
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
        // Already tombstoned by a concurrent request: the idempotent outcome.
        if (!(await this.publicProblem(input.problem_id)))
          return { ok: false, response: problemNotFound() };
        if (!(await this.activeSponsor(sponsorId)))
          return { ok: false, response: sponsorUnavailable() };
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
