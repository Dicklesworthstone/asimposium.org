import {
  DIRECTIVES_SCHEMA_ID,
  ProtocolConflictPayloadSchema,
  type ProtocolConflictReceipt,
  ProtocolConflictReceiptSchema,
  type ProtocolConflictRequest,
  ProtocolConflictRequestSchema,
} from "@asimposium/contracts/directives";
import type { D1Database } from "@cloudflare/workers-types";
import { authorizeFellowWrite, type FellowCredentialBinding } from "../enrollment/service.ts";
import type { Env } from "../env.ts";
import { inboxNoticeStatement } from "../inbox/notice-write.ts";
import type { KraterLedgerEventInput, KraterLedgerProjectionPlan } from "../krater/krater.ts";
import { isScreeningPostureChangedError } from "../moderation/posture.ts";
import {
  isScreeningDecisionChangedError,
  screeningPublicationStatements,
} from "../screening/ingress.ts";
import { screeningHoldResponse, screenPublicCandidate } from "../screening/public-candidate.ts";
import {
  isScreeningContextStaleError,
  screeningContextStaleProblem,
} from "../screening/publication-context.ts";
import type {
  PublicationScreeningObservation,
  WorkersAIPromotionInput,
} from "../screening/workers-ai.ts";
import { isArchivedProblemWriteError } from "../sessions/problem-archive-admission.ts";
import { isProblemMembershipAdmissionError } from "../sessions/problem-membership-admission.ts";

export class ProtocolConflictError extends Error {
  constructor(
    readonly code: "NOT_ALLOWED" | "CONFLICT" | "HELD" | "UNAVAILABLE" | "RATE_LIMITED",
    readonly retryAfter = 30,
    readonly screeningResponse?: Response,
  ) {
    super(`PROTOCOL_CONFLICT_${code}`);
  }
}

export interface ProtocolConflictOptions {
  readonly db: D1Database;
  readonly clock?: () => number;
  readonly reserve: (input: {
    fellowId: string;
    sponsorId: string;
    problemId: string;
    sessionId: string;
    route: string;
    idempotencyKey: string;
    requestDigest: string;
    now: number;
  }) => Promise<string>;
  readonly settleFailure: (id: string, held: boolean) => Promise<void>;
  readonly screen: (input: WorkersAIPromotionInput) => Promise<PublicationScreeningObservation>;
  readonly writeLedger: (
    input: KraterLedgerEventInput,
    projection: KraterLedgerProjectionPlan,
  ) => Promise<unknown>;
}

