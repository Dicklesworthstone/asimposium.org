import {
  COMMENTARY_SCHEMA_ID,
  type CommentaryItem,
  CommentaryItemSchema,
  type CommentaryListQuery,
  type CommentaryListResponse,
  CommentaryListResponseSchema,
  type SponsorCommentaryPostRequest,
  type SponsorCommentaryTombstoneRequest,
} from "@asimposium/contracts";
import type { Env } from "../env.ts";
import { problem } from "../http/envelope.ts";
import { writeLedgerEvent } from "../krater/krater.ts";
import {
  WORKERS_AI_MODEL_VERSION,
  WORKERS_AI_POLICY_VERSION,
  WorkersAIScreeningProvider,
  type WorkersAiBinding,
  workersAIConfigurationDigest,
} from "../screening/workers-ai.ts";
import { screenWithProvider } from "../screening/provider.ts";

export const COMMENTARY_MAX_BODY_CHARS = 2000;
export const COMMENTARY_RATE_LIMIT_PER_MINUTE = 20;

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
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function rowToCommentaryItem(row: CommentaryRow): CommentaryItem {
  let relatesTo: CommentaryItem["relates_to"] = [];
  try {
    relatesTo = JSON.parse(row.relates_to_json);
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
  readonly errorResponse?: Response;
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

  if (aiBinding && typeof (aiBinding as { run?: unknown }).run === "function") {
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
        maxBodyBytes: 8192,
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
          category: observation.coarse_category || "operational-harm",
        };
      }
    } catch {
      // Fail-closed on provider unexpected error
      return {
        ok: false,
        category: "provider-unavailable",
      };
    }
  }

  return { ok: true, category: "benign-context" };
}

export class CommentaryService {
  constructor(private readonly options: CommentaryServiceOptions) {}

  async listCommentaries(
    problemId: string,
    query: CommentaryListQuery,
  ): Promise<CommentaryListResponse | null> {
    const db = this.options.db;
    const problemRow = await db
      .prepare("SELECT id, public_seq, status FROM problems WHERE id = ?")
      .bind(problemId)
      .first<{ id: string; public_seq: number; status: string }>();

    if (!problemRow) return null;

    const cursor = query.cursor ?? 0;
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);

