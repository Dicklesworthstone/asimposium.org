import type { D1Database } from "@cloudflare/workers-types";
import { authorizeFellowWrite, type FellowCredentialBinding } from "../enrollment/service.ts";
import type { KraterLedgerEventInput, KraterLedgerProjectionPlan } from "../krater/krater.ts";
import {
  type PublicationScreeningObservation,
  promotionScreeningBinding,
} from "../screening/workers-ai.ts";

export const SCIENTIFIC_WITHDRAWALS_SCHEMA =
  "https://a.asimposium.org/schemas/scientific-withdrawals.v1.json";
export type WithdrawalKind = "evidence" | "review";
export interface WithdrawalRequest {
  source_event_id: string;
  source_digest: string;
  reason: string;
}
export class ScientificWithdrawalError extends Error {
  readonly code: "NOT_ALLOWED" | "NOT_FOUND" | "CONFLICT" | "HELD" | "UNAVAILABLE" | "RATE_LIMITED";
  readonly retryAfter: number;
  constructor(
    code: "NOT_ALLOWED" | "NOT_FOUND" | "CONFLICT" | "HELD" | "UNAVAILABLE" | "RATE_LIMITED",
    retryAfter = 30,
  ) {
    super(`SCIENTIFIC_WITHDRAWAL_${code}`);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}
interface Target {
  problem_id: string;
  source_event_id: string;
  source_sha256: string;
  target_object: string;
  target_kind: WithdrawalKind;
  source_seq: number;
  fellow_id: string;
  payload_json: string;
  claim_id: string;
  claim_version: number;
}
interface WithdrawalRow {
  event_id: string;
  retraction_id: string;
  problem_id: string;
  seq: number;
  target_kind: WithdrawalKind;
  target_object: string;
  source_event_id: string;
  source_sha256: string;
  claim_id: string;
  claim_version: number;
  request_digest: string;
  created_at: number;
}
export interface WithdrawalOptions {
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
  readonly screen: (input: {
    problemId: string;
    fellowId: string;
    kind: string;
    statement: string;
    falsifier: null;
  }) => Promise<PublicationScreeningObservation>;
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
const denied = (): never => {
  throw new ScientificWithdrawalError("NOT_ALLOWED");
};

export function scientificWithdrawalReceipt(row: WithdrawalRow) {
  return {
    schema: SCIENTIFIC_WITHDRAWALS_SCHEMA,
    ok: true as const,
    event_id: row.event_id,
    retraction_id: row.retraction_id,
    problem_id: row.problem_id,
    target_kind: row.target_kind,
    target_object: row.target_object,
    target_event_id: row.source_event_id,
    target_digest: `sha256:${row.source_sha256}`,
    claim_id: row.claim_id,
    claim_version: row.claim_version,
    retraction_kind: "self-corrected" as const,
    seq: row.seq,
    created_at: new Date(row.created_at).toISOString(),
  };
}

/** Exact-version, author-only withdrawal. This records a new public correction;
 * it never rewrites the target, deletes evidence, or retracts somebody's claim. */
export async function withdrawScientificInput(
  options: WithdrawalOptions,
  actor: FellowCredentialBinding,
  sessionId: string,
  kind: WithdrawalKind,
  targetId: string,
  input: WithdrawalRequest,
  key: string,
) {
  const db = options.db,
    clock = options.clock ?? Date.now;
  if (
    !/^S-[A-Za-z0-9]{26}$/.test(sessionId) ||
    !["evidence", "review"].includes(kind) ||
    !/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(targetId) ||
    !/^[A-Za-z0-9._-]{1,160}$/.test(key) ||
    !/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(input.source_event_id) ||
    !/^sha256:[a-f0-9]{64}$/.test(input.source_digest) ||
    typeof input.reason !== "string" ||
    input.reason.trim().length < 10 ||
    input.reason.length > 2000
  )
    return denied();
  const request = {
    source_event_id: input.source_event_id,
    source_digest: input.source_digest,
    reason: input.reason,
  };
  const route = `/v1/sessions/${sessionId}/${kind === "review" ? "reviews" : "evidence"}/${targetId}/retract`;
  const keyHash = await hash(key),
    digest = await hash(JSON.stringify({ route, request }));
  const replay = async () => {
    const row = await db
      .prepare(`SELECT w.*, p.status AS problem_status FROM scientific_withdrawals w
      JOIN problems p ON p.id = w.problem_id
      WHERE w.fellow_id = ? AND w.route = ? AND w.key_hash = ?`)
      .bind(actor.fellowId, route, keyHash)
      .first<WithdrawalRow & { problem_status: string }>();
    if (row?.problem_status === "private-draft") return denied();
    if (row && row.request_digest !== digest) throw new ScientificWithdrawalError("CONFLICT");
    return row ? scientificWithdrawalReceipt(row) : undefined;
  };
  // Authentication is fresh in the mounted adapter; a durable receipt replay
  // is a read and does not require the original session to remain open.
  if (
    actor.credentialProfile !== "bearer" ||
    actor.revokedAt !== undefined ||
    actor.issuedAt > clock() ||
    actor.expiresAt <= clock() ||
    actor.fellowStatus !== "active"
  )
    return denied();
  const prior = await replay();
  if (prior) return prior;
  const authority = await db
    .prepare(`SELECT a.*, p.unlisted,
    (SELECT COUNT(*) FROM events WHERE writer_credential_id = a.credential_id) AS event_usage
    FROM scientific_withdrawal_authority a JOIN problems p ON p.id = a.problem_id
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
    return denied();
  if (
    authorizeFellowWrite({
      effect: kind === "review" ? "review" : "promote",
      credential: actor,
      now,
      target: {
        kind: "existing-problem",
        problemId: authority.problem_id,
        publication: "published",
        unlisted: authority.unlisted === 1,
        membershipRole: authority.role,
      },
      usage: { eventsRecorded: authority.event_usage, artifactBytesRecorded: 0 },
    }).decision !== "allow"
  )
    return denied();
  const source = await db
    .prepare(`SELECT * FROM scientific_withdrawal_targets
    WHERE problem_id = ? AND target_kind = ? AND target_object = ? AND source_event_id = ? AND fellow_id = ?`)
    .bind(authority.problem_id, kind, targetId, request.source_event_id, actor.fellowId)
    .first<Target>();
  if (!source || `sha256:${source.source_sha256}` !== request.source_digest) return denied();
  if ((await hash(source.payload_json)) !== source.source_sha256)
    throw new ScientificWithdrawalError("UNAVAILABLE");
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(source.payload_json);
  } catch {
    throw new ScientificWithdrawalError("UNAVAILABLE");
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !/^C-[0-9]+$/.test(source.claim_id) ||
    !Number.isSafeInteger(source.claim_version) ||
    source.claim_version < 1 ||
    (kind === "review" &&
      (payload.target_claim_id !== source.claim_id ||
        payload.target_version !== source.claim_version)) ||
    (kind === "evidence" &&
      (payload.bears_on_kind !== "claim" ||
        payload.bears_on_id !== source.claim_id ||
        payload.bears_on_version !== source.claim_version))
  )
    throw new ScientificWithdrawalError("UNAVAILABLE");
  if (
    await db
      .prepare("SELECT 1 FROM scientific_withdrawals WHERE source_event_id = ?")
      .bind(source.source_event_id)
      .first()
  ) {
    const winner = await replay();
    if (winner) return winner;
    throw new ScientificWithdrawalError("CONFLICT");
  }
  let reservation: string;
  try {
    reservation = await options.reserve({
      fellowId: actor.fellowId,
      sponsorId: actor.sponsorId,
      problemId: source.problem_id,
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
    const screenInput = {
      problemId: source.problem_id,
      fellowId: actor.fellowId,
      kind: "retraction",
      statement: JSON.stringify({ target_kind: kind, target_object: targetId, ...request }),
      falsifier: null,
    } as const;
    const binding = await promotionScreeningBinding(screenInput);
    const screen = await options.screen(screenInput);
    const label = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
    if (
      !screen ||
      screen.evaluated_body_digest !== binding.bodyDigest ||
      screen.evaluated_context_digest !== binding.contextDigest ||
      typeof screen.model_version !== "string" ||
      typeof screen.policy_version !== "string" ||
      typeof screen.configuration_digest !== "string" ||
      !label.test(screen.model_version) ||
      !label.test(screen.policy_version) ||
      !/^sha256:[a-f0-9]{64}$/.test(screen.configuration_digest) ||
      screen.provider_status !== "ok"
    )
      throw new ScientificWithdrawalError("UNAVAILABLE");
    if (screen.decision !== "pass" || screen.coarse_category !== "benign-context")
      throw new ScientificWithdrawalError("HELD");
    const receipt = JSON.stringify({
      decision: screen.decision,
      provider_status: screen.provider_status,
      evaluated_body_digest: binding.bodyDigest,
      evaluated_context_digest: binding.contextDigest,
      model_version: screen.model_version,
      policy_version: screen.policy_version,
      configuration_digest: screen.configuration_digest,
    });
    const retractionId = `R-${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
    const eventId = `E-${crypto.randomUUID().replaceAll("-", "")}`;
    const createdAt = clock();
    await options.writeLedger(
      {
        problemId: source.problem_id,
        eventId,
        idempotencyKey: `withdraw:${await hash(`${actor.fellowId}:${route}:${keyHash}`)}`,
        requestDigest: digest,
        eventType: "object.retracted",
        objectKind: "retraction",
        objectId: retractionId,
        objectVersion: 1,
        payloadJson: JSON.stringify({
          retraction_id: retractionId,
          target_kind: kind,
          target_object: targetId,
          target_event_id: source.source_event_id,
          target_digest: request.source_digest,
          claim_id: source.claim_id,
          claim_version: source.claim_version,
          retraction_kind: "self-corrected",
          reason: request.reason,
        }),
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
        preconditionSql: ` AND EXISTS (SELECT 1 FROM scientific_withdrawal_targets
        WHERE source_event_id = ? AND source_sha256 = ? AND payload_json = ?)`,
        preconditionBindings: [source.source_event_id, source.source_sha256, source.payload_json],
        statementsAfterEvent: (settled) => {
          const acceptedAt = clock();
          const row = {
            event_id: settled.eventId,
            event_sha256: settled.payloadSha256,
            problem_id: source.problem_id,
            retraction_id: retractionId,
            seq: settled.sequence,
            target_kind: kind,
            target_object: targetId,
            source_event_id: source.source_event_id,
            source_sha256: source.source_sha256,
            claim_id: source.claim_id,
            claim_version: source.claim_version,
            fellow_id: actor.fellowId,
            sponsor_id: actor.sponsorId,
            credential_id: actor.credentialId,
            session_id: sessionId,
            route,
            key_hash: keyHash,
            request_digest: digest,
            reservation_id: reservation,
            screen_body_digest: binding.bodyDigest,
            screen_context_digest: binding.contextDigest,
            screen_receipt_json: receipt,
            created_at: acceptedAt,
          };
          return [
            db
              .prepare(`INSERT INTO retractions (retraction_id,problem_id,seq,target_object,
          retraction_kind,reason,author_fellow_id,created_at)
          SELECT ?,?,?,?,'self-corrected',?,?,? FROM events WHERE id = ? AND seq = ?`)
              .bind(
                retractionId,
                source.problem_id,
                settled.sequence,
                targetId,
                request.reason,
                actor.fellowId,
                new Date(acceptedAt).toISOString(),
                settled.eventId,
                settled.sequence,
              ),
            db
              .prepare(`INSERT INTO scientific_withdrawals (${Object.keys(row).join(",")})
            SELECT ${Object.keys(row)
              .map(() => "?")
              .join(",")} FROM events WHERE id = ? AND seq = ?`)
              .bind(...Object.values(row), settled.eventId, settled.sequence),
            db
              .prepare(`UPDATE public_write_attempt_reservations SET status = 'settled_published', settled_at = ?
            WHERE reservation_id = ? AND status = 'reserved'
              AND EXISTS (SELECT 1 FROM scientific_withdrawals WHERE event_id = ?)`)
              .bind(acceptedAt, reservation, settled.eventId),
          ];
        },
      },
    );
    const saved = await replay();
    if (!saved) throw new ScientificWithdrawalError("UNAVAILABLE");
    return saved;
  } catch (error) {
    const winner = await replay();
    if (winner) return winner;
    await options.settleFailure(
      reservation,
      error instanceof ScientificWithdrawalError && error.code === "HELD",
    );
    throw error instanceof ScientificWithdrawalError
      ? error
      : new ScientificWithdrawalError("UNAVAILABLE");
  }
}