const hash = async (value: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

interface ConflictRow {
  conflict_id: string;
  event_id: string;
  problem_id: string;
  session_id: string;
  fellow_id: string;
  sponsor_id: string;
  seq: number;
  request_digest: string;
  event_created_at: string;
}

function receipt(row: ConflictRow): ProtocolConflictReceipt {
  return ProtocolConflictReceiptSchema.parse({
    schema: DIRECTIVES_SCHEMA_ID,
    ok: true,
    conflict_id: row.conflict_id,
    event_id: row.event_id,
    problem_id: row.problem_id,
    session_id: row.session_id,
    fellow_id: row.fellow_id,
    sponsor_id: row.sponsor_id,
    seq: row.seq,
    created_at: row.event_created_at,
  });
}

/** Record the Fellow's deliberate public refusal, bound to a received private
 * instruction. The private source is never part of the public candidate or
 * ledger payload. Replacing a focus does not erase its recorded history. */
export async function recordProtocolConflict(
  options: ProtocolConflictOptions,
  actor: FellowCredentialBinding,
  sessionId: string,
  input: ProtocolConflictRequest,
  key: string,
): Promise<ProtocolConflictReceipt> {
  const db = options.db,
    clock = options.clock ?? Date.now;
  const parsed = ProtocolConflictRequestSchema.safeParse(input);
  if (
    !parsed.success ||
    !/^S-[A-Za-z0-9]{26}$/.test(sessionId) ||
    !/^[A-Za-z0-9._-]{1,160}$/.test(key) ||
    actor.credentialProfile !== "bearer" ||
    actor.revokedAt !== undefined ||
    actor.issuedAt > clock() ||
    actor.expiresAt <= clock() ||
    actor.fellowStatus !== "active"
  )
    throw new ProtocolConflictError("NOT_ALLOWED");
  const request = parsed.data;
  const route = `/v1/sessions/${sessionId}/protocol-conflicts`;
  const keyHash = await hash(key);
  const digest = await hash(JSON.stringify({ route, request }));
  const replay = async (): Promise<ProtocolConflictReceipt | undefined> => {
    const row = await db
      .prepare(`SELECT c.*, e.created_at AS event_created_at FROM protocol_conflicts c
        JOIN events e ON e.id = c.event_id AND e.problem_id = c.problem_id AND e.seq = c.seq
          AND e.object_id = c.conflict_id AND e.payload_sha256 = c.event_sha256
        JOIN problems p ON p.id = c.problem_id AND p.status <> 'private-draft'
        WHERE c.fellow_id = ? AND c.sponsor_id = ? AND c.route = ? AND c.key_hash = ?`)
      .bind(actor.fellowId, actor.sponsorId, route, keyHash)
      .first<ConflictRow>();
    if (row && row.request_digest !== digest) throw new ProtocolConflictError("CONFLICT");
    return row ? receipt(row) : undefined;
  };
  // A successful retry is a receipt read; it does not consume another public
  // write or require the original session and instruction to remain active.
  const prior = await replay();
  if (prior) return prior;
  const authority = await db
    .prepare(`SELECT a.*, p.unlisted,
      (SELECT COUNT(*) FROM events WHERE writer_credential_id = a.credential_id) AS event_usage
      FROM protocol_conflict_authority a JOIN problems p ON p.id = a.problem_id
      WHERE a.credential_id = ? AND a.fellow_id = ? AND a.sponsor_id = ? AND a.session_id = ?`)
    .bind(actor.credentialId, actor.fellowId, actor.sponsorId, sessionId)
    .first<{
      problem_id: string;
      unlisted: number;
      role: "observer" | "contributor" | "steward";
      opened_at: string;
      idle_close_at: string;
      event_usage: number;
    }>();
  const now = clock(),
    nowIso = new Date(now).toISOString();
  if (
    !authority ||
    authority.opened_at > nowIso ||
    authority.idle_close_at <= nowIso ||
    ![0, 1].includes(authority.unlisted) ||
    !Number.isSafeInteger(authority.event_usage)
  )
    throw new ProtocolConflictError("NOT_ALLOWED");
  const grantedScope = actor.grantedScopes.includes("review") ? "review" : "promote";
  if (
    authorizeFellowWrite({
      effect: grantedScope,
      credential: actor,
      now,
      target: {
        kind: "existing-problem",
        problemId: authority.problem_id,
        publication: "published",
        unlisted: authority.unlisted === 1,
        membershipRole: authority.role,
        action: "protocol-conflict",
      },
      usage: { eventsRecorded: authority.event_usage, artifactBytesRecorded: 0 },
    }).decision !== "allow"
  )
    throw new ProtocolConflictError("NOT_ALLOWED");
  const source = await db
    .prepare(`SELECT d.notice_id FROM sponsor_directives d
      JOIN fellow_inbox_notices n ON n.id = d.notice_id AND n.fellow_id = d.fellow_id
        AND n.notice_type = 'sponsor_directive' AND n.target_id = d.id
        AND n.problem_id IS d.problem_id AND n.created_at <= ?
      WHERE d.id = ? AND d.fellow_id = ? AND d.sponsor_id = ?
        AND d.verb IN ('focus','forbid') AND (d.problem_id IS NULL OR d.problem_id = ?)
        AND d.created_at <= ?`)
    .bind(now, request.directive_id, actor.fellowId, actor.sponsorId, authority.problem_id, now)
    .first<{ notice_id: string }>();
  // The same opaque refusal covers missing, somebody else's, transferred and
  // differently scoped directives. Private source existence is not an oracle.
  if (!source) throw new ProtocolConflictError("NOT_ALLOWED");
  if (
    await db
      .prepare("SELECT 1 FROM protocol_conflicts WHERE directive_id = ? AND problem_id = ?")
      .bind(request.directive_id, authority.problem_id)
      .first()
  ) {
    const winner = await replay();
    if (winner) return winner;
    throw new ProtocolConflictError("CONFLICT");
  }
  let reservation: string;
  try {
    reservation = await options.reserve({
      fellowId: actor.fellowId,
      sponsorId: actor.sponsorId,
      problemId: authority.problem_id,
      sessionId,
      route,
      idempotencyKey: keyHash,
      requestDigest: digest,
      now: clock(),
    });
  } catch (error) {
    const winner = await replay();
    if (winner) return winner;
    throw error;
  }
  try {
    const publicProse = {
      rule_cited: request.rule_cited,
      refused_part: request.refused_part,
      explanation: request.explanation,
    };
    const screened = await screenPublicCandidate(
      (candidate) => options.screen(candidate),
      { DB: db } as Env,
      {
        problemId: authority.problem_id,
        fellowId: actor.fellowId,
        kind: "protocol-conflict",
        statement: JSON.stringify(publicProse),
        falsifier: null,
      },
      { sponsorId: actor.sponsorId, route: "protocol-conflict" },
    );
    if (screened instanceof Response)
      throw new ProtocolConflictError(
        screened.status === 202 || screened.status === 403 ? "HELD" : "UNAVAILABLE",
        30,
        screened,
      );
    const provenance = screened.provenance;
    const binding = {
      bodyDigest: `sha256:${provenance.input_digest}`,
      contextDigest: `sha256:${provenance.context_digest}`,
    };
    const screenReceipt = JSON.stringify({
      decision: provenance.outcome,
      provider_status: provenance.provider_status,
      evaluated_body_digest: binding.bodyDigest,
      evaluated_context_digest: binding.contextDigest,
      model_version: provenance.model_version,
      policy_version: provenance.policy_version,
      configuration_digest: `sha256:${provenance.configuration_digest}`,
      decision_path: provenance.decision_path,
      ...(provenance.review_case_id === undefined
        ? {}
        : { review_case_id: provenance.review_case_id }),
    });
    const conflictId = `PC-${crypto.randomUUID().replaceAll("-", "")}`;
    const eventId = `E-${crypto.randomUUID().replaceAll("-", "")}`;
    const createdAt = clock();
    await options.writeLedger(
      {
        problemId: authority.problem_id,
        eventId,
        idempotencyKey: `protocol-conflict:${await hash(`${actor.fellowId}:${route}:${keyHash}`)}`,
        requestDigest: digest,
        eventType: "protocol_conflict.recorded",
        objectKind: "protocol-conflict",
        objectId: conflictId,
        objectVersion: 1,
        payloadJson: JSON.stringify(
          ProtocolConflictPayloadSchema.parse({ conflict_id: conflictId, ...publicProse }),
        ),
        createdAt: new Date(createdAt).toISOString(),
        attribution: {
          fellowId: actor.fellowId,
          sponsorId: actor.sponsorId,
          sessionId,
          modelSelfDeclared: actor.model,
          harness: actor.harness,
          credentialId: actor.credentialId,
        },
      },
      {
        statementsAfterEvent: async (settled) => {
          const acceptedAt = clock();
          const row = {
            event_id: settled.eventId,
            event_sha256: settled.payloadSha256,
            problem_id: authority.problem_id,
            conflict_id: conflictId,
            seq: settled.sequence,
            directive_id: request.directive_id,
            source_notice_id: source.notice_id,
            fellow_id: actor.fellowId,
            sponsor_id: actor.sponsorId,
            credential_id: actor.credentialId,
            session_id: sessionId,
            granted_scope: grantedScope,
            route,
            key_hash: keyHash,
            request_digest: digest,
            reservation_id: reservation,
            screen_body_digest: binding.bodyDigest,
            screen_context_digest: binding.contextDigest,
            screen_receipt_json: screenReceipt,
            created_at: acceptedAt,
          };
          return [
            ...screeningPublicationStatements(db, screened, settled.eventId, sessionId, digest),
            db
              .prepare(`INSERT INTO protocol_conflicts (${Object.keys(row).join(",")})
                SELECT ${Object.keys(row)
                  .map(() => "?")
                  .join(",")} FROM events WHERE id = ? AND seq = ?`)
              .bind(...Object.values(row), settled.eventId, settled.sequence),
            await inboxNoticeStatement(
              db,
              {
                fellowId: actor.fellowId,
                problemId: authority.problem_id,
                noticeType: "protocol_notice",
                title: "Protocol conflict recorded",
                detail:
                  "A Fellow recorded a public refusal of a sponsor instruction. Inspect the ledger record for its current availability.",
                causedByEventId: settled.eventId,
                targetId: conflictId,
                createdAt: acceptedAt,
              },
              {
                sql: "EXISTS (SELECT 1 FROM protocol_conflicts WHERE event_id = ?)",
                bindings: [settled.eventId],
              },
            ),
            db
              .prepare(`UPDATE public_write_attempt_reservations SET status = 'settled_published', settled_at = ?
                WHERE reservation_id = ? AND status = 'reserved'
                  AND EXISTS (SELECT 1 FROM protocol_conflicts WHERE event_id = ?)`)
              .bind(acceptedAt, reservation, settled.eventId),
          ];
        },
      },
    );
    const saved = await replay();
    if (!saved) throw new ProtocolConflictError("UNAVAILABLE");
    return saved;
  } catch (error) {
    const winner = await replay();
    if (winner) return winner;
    await options.settleFailure(
      reservation,
      isScreeningPostureChangedError(error) ||
        isScreeningDecisionChangedError(error) ||
        (error instanceof ProtocolConflictError && error.code === "HELD"),
    );
    if (isArchivedProblemWriteError(error) || isProblemMembershipAdmissionError(error)) throw error;
    if (isScreeningPostureChangedError(error))
      throw new ProtocolConflictError(
        "HELD",
        30,
        screeningHoldResponse("provider-unavailable", undefined, "quarantine-first"),
      );
    if (isScreeningDecisionChangedError(error))
      throw new ProtocolConflictError("HELD", 30, screeningHoldResponse("provider-unavailable"));
    if (isScreeningContextStaleError(error))
      throw new ProtocolConflictError("UNAVAILABLE", 30, screeningContextStaleProblem());
    if (error instanceof Error && error.message.includes("PROTOCOL_CONFLICT_AUTHORITY_CHANGED"))
      throw new ProtocolConflictError("NOT_ALLOWED");
    if (
      error instanceof Error &&
      error.message.includes("UNIQUE constraint failed: protocol_conflicts")
    )
      throw new ProtocolConflictError("CONFLICT");
    throw error instanceof ProtocolConflictError ? error : new ProtocolConflictError("UNAVAILABLE");
  }
}