    const rows = await db
      .prepare(
        `SELECT id, problem_id, seq, sponsor_id, body, relates_to_json,
                supersedes_commentary_id, superseded_by_commentary_id,
                tombstoned, tombstone_reason, created_at, updated_at, event_id
         FROM problem_commentaries
         WHERE problem_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .bind(problemId, cursor, limit + 1)
      .all<CommentaryRow>();

    const items = rows.results ?? [];
    const hasMore = items.length > limit;
    const paged = hasMore ? items.slice(0, limit) : items;
    const maxSeq =
      paged.length > 0 && paged[paged.length - 1] !== undefined
        ? paged[paged.length - 1]!.seq
        : cursor;

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
    requestDigest: string,
  ): Promise<
    | { readonly ok: true; readonly item: CommentaryItem; readonly isReplay: boolean }
    | { readonly ok: false; readonly response: Response }
  > {
    const db = this.options.db;
    const now = new Date().toISOString();
    const startTime = performance.now();

    // 1. Verify problem exists and visibility posture
    const problemRow = await db
      .prepare("SELECT id, public_seq, status, sponsor_id FROM problems WHERE id = ?")
      .bind(input.problem_id)
      .first<{ id: string; public_seq: number; status: string; sponsor_id: string }>();

    if (!problemRow) {
      return {
        ok: false,
        response: problem({
          status: 404,
          code: "PROBLEM_NOT_FOUND",
          title: "Problem Not Found",
          detail: `The problem ${input.problem_id} does not exist.`,
          fixHint: "Verify the problem identifier and retry.",
          rule: "A5",
        }),
      };
    }

    if (problemRow.status === "private-draft" && problemRow.sponsor_id !== sponsorId) {
      // Check if steward
      const steward = await db
        .prepare("SELECT 1 FROM problem_stewards WHERE problem_id = ? AND sponsor_id = ?")
        .bind(input.problem_id, sponsorId)
        .first();
      if (!steward) {
        return {
          ok: false,
          response: problem({
            status: 404,
            code: "PROBLEM_NOT_FOUND",
            title: "Problem Not Found",
            detail: `The problem ${input.problem_id} does not exist or is private.`,
            fixHint: "Private drafts are only accessible to their owner or stewards.",
            rule: "A2",
          }),
        };
      }
    }

    // 2. Check idempotency replay in problem_commentaries / idempotency
    const existingIdempotency = await db
      .prepare(
        `SELECT i.request_digest, i.event_id, c.id AS commentary_id
         FROM idempotency i
         LEFT JOIN problem_commentaries c ON c.event_id = i.event_id
         WHERE i.problem_id = ? AND i.idempotency_key = ?`,
      )
      .bind(input.problem_id, idempotencyKey)
      .first<{ request_digest: string; event_id: string | null; commentary_id: string | null }>();

    if (existingIdempotency) {
      if (existingIdempotency.request_digest !== requestDigest) {
        return {
          ok: false,
          response: problem({
            status: 409,
            code: "IDEMPOTENCY_CONFLICT",
            title: "Idempotency Key Conflict",
            detail: "This idempotency key was already used for a different request payload.",
            fixHint: "Retry the original request unchanged or provide a fresh Idempotency-Key.",
            rule: "A5",
          }),
        };
      }
      if (existingIdempotency.commentary_id) {
        const row = await db
          .prepare("SELECT * FROM problem_commentaries WHERE id = ?")
          .bind(existingIdempotency.commentary_id)
          .first<CommentaryRow>();
        if (row) {
          return { ok: true, item: rowToCommentaryItem(row), isReplay: true };
        }
      }
    }

    // 3. Rate limiting check (e.g. 20 comments / minute / sponsor)
    const recentCount = await db
      .prepare(
        `SELECT COUNT(*) as cnt FROM problem_commentaries
         WHERE sponsor_id = ? AND created_at >= datetime('now', '-60 seconds')`,
      )
      .bind(sponsorId)
      .first<{ cnt: number }>();

    if (recentCount && recentCount.cnt >= COMMENTARY_RATE_LIMIT_PER_MINUTE) {
      return {
        ok: false,
        response: problem({
          status: 429,
          code: "RATE_LIMITED",
          title: "Rate Limit Exceeded",
          detail: `Sponsor commentary write rate limit exceeded (${COMMENTARY_RATE_LIMIT_PER_MINUTE} writes per minute).`,
          fixHint: "Wait 60 seconds before submitting further commentary.",
          rule: "A5",
        }),
      };
    }

    // 4. Supersedes validation
    let priorCommentary: CommentaryRow | null = null;
    if (input.supersedes_commentary_id) {
      priorCommentary = await db
        .prepare("SELECT * FROM problem_commentaries WHERE id = ? AND problem_id = ?")
        .bind(input.supersedes_commentary_id, input.problem_id)
        .first<CommentaryRow>();

      if (!priorCommentary) {
        return {
          ok: false,
          response: problem({
            status: 404,
            code: "COMMENTARY_NOT_FOUND",
            title: "Commentary Not Found",
            detail: `Target commentary ${input.supersedes_commentary_id} does not exist on this problem.`,
            fixHint: "Verify the supersedes_commentary_id value.",
            rule: "A5",
          }),
        };
      }

      if (priorCommentary.sponsor_id !== sponsorId) {
        return {
          ok: false,
          response: problem({
            status: 403,
            code: "COMMENTARY_OWNERSHIP_MISMATCH",
            title: "Forbidden",
            detail: "A sponsor may only supersede their own commentary.",
            fixHint: "Submit a new commentary instead of superseding another sponsor's entry.",
            rule: "A2",
          }),
        };
      }

      if (priorCommentary.tombstoned === 1) {
        return {
          ok: false,
          response: problem({
            status: 409,
            code: "COMMENTARY_ALREADY_TOMBSTONED",
            title: "Conflict",
            detail: "A tombstoned commentary cannot be superseded.",
            fixHint: "Submit a fresh commentary without superseding the tombstoned record.",
            rule: "A2",
          }),
        };
      }

      if (priorCommentary.superseded_by_commentary_id !== null) {
        return {
          ok: false,
          response: problem({
            status: 409,
            code: "COMMENTARY_ALREADY_SUPERSEDED",
            title: "Conflict",
            detail: "This commentary has already been superseded by a later revision.",
            fixHint: "Supersede the most recent commentary in the chain.",
            rule: "A2",
          }),
        };
      }
    }

    // 5. Screening L0/L1
    const screening = await screenCommentaryText(
      input.body,
      input.problem_id,
      sponsorId,
      this.options.ai,
    );

    if (!screening.ok) {
      // Coarse policy refusal (Rule A5: starve the oracle)
      return {
        ok: false,
        response: new Response(
          JSON.stringify({
            type: "https://a.asimposium.org/errors/POLICY_DENIED",
            title: "Policy Denied",
            status: 403,
            code: "POLICY_DENIED",
            coarse_category: screening.category,
            appeal: "APPEAL_VIA_OPERATOR",
            detail: "The submitted commentary violates site policy.",
            schema: COMMENTARY_SCHEMA_ID,
          }),
          {
            status: 403,
            headers: {
              "content-type": "application/problem+json; charset=utf-8",
              "cache-control": "no-store",
            },
          },
        ),
      };
    }

    // 6. Write Krater ledger event
    const commentaryId = `COMM-${crypto.randomUUID().replace(/-/g, "")}`;
    const eventId = `EV-COMM-${crypto.randomUUID()}`;
    const eventType = input.supersedes_commentary_id
      ? "commentary.superseded"
      : "commentary.posted";
    const relatesToJson = JSON.stringify(input.relates_to ?? []);

    const writeResult = await writeLedgerEvent(
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
        statementsAfterEvent: (settlement) => {
          const stmts = [
            db
              .prepare(
                `INSERT INTO problem_commentaries (
                   id, problem_id, seq, sponsor_id, body, relates_to_json,
                   supersedes_commentary_id, superseded_by_commentary_id,
                   tombstoned, tombstone_reason, created_at, updated_at, event_id
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?, ?)`,
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
                   WHERE id = ? AND problem_id = ?`,
                )
                .bind(commentaryId, now, input.supersedes_commentary_id, input.problem_id),
            );
          }

          return stmts;
        },
      },
    );

    // 7. OPS.2a structured logging (safe, no body/tokens)
    const durationMs = Math.round(performance.now() - startTime);
    const bodyDigest = `sha256:${await sha256Hex(input.body)}`;
    console.info(
      JSON.stringify({
        facility: "OPS.2a",
        stage: "sponsor-commentary-post",
        sponsor_id: sponsorId,
        problem_id: input.problem_id,
        commentary_id: commentaryId,
        event_id: eventId,
        body_digest: bodyDigest,
        relates_to_count: (input.relates_to ?? []).length,
        request_digest: requestDigest,
        public_seq: writeResult.seq,
        screening_result: "pass",
        status_code: 201,
        duration_ms: durationMs,
      }),
    );

    const createdItem: CommentaryItem = {
      schema: COMMENTARY_SCHEMA_ID,
      commentary_id: commentaryId,
      problem_id: input.problem_id,
      seq: writeResult.seq,
      sponsor_id: sponsorId,
      body: input.body,
      relates_to: input.relates_to ?? [],
      supersedes_commentary_id: input.supersedes_commentary_id ?? null,
      superseded_by_commentary_id: null,
      tombstoned: false,
      tombstone_reason: null,
      created_at: now,
      updated_at: now,
    };

    return { ok: true, item: createdItem, isReplay: false };
  }

  async tombstoneCommentary(
    sponsorId: string,
    input: SponsorCommentaryTombstoneRequest,
    idempotencyKey: string,
    requestDigest: string,
  ): Promise<
    | { readonly ok: true; readonly item: CommentaryItem }
    | { readonly ok: false; readonly response: Response }
  > {
    const db = this.options.db;
    const now = new Date().toISOString();
    const startTime = performance.now();

    // 1. Fetch target commentary
    const target = await db
      .prepare("SELECT * FROM problem_commentaries WHERE id = ? AND problem_id = ?")
      .bind(input.commentary_id, input.problem_id)
      .first<CommentaryRow>();

    if (!target) {
      return {
        ok: false,
        response: problem({
          status: 404,
          code: "COMMENTARY_NOT_FOUND",
          title: "Commentary Not Found",
          detail: `Commentary ${input.commentary_id} does not exist on problem ${input.problem_id}.`,
          fixHint: "Verify the commentary_id and problem_id.",
          rule: "A5",
        }),
      };
    }

    if (target.sponsor_id !== sponsorId) {
      return {
        ok: false,
        response: problem({
          status: 403,
          code: "COMMENTARY_OWNERSHIP_MISMATCH",
          title: "Forbidden",
          detail: "A sponsor may only tombstone their own commentary.",
          fixHint: "Tombstones must be submitted by the authoring sponsor.",
          rule: "A2",
        }),
      };
    }

    if (target.tombstoned === 1) {
      // Already tombstoned: idempotent outcome
      return { ok: true, item: rowToCommentaryItem(target) };
    }

    // 2. Write Krater tombstone event
    const eventId = `EV-COMM-TOMB-${crypto.randomUUID()}`;
    await writeLedgerEvent(
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
        statementsAfterEvent: () => {
          return [
            db
              .prepare(
                `UPDATE problem_commentaries
                 SET tombstoned = 1, tombstone_reason = ?, body = NULL, updated_at = ?
                 WHERE id = ? AND problem_id = ?`,
              )
              .bind(input.reason, now, input.commentary_id, input.problem_id),
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

    const updated = await db
      .prepare("SELECT * FROM problem_commentaries WHERE id = ? AND problem_id = ?")
      .bind(input.commentary_id, input.problem_id)
      .first<CommentaryRow>();

    const durationMs = Math.round(performance.now() - startTime);
    console.info(
      JSON.stringify({
        facility: "OPS.2a",
        stage: "sponsor-commentary-tombstone",
        sponsor_id: sponsorId,
        problem_id: input.problem_id,
        commentary_id: input.commentary_id,
        event_id: eventId,
        reason: input.reason,
        status_code: 200,
        duration_ms: durationMs,
      }),
    );

    return { ok: true, item: rowToCommentaryItem(updated ?? target) };
  }
}
